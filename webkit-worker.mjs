import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, writeFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_BYTES, VERSION, operatePersistentContext } from "./playwright-worker.mjs";
import { FirefoxWorkbench as ContextWorkbench } from "./workbench-firefox.mjs";
import { connectOfficial, nonClosingContext } from "./agent/playwright-proxy.mjs";
import { createHumanizer } from "./agent/humanize.mjs";
import { BrowserDevtools, DEVTOOLS_TOOLS, DEVTOOLS_TOOL_NAMES } from "./agent/devtools.mjs";
import { PluginHost, isPluginTool, pluginTools } from "./agent/plugins.mjs";
import { keepDownloads } from "./agent/downloads.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const error = (code) => Object.assign(new Error(`WebKit owner ${code.replaceAll("_", " ")}`), { code });
async function readJson(stream) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw error("invalid_request");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw error("invalid_request"); }
}
function sameToken(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function webkitLaunchOptions(input) {
  const { viewport, deviceScaleFactor, locale, timezoneId, userAgent, screen } = input.config;
  return {
    executablePath: input.executablePath, headless: input.headless ?? false,
    viewport, deviceScaleFactor, locale, timezoneId, userAgent, screen,
    colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null,
    ...(input.proxy ? { proxy: input.proxy } : {}),
  };
}
async function run() {
  const input = await readJson(process.stdin);
  let address;
  try { address = new URL(input.owner?.endpoint); } catch { throw error("invalid_request"); }
  if (input.version !== VERSION || !input.profileId || !input.userDataDir || !input.executablePath
    || !/^[a-f0-9]{64}$/.test(input.executableSha256) || !input.config?.viewport || !input.config?.screen
    || address.protocol !== "http:" || address.hostname !== "127.0.0.1" || !address.port || address.pathname !== "/"
    || !input.owner.token || !input.owner.generation
    || !process.argv.includes(`--aliasmode-webkit-owner=${input.owner.generation}`)
    || input.args?.length) throw error("invalid_request");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(input.executablePath)) hash.update(chunk);
  if (hash.digest("hex") !== input.executableSha256) throw error("operation_failed");
  const runtime = await import(pathToFileURL(join(ROOT, "node_modules", "playwright-webkit-core", "index.mjs")).href);
  const context = await runtime.webkit.launchPersistentContext(input.userDataDir, webkitLaunchOptions(input));
  const browser = context.browser();
  const browserPid = context?._connection?.toImpl?.(context)?._browser?.options?.browserProcess?.process?.pid;
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0) { await context.close(); throw error("runtime_unavailable"); }
  const workbench = new ContextWorkbench(context);
  const devtools = new BrowserDevtools(context);
  const plugins = new PluginHost({ context, engine: "webkit", profileId: input.profileId, devtools });
  // What the user downloads lands in their Downloads folder, not in Playwright's temporary one.
  keepDownloads(context);
  let official, humanizer;
  const closeOfficial = async () => {
    const current = official; official = undefined;
    await current?.client.close().catch(() => {});
    await current?.server.close().catch(() => {});
  };
  const initializeOfficial = async () => {
    if (official) return official;
    // This pinned WebKit uses Playwright 1.65. Its own bundled MCP implementation
    // understands that context's snapshot and input APIs; no replacement context is created.
    const { default: core } = await import(pathToFileURL(join(ROOT, "node_modules", "playwright-webkit-core", "lib", "coreBundle.js")).href);
    return official = await connectOfficial("vela-webkit-owner", async () => nonClosingContext(context),
      (config, getter) => core.tools.createConnection({ ...config, outputDir: join(input.userDataDir, "mcp-output") }, getter));
  };
  const ids = new WeakMap(); let nextId = 0, closing = false, crashed = false;
  const origins = new Set(); const storageCache = new Map();
  const tabs = () => context.pages().map((page) => {
    if (!ids.has(page)) ids.set(page, `page-${++nextId}`);
    return { id: ids.get(page), url: page.url() };
  });
  // Keep an exact-generation tab snapshot for native window close and manager restart.
  let savedTabs = [];
  const rememberTabs = () => {
    if (closing) return;
    const current = tabs().map((tab) => tab.url).filter((url) => /^https?:/.test(url) && !url.includes("__aliasmode_fingerprint__"));
    if (current.length || context.pages().length) savedTabs = current;
    try { writeFileSync(join(input.userDataDir, "aliasmode-session-tabs.json"), JSON.stringify({ generation: input.sessionGeneration, tabs: savedTabs })); } catch {}
  };
  const watch = (page) => {
    const observe = () => {
      try {
        const url = new URL(page.url());
        if (/^https?:$/.test(url.protocol) && !url.searchParams.has("__aliasmode_fingerprint__")) {
          origins.add(url.origin); storageCache.delete(url.origin);
        }
      } catch {}
      rememberTabs();
    };
    observe();
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) observe(); });
    page.once("crash", () => { crashed = true; });
    page.once("close", rememberTabs);
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  const operate = async (name, payload) => {
    if (closing || payload.ownerGeneration !== input.owner.generation) throw error("runtime_unavailable");
    if (name === "status") return {
      generation: input.owner.generation, directory: input.userDataDir, executablePath: input.executablePath,
      pid: process.pid, browserPid, profileId: input.profileId, pageTargets: tabs(), hasPages: crashed || context.pages().length > 0,
    };
    if (name === "close") {
      rememberTabs();
      // WebKit persists expiring cookies itself. Session cookies need an exact
      // profile snapshot before closing the context, while its store is live.
      const file = join(input.userDataDir, "aliasmode-webkit-session.json");
      const temporary = `${file}.${input.owner.generation}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, profileId: input.profileId,
        generation: input.sessionGeneration, cookies: await context.cookies() }));
      renameSync(temporary, file);
      return null;
    }
    if (name === "workbench") return workbench.run(payload);
    if (name === "bring-to-front") {
      const target = payload.targetId ? tabs().find((tab) => tab.id === payload.targetId) : tabs()[0];
      const page = target && context.pages().find((candidate) => ids.get(candidate) === target.id);
      if (!page) throw error("operation_failed");
      await page.bringToFront(); return null;
    }
    if (name === "session-capture") payload = { ...payload, captureSeed: {
      ...payload.captureSeed, origins: [...new Set([...(payload.captureSeed?.origins ?? []), ...(payload.captureSeed?.openTabsOnly ? [] : origins)])],
    } };
    if (name === "session-restore") storageCache.clear();
    if (name === "mcp-list") return [...(await initializeOfficial()).tools.filter(tool => !/pdf/i.test(tool.name)), ...DEVTOOLS_TOOLS, ...pluginTools(payload.plugins)];
    if (name === "mcp-call") {
      if (typeof payload.name !== "string") throw error("invalid_request");
      if (isPluginTool(payload.name)) return plugins.call(payload.plugins, payload.name, payload.arguments ?? {});
      if (DEVTOOLS_TOOL_NAMES.has(payload.name)) return devtools.call(payload.name, payload.arguments ?? {}).catch(caught => ({ isError: true, content: [{ type: "text", text: caught.message }] }));
      const bridge = await initializeOfficial();
      if (!bridge.tools.some(tool => tool.name === payload.name && !/pdf/i.test(tool.name))) throw error("invalid_request");
      humanizer ??= createHumanizer({ context, profileId: input.profileId,
        callOfficial: (tool, args) => official.client.callTool({ name: tool, arguments: args ?? {} }) });
      humanizer.configure(payload.humanize ?? { enabled: true, speed: 1, pasteOver: null });
      return humanizer.call(payload.name, payload.arguments ?? {});
    }
    if (name === "detach") { await closeOfficial(); return null; }
    if (name === "playwright-endpoint") throw error("invalid_request");
    return operatePersistentContext(browser, context, name, payload, { nativeStorage: true, storageCache });
  };
  let queue = Promise.resolve();
  const send = (response, status, value) => {
    let body = JSON.stringify({ version: VERSION, ...value });
    if (Buffer.byteLength(body) > MAX_BYTES) { status = 400; body = JSON.stringify({ version: VERSION, ok: false, error: { code: "invalid_response", message: "WebKit response exceeded its limit" } }); }
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(body);
  };
  const server = createServer((request, response) => { void (async () => {
    if (request.method !== "POST" || request.url !== "/" || !sameToken(input.owner.token, request.headers.authorization?.replace(/^Bearer /, ""))) {
      send(response, 401, { ok: false, error: { code: "runtime_unavailable", message: "WebKit owner is unavailable" } }); return;
    }
    try {
      const value = await readJson(request);
      if (value.version !== VERSION || typeof value.operation !== "string" || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) throw error("invalid_request");
      // Reading the workbench never waits behind, or holds up, the actions in the queue: a live
      // frame request may wait for the page to paint.
      const concurrent = value.operation === "status"
        || (value.operation === "workbench" && ["tabs", "viewport", "frame"].includes(value.payload.action));
      const pending = concurrent ? operate(value.operation, value.payload) : queue.then(() => operate(value.operation, value.payload));
      if (!concurrent) queue = pending.catch(() => {});
      const result = await pending;
      if (value.operation === "close") { closing = true; await closeOfficial(); devtools.dispose(); await context.close(); }
      send(response, 200, { ok: true, result });
      if (closing) { server.close(); server.closeIdleConnections(); }
    } catch (caught) {
      send(response, 400, { ok: false, error: { code: caught?.code || "operation_failed", message: "WebKit owner operation failed", ...(caught?.details ? { details: caught.details } : {}) } });
    }
  })(); });
  const shutdown = () => { closing = true; devtools.dispose(); server.close(); server.closeIdleConnections(); void closeOfficial().finally(() => context.close()).catch(() => {}); };
  context.once("close", shutdown);
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(address.port), address.hostname, resolve); }); }
  catch (caught) { await context.close().catch(() => {}); throw caught; }
  process.stdout.write(`${JSON.stringify({ version: VERSION, ok: true, result: { endpoint: input.owner.endpoint, pid: process.pid, browserPid, generation: input.owner.generation } })}\n`);
}
if (process.argv.some((arg) => arg.startsWith("--aliasmode-webkit-owner="))) {
  try { await run(); } catch (caught) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, ok: false, error: { code: caught?.code || "operation_failed", message: "WebKit owner could not start" } })}\n`);
    process.exitCode = 1;
  }
}

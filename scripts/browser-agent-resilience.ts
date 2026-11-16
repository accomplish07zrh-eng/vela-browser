import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import WebSocket from "ws";
import { BrowserDevtools } from "../agent/devtools.mjs";
import { AGENT_CONTROL_PATH, AGENT_CONTROL_PROTOCOL } from "../src/agent-control.ts";
import { buildNewProfile } from "../src/create.ts";
import { LifecycleAdmissionController } from "../src/lifecycle-admission.ts";
import { statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import { serveDashboard } from "../src/web.ts";

const executable = process.argv[2] || Bun.which("google-chrome") || Bun.which("chromium");
if (!executable) throw new Error("Pass a Chromium browser executable");
const root = mkdtempSync(join(tmpdir(), "vela-resilience-"));
const profileDir = join(root, "chrome");
const child = Bun.spawn([executable, "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
  "--no-default-browser-check", "--site-per-process", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank"],
  { stdout: "ignore", stderr: "ignore" });

async function until<T>(run: () => T | Promise<T>, expected: (value: T) => boolean, label: string): Promise<T> {
  let value: T;
  const deadline = Date.now() + 12_000;
  do {
    value = await run();
    if (expected(value)) return value;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

let saves = 0, rebuilt = false, stage = "connecting Chromium";
const watchdog = setTimeout(() => {
  console.error(`Timed out while ${stage}`);
  child.kill();
  process.exit(1);
}, 48_000);
const dropReply = Promise.withResolvers<void>();
const binary = Buffer.alloc(180_007, 249);
const sse = "event: snapshot\nid: 42\ndata: stream-before-end\n\n";
const useSourceMap = Buffer.from(JSON.stringify({ version: 3, sources: ["value.ts"], names: [], mappings: "AAAA;AACA;AACA" })).toString("base64");
const compiled = `window.runFixture = (encoded) => {\n  const value = atob(encoded);\n  return value;\n};\n//# sourceMappingURL=data:application/json;base64,${useSourceMap}`;
const leaf = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/wire" && server.upgrade(request)) return;
    if (url.pathname === "/live") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse)); },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    if (url.pathname === "/receipt") return Response.json(saves ? { state: "applied", value: "receipt-1" } : { state: "absent" });
    if (url.pathname === "/save" && request.method === "POST") {
      saves++;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"receipt":'));
          void dropReply.promise.then(() => controller.error(new Error("Reply connection lost")));
        },
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/script.js") return new Response(compiled, { headers: { "Content-Type": "text/javascript" } });
    if (url.pathname === "/leaf") {
      return new Response(`<!doctype html><title>Leaf</title>
        <form aria-label="Other"><button type="button" onclick="fetch('/wrong')">Read receipt</button></form>
        <form aria-label="Draft"><button id="${rebuilt ? "rebuilt" : "original"}" type="button" onclick="fetch('/receipt')">Read receipt</button></form>
        <script src="/script.js"></script>`, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("unexpected", { status: 404 });
  },
  websocket: { open(socket) { socket.send(binary); }, message() {} },
});
const leafUrl = `http://127.0.0.1:${leaf.port}/leaf`;
const pages = Bun.serve({ hostname: "localhost", port: 0, fetch(request) {
  const level = Number(new URL(request.url).searchParams.get("level") ?? 0);
  const address = level === 3 ? leafUrl : `/?level=${level + 1}`;
  return new Response(`<!doctype html><iframe name="layer-${level}" src="${address}"></iframe>`, { headers: { "Content-Type": "text/html" } });
} });

const store = new ProfileStore(":memory:");
let browser: Browser | undefined, dashboard: ReturnType<typeof serveDashboard> | undefined, tools: BrowserDevtools | undefined;
let launch: any = null, closes = 0;
const connections = new Set<WebSocket>();
try {
  const activeFile = join(profileDir, "DevToolsActivePort");
  const active = await until(() => existsSync(activeFile) ? readFileSync(activeFile, "utf8").trim().split(/\r?\n/) : [], value => value.length >= 2, "Chromium endpoint");
  const port = Number(active[0]), endpoint = `ws://127.0.0.1:${port}${active[1]}`;
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? await context.newPage();
  const address = `http://localhost:${pages.port}/?level=0`;
  tools = new BrowserDevtools(context, { engine: "chromium" });
  await page.goto(address);
  stage = "rebinding the nested iframe anchor";
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const reply = await tools!.call(`browser_devtools_${tool}`, args);
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return reply.structuredContent as any;
  };
  const listing = (await call("pages")).pages[0];
  const leafId = listing.frames.find((frame: any) => frame.url === leafUrl);
  assert.equal(leafId.depth, 4);
  const select = { pageId: listing.pageId, frameId: leafId.frameId };
  const anchor = await call("anchor", { ...select, target: { selector: "#original", within: { role: "form", name: "Draft" } } });
  rebuilt = true;
  await page.locator("iframe").evaluate(node => node.replaceWith(node.cloneNode()));
  const action = await call("action", { anchor, action: "click", verify: { response: { urlIncludes: "/receipt", status: 200 } } });
  assert.equal(action.verification.passed, true);
  assert.notEqual(action.frameId, select.frameId);
  assert.equal(action.resolvedBy.text, "Read receipt");

  stage = "capturing live SSE and full WebSocket bytes";
  const live = await call("stream", { action: "start", pageId: listing.pageId });
  const captureId = live.captureId;
  const nested = page.frames().find(frame => frame.url() === leafUrl)!;
  const baseline = await call("dom_delta", { action: "take", frameId: action.frameId, selector: 'form[aria-label="Draft"]' });
  await nested.locator("#rebuilt").evaluate(button => button.setAttribute("data-state", "changed after baseline"));
  const delta = await call("dom_delta", { action: "take", baselineId: baseline.snapshotId });
  assert.equal(delta.records.find((item: any) => item.type === "changed").after.attributes["data-state"], "changed after baseline");
  await nested.evaluate(() => {
    const connection = new EventSource("/live");
    connection.addEventListener("snapshot", () => {});
    const socket = new WebSocket(location.origin.replace("http", "ws") + "/wire");
    socket.binaryType = "arraybuffer";
  });
  const capture = await until(() => call("stream", { action: "read", captureId, limit: 500 }), result =>
    ["sse-message", "http-data", "websocket-received"].every(kind => result.records.some((entry: any) => entry.kind === kind)), "Live Chromium events");
  const bytes = async (entry: any) => Buffer.from((await call("stream", {
    action: "bytes", captureId, offset: entry.payload.offset, bytes: entry.payload.totalBytes,
  })).base64, "base64");
  const event = capture.records.find((entry: any) => entry.kind === "sse-message");
  assert.equal(event.eventId, "42");
  assert.equal((await bytes(event)).toString(), "stream-before-end");
  const streamBytes = await Promise.all(capture.records.filter((entry: any) => entry.kind === "http-data" && entry.requestId === event.requestId).map(bytes));
  assert.equal(Buffer.concat(streamBytes).toString(), sse);
  assert.deepEqual(await bytes(capture.records.find((entry: any) => entry.kind === "websocket-received")), binary);
  assert.equal(capture.records.some((entry: any) => entry.kind === "http-finished" && entry.url.endsWith("/live")), false);
  await call("stream", { action: "stop", captureId });

  stage = "reading an out-of-process frame's source and source map";
  const sources = await call("sources", { action: "list", pageId: listing.pageId, urlIncludes: "/script.js" });
  const script = sources.records.find((record: any) => record.transport === "cdp");
  assert.ok(script, JSON.stringify(sources));
  assert.match((await call("sources", { action: "read", sourceId: script.sourceId })).text, /const value = atob/);
  assert.equal((await call("sources", { action: "map", sourceId: script.sourceId, line: 3 })).original.source, "value.ts");
  stage = "evaluating the mapped runtime tracepoint";
  const tracepoint = await call("sources", { action: "trace_add", sourceId: script.sourceId, originalSource: "value.ts", line: 3, expression: "value" });
  assert.equal(await nested.evaluate(() => (window as any).runFixture("ZGVjb2RlZA==")), "decoded");
  const trace = await until(() => call("events", { kind: "source-trace" }), result => result.records.some((record: any) => record.traceId === tracepoint.traceId), "Runtime tracepoint");
  assert.equal(trace.records.at(-1).value, "decoded");
  await call("sources", { action: "trace_remove", traceId: tracepoint.traceId });

  stage = "opening the desktop task connection";
  const nonce = "a".repeat(64);
  const profile = buildNewProfile({ name: "Resilience", platformOs: "windows" }, () => false);
  store.upsertProfile(profile);
  const originalGetLaunch = store.getLaunch.bind(store);
  store.getLaunch = (id: string) => id === profile.id ? launch : originalGetLaunch(id);
  dashboard = serveDashboard({
    launcher: {
      certifiedActive: async () => !!launch,
      async start() { launch = { profileId: profile.id, ws: endpoint, debugPort: port, pid: child.pid, headless: true }; return { ws: endpoint, port }; },
      async stop() { closes++; launch = null; return true; },
      async reconcileOrphans() {},
      async cacheCleanupSettled() {},
    } as any,
    store, agentNonce: nonce, port: 0, paths: statePaths(root), lifecycleAdmission: new LifecycleAdmissionController(), log() {},
  });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${dashboard!.port}${AGENT_CONTROL_PATH}`, AGENT_CONTROL_PROTOCOL, { headers: { Authorization: `Bearer ${nonce}` } });
    connections.add(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return { ws, async send(method: string, params: Record<string, unknown>) {
      const reply = new Promise<any>((resolve, reject) => {
        const onError = (error: Error) => { ws.off("message", onMessage); reject(error); };
        const onMessage = (raw: WebSocket.RawData) => { ws.off("error", onError); resolve(JSON.parse(raw.toString())); };
        ws.once("message", onMessage); ws.once("error", onError);
      });
      ws.send(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: 1, method, params }));
      const result = await reply;
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.result;
    } };
  }
  const first = await connect();
  assert.equal((await first.send("browser.open", { profileId: profile.id })).ownedByConnection, true);
  const plan = { profileId: profile.id, name: "Save and reconnect", idempotencyKey: "save-once", screenshots: true,
    argument: { leafUrl }, steps: [{
      id: "save",
      timeoutMs: 15_000,
      run: `async ({page, argument}) => {
        const leaf = page.frames().find(frame => frame.url() === argument.input.leafUrl);
        await leaf.evaluate(async (key) => (await fetch("/save", {method: "POST", headers: {"Idempotency-Key": key}})).json(), argument.actionKey);
      }`,
      verify: `async ({page, argument}) => {
        const leaf = page.frames().find(frame => frame.url() === argument.input.leafUrl);
        return leaf.evaluate(async () => (await fetch("/receipt")).json());
      }`,
    }, { id: "confirm", run: `async ({argument}) => ({receipt: argument.previous.save})` }] };
  const { task } = await first.send("browserTasks.start", plan);
  stage = "waiting for the fixture to commit the save";
  await until(async () => {
    const { task: active } = await first.send("browserTasks.status", { runId: task.runId });
    if (!saves && active.state !== "running") throw new Error(`The browser task stopped before submitting: ${JSON.stringify(active)}`);
    return active;
  }, () => saves > 0, "The save request reached the fixture");
  stage = "disconnecting the first agent while the response is still open";
  await new Promise<void>(resolve => { first.ws.once("close", resolve); first.ws.close(); });
  dropReply.resolve();
  const reconnected = await connect();
  const status = () => reconnected.send("browserTasks.status", { runId: task.runId }).then(response => response.task);
  await until(status, value => value.state === "needs_verification", "Uncertain save");
  stage = "reloading the page and reconciling the save receipt";
  await page.reload();
  assert.equal((await reconnected.send("browserTasks.start", plan)).task.runId, task.runId);
  await reconnected.send("browserTasks.resume", { runId: task.runId });
  const finished = await until(status, value => value.state === "completed", "Recovered save");
  assert.equal(finished.steps[0].attempts, 1);
  assert.equal(saves, 1);
  assert.equal(closes, 0);
  const result = await reconnected.send("browserTasks.evidence", { runId: task.runId, sequence: finished.steps[1].evidence, part: "value" });
  assert.deepEqual(JSON.parse(Buffer.from(result.base64, "base64").toString("utf8")), { receipt: "receipt-1" });
  console.log("Chromium verified live SSE and response bytes, full WebSocket payloads, runtime tracepoints, cross-origin rebind and a single committed save after reconnect.");
} finally {
  stage = "finishing fixture cleanup";
  dropReply.resolve();
  for (const socket of connections) socket.terminate();
  await dashboard?.stop(true);
  await dashboard?.stopScripts();
  tools?.dispose(); store.close();
  await browser?.close().catch(() => {});
  child.kill(); await child.exited;
  pages.stop(true); leaf.stop(true);
  rmSync(root, { recursive: true, force: true });
  clearTimeout(watchdog);
}

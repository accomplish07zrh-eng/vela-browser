import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverRuntime } from "./runtime-client.mjs";
import { PlaywrightToolProxy } from "./playwright-proxy.mjs";
import { createHumanizer } from "./humanize.mjs";

const VERSION = process.env.ALIASMODE_APP_VERSION || "0.1.0-beta.32";
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const FIREFOX_FILTERED_TOOLS = new Set(["browser_close", "browser_install", "browser_pdf_save"]);

function firefoxTools(tools) {
  return tools.filter((tool) => !FIREFOX_FILTERED_TOOLS.has(tool.name) && !/pdf/i.test(tool.name));
}

function safeBrowserResult(value) {
  if (value?.engine !== "firefox" && value?.engine !== "webkit") return value;
  const {
    profileId, running, state, engine, capabilities, headless, alreadyOpen,
    ownedByConnection, attachedExisting, selected, closed, sync, deleted, detached,
  } = value;
  return {
    ...(profileId !== undefined ? { profileId } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(state !== undefined ? { state } : {}),
    engine,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(headless !== undefined ? { headless } : {}),
    ...(alreadyOpen !== undefined ? { alreadyOpen } : {}),
    ...(ownedByConnection !== undefined ? { ownedByConnection } : {}),
    ...(attachedExisting !== undefined ? { attachedExisting } : {}),
    ...(selected !== undefined ? { selected } : {}),
    ...(closed !== undefined ? { closed } : {}),
    ...(sync !== undefined ? { sync } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(detached !== undefined ? { detached } : {}),
  };
}
const PROFILE_ID = { type: "string", minLength: 1 };
const PROXY_REPLACEMENT_ROW = {
  type: "object",
  properties: {
    profileId: PROFILE_ID,
    username: { type: "string", minLength: 1, maxLength: 255 },
    expectedVersion: { type: "integer", minimum: 1 },
    proxy: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["http", "https", "socks5"] },
        host: { type: "string" },
        port: { type: "string" },
        user: { type: "string" },
        pass: { type: "string" },
      },
      required: ["type", "host", "port", "user", "pass"],
      additionalProperties: false,
    },
  },
  required: ["proxy"],
  oneOf: [
    { required: ["profileId"], not: { required: ["username"] } },
    { required: ["username"], not: { required: ["profileId"] } },
  ],
  additionalProperties: false,
};

function diagnose(message) {
  if (process.env.ALIASMODE_MCP_DIAGNOSTICS === "1") {
    process.stderr.write(`[aliasmode-mcp-host] ${message}\n`);
  }
}

function toolAnnotations(title, { readOnly = false, destructive = false, openWorld = false } = {}) {
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    openWorldHint: openWorld,
  };
}

const ALIAS_TOOLS = [
{
    name: "aliasmode_profiles_list",
    description: "List local Vela Browser profiles and their current browser state.",
    annotations: toolAnnotations("List Vela Browser profiles"),
    inputSchema: EMPTY_SCHEMA,
  },
{
    name: "aliasmode_profile_create",
    description: "Create a persistent Vela Browser profile, or an explicit temporary profile. Without engine, Windows creates a Vela Chromium profile, and macOS and Linux create a Vela Firefox profile.",
    annotations: toolAnnotations("Create a Vela Browser profile"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        group: { type: "string" },
        platform: { type: "string" },
        engine: { type: "string", enum: ["chromium", "firefox", "webkit"] },
        chromiumRuntime: {
          type: "string",
          enum: ["aliasmode", "cloakbrowser"],
          description: "Chromium profiles only. aliasmode (Vela Chromium 155) is the default where this computer can run it. CloakBrowser profiles on one computer can be linked to each other.",
        },
        screen: { type: "string" },
        proxy: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["http", "https", "socks5"] },
                host: { type: "string" },
                port: { type: "string" },
                user: { type: "string" },
                pass: { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        temporary: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
{
    name: "aliasmode_profile_delete",
    description: "Delete a closed Vela Browser profile.",
    annotations: toolAnnotations("Delete a Vela Browser profile", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
{
    name: "aliasmode_browser_open",
    description: "Open a Vela Browser browser and select it for Playwright actions.",
    annotations: toolAnnotations("Open a Vela Browser browser", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        headless: { type: "boolean", default: false },
        startupUrls: {
          type: "array",
          items: { type: "string", pattern: "^https?://" },
        },
        select: { type: "boolean", default: true },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
{
    name: "aliasmode_browser_select",
    description: "Select an open Vela Browser browser for subsequent Playwright actions.",
    annotations: toolAnnotations("Select a Vela Browser browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
{
    name: "aliasmode_browser_status",
    description: "Get the selected browser state, or the state of one profile.",
    annotations: toolAnnotations("Get Vela Browser browser status", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
{
    name: "aliasmode_browser_close",
    description: "Safely capture and close one Vela Browser browser.",
    annotations: toolAnnotations("Close a Vela Browser browser", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
{
    name: "browser_close",
    description: "Safely capture and close the selected Vela Browser browser.",
    annotations: toolAnnotations("Close the selected Vela Browser browser", { destructive: true }),
    inputSchema: EMPTY_SCHEMA,
  },
{
    name: "aliasmode_humanize",
    description: "Turn human-like input on or off for the browsers this connection drives, or change its pace. It is on by default: clicks, hovers, drags, typing and form filling move a pointer on a curved path, land inside the element, scroll with the wheel and type key by key, each profile with its own stable habits. Call without arguments to read the current setting.",
    annotations: toolAnnotations("Human-like input"),
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        speed: { type: "number", minimum: 0.4, maximum: 2.5, description: "1 is the profile's natural pace; 2 is twice as fast." },
        pasteOver: {
          type: ["integer", "null"],
          minimum: 0,
          description: "Text longer than this many characters goes in at once, like a paste, instead of key by key. 0 always types; null restores each profile's own threshold (28 to 51 characters). The system clipboard is never used.",
        },
      },
      additionalProperties: false,
    },
  }
];

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "Vela Browser operation failed";
  return message.replace(/wss?:\/\/\S+/gi, "CDP endpoint").slice(0, 500);
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: safeError(error) }],
  };
}

function profileInput(args) {
  const { temporary = false, ...input } = args;
  return { input, temporary };
}

export async function createVelaBrowserMcp(options = {}) {
  const playwright = options.playwright ?? new PlaywrightToolProxy(VERSION);
  await playwright.initialize();
  const discovered = options.discovered ?? await discoverRuntime(options.runtime);
  const runtime = discovered.client;
  const server = new Server(
    { name: "aliasmode", version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );
  let selectedProfileId;
  const humanize = { enabled: true, speed: 1 };
  const ownedProfileIds = new Set();
  /**
   * One live session per open browser. Each has its own Playwright connection, its own human-like
   * pointer and keyboard, and its own action lane: actions on one browser run one after another,
   * actions on different browsers run at the same time. None of them move the computer's real
   * pointer or need the window to be in front.
   */
  const sessions = new Map();
  const newProxy = options.createPlaywright ?? (() => options.playwright ?? new PlaywrightToolProxy(VERSION));
  let closing;

  const toolsFor = (session) => session && session.engine !== "chromium" ? session.tools : playwright.listTools();
  let advertisedTools = JSON.stringify(toolsFor(undefined));
  const publishTools = async () => {
    const current = JSON.stringify(toolsFor(sessions.get(selectedProfileId)));
    if (current === advertisedTools) return;
    advertisedTools = current;
    await server.sendToolListChanged().catch(() => {});
  };
  const withTarget = (tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema?.properties ?? {}),
        profileId: {
          type: "string",
          description: "Optional. The open Vela Browser profile to act on; defaults to the selected one. Calls for different profiles run in parallel, each browser with its own pointer and keyboard.",
        },
      },
    },
  });

  const detachSession = async (profileId) => {
    const session = sessions.get(profileId);
    if (!session) return;
    sessions.delete(profileId);
    await session.lane.catch(() => {});
    await session.proxy?.detach();
  };

  const attachSession = async (profileId, status) => {
    const engine = ["firefox", "webkit"].includes(status.engine) ? status.engine : "chromium";
    const existing = sessions.get(profileId);
    if (existing && existing.engine === engine && (engine !== "chromium" || (existing.ws === status.ws && existing.proxy.browser?.isConnected?.() !== false))) return existing;
    await detachSession(profileId);
    if (engine !== "chromium") {
      const result = await runtime.call(`${engine}.tools.list`, { profileId });
      const session = { engine, tools: firefoxTools(result.tools ?? []), lane: Promise.resolve() };
      sessions.set(profileId, session);
      return session;
    }
    if (!status.ws) throw new Error("open this Vela Browser profile before selecting it");
    const proxy = newProxy();
    // A shared test double serves one browser at a time.
    if (proxy === playwright) {
      for (const [id, other] of [...sessions]) if (other.proxy === playwright) await detachSession(id);
    }
    await proxy.attach(status.ws);
    const humanizer = proxy.context ? createHumanizer({
      context: proxy.context,
      profileId,
      callOfficial: (tool, toolArgs) => proxy.callTool(tool, toolArgs),
    }) : undefined;
    humanizer?.configure({ ...humanize, pasteOver: humanize.pasteOver ?? null });
    const session = { engine, ws: status.ws, proxy, humanizer, lane: Promise.resolve() };
    sessions.set(profileId, session);
    return session;
  };

  const selectBrowser = async (profileId, knownStatus) => {
    const status = knownStatus ?? await runtime.call("browser.status", { profileId });
    if (!status.running) throw new Error("open this Vela Browser profile before selecting it");
    selectedProfileId = undefined;
    const session = await attachSession(profileId, status);
    selectedProfileId = profileId;
    if (session.engine !== "chromium") return safeBrowserResult({ ...status, selected: true });
    return {
      profileId,
      selected: true,
      running: true,
      port: status.port,
      headless: status.headless,
    };
  };

  const sessionFor = async (profileId) => {
    const existing = sessions.get(profileId);
    if (existing && existing.proxy?.browser?.isConnected?.() !== false) return existing;
    const status = await runtime.call("browser.status", { profileId });
    if (!status.running) throw new Error("open this Vela Browser profile before acting on it");
    return attachSession(profileId, status);
  };

  const closeBrowser = async (profileId) => {
    const target = profileId || selectedProfileId;
    if (!target) throw new Error("select an open Vela Browser browser first");
    const selected = target === selectedProfileId;
    await detachSession(target);
    try {
      const result = await runtime.call("browser.close", { profileId: target });
      ownedProfileIds.delete(target);
      if (selected) selectedProfileId = undefined;
      return safeBrowserResult(result);
    } catch (error) {
      const status = await runtime.call("browser.status", { profileId: target }).catch(() => undefined);
      if (status?.running) await attachSession(target, status).catch(() => {});
      throw error;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ALIAS_TOOLS, ...toolsFor(sessions.get(selectedProfileId)).map(withTarget)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === "aliasmode_profiles_list") {
        return toolResult(await runtime.call("profiles.list"));
      }
      if (name === "aliasmode_profile_create") {
        return toolResult(await runtime.call("profiles.create", profileInput(args)));
      }
      if (name === "aliasmode_profile_delete") {
        return toolResult(await runtime.call("profiles.delete", { profileId: args.profileId }));
      }
      if (name === "aliasmode_browser_open") {
        const opened = await runtime.call("browser.open", {
          profileId: args.profileId,
          ...(args.headless !== undefined ? { headless: args.headless } : {}),
          ...(args.startupUrls ? { startupUrls: args.startupUrls } : {}),
        });
        if (opened.ownedByConnection) ownedProfileIds.add(args.profileId);
        const known = {
          running: true,
          ...((opened.engine === "firefox" || opened.engine === "webkit")
            ? { engine: opened.engine, capabilities: opened.capabilities, headless: opened.headless }
            : { ws: opened.ws, port: opened.port, headless: opened.headless }),
        };
        if (args.select !== false) {
          try {
            await selectBrowser(args.profileId, known);
          } catch (error) {
            if (opened.ownedByConnection) {
              const closed = await runtime.call("browser.close", { profileId: args.profileId })
                .then(() => true, () => false);
              if (closed) ownedProfileIds.delete(args.profileId);
            }
            throw error;
          }
        } else {
          // Ready for parallel actions addressed by profileId; a failure here retries on first use.
          await attachSession(args.profileId, known).catch(() => {});
        }
        return toolResult(safeBrowserResult({
          profileId: opened.profileId,
          ...((opened.engine === "firefox" || opened.engine === "webkit")
            ? { engine: opened.engine, capabilities: opened.capabilities }
            : { port: opened.port }),
          headless: opened.headless,
          alreadyOpen: opened.alreadyOpen,
          selected: args.select !== false,
        }));
      }
      if (name === "aliasmode_browser_select") {
        return toolResult(await selectBrowser(args.profileId));
      }
      if (name === "aliasmode_browser_status") {
        const profileId = args.profileId || selectedProfileId;
        if (!profileId) throw new Error("select an open Vela Browser browser first");
        const status = await runtime.call("browser.status", { profileId });
        const { ws: _ws, firefoxOwner: _firefoxOwner, ...safeStatus } = safeBrowserResult(status);
        return toolResult({ ...safeStatus, selected: profileId === selectedProfileId });
      }
      if (name === "aliasmode_humanize") {
        if (typeof args.enabled === "boolean") humanize.enabled = args.enabled;
        if (typeof args.speed === "number") humanize.speed = Math.min(2.5, Math.max(0.4, args.speed));
        if (args.pasteOver === null) delete humanize.pasteOver;
        else if (Number.isInteger(args.pasteOver) && args.pasteOver >= 0) humanize.pasteOver = args.pasteOver;
        for (const session of sessions.values()) session.humanizer?.configure({ ...humanize, pasteOver: humanize.pasteOver ?? null });
        return toolResult({ ...humanize });
      }
      if (name === "aliasmode_browser_close" || name === "browser_close") {
        return toolResult(await closeBrowser(args.profileId));
      }
      const { profileId: requested, ...toolArgs } = args;
      const target = typeof requested === "string" && requested ? requested : selectedProfileId;
      if (!target) throw new Error("select an open Vela Browser browser first");
      const session = await sessionFor(target);
      if (!toolsFor(session).some((tool) => tool.name === name)) {
        throw new Error(`unknown Vela Browser tool: ${name}`);
      }
      const act = () => session.engine !== "chromium"
        ? runtime.call(`${session.engine}.tools.call`, { profileId: target, name, arguments: toolArgs, humanize })
        : session.humanizer ? session.humanizer.call(name, toolArgs) : session.proxy.callTool(name, toolArgs);
      const run = session.lane.then(act);
      session.lane = run.then(() => undefined, () => undefined);
      return await run;
    } catch (error) {
      return errorResult(error);
    } finally {
      if (["aliasmode_browser_open", "aliasmode_browser_select", "aliasmode_browser_close", "browser_close"].includes(name)) await publishTools();
    }
  });

  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      diagnose("close started");
      for (const profileId of [...sessions.keys()]) await detachSession(profileId);
      await playwright.detach();
      diagnose("playwright detached");
      for (const profileId of [...ownedProfileIds]) {
        diagnose("owned browser close started");
        const closed = await runtime.call("browser.close", { profileId })
          .then(() => true, () => false);
        diagnose(`owned browser close finished closed=${closed}`);
        if (closed) ownedProfileIds.delete(profileId);
      }
      runtime.close();
      diagnose("runtime closed");
    })();
    return closing;
  };

  server.onclose = () => { void close(); };
  return { server, close };
}

export function sanitizeEnvironment(env = process.env) {
  const allowed = new Set([
    "APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
    "ALIASMODE_APP_VERSION", "ALIASMODE_DESKTOP_EXE", "ALIASMODE_MCP_DIAGNOSTICS",
    "ALIASMODE_RUNTIME_DESCRIPTOR",
    "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE",
    // Linux: the app that the host may start needs the desktop session, and the data folder.
    "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  ]);
  for (const key of Object.keys(env)) {
    if (!allowed.has(key.toUpperCase())) delete env[key];
  }
}

async function main() {
  sanitizeEnvironment();
  const desktopExecutable = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    // macOS: Contents/Resources -> Contents/MacOS; Linux: lib/<app> -> bin.
    ...(process.platform === "darwin" ? ["..", "MacOS", "aliasmode"]
      : process.platform === "linux" ? ["..", "..", "bin", "aliasmode"] : ["Vela Browser.exe"]),
  );
  const host = await createVelaBrowserMcp({ runtime: { desktopExecutable } });
  let shuttingDown = false;
  const shutdown = (event = "signal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    diagnose(`shutdown requested event=${event}`);
    void host.close().finally(() => {
      diagnose("shutdown complete");
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("end", () => shutdown("stdin-end"));
  process.stdin.once("close", () => shutdown("stdin-close"));
  await host.server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Vela Browser MCP could not start: ${safeError(error)}`);
    console.error("Run Vela Browser setup again or open the app once.");
    process.exit(1);
  });
}

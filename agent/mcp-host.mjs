import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { discoverRuntime } from "./runtime-client.mjs";
import { PlaywrightToolProxy } from "./playwright-proxy.mjs";
import { createHumanizer } from "./humanize.mjs";
import { isPluginTool, pluginTools } from "./plugins.mjs";
import { GUIDE_TOPICS, guideText } from "./guides.mjs";

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg?.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {}
  return "0.1.7";
}

const VERSION = process.env.ALIASMODE_APP_VERSION || packageVersion();
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const FIREFOX_FILTERED_TOOLS = new Set(["browser_close", "browser_install", "browser_pdf_save"]);

function firefoxTools(tools) {
  return tools.filter((tool) => !FIREFOX_FILTERED_TOOLS.has(tool.name) && (isPluginTool(tool.name) || !/pdf/i.test(tool.name)));
}

function safeBrowserResult(value) {
  if (value?.engine !== "firefox" && value?.engine !== "webkit") return value;
  const {
    profileId, running, state, engine, capabilities, headless, alreadyOpen,
    ownedByConnection, attachedExisting, selected, closed, sync, deleted, detached,
    proxyType, proxyNodeId, proxyNodeName, proxyCountry,
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
    ...(proxyType !== undefined ? { proxyType } : {}),
    ...(proxyNodeId !== undefined ? { proxyNodeId } : {}),
    ...(proxyNodeName !== undefined ? { proxyNodeName } : {}),
    ...(proxyCountry !== undefined ? { proxyCountry } : {}),
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
    process.stderr.write(`[vela-browser-mcp-host] ${message}\n`);
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
    name: "vela_profiles_list",
    description: "List local Vela Browser profiles and their current browser state.",
    annotations: toolAnnotations("List Vela Browser profiles"),
    inputSchema: EMPTY_SCHEMA,
  },
{
    name: "vela_profile_create",
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
          enum: ["vela", "cloakbrowser"],
          description: "Chromium profiles only. vela (Vela Chromium 155) is the default where this computer can run it. CloakBrowser profiles on one computer can be linked to each other.",
        },
        screen: { type: "string" },
        platformOs: { type: "string", enum: ["windows", "macos", "linux", ""] },
        customNo: { type: "string" },
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
    name: "vela_profile_delete",
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
    name: "vela_browser_open",
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
    name: "vela_browser_select",
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
    name: "vela_browser_status",
    description: "Get the selected browser state, or the state of one profile.",
    annotations: toolAnnotations("Get Vela Browser browser status", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID },
      additionalProperties: false,
    },
  },
{
    name: "vela_browser_close",
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
    name: "vela_proxy_pool_list",
    description: "List the proxies in Vela Browser's proxy pool, to choose one for vela_browser_set_proxy. Each has a nodeId, name, protocol, exit country (from its last check, or its name when never checked), status, and how many profiles use it of how many may. Credentials and subscription links are never returned.",
    annotations: toolAnnotations("List the proxy pool", { readOnly: true }),
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter exit country, e.g. US." },
        tag: { type: "string" },
        status: { type: "string", enum: ["working", "unstable", "failed", "unavailable", "unchecked"] },
        available: { type: "boolean", description: "Only proxies that are enabled and below their sharing limit." },
      },
      additionalProperties: false,
    },
  },
{
    name: "vela_proxy_pool_check",
    description: "Check pool proxies now (exit IP country, whether they work). This sends a few requests to an IP lookup service through each proxy. Returns the same entries as vela_proxy_pool_list.",
    annotations: toolAnnotations("Check pool proxies", { openWorld: true }),
    inputSchema: {
      type: "object",
      properties: { nodeIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 50 } },
      required: ["nodeIds"],
      additionalProperties: false,
    },
  },
{
    name: "vela_browser_set_proxy",
    description: "Give a profile a proxy from the pool (nodeId from vela_proxy_pool_list). Changing a profile's exit shows its sites an IP change, so the user may have to approve it in Vela Browser first (the call waits up to a minute). The new proxy is checked before anything changes. A closed profile uses it from its next start. An open browser saves its session, closes and reopens on the new exit with its tabs (timezone and WebRTC follow the new exit); this connection reattaches to it. Errors: approval_denied, approval_timeout, node_unavailable, pool_exhausted, rate_limited (one change per profile every 30 seconds), profile_busy, switch_check_failed, teardown_unconfirmed, reopen_failed, exit_is_direct.",
    annotations: toolAnnotations("Change a profile's proxy", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: { profileId: PROFILE_ID, nodeId: { type: "string", minLength: 1 } },
      required: ["profileId", "nodeId"],
      additionalProperties: false,
    },
  },
{
    name: "vela_humanize",
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
  },
  {
    name: "browser_batch",
    description: "Run several browser actions in one call, in order, each exactly as if called on its own (human-like input included). For example: type into two fields, then click the button. Stops at the first step that fails and says which one. Returns the last step's result, with its page snapshot, after a one-line summary of the steps before it. Prefer this to calling actions one at a time.",
    annotations: toolAnnotations("Several browser actions in one call", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        steps: {
          type: "array", minItems: 1, maxItems: 25,
          description: "Each step names a browser tool listed by this server and its arguments, as you would call it alone.",
          items: {
            type: "object",
            properties: { tool: { type: "string" }, arguments: { type: "object" } },
            required: ["tool"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "vela_guide",
    description: "Read Vela Browser's built-in guide before larger work: \"automation\" (driving profiles efficiently and what needs a person), \"scripts\" (writing JavaScript or Python scripts that run in many profiles) or \"plugins\" (writing plugins that add tools).",
    annotations: toolAnnotations("Read a Vela Browser guide", { readOnly: true }),
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: GUIDE_TOPICS },
        language: { type: "string", description: "Optional. zh-CN for Chinese; English otherwise." },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "vela_profile_update",
    description: "Rename a profile, move it to another group or set its tags. Its fingerprint, proxy and sign-ins cannot be changed this way.",
    annotations: toolAnnotations("Update a profile's name, group or tags"),
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string", minLength: 1 },
        name: { type: "string", maxLength: 120 },
        group: { type: "string", maxLength: 120 },
        tags: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 50 },
      },
      required: ["profileId"],
      additionalProperties: false,
    },
  },
  {
    name: "vela_scripts_list",
    description: "List the saved scripts: id, name, language, description and revision.",
    annotations: toolAnnotations("List Vela Browser scripts", { readOnly: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "vela_script_read",
    description: "Read one saved script, with its source.",
    annotations: toolAnnotations("Read a Vela Browser script", { readOnly: true }),
    inputSchema: { type: "object", properties: { scriptId: { type: "string", minLength: 1 } }, required: ["scriptId"], additionalProperties: false },
  },
  {
    name: "vela_script_save",
    description: "Save a new script, or a new version of one (pass scriptId). Read vela_guide topic \"scripts\" first. The user reads the code and approves it in Vela Browser unless they allowed AI code; the call waits for that answer and saves nothing when it is refused.",
    annotations: toolAnnotations("Save a Vela Browser script", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", minLength: 1, description: "Optional. The script to replace." },
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        language: { type: "string", enum: ["javascript", "python"] },
        source: { type: "string", minLength: 1 },
      },
      required: ["name", "language", "source"],
      additionalProperties: false,
    },
  },
  {
    name: "vela_script_run",
    description: "Run a saved script once in each listed profile, several browsers at a time. Closed profiles are opened for the run. Returns the run; follow it with vela_script_run_status. Saved sign-ins are never passed to a run an AI starts.",
    annotations: toolAnnotations("Run a Vela Browser script", { destructive: true, openWorld: true }),
    inputSchema: {
      type: "object",
      properties: {
        scriptId: { type: "string", minLength: 1 },
        profileIds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 500 },
        inputs: { type: "object", description: "Given to the script as inputs." },
        concurrency: { type: "integer", minimum: 1, maximum: 50, description: "Browsers at a time. Defaults to 10." },
      },
      required: ["scriptId", "profileIds"],
      additionalProperties: false,
    },
  },
  {
    name: "vela_script_run_status",
    description: "The current or last script run: each profile's status and the run's log from logOffset on. Pass the returned nextOffset to read only what is new.",
    annotations: toolAnnotations("Read a script run", { readOnly: true }),
    inputSchema: { type: "object", properties: { logOffset: { type: "integer", minimum: 0 } }, additionalProperties: false },
  },
  {
    name: "vela_script_stop",
    description: "Stop the current script run. Profiles that already finished keep their results.",
    annotations: toolAnnotations("Stop a script run", { destructive: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "vela_plugins_list",
    description: "List the enabled plugins and the tools they add.",
    annotations: toolAnnotations("List Vela Browser plugins", { readOnly: true }),
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "vela_plugin_save",
    description: "Save a plugin: its vela-plugin.json manifest and its module. Read vela_guide topic \"plugins\" first. The user reads the code and approves it in Vela Browser unless they allowed AI code; its tools appear the next time a browser is selected.",
    annotations: toolAnnotations("Save a Vela Browser plugin", { destructive: true }),
    inputSchema: {
      type: "object",
      properties: {
        pluginId: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$" },
        manifest: { type: "object", description: "The vela-plugin.json content; its id is set to pluginId." },
        module: { type: "string", minLength: 1, description: "The module's source (export default function setup(vela) { ... })." },
      },
      required: ["pluginId", "manifest", "module"],
      additionalProperties: false,
    },
  },
];

/** Tools whose result already carries the updated page snapshot. */
const SNAPSHOT_RETURNING = /^browser_(click|type|fill_form|select_option|press_key|hover|drag|navigate|navigate_back|handle_dialog|file_upload|wait_for|tabs)$/;
/** Tools a batch never runs: lifecycle belongs to Vela Browser, and a batch does not nest. */
const NOT_IN_BATCH = new Set(["browser_batch", "browser_close", "browser_install", "vela_browser_close"]);

const LEGACY_ALIAS_TOOLS = new Set([
  "aliasmode_profiles_list",
  "aliasmode_profile_create",
  "aliasmode_profile_delete",
  "aliasmode_browser_open",
  "aliasmode_browser_select",
  "aliasmode_browser_status",
  "aliasmode_browser_close",
  "aliasmode_proxy_pool_list",
  "aliasmode_proxy_pool_check",
  "aliasmode_browser_set_proxy",
  "aliasmode_humanize",
]);

/**
 * Earlier versions named the Vela Browser tools aliasmode_*. They are listed as vela_* now; a
 * script or saved prompt that still calls an old name reaches the same tool.
 */
export function canonicalToolName(name) {
  if (typeof name !== "string" || !LEGACY_ALIAS_TOOLS.has(name)) return name;
  return `vela_${name.slice("aliasmode_".length)}`;
}

/** Tells the AI where the extra calls go, so it does not take a snapshot it already has. */
function guideTool(tool) {
  if (tool.name === "browser_snapshot") {
    return { ...tool, description: `${tool.description} Actions such as browser_click and browser_type already return the updated snapshot: take one only to look before the first action.` };
  }
  if (SNAPSHOT_RETURNING.test(tool.name)) {
    return { ...tool, description: `${tool.description} Returns the updated page snapshot, so no separate browser_snapshot is needed. Several actions in a row go faster as one browser_batch call.` };
  }
  return tool;
}

/**
 * The name of the AI driving this connection, as its client introduces itself ("claude-code",
 * "codex-mcp-client"…), for the label on the pointer Vela Browser draws over the card.
 */
export function agentLabel(info) {
  const raw = String(info?.title || info?.name || "").trim();
  if (/claude[\s_-]*code/i.test(raw)) return "Claude Code";
  for (const [pattern, label] of [[/claude/i, "Claude"], [/codex/i, "Codex"], [/openclaw/i, "OpenClaw"], [/hermes/i, "Hermes"],
    [/cursor/i, "Cursor"], [/gemini/i, "Gemini"], [/windsurf/i, "Windsurf"], [/cline/i, "Cline"], [/goose/i, "Goose"]]) {
    if (pattern.test(raw)) return label;
  }
  const clean = raw.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
  return clean ? clean.replace(/(^|\s)\p{Ll}/gu, (letter) => letter.toUpperCase()) : "AI";
}

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
  // "vela" is how the tool names Vela Chromium 155; the profile store keeps its older name.
  if (input.chromiumRuntime === "vela") input.chromiumRuntime = "aliasmode";
  return { input, temporary };
}

export async function createVelaBrowserMcp(options = {}) {
  const playwright = options.playwright ?? new PlaywrightToolProxy(VERSION);
  await playwright.initialize();
  const discovered = options.discovered ?? await discoverRuntime(options.runtime);
  const runtime = discovered.client;
  const server = new Server(
    { name: "vela-browser", title: "Vela Browser", version: VERSION },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
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

  // Plugins are read by Vela Browser; an older app without them simply lists none.
  const enabledPlugins = () => runtime.call("plugins.list", {})
    .then(result => Array.isArray(result?.plugins) ? result.plugins : [], () => []);
  const toolsFor = (session) => session && session.engine !== "chromium"
    ? session.tools : [...playwright.listTools(), ...pluginTools(session?.proxy?.pluginSpecs ?? [])];
  /** Picks up plugins added, changed or switched off since this browser was attached. */
  const refreshPlugins = async (profileId, session) => {
    if (session.engine === "chromium") { if (session.proxy) session.proxy.pluginSpecs = await enabledPlugins(); return; }
    const result = await runtime.call(`${session.engine}.tools.list`, { profileId }).catch(() => undefined);
    if (Array.isArray(result?.tools)) session.tools = firefoxTools(result.tools);
  };
  let advertisedTools = JSON.stringify(toolsFor(undefined));
  const publishTools = async () => {
    const current = JSON.stringify(toolsFor(sessions.get(selectedProfileId)));
    if (current === advertisedTools) return;
    advertisedTools = current;
    await server.sendToolListChanged().catch(() => {});
  };
  const withTarget = (tool) => {
    const props = tool.inputSchema?.properties;
    const properties = props && typeof props === "object" && !Array.isArray(props) ? props : {};
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...properties,
          profileId: {
            type: "string",
            description: "Optional. The open Vela Browser profile to act on; defaults to the selected one. Calls for different profiles run in parallel, each browser with its own pointer and keyboard.",
          },
        },
      },
    };
  };

  /**
   * Sends the humanizer's pointer to Vela Browser, which draws it over this browser's card on the
   * workbench (never in the page). Moves go at most about 30 a second; presses always go. An app
   * that does not know the method is not asked again.
   */
  let pointerSupported = true;
  const agent = () => agentLabel(server.getClientVersion());
  const pointerReporter = (profileId) => {
    let last = 0, pending = null, timer = null;
    const send = (event) => {
      if (!pointerSupported) return;
      runtime.call("workbench.pointer", { profileId, x: Math.round(event.x * 10) / 10, y: Math.round(event.y * 10) / 10, phase: event.phase, agent: agent() })
        .catch((error) => { if (/unknown|unsupported|invalid_request/i.test(String(error?.message ?? error))) pointerSupported = false; });
    };
    return (event) => {
      if (!pointerSupported) return;
      if (event.phase !== "move") { clearTimeout(timer); timer = null; pending = null; last = Date.now(); send(event); return; }
      const wait = 33 - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); send(event); return; }
      pending = event;
      timer ??= setTimeout(() => { timer = null; if (pending) { last = Date.now(); send(pending); pending = null; } }, wait);
    };
  };

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
    await proxy.attach(status.ws, { profileId });
    proxy.pluginSpecs = await enabledPlugins();
    const humanizer = proxy.context ? createHumanizer({
      context: proxy.context,
      profileId,
      callOfficial: (tool, toolArgs) => proxy.callTool(tool, toolArgs),
      onPointer: pointerReporter(profileId),
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
    const previous = sessions.get(profileId);
    const session = await attachSession(profileId, status);
    // Selecting a browser again is how plugin changes reach a browser that stayed attached.
    if (session === previous) await refreshPlugins(profileId, session);
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

  // The built-in guides, also as resources for clients that read them.
  const guideUri = (language, topic) => `vela://guide/${language}/${topic}`;
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: ["en", "zh-CN"].flatMap((language) => GUIDE_TOPICS.map((topic) => ({
      uri: guideUri(language, topic), name: `Vela Browser guide: ${topic} (${language})`, mimeType: "text/markdown",
    }))),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const match = /^vela:\/\/guide\/(en|zh-CN)\/([a-z]+)$/.exec(request.params.uri);
    if (!match || !GUIDE_TOPICS.includes(match[2])) throw new Error("Unknown resource");
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: guideText(match[2], match[1]) }] };
  });

  // Vela Browser applies its per-AI group permissions and keeps its record under this client's name.
  let identified;
  const identify = () => identified ??= runtime.call("session.identify", { name: agent() }).catch(() => {});
  /** Page actions in Chromium reach the browser directly, so they are reported for the record. */
  const reportAction = (profileId, tool, args, result, error) => {
    const detail = tool === "browser_navigate" && typeof args?.url === "string" ? args.url
      : tool === "browser_batch" && Array.isArray(args?.steps) ? args.steps.map((step) => step?.tool).filter(Boolean).join(", ") : undefined;
    const failed = !!error || !!result?.isError;
    const reason = error ? safeError(error) : failed ? (result?.content ?? []).map((part) => part?.text).filter(Boolean).join(" ").slice(0, 300) : undefined;
    void runtime.call("session.audit", { profileId, tool, ok: !failed, ...(detail ? { detail } : {}), ...(reason ? { error: reason } : {}) }).catch(() => {});
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await identify();
    return { tools: [...ALIAS_TOOLS, ...toolsFor(sessions.get(selectedProfileId)).map(withTarget).map(guideTool)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = canonicalToolName(request.params.name);
    const args = request.params.arguments ?? {};
    await identify();
    try {
      if (name === "vela_profiles_list") {
        return toolResult(await runtime.call("profiles.list"));
      }
      if (name === "vela_guide") {
        if (!GUIDE_TOPICS.includes(args.topic)) throw new Error(`topic must be one of ${GUIDE_TOPICS.join(", ")}`);
        return { content: [{ type: "text", text: guideText(args.topic, args.language) }] };
      }
      if (name === "vela_profile_update") {
        const { profileId, ...set } = args;
        return toolResult(await runtime.call("profiles.update", { profileId, set }));
      }
      if (name === "vela_scripts_list") return toolResult(await runtime.call("scripts.list"));
      if (name === "vela_script_read") return toolResult(await runtime.call("scripts.get", { scriptId: args.scriptId }));
      if (name === "vela_script_save") return toolResult(await runtime.call("scripts.save", { ...args, client: agent() }));
      if (name === "vela_script_run") return toolResult(await runtime.call("scripts.run", args));
      if (name === "vela_script_stop") return toolResult(await runtime.call("scripts.stop"));
      if (name === "vela_script_run_status") {
        const { run } = await runtime.call("scripts.status");
        const log = run ? await runtime.call("scripts.log", { runId: run.id, offset: args.logOffset ?? 0 }) : null;
        return toolResult({ run, log });
      }
      if (name === "vela_plugins_list") {
        const { plugins } = await runtime.call("plugins.list");
        return toolResult({ plugins: (plugins ?? []).map((plugin) => ({ id: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, tools: (plugin.tools ?? []).map((tool) => tool.toolName) })) });
      }
      if (name === "vela_plugin_save") return toolResult(await runtime.call("plugins.save", { ...args, client: agent() }));
      if (name === "vela_proxy_pool_list") {
        return toolResult(await runtime.call("proxyPool.list", args));
      }
      if (name === "vela_proxy_pool_check") {
        return toolResult(await runtime.call("proxyPool.check", { nodeIds: args.nodeIds }));
      }
      if (name === "vela_browser_set_proxy") {
        const client = server.getClientVersion?.()?.name;
        const syncSessionAfterSwitch = async (reopened) => {
          if (!reopened && !sessions.has(args.profileId) && !ownedProfileIds.has(args.profileId) && selectedProfileId !== args.profileId) {
            return;
          }
          const wasSelected = selectedProfileId === args.profileId;
          await detachSession(args.profileId).catch(() => {});
          const status = await runtime.call("browser.status", { profileId: args.profileId }).catch(() => undefined);
          if (status?.running) {
            if (sessions.has(args.profileId) || reopened || wasSelected) {
              if (wasSelected) await selectBrowser(args.profileId, status).catch(() => {});
              else await attachSession(args.profileId, status).catch(() => {});
            }
          } else {
            ownedProfileIds.delete(args.profileId);
            if (wasSelected) selectedProfileId = undefined;
          }
          await publishTools().catch(() => {});
        };
        let result;
        try {
          result = await runtime.call("profiles.setProxy", {
            profileId: args.profileId, nodeId: args.nodeId, ...(client ? { client: String(client) } : {}),
          });
        } catch (error) {
          await syncSessionAfterSwitch(false);
          throw error;
        }
        // A reopened browser is a new browser: drop the old connection and attach to the new one.
        if (result?.applied === "reopened" && (sessions.has(args.profileId) || selectedProfileId === args.profileId)) {
          await syncSessionAfterSwitch(true);
        }
        return toolResult(result);
      }
      if (name === "vela_profile_create") {
        return toolResult(await runtime.call("profiles.create", profileInput(args)));
      }
      if (name === "vela_profile_delete") {
        return toolResult(await runtime.call("profiles.delete", { profileId: args.profileId }));
      }
      if (name === "vela_browser_open") {
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
          // Ready for parallel actions addressed by profileId; refresh plugins if already attached.
          const previous = sessions.get(args.profileId);
          const session = await attachSession(args.profileId, known).catch(() => undefined);
          if (session && session === previous) await refreshPlugins(args.profileId, session).catch(() => {});
          if (args.profileId === selectedProfileId) await publishTools().catch(() => {});
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
      if (name === "vela_browser_select") {
        return toolResult(await selectBrowser(args.profileId));
      }
      if (name === "vela_browser_status") {
        const profileId = args.profileId || selectedProfileId;
        if (!profileId) throw new Error("select an open Vela Browser browser first");
        const status = await runtime.call("browser.status", { profileId });
        const { ws: _ws, firefoxOwner: _firefoxOwner, ...safeStatus } = safeBrowserResult(status);
        return toolResult({ ...safeStatus, selected: profileId === selectedProfileId });
      }
      if (name === "vela_humanize") {
        if (typeof args.enabled === "boolean") humanize.enabled = args.enabled;
        if (typeof args.speed === "number") humanize.speed = Math.min(2.5, Math.max(0.4, args.speed));
        if (args.pasteOver === null) delete humanize.pasteOver;
        else if (Number.isInteger(args.pasteOver) && args.pasteOver >= 0) humanize.pasteOver = args.pasteOver;
        for (const session of sessions.values()) session.humanizer?.configure({ ...humanize, pasteOver: humanize.pasteOver ?? null });
        return toolResult({ ...humanize });
      }
      if (name === "vela_browser_close" || name === "browser_close") {
        return toolResult(await closeBrowser(args.profileId));
      }
      const { profileId: requested, ...toolArgs } = args;
      const target = typeof requested === "string" && requested ? requested : selectedProfileId;
      if (!target) throw new Error("select an open Vela Browser browser first");
      const session = await sessionFor(target);
      if (session.engine === "chromium" && (isPluginTool(name) || (name === "browser_batch" && Array.isArray(toolArgs.steps) && toolArgs.steps.some((step) => isPluginTool(step?.tool))))) {
        await refreshPlugins(target, session);
        if (target === selectedProfileId) await publishTools().catch(() => {});
      }
      const known = (tool) => toolsFor(session).some((entry) => entry.name === tool);
      const actOne = (tool, toolArguments) => session.engine !== "chromium"
        ? runtime.call(`${session.engine}.tools.call`, { profileId: target, name: tool, arguments: toolArguments, humanize: { ...humanize, agent: agent() } })
        : session.humanizer ? session.humanizer.call(tool, toolArguments) : session.proxy.callTool(tool, toolArguments);
      let act;
      if (name === "browser_batch") {
        const steps = Array.isArray(toolArgs.steps) ? toolArgs.steps : [];
        if (!steps.length || steps.length > 25) throw new Error("browser_batch takes 1 to 25 steps");
        for (const [index, step] of steps.entries()) {
          const tool = step?.tool;
          if (typeof tool !== "string" || NOT_IN_BATCH.has(canonicalToolName(tool)) || /^(vela|aliasmode)_/.test(tool) || !known(tool)) {
            throw new Error(`step ${index + 1}: ${typeof tool === "string" ? tool : "a step"} cannot run in a batch`);
          }
          if (step.arguments !== undefined && (typeof step.arguments !== "object" || step.arguments === null || Array.isArray(step.arguments))) {
            throw new Error(`step ${index + 1}: arguments must be an object`);
          }
        }
        // The whole batch holds this browser's lane, so no other call lands between its steps.
        act = async () => {
          const done = [];
          let result;
          for (const [index, step] of steps.entries()) {
            const { profileId: _ignored, ...stepArguments } = step.arguments ?? {};
            try { result = await actOne(step.tool, stepArguments); }
            catch (error) { result = errorResult(error); }
            if (result?.isError) {
              const reason = (result.content ?? []).map((part) => part.text).filter(Boolean).join(" ") || "failed";
              return { isError: true, content: [{ type: "text", text: `${done.length ? `Done: ${done.join(", ")}. ` : ""}Step ${index + 1} (${step.tool}) failed: ${reason}` }] };
            }
            done.push(`${index + 1}. ${step.tool}`);
          }
          const summary = steps.length > 1 ? [{ type: "text", text: `Ran ${steps.length} steps: ${done.join(", ")}. The last step's result follows.` }] : [];
          return { ...result, content: [...summary, ...(result?.content ?? [])] };
        };
      } else {
        if (!known(name)) throw new Error(`unknown Vela Browser tool: ${name}`);
        act = () => actOne(name, toolArgs);
      }
      const run = session.lane.then(act);
      session.lane = run.then(() => undefined, () => undefined);
      if (session.engine !== "chromium") return await run;
      try {
        const result = await run;
        reportAction(target, name, toolArgs, result);
        return result;
      } catch (error) {
        reportAction(target, name, toolArgs, undefined, error);
        throw error;
      }
    } catch (error) {
      return errorResult(error);
    } finally {
      if (["vela_browser_open", "vela_browser_select", "vela_browser_close", "browser_close"].includes(name)) await publishTools();
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

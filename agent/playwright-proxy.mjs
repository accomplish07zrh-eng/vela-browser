import process from "node:process";
import { pathToFileURL } from "node:url";
import { createConnection } from "@playwright/mcp";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserDevtools, DEVTOOLS_TOOLS, DEVTOOLS_TOOL_NAMES } from "./devtools.mjs";
import { PluginHost, isPluginTool } from "./plugins.mjs";

const CAPABILITIES = ["core", "core-tabs", "vision", "pdf", "testing", "tracing"];
const FILTERED_TOOLS = new Set(["browser_close", "browser_install"]);

/**
 * Playwright's browser_resize does not resize the window: it pins the page to a fixed viewport
 * (setViewportSize), so the page draws in a corner of a larger window, and innerWidth no longer
 * matches outerWidth, which a page can measure. Vela Browser answers it by resizing the window
 * itself; Vela Browser keeps the window within the profile's screen as it does for a person.
 */
const RESIZE_DESCRIPTION = "Resize the browser window itself so the page area is about width x height CSS pixels. The page is never given a fixed viewport, so it still fills a real window; the window is kept within the profile's screen. Returns the page area it got.";
export function withWindowResize(tools) {
  return tools.map((tool) => tool.name === "browser_resize" ? { ...tool, description: RESIZE_DESCRIPTION } : tool);
}

// The window's frame, toolbar and tab strip are far smaller than this; a page this much smaller than its window has a fixed viewport.
const MAX_FRAME_WIDTH = 120;
const MAX_FRAME_HEIGHT = 400;
// Emulation calls that give a page a fixed size, which no AI tool or code may send.
const PINNING_METHODS = new Set(["Emulation.setDeviceMetricsOverride", "Emulation.setVisibleSize"]);
const PINNING_REFUSAL = "Vela Browser does not give pages a fixed viewport: the page would draw in a corner of its window and look automated. Use browser_resize, which resizes the window itself.";

async function frameOf(cdp, windowId) {
  const current = (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
  const viewport = (await cdp.send("Page.getLayoutMetrics")).cssLayoutViewport;
  return { viewport, width: Math.max(0, current.width - viewport.clientWidth), height: Math.max(0, current.height - viewport.clientHeight) };
}
const pinned = (frame) => frame.width > MAX_FRAME_WIDTH || frame.height > MAX_FRAME_HEIGHT;

/** Whether `page` draws in only part of its window. A minimized window has no page area to compare. */
export async function viewportPinned(page, newSession) {
  const cdp = await newSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    return bounds.windowState !== "minimized" && pinned(await frameOf(cdp, windowId));
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Lets `page` fill its window again if anything gave it a fixed viewport, and returns whether it had one.
 * A minimized window has no page area to compare, so it is left as it is.
 */
export async function unpinViewport(context, page, newSession = (target) => context.newCDPSession(target)) {
  const cdp = await newSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    if (bounds.windowState === "minimized") return false;
    const before = await frameOf(cdp, windowId);
    if (!pinned(before)) return false;
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    const after = await frameOf(cdp, windowId);
    // A page its reader zoomed in looks small too; only a page that changed size had a fixed viewport.
    return after.viewport.clientWidth !== before.viewport.clientWidth || after.viewport.clientHeight !== before.viewport.clientHeight;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Resizes the window of `page` so its layout viewport is width x height. */
export async function resizeWindow(context, page, width, height, newSession = (target) => context.newCDPSession(target)) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 150 || width > 10_000 || height > 10_000) {
    throw new Error("give a width of 200 or more and a height of 150 or more");
  }
  await unpinViewport(context, page, newSession);
  const cdp = await newSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    if (bounds.windowState === "minimized" || bounds.windowState === "maximized" || bounds.windowState === "fullscreen") {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    }
    // The window's frame, toolbar and tab strip around the page stay as they are.
    const frame = await frameOf(cdp, windowId);
    if (pinned(frame)) throw new Error("this page is zoomed in, so its window size cannot be worked out; reset the page zoom and try again");
    const frameWidth = frame.width;
    const frameHeight = frame.height;
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: Math.round(width + frameWidth), height: Math.round(height + frameHeight) } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = (await cdp.send("Page.getLayoutMetrics")).cssLayoutViewport;
    return { width: after.clientWidth, height: after.clientHeight };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Whether a CDP call would pin a page, sent directly or wrapped for a target the session attached to. */
function pinningCall(method, params) {
  if (PINNING_METHODS.has(method)) return true;
  if (method !== "Target.sendMessageToTarget") return false;
  try { return PINNING_METHODS.has(JSON.parse(String(params?.message ?? "")).method); } catch { return false; }
}

/**
 * Stops code an AI runs from pinning any page of `context` to a fixed viewport: page.setViewportSize
 * resizes the window instead, and CDP sessions, page or browser level, refuse the calls that would pin it.
 * `originalSession` stays unguarded for Vela Browser's own CDP use. While `capture` runs, the CDP
 * sessions opened are kept, so a page pinned some way the guard did not see can be freed by closing
 * them: an emulated size belongs to the session that set it and ends with it.
 */
export function guardViewports(context, browser) {
  if (typeof context?.newCDPSession !== "function") return { originalSession: undefined, capture: async (work) => ({ result: await work(), sessions: new Set() }), dispose: () => {} };
  const originalSession = context.newCDPSession.bind(context);
  const originalBrowserSession = browser?.newBrowserCDPSession?.bind(browser);
  let opened;
  const guardSession = (session) => {
    const send = session.send.bind(session);
    session.send = async (method, params) => {
      if (pinningCall(method, params)) throw new Error(PINNING_REFUSAL);
      return await send(method, params);
    };
    opened?.add(session);
    return session;
  };
  const guardPage = (page) => {
    if (!page || page.__velaViewportGuard) return;
    Object.defineProperty(page, "__velaViewportGuard", { value: true });
    page.setViewportSize = async (size) => { await resizeWindow(context, page, Number(size?.width), Number(size?.height), originalSession); };
  };
  context.newCDPSession = async (target) => guardSession(await originalSession(target));
  if (originalBrowserSession) browser.newBrowserCDPSession = async () => guardSession(await originalBrowserSession());
  for (const page of context.pages()) guardPage(page);
  context.on("page", guardPage);
  return {
    originalSession,
    /** Runs `work`, then returns its result with the CDP sessions it opened. */
    async capture(work) {
      opened = new Set();
      const sessions = opened;
      try { return { result: await work(), sessions }; } finally { opened = undefined; }
    },
    dispose: () => context.off?.("page", guardPage),
  };
}

export async function connectOfficial(version, contextGetter, connectionFactory = createConnection) {
  const server = await connectionFactory({ capabilities: CAPABILITIES }, contextGetter);
  const client = new Client(
    { name: "aliasmode-playwright-proxy", version },
    { capabilities: { roots: { listChanged: false } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(process.cwd()).href, name: "workspace" }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();
    return {
      client,
      server,
      tools: withWindowResize(listed.tools.filter((tool) => !FILTERED_TOOLS.has(tool.name))),
    };
  } catch (error) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
}

export function nonClosingContext(context) {
  return new Proxy(context, {
    get(target, property) {
      if (property === "close") return async () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class PlaywrightToolProxy {
  constructor(version, connectOverCDP = (...args) => chromium.connectOverCDP(...args)) {
    this.version = version;
    this.connectOverCDP = connectOverCDP;
    this.tools = [];
  }

  async initialize() {
    if (this.tools.length) return;
    const official = await connectOfficial(this.version, async () => {
      throw new Error("select an open Vela Browser browser first");
    });
    this.tools = [...official.tools, ...DEVTOOLS_TOOLS];
    await official.client.close().catch(() => {});
    await official.server.close().catch(() => {});
  }

  /** profileId names the environment for its plugins; the enabled plugins are set by the host. */
  async attach(endpoint, { profileId } = {}) {
    await this.detach();
    const browser = await this.connectOverCDP(endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error("Vela Browser browser did not expose a persistent context");
    }

    try {
      this.viewportGuard = guardViewports(context, browser);
      this.devtools = new BrowserDevtools(context);
      this.plugins = new PluginHost({ context, engine: "chromium", profileId, devtools: this.devtools, log: (msg) => process.stderr.write(`${msg}\n`) });
      const official = await connectOfficial(
        this.version,
        async () => nonClosingContext(context),
      );
      this.browser = browser;
      this.context = context;
      this.officialServer = official.server;
      this.officialClient = official.client;
      this.tools = [...official.tools, ...DEVTOOLS_TOOLS];
    } catch (error) {
      this.viewportGuard?.dispose(); this.viewportGuard = undefined;
      this.devtools?.dispose(); this.devtools = undefined;
      this.plugins?.dispose(); this.plugins = undefined;
      await browser.close().catch(() => {});
      throw error;
    }
  }

  listTools() {
    return this.tools;
  }

  async callTool(name, args) {
    if (!this.officialClient) throw new Error("select an open Vela Browser browser first");
    const program = name === "browser_devtools_program";
    if (DEVTOOLS_TOOL_NAMES.has(name) && !program) return await this.devtools.call(name, args ?? {});
    if (isPluginTool(name)) return await this.plugins.call(this.pluginSpecs ?? [], name, args ?? {});
    if (FILTERED_TOOLS.has(name)) throw new Error("Vela Browser owns browser lifecycle operations");
    const session = this.viewportGuard?.originalSession;
    if (name === "browser_resize" && this.context) {
      const pages = this.context.pages();
      const page = pages[pages.length - 1];
      if (!page) throw new Error("this browser has no open tab");
      const size = await resizeWindow(this.context, page, Number(args?.width), Number(args?.height), session);
      return { content: [{ type: "text", text: `Resized the browser window; the page area is now ${size.width}x${size.height}.` }] };
    }
    const call = () => program ? this.devtools.call(name, args ?? {}) : this.officialClient.callTool({ name, arguments: args ?? {} });
    if ((!program && name !== "browser_run_code") || !this.context || !session) return await call();
    // Code can still pin a page some way the guard does not see; whatever it pinned is undone here.
    const { result, sessions } = await this.viewportGuard.capture(call);
    const pages = this.context.pages();
    const stuck = [];
    for (const page of pages) if (await viewportPinned(page, session).catch(() => false)) stuck.push(page);
    if (!stuck.length) return result;
    for (const opened of sessions) await opened.detach().catch(() => {});
    for (const page of stuck) await unpinViewport(this.context, page, session).catch(() => false);
    let freed = 0;
    for (const page of stuck) if (!(await viewportPinned(page, session).catch(() => true))) freed += 1;
    process.stderr.write(`[viewport-guard] ${name} pinned ${stuck.length} page(s); ${freed} now fill their window\n`);
    const note = freed === stuck.length
      ? "Vela Browser undid a fixed viewport this code gave the page: pages always fill their real window. Use browser_resize to change the window size."
      : "This code gave the page a fixed viewport that Vela Browser could not undo, so the page draws in part of its window. Close and reopen this browser, and use browser_resize to change the window size.";
    return { ...result, content: [...(result?.content ?? []), { type: "text", text: note }] };
  }

  async detach() {
    const client = this.officialClient;
    const server = this.officialServer;
    const browser = this.browser;
    this.officialClient = undefined;
    this.officialServer = undefined;
    this.browser = undefined;
    this.context = undefined;
    this.viewportGuard?.dispose(); this.viewportGuard = undefined;
    this.devtools?.dispose(); this.devtools = undefined;
    this.plugins?.dispose(); this.plugins = undefined;
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    // A CDP-connected Browser closes only its Playwright transport. The guarded
    // context close above prevents the official MCP server from closing Vela Browser.
    await browser?.close().catch(() => {});
  }
}

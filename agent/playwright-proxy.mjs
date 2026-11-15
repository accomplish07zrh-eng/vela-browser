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

/** Resizes the window of `page` so its layout viewport is width x height. */
export async function resizeWindow(context, page, width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 150 || width > 10_000 || height > 10_000) {
    throw new Error("give a width of 200 or more and a height of 150 or more");
  }
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    if (bounds.windowState === "minimized" || bounds.windowState === "maximized" || bounds.windowState === "fullscreen") {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    }
    const current = (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;
    const viewport = (await cdp.send("Page.getLayoutMetrics")).cssLayoutViewport;
    // The window's frame, toolbar and tab strip around the page stay as they are.
    const frameWidth = Math.max(0, current.width - viewport.clientWidth);
    const frameHeight = Math.max(0, current.height - viewport.clientHeight);
    // A page far smaller than its window was given a fixed viewport earlier in this session; resizing the window would not help.
    if (frameWidth > 120 || frameHeight > 400) throw new Error("this page was given a fixed viewport earlier, so it draws in a corner of its window; close and reopen the browser to undo it");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: Math.round(width + frameWidth), height: Math.round(height + frameHeight) } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = (await cdp.send("Page.getLayoutMetrics")).cssLayoutViewport;
    return { width: after.clientWidth, height: after.clientHeight };
  } finally {
    await cdp.detach().catch(() => {});
  }
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
    if (DEVTOOLS_TOOL_NAMES.has(name)) return await this.devtools.call(name, args ?? {});
    if (isPluginTool(name)) return await this.plugins.call(this.pluginSpecs ?? [], name, args ?? {});
    if (FILTERED_TOOLS.has(name)) throw new Error("Vela Browser owns browser lifecycle operations");
    // Code that pins the viewport would do what browser_resize no longer does.
    if (name === "browser_run_code" && /setViewportSize|setDeviceMetricsOverride/.test(String(args?.code ?? ""))) {
      throw new Error("Vela Browser does not give pages a fixed viewport: the page would draw in a corner of its window and look automated. Use browser_resize, which resizes the window itself.");
    }
    if (name === "browser_resize" && this.context) {
      const pages = this.context.pages();
      const page = pages[pages.length - 1];
      if (!page) throw new Error("this browser has no open tab");
      const size = await resizeWindow(this.context, page, Number(args?.width), Number(args?.height));
      return { content: [{ type: "text", text: `Resized the browser window; the page area is now ${size.width}x${size.height}.` }] };
    }
    return await this.officialClient.callTool({ name, arguments: args ?? {} });
  }

  async detach() {
    const client = this.officialClient;
    const server = this.officialServer;
    const browser = this.browser;
    this.officialClient = undefined;
    this.officialServer = undefined;
    this.browser = undefined;
    this.context = undefined;
    this.devtools?.dispose(); this.devtools = undefined;
    this.plugins?.dispose(); this.plugins = undefined;
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    // A CDP-connected Browser closes only its Playwright transport. The guarded
    // context close above prevents the official MCP server from closing Vela Browser.
    await browser?.close().catch(() => {});
  }
}

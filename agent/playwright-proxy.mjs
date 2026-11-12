import process from "node:process";
import { pathToFileURL } from "node:url";
import { createConnection } from "@playwright/mcp";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserDevtools, DEVTOOLS_TOOLS, DEVTOOLS_TOOL_NAMES } from "./devtools.mjs";

const CAPABILITIES = ["core", "core-tabs", "vision", "pdf", "testing", "tracing"];
const FILTERED_TOOLS = new Set(["browser_close", "browser_install"]);

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
      tools: listed.tools.filter((tool) => !FILTERED_TOOLS.has(tool.name)),
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

  async attach(endpoint) {
    await this.detach();
    const browser = await this.connectOverCDP(endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      throw new Error("Vela Browser browser did not expose a persistent context");
    }

    try {
      this.devtools = new BrowserDevtools(context);
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
    if (FILTERED_TOOLS.has(name)) throw new Error("Vela Browser owns browser lifecycle operations");
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
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    // A CDP-connected Browser closes only its Playwright transport. The guarded
    // context close above prevents the official MCP server from closing Vela Browser.
    await browser?.close().catch(() => {});
  }
}

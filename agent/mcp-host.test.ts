import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createVelaBrowserMcp, sanitizeEnvironment } from "./mcp-host.mjs";
import { DEVTOOLS_TOOLS } from "./devtools.mjs";

class FakeRuntime {
  events: string[] = [];
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  closed = false;

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.events.push(`${method}:${params.profileId ?? ""}`);
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "profiles.list") return { profiles: [] };
    if (method === "profiles.create") return { id: "created-profile", temporary: params.temporary === true };
    if (method === "profiles.update") return { profileId: params.profileId, updated: true };
    if (method === "profiles.replaceProxies") {
      return {
        ok: true,
        dryRun: params.dryRun !== false,
        counts: { received: 1, matched: 1, ready: 1, updated: 0, unchanged: 0, missing: 0, skipped: 0 },
        results: [{ index: 0, status: "ready", profileId: "profile-1", currentVersion: 4 }],
        missingUsernames: [],
      };
    }
    if (method === "browser.open") {
      const ownedByConnection = params.profileId !== "existing";
      return {
        profileId: params.profileId,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        port: 9333,
        headless: params.headless === true,
        alreadyOpen: !ownedByConnection,
        ownedByConnection,
      };
    }
    if (method === "browser.status") {
      return {
        profileId: params.profileId,
        running: true,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        port: 9333,
        headless: false,
      };
    }
    if (method === "browser.close") return { profileId: params.profileId, closed: true, deleted: false };
    throw new Error(`unexpected runtime method ${method}`);
  }

  close() {
    this.closed = true;
    this.events.push("runtime.close:");
  }
}

class FirefoxRuntime extends FakeRuntime {
  constructor(readonly engine = "firefox") { super(); }
  override async call(method: string, params: Record<string, unknown> = {}) {
    this.events.push(`${method}:${params.profileId ?? ""}`);
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "browser.open") return {
      profileId: params.profileId, engine: this.engine, capabilities: [`${this.engine}-native`, "mcp"],
      headless: false, alreadyOpen: false, ownedByConnection: true,
    };
    if (method === "browser.status") return {
      profileId: params.profileId, running: true, engine: this.engine, capabilities: [`${this.engine}-native`, "mcp"], headless: false,
    };
    if (method === `${this.engine}.tools.list`) return {
      tools: [
        ...DEVTOOLS_TOOLS,
        { name: "browser_snapshot", description: "native snapshot", inputSchema: { type: "object" } },
        { name: "browser_pdf_save", description: "PDF", inputSchema: { type: "object" } },
        { name: "browser_install", description: "install", inputSchema: { type: "object" } },
        { name: "browser_close", description: "close", inputSchema: { type: "object" } },
      ],
    };
    if (method === `${this.engine}.tools.call`) return { content: [{ type: "text", text: "native snapshot" }] };
    if (method === "browser.close") return { profileId: params.profileId, closed: true, deleted: false, engine: this.engine };
    return await super.call(method, params);
  }
}

class FakePlaywright {
  events: string[] = [];
  tools = [{
    name: "browser_snapshot",
    description: "snapshot",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      title: "Browser snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  }];
  failNextAttach = false;

  async initialize() {
    this.events.push("initialize");
  }

  async attach(endpoint: string) {
    this.events.push(`attach:${endpoint}`);
    if (this.failNextAttach) {
      this.failNextAttach = false;
      throw new Error("attach failed");
    }
  }

  listTools() {
    return this.tools;
  }

  async callTool(name: string) {
    this.events.push(`call:${name}`);
    return { content: [{ type: "text", text: "snapshot" }] };
  }

  async detach() {
    this.events.push("detach");
  }
}

test("MCP host preserves Windows environment keys case-insensitively", () => {
  const env: Record<string, string> = {
    APPDATA: "appdata",
    Path: "system path",
    TEMP: "temp",
    ALIASMODE_LIVE_PROXY_PASS: "secret",
    GITHUB_TOKEN: "secret",
  };
  sanitizeEnvironment(env);
  expect(env).toEqual({ APPDATA: "appdata", Path: "system path", TEMP: "temp" });
});

test("MCP lifecycle tools include directory annotations", async () => {
  const host = await createVelaBrowserMcp({
    discovered: { client: new FakeRuntime() },
    playwright: new FakePlaywright(),
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = (await client.listTools()).tools;
  const annotated = tools.filter((tool) => tool.name.startsWith("aliasmode_") || tool.name === "browser_close");
  for (const tool of annotated) {
    expect(typeof tool.annotations?.title).toBe("string");
    expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
    expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
  }
  expect(tools.find((tool) => tool.name === "vela_profiles_list")?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  });
  expect(tools.find((tool) => tool.name === "vela_profile_delete")?.annotations?.destructiveHint).toBe(true);
  expect(tools.some((tool) => tool.name === "aliasmode_profiles_replace_proxies")).toBe(false);
  expect(tools.some((tool) => tool.name === "aliasmode_profile_update")).toBe(false);
  expect(tools.find((tool) => tool.name === "vela_browser_open")?.annotations).toMatchObject({
    destructiveHint: true,
    openWorldHint: true,
  });
  expect(tools.find((tool) => tool.name === "vela_browser_select")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "vela_browser_status")?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(tools.find((tool) => tool.name === "vela_browser_close")?.annotations?.destructiveHint).toBe(true);
  expect(tools.find((tool) => tool.name === "browser_close")?.annotations?.destructiveHint).toBe(true);

  await client.close();
  await host.close();
});

test("MCP profile creation forwards the selected browser engine", async () => {
  const runtime = new FakeRuntime();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const tool = (await client.listTools()).tools.find((tool) => tool.name === "vela_profile_create");
  expect(tool?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: {
      engine: { type: "string", enum: ["chromium", "firefox", "webkit"] },
      chromiumRuntime: { type: "string", enum: ["vela", "cloakbrowser"] },
    },
  });
  expect(tool?.description).toContain("Without engine, Windows creates a Vela Chromium profile, and macOS and Linux create a Vela Firefox profile.");
  const created = await client.callTool({ name: "vela_profile_create", arguments: { name: "Firefox", engine: "firefox" } });
  expect(created.isError).not.toBe(true);
  expect(runtime.calls.at(-1)).toEqual({
    method: "profiles.create",
    params: { input: { name: "Firefox", engine: "firefox" }, temporary: false },
  });
  // An explicit CloakBrowser request reaches the runtime unchanged.
  await client.callTool({ name: "vela_profile_create", arguments: { name: "Cloak", chromiumRuntime: "cloakbrowser" } });
  expect(runtime.calls.at(-1)).toEqual({
    method: "profiles.create",
    params: { input: { name: "Cloak", chromiumRuntime: "cloakbrowser" }, temporary: false },
  });

  // Vela Chromium 155 is "vela" to the AI and keeps its stored name in the runtime.
  await client.callTool({ name: "vela_profile_create", arguments: { name: "Vela", chromiumRuntime: "vela" } });
  expect(runtime.calls.at(-1)).toEqual({
    method: "profiles.create",
    params: { input: { name: "Vela", chromiumRuntime: "aliasmode" }, temporary: false },
  });

  await client.close();
  await host.close();
});

test("MCP host is named Vela Browser and still answers the pre-0.1.7 aliasmode_* tool names", async () => {
  const runtime = new FakeRuntime();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  expect(client.getServerVersion()).toMatchObject({ name: "vela-browser", title: "Vela Browser" });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain("vela_profiles_list");
  expect(names.some((name) => name.startsWith("aliasmode_"))).toBe(false);
  const legacy = await client.callTool({ name: "aliasmode_profiles_list", arguments: {} });
  expect(legacy.isError).not.toBe(true);
  expect(runtime.calls.at(-1)?.method).toBe("profiles.list");

  await client.close();
  await host.close();
});

test("MCP host exposes Playwright tools before selection and uses safe close", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createVelaBrowserMcp({
    discovered: { client: runtime },
    playwright,
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    host.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const initial = await client.listTools();
  expect(initial.tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);
  expect(initial.tools.some((tool) => tool.name === "browser_install")).toBe(false);
  expect(initial.tools.some((tool) => tool.name === "browser_close")).toBe(true);

  const opened = await client.callTool({
    name: "vela_browser_open",
    arguments: { profileId: "profile1", headless: true },
  });
  expect(opened.isError).not.toBe(true);
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);

  const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} });
  expect(snapshot.content).toEqual([{ type: "text", text: "snapshot" }]);

  const closed = await client.callTool({ name: "browser_close", arguments: {} });
  expect(closed.isError).not.toBe(true);
  expect(playwright.events).toEqual([
    "initialize",
    "attach:ws://127.0.0.1:9333/devtools/browser/test",
    "call:browser_snapshot",
    "detach",
  ]);
  expect(runtime.events).toContain("browser.close:profile1");
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);

  await client.close();
  await host.close();
  expect(runtime.closed).toBe(true);
});

test("MCP host relays Firefox native tools without transport, PDF, or lifecycle tools", async () => {
  const runtime = new FirefoxRuntime();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const opened = await client.callTool({ name: "vela_browser_open", arguments: { profileId: "firefox" } });
  expect(opened.isError).not.toBe(true);
  expect(JSON.stringify(opened)).toContain('"engine":"firefox"');
  expect(JSON.stringify(opened)).not.toContain('"port"');
  expect(JSON.stringify(opened)).not.toContain('"ws"');
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("browser_snapshot");
  expect(tools).not.toContain("browser_pdf_save");
  expect(tools).not.toContain("browser_install");
  const snapshot = await client.callTool({ name: "browser_snapshot", arguments: {} });
  expect(snapshot.content).toEqual([{ type: "text", text: "native snapshot" }]);
  expect(runtime.calls.some((call) => call.method === "firefox.tools.call" && call.params.name === "browser_snapshot")).toBe(true);

  await client.close();
  await host.close();
});

test.each(["firefox", "webkit"])("%s developer tools retain profile targeting and default write access", async (engine) => {
  const runtime = new FirefoxRuntime(engine);
  const proxy = new FakePlaywright();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: proxy });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  let updates = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { updates++; });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    expect((await client.callTool({ name: "vela_browser_open", arguments: { profileId: "a" } })).isError).not.toBe(true);
    expect(updates).toBe(1);
    const names = new Set((await client.listTools()).tools.map(tool => tool.name));
    for (const tool of DEVTOOLS_TOOLS) expect(names.has(tool.name)).toBe(true);
    const input = { profileId: "b", expression: "() => { document.title = 'edited'; return document.title; }" };
    expect((await client.callTool({ name: "browser_devtools_evaluate", arguments: input })).isError).not.toBe(true);
    expect(runtime.calls.at(-1)).toMatchObject({ method: `${engine}.tools.call`, params: {
      profileId: "b", name: "browser_devtools_evaluate", arguments: { expression: input.expression }, humanize: { enabled: true },
    } });
    expect(proxy.events.some(event => event.startsWith("attach:"))).toBe(false);
  } finally { await client.close(); await host.close(); }
});

test("MCP shutdown closes owned browsers but preserves pre-existing browsers", async () => {
  const runtime = new FakeRuntime();
  const host = await createVelaBrowserMcp({
    discovered: { client: runtime },
    playwright: new FakePlaywright(),
  });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "vela_browser_open",
    arguments: { profileId: "existing" },
  });
  await client.callTool({
    name: "vela_browser_open",
    arguments: { profileId: "owned" },
  });
  await client.close();
  await host.close();

  expect(runtime.events).toContain("browser.close:owned");
  expect(runtime.events).not.toContain("browser.close:existing");
  expect(runtime.events.at(-1)).toBe("runtime.close:");
});

test("a failed profile switch clears the stale selection", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "vela_browser_open",
    arguments: { profileId: "profile1" },
  });
  playwright.failNextAttach = true;
  const switched = await client.callTool({
    name: "vela_browser_select",
    arguments: { profileId: "profile2" },
  });
  expect(switched.isError).toBe(true);
  expect((await client.listTools()).tools.some((tool) => tool.name === "browser_snapshot")).toBe(true);
  const status = await client.callTool({ name: "vela_browser_status", arguments: {} });
  expect(status.isError).toBe(true);

  await client.close();
  await host.close();
});

test("browser actions require one selected profile", async () => {
  const runtime = new FakeRuntime();
  const playwright = new FakePlaywright();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({ name: "browser_snapshot", arguments: {} });
  expect(result.isError).toBe(true);
  expect((result.content as Array<{ text?: string }>)[0]).toMatchObject({ text: "select an open Vela Browser browser first" });

  await client.close();
  await host.close();
});

class ActingPlaywright extends FakePlaywright {
  calls: Array<{ name: string; args: unknown }> = [];
  override tools = ["browser_snapshot", "browser_click", "browser_type"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) as any;
  override async callTool(name: string, args?: any) {
    this.calls.push({ name, args });
    if (args?.fail) return { isError: true, content: [{ type: "text", text: "element not found" }] };
    return { content: [{ type: "text", text: `${name} done, snapshot after ${this.calls.length}` }] };
  }
}

test("browser_batch runs several actions in one call and returns only the last snapshot", async () => {
  const runtime = new FakeRuntime();
  const playwright = new ActingPlaywright();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "vela_browser_select", arguments: { profileId: "profile-1" } });
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "browser_batch")).toBeTruthy();
    // The descriptions steer the AI away from snapshots it already has.
    expect(tools.find((tool) => tool.name === "browser_click")!.description).toContain("no separate browser_snapshot is needed");
    expect(tools.find((tool) => tool.name === "browser_snapshot")!.description).toContain("only to look before the first action");

    const result: any = await client.callTool({ name: "browser_batch", arguments: { steps: [
      { tool: "browser_type", arguments: { ref: "e1", text: "a@b.c", profileId: "ignored" } },
      { tool: "browser_type", arguments: { ref: "e2", text: "secret" } },
      { tool: "browser_click", arguments: { ref: "e3" } },
    ] } });
    expect(result.isError).toBeUndefined();
    expect(playwright.calls.map((call) => call.name)).toEqual(["browser_type", "browser_type", "browser_click"]);
    expect(playwright.calls[0]!.args).toEqual({ ref: "e1", text: "a@b.c" });
    expect(result.content.map((part: any) => part.text)).toEqual([
      "Ran 3 steps: 1. browser_type, 2. browser_type, 3. browser_click. The last step's result follows.",
      "browser_click done, snapshot after 3",
    ]);

    // A failing step stops the batch and names itself.
    playwright.calls = [];
    const failed: any = await client.callTool({ name: "browser_batch", arguments: { steps: [
      { tool: "browser_click", arguments: { ref: "e1" } }, { tool: "browser_click", arguments: { fail: true } }, { tool: "browser_click" },
    ] } });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe("Done: 1. browser_click. Step 2 (browser_click) failed: element not found");
    expect(playwright.calls).toHaveLength(2);

    // Lifecycle, nested batches and unknown tools never run, and nothing runs before the check.
    playwright.calls = [];
    for (const tool of ["browser_close", "browser_batch", "vela_browser_close", "browser_nope"]) {
      const refused: any = await client.callTool({ name: "browser_batch", arguments: { steps: [{ tool: "browser_click" }, { tool }] } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain("step 2");
    }
    expect(playwright.calls).toEqual([]);
  } finally {
    await client.close();
    await host.close();
  }
});

test("MCP cannot call retired account tools or forward them to the runtime", async () => {
    const runtime = new FakeRuntime();
    const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
      for (const name of ["aliasmode_profile_update", "aliasmode_profiles_replace_proxies"]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
      }
      // Only the client's name reaches the runtime; the retired tools never do.
      expect(runtime.calls).toEqual([{ method: "session.identify", params: { name: "Test" } }]);
    } finally { await client.close(); await host.close(); }
  });

test.each(["chromium", "firefox", "webkit"])("MCP profile and %s status results retain safe proxy fields", async (engine) => {
  const profiles: Record<string, Record<string, unknown>> = {
    pool: { proxyNodeId: "node-1", proxyNodeName: "Tokyo", proxyCountry: "JP" },
    deleted: { proxyNodeId: "deleted-node" },
    direct: { proxyType: "socks5" },
    none: {},
  };
  class ProxyStatusRuntime extends FakeRuntime {
    override async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
      if (method === "profiles.list") return { profiles: Object.entries(profiles).map(([id, fields]) => ({ id, ...fields })) };
      if (method === "browser.status") return {
        profileId: params.profileId, running: true, ...profiles[String(params.profileId)],
        ...(engine === "chromium" ? { ws: "ws://127.0.0.1:9333/private", port: 9333 }
          : { engine, capabilities: ["mcp"], firefoxOwner: { token: "private-token" } }),
      };
      return super.call(method, params);
    }
  }
  const host = await createVelaBrowserMcp({ discovered: { client: new ProxyStatusRuntime() }, playwright: new FakePlaywright() });
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.callTool({ name: "vela_profiles_list", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toEqual({ profiles: Object.entries(profiles).map(([id, fields]) => ({ id, ...fields })) });
    for (const [id, fields] of Object.entries(profiles)) {
      const status = await client.callTool({ name: "vela_browser_status", arguments: { profileId: id } });
      expect(status.isError).not.toBe(true);
      expect(Object.fromEntries(Object.entries(status.structuredContent as object).filter(([key]) => key.startsWith("proxy")))).toEqual(fields);
      expect(JSON.stringify(status)).not.toContain("private-token");
      expect(JSON.stringify(status)).not.toContain("ws://");
    }
  } finally { await client.close(); await host.close(); }
});

class PoolRuntime extends FakeRuntime {
  ws = "ws://127.0.0.1:9333/devtools/browser/before";
  override async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (method === "proxyPool.list") { this.calls.push({ method, params: structuredClone(params) }); return { nodes: [{ nodeId: "n1", name: "LA", protocol: "anytls", country: "US", status: "working", assignedProfiles: 0, maxProfiles: null }] }; }
    if (method === "proxyPool.check") { this.calls.push({ method, params: structuredClone(params) }); return { nodes: [] }; }
    if (method === "profiles.setProxy") {
      this.calls.push({ method, params: structuredClone(params) });
      // The browser reopened: it now answers on a new endpoint.
      this.ws = "ws://127.0.0.1:9334/devtools/browser/after";
      return { profileId: params.profileId, applied: "reopened", previous: "http · A", next: "anytls · LA", sharedWith: [] };
    }
    if (method === "browser.status") {
      this.calls.push({ method, params: structuredClone(params) });
      return { profileId: params.profileId, running: true, ws: this.ws, port: 9333, headless: false };
    }
    return super.call(method, params);
  }
}

test("MCP proxy tools: list and check the pool, change a profile's proxy as this client, and follow a reopened browser", async () => {
  const runtime = new PoolRuntime();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
  const client = new Client({ name: "Claude Code", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  expect(tools.vela_proxy_pool_list?.annotations).toMatchObject({ readOnlyHint: true });
  expect(tools.vela_proxy_pool_check?.annotations).toMatchObject({ openWorldHint: true });
  expect(tools.vela_browser_set_proxy?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
  expect(tools.vela_browser_set_proxy?.inputSchema).toMatchObject({ required: ["profileId", "nodeId"], additionalProperties: false });

  await client.callTool({ name: "vela_proxy_pool_list", arguments: { country: "US", available: true } });
  expect(runtime.calls.at(-1)).toEqual({ method: "proxyPool.list", params: { country: "US", available: true } });
  await client.callTool({ name: "vela_proxy_pool_check", arguments: { nodeIds: ["n1"] } });
  expect(runtime.calls.at(-1)).toEqual({ method: "proxyPool.check", params: { nodeIds: ["n1"] } });

  // Select the browser, then change its proxy: the call carries this client's name, and the
  // connection reattaches to the reopened browser.
  await client.callTool({ name: "vela_browser_select", arguments: { profileId: "p1" } });
  const changed = await client.callTool({ name: "vela_browser_set_proxy", arguments: { profileId: "p1", nodeId: "n1" } });
  expect(changed.isError).not.toBe(true);
  expect(runtime.calls.find((call) => call.method === "profiles.setProxy")).toEqual({ method: "profiles.setProxy", params: { profileId: "p1", nodeId: "n1", client: "Claude Code" } });
  const statusCalls = runtime.calls.filter((call) => call.method === "browser.status");
  expect(statusCalls.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(changed.content)).toContain("reopened");

  await client.close();
  await host.close();
});

test("MCP lists the guide, profile update, script and plugin tools and serves built-in guides", async () => {
  class CodeRuntime extends FakeRuntime {
    override async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
      if (["scripts.list", "scripts.get", "scripts.save", "scripts.run", "scripts.stop", "plugins.save"].includes(method)) {
        this.calls.push({ method, params: structuredClone(params) });
        if (method === "scripts.list") return { scripts: [{ id: "s1", name: "Title", language: "javascript" }] };
        if (method === "scripts.get") return { script: { id: "s1", name: "Title", language: "javascript", source: "export default async () => {};" } };
        if (method === "scripts.save") return { script: { id: "s1", name: params.name, language: params.language, revision: 1 } };
        if (method === "scripts.run") return { run: { id: "r1", status: "running" } };
        if (method === "scripts.stop") return { run: { id: "r1", status: "stopping" } };
        if (method === "plugins.save") return { pluginId: params.pluginId, tools: ["plugin_demo_read"] };
      }
      if (method === "scripts.status") {
        this.calls.push({ method, params: structuredClone(params) });
        return { run: { id: "r1", status: "finished" } };
      }
      if (method === "scripts.log") {
        this.calls.push({ method, params: structuredClone(params) });
        return { text: "ok\n", nextOffset: 3 };
      }
      if (method === "plugins.list") {
        this.calls.push({ method, params: structuredClone(params) });
        return { plugins: [{ id: "demo", name: "Demo", version: "1.0.0", description: "Desc", tools: [{ toolName: "plugin_demo_read" }] }] };
      }
      return super.call(method, params);
    }
  }

  const runtime = new CodeRuntime();
  const host = await createVelaBrowserMcp({ discovered: { client: runtime }, playwright: new FakePlaywright() });
  const client = new Client({ name: "Claude Code", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = Object.fromEntries((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    for (const expected of [
      "vela_guide", "vela_profile_update", "vela_scripts_list", "vela_script_read",
      "vela_script_save", "vela_script_run", "vela_script_run_status", "vela_script_stop",
      "vela_plugins_list", "vela_plugin_save",
    ]) {
      expect(tools[expected]).toBeDefined();
    }
    expect(tools.vela_guide?.annotations?.readOnlyHint).toBe(true);

    const enGuide: any = await client.callTool({ name: "vela_guide", arguments: { topic: "scripts" } });
    expect(enGuide.isError).not.toBe(true);
    expect(enGuide.content[0].text).toContain("# Writing scripts");

    const zhGuide: any = await client.callTool({ name: "vela_guide", arguments: { topic: "plugins", language: "zh-CN" } });
    expect(zhGuide.isError).not.toBe(true);
    expect(zhGuide.content[0].text).toContain("# 插件编写指南");

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("vela://guide/en/scripts");
    expect(resources.resources.map((r) => r.uri)).toContain("vela://guide/zh-CN/plugins");
    const readRes = await client.readResource({ uri: "vela://guide/zh-CN/automation" });
    expect((readRes.contents[0] as { text?: string }).text).toContain("# 用 AI 操控 Vela Browser");

    await client.callTool({ name: "vela_profile_update", arguments: { profileId: "p1", name: "Renamed", group: "G", tags: ["a"] } });
    expect(runtime.calls.at(-1)).toEqual({ method: "profiles.update", params: { profileId: "p1", set: { name: "Renamed", group: "G", tags: ["a"] } } });

    await client.callTool({ name: "vela_script_save", arguments: { name: "Demo", language: "javascript", source: "export default async () => {};" } });
    expect(runtime.calls.at(-1)).toEqual({
      method: "scripts.save",
      params: { name: "Demo", language: "javascript", source: "export default async () => {};", client: "Claude Code" },
    });

    const runStatus: any = await client.callTool({ name: "vela_script_run_status", arguments: { logOffset: 0 } });
    expect(runStatus.structuredContent).toEqual({ run: { id: "r1", status: "finished" }, log: { text: "ok\n", nextOffset: 3 } });

    const pluginsListed: any = await client.callTool({ name: "vela_plugins_list", arguments: {} });
    expect(pluginsListed.structuredContent).toEqual({
      plugins: [{ id: "demo", name: "Demo", version: "1.0.0", description: "Desc", tools: ["plugin_demo_read"] }],
    });

    const readScript: any = await client.callTool({ name: "vela_script_read", arguments: { scriptId: "s1" } });
    expect(readScript.structuredContent?.script?.id).toBe("s1");

    const startedRun: any = await client.callTool({ name: "vela_script_run", arguments: { scriptId: "s1", profileIds: ["p1"] } });
    expect(startedRun.structuredContent?.run?.id).toBe("r1");

    const stoppedRun: any = await client.callTool({ name: "vela_script_stop", arguments: {} });
    expect(stoppedRun.structuredContent?.run?.status).toBe("stopping");

    const savedPlugin: any = await client.callTool({
      name: "vela_plugin_save",
      arguments: {
        pluginId: "demo",
        manifest: { name: "Demo", version: "1.0.0", tools: [{ name: "read", description: "Read" }] },
        module: "export default () => ({ read: () => 1 });",
      },
    });
    expect(savedPlugin.structuredContent?.pluginId).toBe("demo");
    expect(tools.vela_script_save?.inputSchema?.properties?.scriptId).toMatchObject({ minLength: 1 });
    expect((tools.vela_script_run?.inputSchema?.properties?.concurrency as any)?.description).toContain("Defaults to 10.");
  } finally {
    await client.close();
    await host.close();
  }
});

test("plugin tools with pdf in their name work on Firefox, and Chromium refreshes plugins on open(select: false) and call", async () => {
  const ffRuntime = new FirefoxRuntime("firefox");
  const origCall = ffRuntime.call.bind(ffRuntime);
  ffRuntime.call = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "firefox.tools.list") {
      return {
        tools: [
          { name: "browser_snapshot", description: "Snap", inputSchema: { type: "object", properties: {} } },
          { name: "browser_pdf_save", description: "PDF", inputSchema: { type: "object", properties: {} } },
          { name: "plugin_pdf_reader_read", description: "Reads PDF metadata", inputSchema: { type: "object", properties: {} } },
        ],
      };
    }
    if (method === "firefox.tools.call") {
      ffRuntime.calls.push({ method, params: structuredClone(params) });
      return { content: [{ type: "text", text: `called:${params.name}` }] };
    }
    return origCall(method, params);
  };
  const ffHost = await createVelaBrowserMcp({ discovered: { client: ffRuntime }, playwright: new FakePlaywright() });
  const ffClient = new Client({ name: "Test", version: "1" }, { capabilities: {} });
  const [s1, c1] = InMemoryTransport.createLinkedPair();
  await Promise.all([ffHost.server.connect(s1), ffClient.connect(c1)]);
  try {
    await ffClient.callTool({ name: "vela_browser_open", arguments: { profileId: "ff-1" } });
    const ffTools = (await ffClient.listTools()).tools.map((t) => t.name);
    expect(ffTools).not.toContain("browser_pdf_save");
    expect(ffTools).toContain("plugin_pdf_reader_read");
    const callRes: any = await ffClient.callTool({ name: "plugin_pdf_reader_read", arguments: {} });
    expect(callRes.isError).not.toBe(true);
    expect(callRes.content[0].text).toBe("called:plugin_pdf_reader_read");
  } finally {
    await ffClient.close();
    await ffHost.close();
  }

  let enabled = false;
  class DynamicPluginRuntime extends FakeRuntime {
    override async call(method: string, params: Record<string, unknown> = {}) {
      if (method === "plugins.list") {
        this.calls.push({ method, params: structuredClone(params) });
        return {
          plugins: enabled
            ? [{ id: "dyn", name: "Dyn", version: "1.0.0", revision: "1", module: resolve(tmpdir(), "plugins", "dyn", "index.mjs"), tools: [{ name: "ping", toolName: "plugin_dyn_ping", title: "Ping", description: "Ping", readOnly: true, inputSchema: { type: "object", properties: {} } }] }]
            : [],
        };
      }
      return super.call(method, params);
    }
  }
  const crRuntime = new DynamicPluginRuntime();
  const crPlaywright = new FakePlaywright();
  const crHost = await createVelaBrowserMcp({ discovered: { client: crRuntime }, playwright: crPlaywright });
  const crClient = new Client({ name: "Test", version: "1" }, { capabilities: {} });
  const [s2, c2] = InMemoryTransport.createLinkedPair();
  await Promise.all([crHost.server.connect(s2), crClient.connect(c2)]);
  try {
    await crClient.callTool({ name: "vela_browser_open", arguments: { profileId: "cr-1", select: true } });
    expect((await crClient.listTools()).tools.map((t) => t.name)).not.toContain("plugin_dyn_ping");

    // Enable plugin then reopen with select: false -> tools refresh for already-attached profile.
    enabled = true;
    await crClient.callTool({ name: "vela_browser_open", arguments: { profileId: "cr-1", select: false } });
    expect((await crClient.listTools()).tools.map((t) => t.name)).toContain("plugin_dyn_ping");

    // Disable plugin while still selected -> next plugin tool call refreshes and refuses disabled plugin tool.
    enabled = false;
    const disabledCall: any = await crClient.callTool({ name: "plugin_dyn_ping", arguments: {} });
    expect(disabledCall.isError).toBe(true);
  } finally {
    await crClient.close();
    await crHost.close();
  }
});

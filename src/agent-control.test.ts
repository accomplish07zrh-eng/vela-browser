import { expect, test } from "bun:test";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PROTOCOL,
  AgentControlHub,
  AgentControlSession,
  parseAgentControlRequest,
  validAgentAuthorization,
} from "./agent-control.ts";
import type { ProxyReplacementsRequest } from "../contracts/cloud-v1.ts";
import { CloudApiError } from "./cloud-client.ts";
import { buildNewProfile } from "./create.ts";
import { encodePortableProfile } from "./portable-profile.ts";

function wire(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id, method, params });
}

function harness(options: {
  active?: boolean;
  firefox?: boolean;
  webkit?: boolean;
  stopResult?: boolean;
  temporary?: boolean;
} = {}) {
  const events: string[] = [];
  let launch = options.active
    ? {
        profileId: "profile1",
        pid: 11,
        debugPort: 9333,
        ws: "ws://127.0.0.1:9333/devtools/browser/test",
        startedAt: 1,
        headless: true,
        ...(options.firefox ? {
          engine: "firefox" as const,
          firefoxOwner: { endpoint: "http://127.0.0.1:9444/", token: "private-token", pid: 12, browserPid: 13, generation: "generation" },
        } : {}),
        ...(options.webkit ? {
          engine: "webkit" as const,
          ws: "webkit://127.0.0.1:9444/private-generation",
          webkitOwner: { endpoint: "http://127.0.0.1:9444/", token: "private-token", pid: 12, browserPid: 13, generation: "private-generation" },
        } : {}),
      }
    : null;
  let profileExists = true;
  let temporary = options.temporary ?? false;
  let cacheClearing = false;
  const store = {
    getLaunch: (id: string) => id === "profile1" ? launch : null,
    listAgentTemporary: () => temporary ? ["profile1"] : [],
    clearAgentTemporary: (id: string) => {
      events.push(`clear-temp:${id}`);
      temporary = false;
    },
    getProfile: (id: string) => id === "profile1" && profileExists ? { id } : null,
    deleteProfile: (id: string) => {
      events.push(`delete:${id}`);
      profileExists = false;
      temporary = false;
      return true;
    },
  };
  const launcher = {
    certifiedActive: async () => options.active ?? false,
    start: async (_id: string, _urls: string[], open: { headless?: boolean }) => {
      events.push(`start:${open.headless ?? false}`);
      launch = {
        profileId: "profile1",
        pid: 12,
        debugPort: 9444,
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        startedAt: 2,
        headless: open.headless,
      } as typeof launch;
      return {
        ws: "ws://127.0.0.1:9444/devtools/browser/new",
        port: 9444,
      };
    },
    stop: async (id: string) => {
      events.push(`stop:${id}`);
      if (options.stopResult === false) return false;
      launch = null;
      cacheClearing = true;
      return true;
    },
    // The post-stop cache delete blocks deletion until it ends.
    cacheCleanupSettled: async (id: string) => { events.push(`cache-settled:${id}`); cacheClearing = false; },
    profileDeletionBlocked: () => cacheClearing,
    removeUserDataDir: (id: string) => events.push(`remove-data:${id}`),
  };
  const admission = {
    run: async (_operation: unknown, fn: () => Promise<unknown>) => await fn(),
  };
  const deps = {
    launcher: launcher as any,
    store: store as any,
    admission: admission as any,
  };
  return {
    deps,
    events,
    session: new AgentControlSession(deps),
    temporary: () => temporary,
    profileExists: () => profileExists,
    restoreTemporaryProfile: () => {
      temporary = true;
      profileExists = true;
    },
  };
}

test("agent protocol validates message shape, size, and authorization", () => {
  expect(parseAgentControlRequest(wire("profiles.list", {}, 7))).toEqual({
    protocol: AGENT_CONTROL_PROTOCOL,
    id: 7,
    method: "profiles.list",
    params: {},
  });
  expect(() => parseAgentControlRequest("{}"))
    .toThrow("invalid protocol shape");
  expect(() => parseAgentControlRequest(new Uint8Array(AGENT_CONTROL_MAX_MESSAGE_BYTES + 1)))
    .toThrow("request size is invalid");

  const nonce = "a".repeat(64);
  expect(validAgentAuthorization(`Bearer ${nonce}`, nonce)).toBe(true);
  expect(validAgentAuthorization(null, nonce)).toBe(false);
  expect(validAgentAuthorization(`Bearer ${"b".repeat(64)}`, nonce)).toBe(false);
});

test("retired account methods cannot access a Cloud connection", async () => {
  const h = harness();
  const session = new AgentControlSession({
    ...h.deps,
    ...({ cloudConnection: new Proxy({}, { get() { throw new Error("retired Cloud connection accessed"); } }) } as any),
  });
  for (const method of ["mcp.connectors.create", "mcp.connectors.list", "mcp.connectors.revoke", "profiles.replaceProxies"]) {
    expect(await session.enqueue(wire(method))).toMatchObject({ ok: false, error: { code: "accounts_removed" } });
  }
  expect(h.events).toEqual([]);
});

test("hub cleanup runs at startup but not for each connection", async () => {
  const h = harness({ temporary: true });
  const hub = new AgentControlHub(h.deps);
  await hub.cleanupTemporaryProfiles();
  expect(h.profileExists()).toBe(false);

  h.restoreTemporaryProfile();
  hub.connect();
  await Bun.sleep(0);
  expect(h.profileExists()).toBe(true);
  expect(h.temporary()).toBe(true);
});

test("disconnect closes a browser opened by this connection", async () => {
  const h = harness();
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.ok).toBe(true);
  expect(response.result).toMatchObject({
    profileId: "profile1",
    headless: true,
    alreadyOpen: false,
    ownedByConnection: true,
  });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:true", "stop:profile1"]);
});

test("an explicit detach transfers a CLI-opened browser out of connection cleanup", async () => {
  const h = harness();
  await h.session.enqueue(wire("browser.open", { profileId: "profile1" }));
  const detached = await h.session.enqueue(wire("browser.detach", { profileId: "profile1" }));
  expect(detached).toMatchObject({ ok: true, result: { detached: true } });

  await h.session.disconnect();
  expect(h.events).toEqual(["start:false"]);
});

test("disconnect detaches from an existing browser without closing it", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: true,
  }));

  expect(response.result).toMatchObject({
    alreadyOpen: true,
    ownedByConnection: false,
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("disconnect leaves a running browser alone when its status check missed and start reattached", async () => {
  const h = harness();
  const deps = {
    ...h.deps,
    launcher: {
      ...h.deps.launcher,
      start: async () => {
        h.events.push("reattach");
        return { ws: "ws://127.0.0.1:9333/devtools/browser/test", port: 9333, reattached: true };
      },
    },
  };
  const session = new AgentControlSession(deps as any);
  const response = await session.enqueue(wire("browser.open", { profileId: "profile1" }));

  expect(response.result).toMatchObject({ alreadyOpen: true, ownedByConnection: false });
  await session.disconnect();
  expect(h.events).toEqual(["reattach"]);
});

test("Firefox browser status and open keep the owner transport private", async () => {
  const h = harness({ active: true, firefox: true });
  const session = new AgentControlSession({
    ...h.deps,
    firefoxCall: async () => ({ tools: [] }),
  });

  const status = await session.enqueue(wire("browser.status", { profileId: "profile1" }));
  const opened = await session.enqueue(wire("browser.open", { profileId: "profile1" }));

  for (const result of [status, opened]) {
    const text = JSON.stringify(result);
    expect(text).toContain('"engine":"firefox"');
    expect(text).not.toContain("firefoxOwner");
    expect(text).not.toContain("private-token");
    expect(text).not.toContain("firefox://");
    expect(text).not.toContain("debugPort");
    expect(text).not.toContain('"port"');
    expect(text).not.toContain('"ws"');
  }
  await session.disconnect();
});

test("Firefox MCP relays official schemas and calls through the authenticated manager", async () => {
  const h = harness({ active: true, firefox: true });
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const session = new AgentControlSession({
    ...h.deps,
    firefoxCall: async (_owner, operation, payload) => {
      calls.push({ operation, payload });
      return operation === "mcp-list" ? [{ name: "browser_snapshot" }] : { content: [] };
    },
  });

  expect(await session.enqueue(wire("firefox.tools.list", { profileId: "profile1" }))).toMatchObject({
    ok: true, result: { tools: [{ name: "browser_snapshot" }] },
  });
  expect(await session.enqueue(wire("firefox.tools.call", {
    profileId: "profile1", name: "browser_snapshot", arguments: { compact: true },
  }))).toMatchObject({ ok: true, result: { content: [] } });
  expect(calls).toEqual([
    { operation: "mcp-list", payload: {} },
    { operation: "mcp-call", payload: { name: "browser_snapshot", arguments: { compact: true } } },
  ]);
});

test("the AI's pointer is passed to the workbench, and malformed pointers are refused", async () => {
  const h = harness({ active: true });
  const seen: unknown[] = [];
  const session = new AgentControlSession({ ...h.deps, pointer: (profileId, pointer) => { seen.push({ profileId, ...pointer }); } });
  expect(await session.enqueue(wire("workbench.pointer", { profileId: "profile1", x: 12.5, y: 40, phase: "down" }))).toMatchObject({ ok: true });
  expect(seen).toEqual([{ profileId: "profile1", x: 12.5, y: 40, phase: "down" }]);
  for (const bad of [{ x: "1", y: 2, phase: "move" }, { x: 1, y: 2, phase: "wave" }, { x: Infinity, y: 2, phase: "move" }, { x: 1, y: 99999, phase: "up" }]) {
    expect(await session.enqueue(wire("workbench.pointer", { profileId: "profile1", ...bad }))).toMatchObject({ ok: false });
  }
  expect(seen).toHaveLength(1);
  await session.disconnect();
});

test("enabled plugins are listed for Chromium and travel with Firefox and WebKit tool calls", async () => {
  const plugins = [{ id: "fixture", name: "Fixture", version: "1", description: "", module: "/plugins/fixture/index.mjs", revision: "r",
    tools: [{ name: "read", toolName: "plugin_fixture_read", title: "Fixture: read", description: "Reads.", inputSchema: { type: "object" }, readOnly: true, timeoutSeconds: 120 }] }];
  const firefox = harness({ active: true, firefox: true });
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const session = new AgentControlSession({ ...firefox.deps, plugins: () => plugins,
    firefoxCall: async (_owner, operation, payload) => { calls.push({ operation, payload }); return operation === "mcp-list" ? [] : { content: [] }; } });
  expect(await session.enqueue(wire("plugins.list", {}))).toMatchObject({ ok: true, result: { plugins } });
  await session.enqueue(wire("firefox.tools.list", { profileId: "profile1" }));
  await session.enqueue(wire("firefox.tools.call", { profileId: "profile1", name: "plugin_fixture_read", arguments: { a: 1 } }));
  expect(calls).toEqual([
    { operation: "mcp-list", payload: { plugins } },
    { operation: "mcp-call", payload: { name: "plugin_fixture_read", arguments: { a: 1 }, plugins } },
  ]);
  const webkit = harness({ active: true, webkit: true });
  const webkitCalls: any[] = [];
  const webkitSession = new AgentControlSession({ ...webkit.deps, plugins: () => plugins,
    webkitCall: async (_owner, operation, payload) => { webkitCalls.push({ operation, payload }); return []; } });
  await webkitSession.enqueue(wire("webkit.tools.list", { profileId: "profile1" }));
  expect(webkitCalls[0]).toEqual({ operation: "mcp-list", payload: { plugins } });
  // A plugins folder that cannot be read lists nothing instead of failing every tool call.
  const broken = new AgentControlSession({ ...firefox.deps, plugins: () => { throw new Error("unreadable"); } });
  expect(await broken.enqueue(wire("plugins.list", {}))).toMatchObject({ ok: true, result: { plugins: [] } });
  await session.disconnect(); await webkitSession.disconnect(); await broken.disconnect();
});

test("WebKit agent status and open disclose capabilities and keep the native owner private", async () => {
  const h = harness({ active: true, webkit: true });
  for (const method of ["browser.status", "browser.open"]) {
    const result = await h.session.enqueue(wire(method, { profileId: "profile1" }));
    expect(result).toMatchObject({ ok: true, result: { engine: "webkit", experimental: true } });
    expect((result.result as any).capabilities).toContain("workbench");
    expect((result.result as any).capabilities).toContain("mcp");
    const text = JSON.stringify(result);
    for (const privateValue of ["private-token", "private-generation", "webkitOwner", "webkit://", "9444", '"ws"', '"port"', "debugPort"]) {
      expect(text).not.toContain(privateValue);
    }
  }
  const unsupported = await h.session.enqueue(wire("firefox.tools.list", { profileId: "profile1" }));
  expect(unsupported.ok).toBe(false);
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("WebKit developer calls use the current profile's certified owner and retain writes", async () => {
  const h = harness({ active: true, webkit: true });
  const calls: any[] = [];
  const session = new AgentControlSession({ ...h.deps,
    webkitCall: async (owner, operation, payload) => { calls.push({ owner, operation, payload }); return { content: [] }; },
  });
  const params = { profileId: "profile1", name: "browser_devtools_storage_edit", arguments: { storage: "localStorage", action: "set", entries: { key: "value" } } };
  expect(await session.enqueue(wire("webkit.tools.call", params))).toMatchObject({ ok: true });
  expect(calls[0]).toMatchObject({ owner: { generation: "private-generation", token: "private-token" }, operation: "mcp-call", payload: {
    name: params.name, arguments: params.arguments,
  } });
  // The owner generation must be rechecked for every call, including after an external close.
  h.deps.launcher.certifiedActive = async () => false;
  expect(await session.enqueue(wire("webkit.tools.call", params))).toMatchObject({ ok: false, error: { code: "browser_not_running" } });
  expect(calls).toHaveLength(1);
  await session.disconnect();
});

test("an existing browser rejects a launch-mode change", async () => {
  const h = harness({ active: true });
  const response = await h.session.enqueue(wire("browser.open", {
    profileId: "profile1",
    headless: false,
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "mode_conflict" },
  });
  await h.session.disconnect();
  expect(h.events).toEqual([]);
});

test("temporary profiles delete only after confirmed browser close", async () => {
  const h = harness({ active: true, temporary: true });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({ ok: true, result: { closed: true, deleted: true } });
  expect(h.events).toEqual([
    "stop:profile1",
    "cache-settled:profile1",
    "remove-data:profile1",
    "delete:profile1",
  ]);
  expect(h.temporary()).toBe(false);
  expect(h.profileExists()).toBe(false);
});

test("an unconfirmed close retains the temporary profile marker", async () => {
  const h = harness({ active: true, temporary: true, stopResult: false });
  const response = await h.session.enqueue(wire("browser.close", {
    profileId: "profile1",
  }));

  expect(response).toMatchObject({
    ok: false,
    error: { code: "close_unconfirmed" },
  });
  expect(h.events).toEqual(["stop:profile1"]);
  expect(h.temporary()).toBe(true);
  expect(h.profileExists()).toBe(true);
});

function cloudEditHarness() {
  const h = harness();
  const profile = buildNewProfile({ name: "Cloud account", group: "accounts" }, () => false);
  profile.id = "profile1";
  profile.password = "old-password";
  profile.email = "keep@example.test";
  profile.cookies = [{ name: "auth_token", value: "session-secret", domain: ".x.com", path: "/" }];
  const payload = encodePortableProfile(profile);
  const authoritative = {
    profile: { id: profile.id, name: profile.name, group: profile.group, platform: "x.com", tags: [], version: 7, permission: "edit", activeOpens: [] as unknown[] },
    payload,
  };
  const updates: any[] = [];
  const client = {
    getProfile: async () => authoritative,
    updateProfile: async (profileId: string, request: unknown) => { updates.push({ profileId, request }); },
  };
  const deps = {
    ...h.deps,
    launcher: { ...h.deps.launcher, reconcileOrphans: async () => {} },
    cloudBrowser: { listRoster: async () => ({ profiles: [authoritative.profile] }) } as any,
    cloudConnection: { deviceId: () => "device-id", client } as any,
  };
  return { ...h, deps, client, authoritative, updates, session: new AgentControlSession(deps) };
}

test("Local profiles.create sets the timezone from the proxy", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ status: "success", timezone: "Europe/Paris" })) as unknown as typeof fetch;
  try {
    const h = harness();
    const saved: any[] = [];
    const session = new AgentControlSession({ ...h.deps, store: { ...h.deps.store, upsertProfile: (profile: any) => saved.push(profile) } as any });
    const response = await session.enqueue(wire("profiles.create", {
      input: { name: "agent", proxy: { type: "http", host: "proxy.example", port: "8080" } },
    }));
    expect(response).toMatchObject({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ timezone: "Europe/Paris", locale: "fr-FR" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** Runs `run` as if on Windows x64, Apple Silicon macOS, or Linux x64. */
async function onHost(platform: "win32" | "darwin" | "linux", run: () => Promise<void>): Promise<void> {
  const host = { platform: process.platform, arch: process.arch };
  Object.defineProperties(process, { platform: { value: platform }, arch: { value: platform === "darwin" ? "arm64" : "x64" } });
  try {
    await run();
  } finally {
    Object.defineProperties(process, { platform: { value: host.platform }, arch: { value: host.arch } });
  }
}

// The MCP create tool and `vela-browser-mcp profiles create` both send this request.
test.each([
  ["win32", "chromium", "aliasmode"],
  ["darwin", "firefox", undefined],
  ["linux", "firefox", undefined],
] as const)("profiles.create on %s defaults to %s, and an explicit browser request wins", async (platform, engine, runtime) => {
  const h = harness();
  const saved: any[] = [];
  const session = new AgentControlSession({ ...h.deps, store: { ...h.deps.store, upsertProfile: (profile: any) => saved.push(profile) } as any });
  await onHost(platform, async () => {
    for (const input of [{}, { chromiumRuntime: "cloakbrowser" }, { engine: "chromium" }, { engine: "firefox" }]) {
      expect(await session.enqueue(wire("profiles.create", { input: { name: "agent", ...input } }))).toMatchObject({ ok: true });
    }
  });
  expect(saved.map((profile) => [profile.engine, profile.chromiumRuntime])).toEqual([
    [engine, runtime],
    ["chromium", undefined],
    ["chromium", "aliasmode"],
    ["firefox", undefined],
  ]);
});

// ---- Proxy pool and proxy changes for AI clients ----

import { ProfileStore } from "./store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeApprovalQueue, type AiCodePolicy } from "./code-approvals.ts";
import { scanPlugins } from "./plugins.ts";
import { ScriptLibrary } from "./scripts.ts";
import { ProxyApprovalQueue, type AiProxyPolicy } from "./proxy-approvals.ts";
import { parseSubscription } from "./subscription.ts";

function poolHarness(policy: AiProxyPolicy) {
  const store = new ProfileStore(":memory:");
  store.upsertProfile({ ...buildNewProfile({ name: "Shop", group: "g", proxy: { type: "http", host: "old.example", port: "8080" } }, () => false), id: "profile1" });
  const [node] = store.proxyPool.importText("203.0.113.40:8080:pool-user:pool-secret#🇺🇸 LA").added;
  store.proxyPool.recordCheck(node!.id, { status: "working", country: "US", checkedAt: 1 });
  const approvals = new ProxyApprovalQueue();
  let launchSeq = 0;
  const launcher = {
    kernels: { startTemporary: async () => { throw new Error("no kernel nodes here"); } },
    reconcileOrphans: async () => {},
    certifiedActive: async (id: string) => !!store.getLaunch(id),
    start: async (id: string, _args?: string[], opts?: { headless?: boolean }) => {
      const n = ++launchSeq;
      const ws = `ws://127.0.0.1:${9400 + n}/devtools/browser/${n}`;
      const port = 9400 + n;
      store.recordLaunch({
        profileId: id, pid: 100 + n, debugPort: port, ws, startedAt: Date.now(), relayPort: 19400 + n,
        ...(opts?.headless !== undefined ? { headless: opts.headless } : {}),
      });
      return { ws, port };
    },
    stop: async (id: string) => { store.clearLaunch(id); return true; },
    captureLocalSession: async () => {},
  };
  const session = new AgentControlSession({
    launcher: launcher as any, store, admission: { run: async (_req: unknown, fn: () => Promise<unknown>) => await fn() } as any,
    proxyApprovals: approvals, aiProxyPolicy: () => policy,
    proxySwitchCheck: async () => ({ status: "working", attempts: 3, successes: 3, ip: "203.0.113.41", country: "US" }),
    proxySwitchDirect: async () => null,
    proxyTimezoneFetch: async () => new Response("{}"),
  });
  return { store, node: node!, launcher, approvals, session, close: () => store.close() };
}

function proxyFields(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key.startsWith("proxy")));
}

test("profile lists and browser status describe proxies without exposing connection details", async () => {
  const h = poolHarness("ask");
  try {
    const subscriptionUrl = "https://subscription.example/private-token";
    const sub = h.store.proxyPool.addSubscription({ url: subscriptionUrl });
    const parsed = parseSubscription([
      "anytls://kernel-password@kernel-proxy.example:49123#%F0%9F%87%AF%F0%9F%87%B5%20Tokyo",
      "trojan://hint-password@hint-proxy.example:49124#%F0%9F%87%AB%F0%9F%87%B7%20Paris",
      "anytls://unknown-password@unknown-proxy.example:49125#Transit",
    ].join("\n"));
    h.store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
    const subscriptionNodes = h.store.proxyPool.list().filter((node) => node.subscriptionId === sub.id);
    expect(subscriptionNodes).toHaveLength(3);
    const [checked, hinted, unknown] = subscriptionNodes;
    h.store.proxyPool.recordCheck(checked!.id, { status: "working", country: "gb", checkedAt: 1 });
    h.store.proxyPool.recordCheck(hinted!.id, { status: "working", country: "", checkedAt: 1 });
    h.store.proxyPool.recordCheck(unknown!.id, { status: "working", country: "unknown", checkedAt: 1 });
    const base = h.store.getProfile("profile1")!;
    const save = (id: string, proxy: typeof base.proxy) => h.store.upsertProfile({ ...base, id, name: id, proxy });
    save("profile1", checked!.proxy);
    // A plain proxy that also happens to be in the pool is still described only by type.
    save("direct", h.node.proxy);
    save("personal", { type: "socks5", host: "personal-proxy.example", port: "49126", user: "direct-user", pass: "direct-password" });
    save("none", null);
    save("hint", hinted!.proxy);
    save("unknown", unknown!.proxy);

    const expected: Record<string, Record<string, unknown>> = {
      profile1: { proxyNodeId: checked!.id, proxyNodeName: "🇯🇵 Tokyo", proxyCountry: "GB" },
      direct: { proxyType: "http" },
      personal: { proxyType: "socks5" },
      none: {},
      hint: { proxyNodeId: hinted!.id, proxyNodeName: "🇫🇷 Paris", proxyCountry: "FR" },
      unknown: { proxyNodeId: unknown!.id, proxyNodeName: "Transit" },
    };
    const listed = await h.session.enqueue(wire("profiles.list"));
    expect(listed.ok).toBe(true);
    const profiles = (listed.result as { profiles: Array<{ id: string }> }).profiles;
    expect(profiles).toHaveLength(Object.keys(expected).length);
    const poolListed = await h.session.enqueue(wire("proxyPool.list"));
    expect(poolListed.ok).toBe(true);
    const nodes = (poolListed.result as { nodes: Array<{ nodeId: string; country?: string }> }).nodes;
    expect(nodes.find((node) => node.nodeId === checked!.id)?.country).toBe("GB");
    expect(nodes.find((node) => node.nodeId === hinted!.id)?.country).toBe("FR");
    expect(nodes.find((node) => node.nodeId === unknown!.id)?.country).toBeUndefined();
    const results = [listed, poolListed];
    for (const profile of profiles) {
      expect(proxyFields(profile)).toEqual(expected[profile.id]!);
      const status = await h.session.enqueue(wire("browser.status", { profileId: profile.id }));
      expect(status.ok).toBe(true);
      expect(proxyFields(status.result)).toEqual(expected[profile.id]!);
      results.push(status);
    }
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const secret of ["kernel-proxy.example", "49123", "kernel-password", "hint-proxy.example", "49124", "hint-password",
        "unknown-proxy.example", "49125", "unknown-password", "203.0.113.40", '"port":"8080"', "pool-user", "pool-secret",
        "personal-proxy.example", "49126", "direct-user", "direct-password", subscriptionUrl, '"outbound"']) {
        expect(text).not.toContain(secret);
      }
    }

    // Running browsers retain the same proxy fields alongside their engine details.
    h.store.recordLaunch({ profileId: "profile1", pid: 12, debugPort: 9333, ws: "firefox://private", startedAt: 1, engine: "firefox" });
    const runningSession = new AgentControlSession({
      launcher: { certifiedActive: async () => true } as any, store: h.store, admission: {} as any,
    });
    const running = await runningSession.enqueue(wire("browser.status", { profileId: "profile1" }));
    expect(running).toMatchObject({ ok: true, result: { running: true, engine: "firefox", ...expected.profile1 } });
    expect(proxyFields(running.result)).toEqual(expected.profile1!);

    // An invalid check country is unknown, so the valid region hint remains useful.
    h.store.proxyPool.recordCheck(hinted!.id, { status: "working", country: "unknown", checkedAt: 2 });
    const invalidCountry = await h.session.enqueue(wire("browser.status", { profileId: "hint" }));
    expect(proxyFields(invalidCountry.result)).toEqual(expected.hint!);
    const poolAfterCheck = await h.session.enqueue(wire("proxyPool.list", { country: "FR" }));
    expect((poolAfterCheck.result as { nodes: Array<{ nodeId: string }> }).nodes.map((node) => node.nodeId)).toContain(hinted!.id);

    h.store.proxyPool.remove([unknown!.id]);
    const afterDelete = await h.session.enqueue(wire("profiles.list"));
    const deletedProfile = (afterDelete.result as { profiles: Array<{ id: string }> }).profiles.find((profile) => profile.id === "unknown");
    expect(proxyFields(deletedProfile)).toEqual({ proxyNodeId: unknown!.id });
    const deletedStatus = await h.session.enqueue(wire("browser.status", { profileId: "unknown" }));
    expect(proxyFields(deletedStatus.result)).toEqual({ proxyNodeId: unknown!.id });
  } finally { h.close(); }
});

test("proxy labels do not expose subscription node addresses or credentials", async () => {
  const h = poolHarness("allow_pool");
  try {
    const subscriptionUrl = "https://subscription.example/secret-subscription";
    const sub = h.store.proxyPool.addSubscription({ url: subscriptionUrl });
    const parsed = parseSubscription("anytls://hidden-password@hidden-proxy.example:49991");
    h.store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
    const node = h.store.proxyPool.list().find((item) => item.subscriptionId === sub.id)!;
    expect(node.name).toBe("hidden-proxy.example:49991");
    h.store.upsertProfile({ ...h.store.getProfile("profile1")!, proxy: node.proxy });

    for (const name of [node.name, "hidden-password", subscriptionUrl, JSON.stringify(node.outbound)]) {
      h.store.proxyPool.update(node.id, { name });
      const listed = await h.session.enqueue(wire("profiles.list"));
      expect(proxyFields((listed.result as { profiles: unknown[] }).profiles[0])).toEqual({ proxyNodeId: node.id });
      for (const result of [
        listed,
        await h.session.enqueue(wire("browser.status", { profileId: "profile1" })),
        await h.session.enqueue(wire("proxyPool.list")),
      ]) {
        expect(result.ok).toBe(true);
        const text = JSON.stringify(result);
        for (const secret of ["hidden-proxy.example", "49991", "hidden-password", subscriptionUrl, '"outbound"']) expect(text).not.toContain(secret);
      }
    }
    // The link must stay private even when its subscription has been removed.
    h.store.proxyPool.update(node.id, { name: subscriptionUrl });
    h.store.proxyPool.removeSubscription(sub.id, () => true);
    const retained = await h.session.enqueue(wire("profiles.list"));
    expect(retained.ok).toBe(true);
    expect(JSON.stringify(retained)).not.toContain(subscriptionUrl);
  } finally { h.close(); }
});

test("MCP proxy changes do not reveal proxy addresses in labels or the exit check", async () => {
  const h = poolHarness("allow_pool");
  try {
    h.store.proxyPool.update(h.node.id, { name: "203.0.113.40:8080" });
    const session = new AgentControlSession({
      launcher: h.launcher as any, store: h.store, admission: {} as any,
      aiProxyPolicy: () => "allow_pool",
      proxySwitchCheck: async () => ({ status: "working", attempts: 3, successes: 3, ip: "203.0.113.40", country: "US" }),
      proxySwitchDirect: async () => null,
      proxyTimezoneFetch: async () => new Response("{}"),
    });
    const result = await session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: h.node.id }));
    expect(result).toMatchObject({ ok: true, result: { previous: "http", next: "http", exit: { country: "US" } } });
    for (const secret of ["old.example", "203.0.113.40", "8080", "pool-user", "pool-secret"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  } finally { h.close(); }
});

test("an approved proxy change reports the proxy present after the approval wait", async () => {
  const h = poolHarness("ask");
  try {
    const pending = h.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: h.node.id }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const question = h.approvals.list()[0]!;
    h.store.upsertProfile({
      ...h.store.getProfile("profile1")!,
      proxy: { type: "socks5", host: "updated-proxy.example", port: "49993", user: "updated-user", pass: "updated-secret" },
    });
    h.approvals.answer(question.id, true);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, result: { previous: "socks5" } });
    for (const secret of ["old.example", "updated-proxy.example", "49993", "updated-user", "updated-secret"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  } finally { h.close(); }
});

test("remote profile responses use authoritative proxy settings instead of the local launch cache", async () => {
  const h = poolHarness("ask");
  try {
    const local = h.store.getProfile("profile1")!;
    const remoteProfiles = [
      { ...local, proxy: { type: "pool" as const, host: h.node.id, port: "0", user: "", pass: "" } },
      { ...local, id: "remote-only", proxy: { type: "socks5" as const, host: "remote-proxy.example", port: "49992", user: "remote-user", pass: "remote-secret" } },
      { ...local, id: "no-proxy", proxy: null },
    ];
    const remote = {
      listRoster: async () => ({ profiles: remoteProfiles.map(({ id, name, group }) => ({ id, name, group })) }),
      getProfiles: async (ids: string[]) => remoteProfiles.filter((profile) => ids.includes(profile.id)),
      getProfile: async (id: string) => remoteProfiles.find((profile) => profile.id === id)!,
    };
    const session = new AgentControlSession({
      launcher: { reconcileOrphans: async () => {}, certifiedActive: async () => false } as any,
      store: h.store, admission: {} as any, remote: remote as any,
    });
    const expected: Record<string, Record<string, unknown>> = {
      profile1: { proxyNodeId: h.node.id, proxyNodeName: "🇺🇸 LA", proxyCountry: "US" },
      "remote-only": { proxyType: "socks5" },
      "no-proxy": {},
    };
    const listed = await session.enqueue(wire("profiles.list"));
    expect(listed.ok).toBe(true);
    const results = [listed];
    for (const profile of (listed.result as { profiles: Array<{ id: string }> }).profiles) {
      expect(proxyFields(profile)).toEqual(expected[profile.id]!);
      const status = await session.enqueue(wire("browser.status", { profileId: profile.id }));
      expect(status.ok).toBe(true);
      expect(proxyFields(status.result)).toEqual(expected[profile.id]!);
      results.push(status);
    }
    expect((listed.result as { profiles: unknown[] }).profiles).toHaveLength(3);
    for (const result of results) {
      const text = JSON.stringify(result);
      for (const secret of ["old.example", "remote-proxy.example", "49992", "remote-user", "remote-secret"]) expect(text).not.toContain(secret);
    }
  } finally { h.close(); }
});

test("an AI lists the pool without credentials and can filter it", async () => {
  const h = poolHarness("ask");
  const listed = await h.session.enqueue(wire("proxyPool.list", { country: "us", available: true }));
  expect(listed.ok).toBe(true);
  expect(listed.result).toEqual({ nodes: [{ nodeId: h.node.id, name: "🇺🇸 LA", protocol: "http", country: "US", status: "working", assignedProfiles: 0, maxProfiles: 1 }] });
  expect(JSON.stringify(listed)).not.toContain("pool-secret");
  expect(((await h.session.enqueue(wire("proxyPool.list", { country: "JP" }))).result as any).nodes).toEqual([]);
  expect((await h.session.enqueue(wire("proxyPool.check", { nodeIds: [] }))).error?.code).toBe("invalid_request");
  h.close();
});

test("by default a person approves an AI's proxy change; a refusal or silence changes nothing", async () => {
  const h = poolHarness("ask");
  const pending = h.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: h.node.id, client: "Claude Code" }));
  await new Promise((r) => setTimeout(r, 20));
  const [question] = h.approvals.list();
  expect(question).toMatchObject({ profileId: "profile1", profileName: "Shop", client: "Claude Code", from: "http://old.example:8080", to: "http · 🇺🇸 LA", reopens: false });
  h.approvals.answer(question!.id, false);
  expect((await pending).error?.code).toBe("approval_denied");
  expect(h.store.getProfile("profile1")!.proxy!.host).toBe("old.example");

  const approved = h.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: h.node.id, client: "Claude Code" }));
  await new Promise((r) => setTimeout(r, 20));
  h.approvals.answer(h.approvals.list()[0]!.id, true);
  const answer = await approved;
  expect(answer.ok).toBe(true);
  expect(answer.result).toMatchObject({ profileId: "profile1", applied: "saved", next: "http · 🇺🇸 LA" });
  expect(h.store.getProfile("profile1")!.proxy!.host).toBe("203.0.113.40");
  expect(h.store.proxyPool.switchHistory("profile1")[0]).toMatchObject({ by: "mcp:Claude Code", outcome: "saved" });
  expect(JSON.stringify(answer)).not.toContain("pool-secret");
  h.close();
});

test("the user's setting can let pool changes through or turn them off", async () => {
  const allowed = poolHarness("allow_pool");
  const ok = await allowed.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: allowed.node.id }));
  expect(ok.ok).toBe(true);
  expect(allowed.approvals.list()).toEqual([]);
  // The switch's own limits still hold: one change per profile every 30 seconds.
  const again = await allowed.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: allowed.node.id }));
  expect(again.error?.code).toBe("rate_limited");
  allowed.close();

  const denied = poolHarness("deny");
  const refused = await denied.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: denied.node.id }));
  expect(refused.error?.code).toBe("approval_denied");
  expect(denied.store.getProfile("profile1")!.proxy!.host).toBe("old.example");
  denied.close();
});

test("an unknown node or profile is refused before anyone is asked", async () => {
  const h = poolHarness("ask");
  expect((await h.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: "missing" }))).error?.code).toBe("node_unavailable");
  expect((await h.session.enqueue(wire("profiles.setProxy", { profileId: "nobody", nodeId: h.node.id }))).error?.code).toBe("no_such_profile");
  expect(h.approvals.list()).toEqual([]);
  h.close();
});

test("ordinary node names stay visible to an AI, even with numbers or slashes in them", async () => {
  const h = poolHarness("allow_pool");
  try {
    const sub = h.store.proxyPool.addSubscription({ url: "https://subscription.example/secret-subscription" });
    const parsed = parseSubscription("anytls://hidden-password@hidden-proxy.example:443?sni=hidden-proxy.example#x");
    h.store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
    const node = h.store.proxyPool.list().find((item) => item.subscriptionId === sub.id)!;
    h.store.upsertProfile({ ...h.store.getProfile("profile1")!, proxy: node.proxy });
    for (const name of ["🇭🇰 香港 01 | 100M", "HK/IEPL 443", "SG-2x chrome"]) {
      h.store.proxyPool.update(node.id, { name });
      const listed = await h.session.enqueue(wire("profiles.list"));
      expect(proxyFields((listed.result as { profiles: unknown[] }).profiles[0])).toMatchObject({ proxyNodeId: node.id, proxyNodeName: name });
    }
  } finally { h.close(); }
});

test("setProfileProxy updates attached session state when switching reopens an open browser", async () => {
  const h = poolHarness("allow_pool");
  try {
    // Open profile1 via the agent session first so openedEndpoints tracks it.
    const opened = await h.session.enqueue(wire("browser.open", { profileId: "profile1" }));
    expect(opened.ok).toBe(true);
    const initialWs = (opened.result as { ws: string }).ws;
    const switched = await h.session.enqueue(wire("profiles.setProxy", { profileId: "profile1", nodeId: h.node.id }));
    expect(switched).toMatchObject({ ok: true, result: { applied: "reopened" } });
    // Session endpoint updated to the reopened launch so status and close target the new launch.
    const status = await h.session.enqueue(wire("browser.status", { profileId: "profile1" }));
    expect(status).toMatchObject({ ok: true, result: { running: true, ownedByConnection: true } });
    expect((status.result as { ws: string }).ws).not.toBe(initialWs);
    const closed = await h.session.enqueue(wire("browser.close", { profileId: "profile1" }));
    expect(closed).toMatchObject({ ok: true, result: { closed: true } });
    expect(h.store.getLaunch("profile1")).toBeNull();
  } finally { h.close(); }
});

test("profiles.update only allows name, group and tags and rejects other fields", async () => {
  const h = poolHarness("ask");
  try {
    const before = h.store.getProfile("profile1")!;
    for (const field of ["proxy", "username", "password", "platform", "resolution", "timezone"]) {
      const rejected = await h.session.enqueue(wire("profiles.update", {
        profileId: "profile1",
        set: { name: "Renamed", [field]: "x" },
      }));
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe("invalid_request");
      expect(rejected.error?.message).toContain(field);
    }
    expect(h.store.getProfile("profile1")!.name).toBe(before.name);

    const ok = await h.session.enqueue(wire("profiles.update", {
      profileId: "profile1",
      set: { name: "  Shop EU  ", group: "  EU  ", tags: [" vip ", "vip", "", "retail"] },
    }));
    expect(ok).toEqual({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 1,
      ok: true,
      result: { profile: { id: "profile1", name: "Shop EU", group: "EU", tags: ["vip", "retail"] } },
    });
    const after = h.store.getProfile("profile1")!;
    expect(after.name).toBe("Shop EU");
    expect(after.group).toBe("EU");
    expect(after.tags).toEqual(["vip", "retail"]);
    expect(after.proxy).toEqual(before.proxy);
  } finally { h.close(); }
});

function codeHarness(policy: AiCodePolicy) {
  const dir = mkdtempSync(join(tmpdir(), "vela-agent-code-"));
  const store = new ProfileStore(":memory:");
  store.upsertProfile({ ...buildNewProfile({ name: "One", group: "g" }, () => false), id: "p1" });
  const library = new ScriptLibrary(dir, false);
  const startCalls: unknown[] = [];
  const runner = {
    start: (req: unknown) => {
      startCalls.push(req);
      return { id: "run-1", scriptId: (req as any).scriptId, scriptName: "Demo", status: "running", profiles: [] };
    },
    status: () => null,
    log: () => ({ text: "", nextOffset: 0 }),
    stop: async () => null,
  };
  const codeApprovals = new CodeApprovalQueue();
  const pluginsRoot = join(dir, "plugins");
  let currentPolicy = policy;
  const session = new AgentControlSession({
    launcher: { reconcileOrphans: async () => {}, certifiedActive: async () => false } as any,
    store,
    admission: { run: async (_req: unknown, fn: () => Promise<unknown>) => await fn() } as any,
    scripts: { library, runner: runner as any },
    pluginsRoot,
    codeApprovals,
    aiCodePolicy: () => currentPolicy,
  });
  return {
    dir, store, library, startCalls, codeApprovals, pluginsRoot, session,
    setPolicy: (next: AiCodePolicy) => { currentPolicy = next; },
    close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("scripts.save obeys ask, allow and deny policies", async () => {
  const h = codeHarness("ask");
  try {
    const scriptParams = { name: "Check title", description: "Reads title", language: "javascript", source: "export default async () => {};", client: "Claude Code" };

    // ask: waits for approval; denial saves nothing.
    const deniedReq = h.session.enqueue(wire("scripts.save", scriptParams));
    await new Promise((r) => setTimeout(r, 20));
    const [pendingDeny] = h.codeApprovals.list();
    expect(pendingDeny).toMatchObject({ kind: "script", action: "create", title: "Check title", client: "Claude Code", detail: "javascript" });
    h.codeApprovals.answer(pendingDeny!.id, false);
    expect((await deniedReq).error?.code).toBe("approval_denied");
    expect(await h.library.list()).toEqual([]);

    // ask: approval saves the script.
    const approvedReq = h.session.enqueue(wire("scripts.save", scriptParams));
    await new Promise((r) => setTimeout(r, 20));
    h.codeApprovals.answer(h.codeApprovals.list()[0]!.id, true);
    const approvedRes = await approvedReq;
    expect(approvedRes.ok).toBe(true);
    const savedId = (approvedRes.result as { script: { id: string } }).script.id;
    expect(await h.library.list()).toHaveLength(1);

    // allow: updates immediately without queueing an approval.
    h.setPolicy("allow");
    const allowedRes = await h.session.enqueue(wire("scripts.save", { ...scriptParams, scriptId: savedId, source: "export default async () => { return 1; };" }));
    expect(allowedRes.ok).toBe(true);
    expect(h.codeApprovals.list()).toEqual([]);
    expect((await h.library.get(savedId)).source).toContain("return 1");

    // deny: rejects immediately without queueing an approval or changing the saved script.
    h.setPolicy("deny");
    const policyDenied = await h.session.enqueue(wire("scripts.save", { ...scriptParams, scriptId: savedId, source: "export default async () => { return 2; };" }));
    expect(policyDenied.error?.code).toBe("approval_denied");
    expect(h.codeApprovals.list()).toEqual([]);
    expect((await h.library.get(savedId)).source).toContain("return 1");
  } finally { h.close(); }
});

test("scripts.run always forces useCredentials=false", async () => {
  const h = codeHarness("allow");
  try {
    const saved = await h.library.save({ name: "Run test", description: "", language: "javascript", source: "export default async () => {};" });
    const started = await h.session.enqueue(wire("scripts.run", {
      scriptId: saved.id,
      profileIds: ["p1"],
      inputs: { url: "https://example.com" },
      useCredentials: true,
      concurrency: 2,
    }));
    expect(started.ok).toBe(true);
    expect(h.startCalls).toEqual([{
      scriptId: saved.id,
      profileIds: ["p1"],
      inputs: { url: "https://example.com" },
      useCredentials: false,
      concurrency: 2,
    }]);
  } finally { h.close(); }
});

test("plugins.save rejects invalid manifests before asking or writing, and writes valid plugins when allowed", async () => {
  const h = codeHarness("ask");
  try {
    const invalid = await h.session.enqueue(wire("plugins.save", {
      pluginId: "bad-plugin",
      manifest: { name: "Bad", version: "1.0.0", tools: [] },
      module: "export default () => ({});",
    }));
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe("invalid_request");
    expect(h.codeApprovals.list()).toEqual([]);
    expect(scanPlugins(h.pluginsRoot).infos).toEqual([]);

    const badMain = await h.session.enqueue(wire("plugins.save", {
      pluginId: "bad-main",
      manifest: { name: "Bad", version: "1.0.0", main: "../outside.mjs", tools: [{ name: "read", description: "x" }] },
      module: "export default () => ({});",
    }));
    expect(badMain.error?.code).toBe("invalid_request");
    expect(h.codeApprovals.list()).toEqual([]);

    h.setPolicy("allow");
    const valid = await h.session.enqueue(wire("plugins.save", {
      pluginId: "page-title",
      manifest: { name: "Page title", version: "1.0.0", tools: [{ name: "read", description: "Read title.", readOnly: true }] },
      module: "export default (vela) => ({ read: () => vela.profileId });",
    }));
    expect(valid.ok).toBe(true);
    expect(valid.result).toMatchObject({ pluginId: "page-title", tools: ["plugin_page_title_read"] });
    const scanned = scanPlugins(h.pluginsRoot);
    expect(scanned.specs.map((spec) => spec.id)).toEqual(["page-title"]);
  } finally { h.close(); }
});

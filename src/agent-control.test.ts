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
  for (const method of ["mcp.connectors.create", "mcp.connectors.list", "mcp.connectors.revoke", "profiles.update", "profiles.replaceProxies"]) {
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

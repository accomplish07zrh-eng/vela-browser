import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import { ProfileStore } from "./store.ts";
import { parseSubscription } from "./subscription.ts";
import { ProxySwitchError, saveProfileProxy, switchProfileProxy, type SwitchDeps } from "./proxy-switch.ts";
import type { LaunchInfo, ProxySpec } from "./types.ts";
import type { ProxyCheckResult } from "./proxy-check.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const OLD: ProxySpec = { type: "http", host: "old.example", port: "8080", user: "", pass: "" };

function setup(opts: { running?: boolean; headless?: boolean } = {}) {
  const store = new ProfileStore(":memory:"); stores.push(store);
  store.upsertProfile({ ...buildNewProfile({ name: "p1", group: "g", proxy: OLD }, () => false), id: "p1" });
  store.upsertProfile({ ...buildNewProfile({ name: "p2", group: "g", proxy: OLD }, () => false), id: "p2" });
  const [node] = store.proxyPool.importText("203.0.113.40:8080#new exit").added;
  const events: string[] = [];
  let clock = 1_000_000;
  const launch = (): LaunchInfo => ({ profileId: "p1", pid: 1, debugPort: 9333, ws: "ws://x", startedAt: 1, relayPort: 41234, ...(opts.headless ? { headless: true } : {}) });
  if (opts.running) store.recordLaunch(launch());
  let stopOk = true;
  let startFails = false;
  let exitAfter: Partial<ProxyCheckResult> = { status: "working", ip: "203.0.113.41", country: "US" };
  let preCheck: Partial<ProxyCheckResult> = { status: "working", ip: "203.0.113.41", country: "US" };
  const checked: ProxySpec[] = [];
  const deps: SwitchDeps = {
    store,
    launcher: {
      captureLocalSession: async (id) => { events.push(`capture ${id}`); },
      stop: async (id) => { events.push(`stop ${id}`); if (stopOk) store.clearLaunch(id); return stopOk; },
      start: async (id, _args, startOpts) => {
        events.push(`start ${id} headless=${startOpts?.headless ?? "default"} proxy=${store.getProfile(id)!.proxy!.host}`);
        if (startFails) throw new Error("no browser");
        store.recordLaunch(launch());
        return { ws: "ws://x", port: 9333 };
      },
      kernels: {
        startTemporary: async (entries) => {
          events.push(`temporary kernel ${entries.map((e) => e.outbound.type).join(",")}`);
          return {
            process: { pid: 9, spec: OLD, exited: new Promise<number>(() => {}), stop: () => events.push("temporary kernel stopped") },
            specs: new Map(entries.map((e) => [e.tag, { type: "socks5" as const, host: "127.0.0.1", port: "45000", user: "k", pass: "k" }])),
          };
        },
      },
    },
    assign: async (id, proxy) => { events.push(`assign ${id} ${proxy.type}:${proxy.host}`); store.upsertProfile({ ...store.getProfile(id)!, proxy }); },
    check: async (proxy) => {
      checked.push(proxy);
      const after = proxy.host === "127.0.0.1" && proxy.port === "41234";
      return { attempts: 3, successes: 3, ...(after ? exitAfter : preCheck) } as ProxyCheckResult;
    },
    direct: async () => ({ ip: "198.51.100.1" }),
    now: () => clock,
  };
  return {
    store, node: node!, deps, events, checked,
    advance: (ms: number) => { clock += ms; },
    failStop: () => { stopOk = false; },
    failStart: () => { startFails = true; },
    setPreCheck: (r: Partial<ProxyCheckResult>) => { preCheck = r; },
    setExitAfter: (r: Partial<ProxyCheckResult>) => { exitAfter = r; },
  };
}

test("a closed profile just takes the checked node; its next start uses it", async () => {
  const { store, node, deps, events } = setup();
  const result = await switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" });
  expect(result).toMatchObject({ applied: "saved", previous: "http://old.example:8080", next: "http · new exit", exit: { country: "US" } });
  expect(events).toEqual(["assign p1 http:203.0.113.40"]);
  expect(store.proxyPool.switchHistory("p1")).toEqual([
    { profileId: "p1", at: 1_000_000, by: "dashboard", from: "http://old.example:8080", to: "http · new exit", outcome: "saved", exitCountry: "US" },
  ]);
});

test("an open browser saves its session, closes, takes the node, reopens in its own mode, and its exit is checked again", async () => {
  const { store, node, deps, events, checked } = setup({ running: true, headless: true });
  const result = await switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "mcp:Claude" });
  expect(result.applied).toBe("reopened");
  expect(events).toEqual(["capture p1", "stop p1", "assign p1 http:203.0.113.40", "start p1 headless=true proxy=203.0.113.40"]);
  // The node first, then the reopened browser's own relay.
  expect(checked.map((p) => `${p.host}:${p.port}`)).toEqual(["203.0.113.40:8080", "127.0.0.1:41234"]);
  expect(store.proxyPool.switchHistory("p1")[0]).toMatchObject({ by: "mcp:Claude", outcome: "reopened" });
});

test("a node that fails its check changes nothing, and the open browser stays open", async () => {
  for (const status of ["failed", "unavailable"] as const) {
    const { store, node, deps, events, setPreCheck } = setup({ running: true });
    setPreCheck({ status, reason: "timeout" });
    await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "switch_check_failed" });
    expect(events).toEqual([]);
    expect(store.getProfile("p1")!.proxy).toEqual(OLD);
    expect(store.getLaunch("p1")).not.toBeNull();
    expect(store.proxyPool.switchHistory("p1")[0]).toMatchObject({ outcome: "failed", code: "switch_check_failed" });
  }
});

test("a browser that cannot be closed for certain keeps its proxy", async () => {
  const { store, node, deps, events, failStop } = setup({ running: true });
  failStop();
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "teardown_unconfirmed" });
  expect(events).toEqual(["capture p1", "stop p1"]);
  expect(store.getProfile("p1")!.proxy).toEqual(OLD);
});

test("a reopened browser whose traffic leaves from this computer's address is closed at once", async () => {
  const { node, deps, events, setExitAfter, store } = setup({ running: true });
  setExitAfter({ status: "failed", reason: "proxy_bypassed" });
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "exit_is_direct" });
  expect(events.at(-1)).toBe("stop p1");
  expect(store.getLaunch("p1")).toBeNull();
});

test("a reopen that fails says the proxy is saved", async () => {
  const { store, node, deps, failStart } = setup({ running: true });
  failStart();
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "reopen_failed" });
  expect(store.getProfile("p1")!.proxy!.host).toBe("203.0.113.40");
});

test("a node at its sharing limit, a disabled or missing node, and a profile that does not exist are refused", async () => {
  const { store, node, deps } = setup();
  store.upsertProfile({ ...store.getProfile("p2")!, proxy: node.proxy });
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "pool_exhausted", detail: { profiles: [{ id: "p2" }] } });
  store.proxyPool.update(node.id, { maxProfiles: null, disabled: true });
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "node_unavailable" });
  await expect(switchProfileProxy(deps, { profileId: "p1", nodeId: "missing", by: "dashboard" })).rejects.toMatchObject({ code: "node_unavailable" });
  await expect(switchProfileProxy(deps, { profileId: "nope", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "no_such_profile" });
});

test("a profile waits between two switches, and one switch runs at a time", async () => {
  const { node, deps, advance, store } = setup();
  const [other] = store.proxyPool.importText("203.0.113.50:8080#second").added;
  await switchProfileProxy(deps, { profileId: "p1", nodeId: node.id, by: "dashboard" });
  const early = await switchProfileProxy(deps, { profileId: "p1", nodeId: other!.id, by: "dashboard" }).catch((e) => e);
  expect(early).toBeInstanceOf(ProxySwitchError);
  expect(early.code).toBe("rate_limited");
  expect(early.detail.retryAfterMs).toBe(30_000);
  advance(30_000);
  // Two at once: the second is refused while the first runs.
  let release!: () => void;
  const slow: SwitchDeps = { ...deps, check: async () => { await new Promise<void>((r) => { release = r; }); return { status: "working", attempts: 3, successes: 3 }; } };
  const first = switchProfileProxy(slow, { profileId: "p1", nodeId: other!.id, by: "dashboard" });
  await new Promise((r) => setTimeout(r, 10));
  await expect(switchProfileProxy(slow, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "profile_busy" });
  release();
  await first;
});

test("a kernel node is checked through a temporary kernel that stops afterwards", async () => {
  const { store, deps, events } = setup();
  const parsed = parseSubscription("anytls://P@sg.node.example:443?sni=sg.node.example#SG");
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/a" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const kernelNode = store.proxyPool.list().find((n) => n.protocol === "anytls")!;
  const result = await switchProfileProxy(deps, { profileId: "p1", nodeId: kernelNode.id, by: "dashboard" });
  expect(result.next).toBe("anytls · SG");
  expect(events).toEqual(["temporary kernel anytls", "temporary kernel stopped", `assign p1 pool:${kernelNode.id}`]);
});

test("assigning or switching a pool node pre-fills closed profile timezone while respecting timezoneManual", async () => {
  const { store } = setup();
  const parsed = parseSubscription("anytls://P@jp.node.example:443?sni=jp.node.example#JP");
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/tz" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const kernelNode = store.proxyPool.list().find((n) => n.protocol === "anytls")!;
  store.proxyPool.recordCheck(kernelNode.id, { status: "working", ip: "203.0.113.7", country: "JP", timezone: "Asia/Tokyo", checkedAt: 1 });

  await saveProfileProxy(store, "p1", kernelNode.proxy);
  expect(store.getProfile("p1")!.timezone).toBe("Asia/Tokyo");

  // Manual timezone is preserved even when assigning a checked pool node.
  store.upsertProfile({ ...store.getProfile("p2")!, timezone: "America/Chicago", timezoneManual: true });
  await saveProfileProxy(store, "p2", kernelNode.proxy);
  expect(store.getProfile("p2")!.timezone).toBe("America/Chicago");
});

test("switchProfileProxy re-validates node availability after pre-check completes", async () => {
  const { store, deps } = setup();
  const parsed = parseSubscription("vless://11111111-2222-3333-4444-555555555555@jp.example:443?security=tls#JP");
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/toctou" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const node = store.proxyPool.list().find((n) => n.subscriptionId === sub.id)!;

  const raceDeps: SwitchDeps = {
    ...deps,
    check: async () => {
      // Simulate the node getting disabled while the slow proxy check was running.
      store.proxyPool.update(node.id, { disabled: true });
      return { status: "working", attempts: 3, successes: 3, ip: "203.0.113.55", country: "JP" };
    },
  };
  await expect(switchProfileProxy(raceDeps, { profileId: "p1", nodeId: node.id, by: "dashboard" })).rejects.toMatchObject({ code: "node_unavailable" });
  expect(store.getProfile("p1")!.proxy).toEqual(OLD);
});

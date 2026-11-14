import { afterEach, expect, test } from "bun:test";
import { buildNewProfile } from "./create.ts";
import type { Launcher } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function setup() {
  const store = new ProfileStore(":memory:"); stores.push(store);
  for (const id of ["p1", "p2"]) {
    store.upsertProfile({ ...buildNewProfile({ name: id, group: "folder", proxy: { type: "http", host: "old.example", port: "8080" } }, () => false), id, timezone: "Asia/Tokyo" });
  }
  const launcher = {} as unknown as Launcher;
  const options: UiRuntimeOptions = { timezoneFetch: async () => new Response('{"status":"success","timezone":"Europe/Paris"}') };
  const call = (path: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    handleUiRequest(new Request(`http://localhost/ui/api/proxy-pool${path}`, body === undefined
      ? { method: "GET" }
      : { method: "POST", headers, body: JSON.stringify(body) }), launcher, store, null, options).then((r) => r!);
  return { store, options, call };
}

test("the pool lists nodes without credentials and imports pasted proxies", async () => {
  const { call } = setup();
  const imported = await (await call("/import", { text: "10.0.0.1:8080:pool-user:pool-secret#🇺🇸 LA\nbad line\n10.0.0.1:8080:pool-user:pool-secret", type: "socks5", tags: ["res"] })).json();
  expect(imported).toMatchObject({ ok: true, added: 1, duplicates: 1, invalid: [{ line: 2 }] });
  const listed = await call("");
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const text = await listed.text();
  expect(text).not.toContain("pool-secret");
  expect(text).not.toContain("pool-user");
  expect(JSON.parse(text).nodes[0]).toMatchObject({ name: "🇺🇸 LA", proxy: "socks5://10.0.0.1:8080", hasAuth: true, tags: ["res"], maxProfiles: 1, regionHint: "US", profiles: [] });
});

test("pool mutations need a same-origin JSON request", async () => {
  const { call } = setup();
  expect((await call("/import", { text: "10.0.0.1:8080" }, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await call("/import", { text: "10.0.0.1:8080" }, { "Content-Type": "application/json", Origin: "https://outside.invalid" })).status).toBe(403);
  expect((await call("")).status).toBe(200);
});

test("a node's details change, its proxy cannot, and nodes can be removed", async () => {
  const { call, store } = setup();
  const { addedIds: [id] } = await (await call("/import", { text: "10.0.0.1:8080" })).json();
  const updated = await (await call("/update", { id, name: "HK 01", maxProfiles: 2, tags: ["a"] })).json();
  expect(updated.node).toMatchObject({ name: "HK 01", maxProfiles: 2, tags: ["a"], regionHint: "HK" });
  expect((await call("/update", { id, host: "10.9.9.9" })).status).toBe(400);
  expect(await (await call("/delete", { ids: [id] })).json()).toEqual({ ok: true, removed: 1 });
  expect(store.proxyPool.list()).toEqual([]);
});

test("giving a profile a node saves its proxy and the new exit's timezone, within the sharing limit", async () => {
  const { call, store } = setup();
  const { addedIds: [id] } = await (await call("/import", { text: "10.0.0.1:8080:u:secret" })).json();
  const first = await call("/assign", { profileId: "p1", nodeId: id });
  expect(await first.json()).toEqual({ ok: true, sharedWith: [] });
  expect(store.getProfile("p1")!.proxy).toEqual({ type: "http", host: "10.0.0.1", port: "8080", user: "u", pass: "secret" });
  expect(store.getProfile("p1")!.timezone).toBe("Europe/Paris");
  // The same profile again is fine: it already holds the node.
  expect((await call("/assign", { profileId: "p1", nodeId: id })).status).toBe(200);

  const refused = await call("/assign", { profileId: "p2", nodeId: id });
  expect(refused.status).toBe(409);
  const body = await refused.json();
  expect(body).toMatchObject({ code: "pool_exhausted", profiles: [{ id: "p1" }] });
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(store.getProfile("p2")!.proxy!.host).toBe("old.example");

  await call("/update", { id, maxProfiles: null });
  const shared = await (await call("/assign", { profileId: "p2", nodeId: id })).json();
  expect(shared).toMatchObject({ ok: true, sharedWith: [{ id: "p1" }] });
  const listed = await (await call("")).json();
  expect(listed.nodes[0].profiles.map((p: { id: string }) => p.id)).toEqual(["p1", "p2"]);

  await call("/update", { id, disabled: true });
  expect((await call("/assign", { profileId: "p1", nodeId: id })).status).toBe(409);
  expect((await call("/assign", { profileId: "missing", nodeId: id })).status).toBe(409);
});

test("a typed timezone stays when a profile gets a node", async () => {
  const { call, store } = setup();
  store.upsertProfile({ ...store.getProfile("p1")!, timezone: "America/Chicago", timezoneManual: true });
  const { addedIds: [id] } = await (await call("/import", { text: "10.0.0.1:8080" })).json();
  await call("/assign", { profileId: "p1", nodeId: id });
  expect(store.getProfile("p1")!.timezone).toBe("America/Chicago");
});

test("checks stream each node's result and save it on the node", async () => {
  const { call, store, options } = setup();
  await call("/import", { text: "10.0.0.1:8080:u:secret\n10.0.0.2:8080" });
  let calls = 0;
  options.proxyCheck = async () => { calls++; return { status: "working", attempts: 3, successes: 3, ip: "203.0.113.7", country: "US" }; };
  const response = await call("/check", {});
  expect(response.headers.get("content-type")).toContain("ndjson");
  const text = await response.text();
  expect(text).not.toContain("secret");
  const events = text.trim().split("\n").map((line) => JSON.parse(line));
  expect(calls).toBe(2);
  expect(events.filter((e) => e.type === "node").map((e) => e.node.check.status)).toEqual(["working", "working"]);
  expect(events.at(-1)).toEqual({ type: "done" });
  expect(store.proxyPool.list().every((node) => node.check?.ip === "203.0.113.7")).toBe(true);
  // Both left through one IP: the list says so.
  const listed = await (await call("")).json();
  expect(listed.nodes[0].sameExitAs).toEqual([listed.nodes[1].id]);
});

import { parseSubscription, SubscriptionError } from "./subscription.ts";

test("subscriptions: added and refreshed through the routes, the link never in an answer", async () => {
  const { store } = setup();
  const links = "anytls://ANYPASS@sg.node.example:443?sni=sg.node.example#SG\nvless://u-1@jp.node.example:443?security=tls#JP\nwireguard://x@y:1#WG";
  let fail = false;
  const fetchSubscription = (async () => {
    if (fail) throw new SubscriptionError("The subscription server answered 403");
    return { body: links, userAgent: "clash.meta", usage: { totalBytes: 100, downloadBytes: 40 }, parsed: parseSubscription(links) };
  }) as any;
  const call = (path: string, body?: unknown) => handleUiRequest(new Request(`http://localhost/ui/api/proxy-pool${path}`, body === undefined
    ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  {} as any, store, null, {}).then((r) => r!);
  // ui.ts passes the launcher's kernels; routes without them still list and sync.
  const { handleProxyPoolRequest } = await import("./proxy-pool-api.ts");
  const direct = (path: string, body?: unknown) => handleProxyPoolRequest(new Request(`http://localhost/ui/api/proxy-pool${path}`, body === undefined
    ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  store, {}, { assign: async () => null, fetchSubscription });

  const added = await (await direct("/subscriptions/add", { url: "https://sub.example/secret-token", name: "My airport" })).json();
  expect(added).toMatchObject({ ok: true, added: 2, kept: 0, removed: 0, format: "uri", unsupported: [{ name: "WG" }] });
  expect(added.subscription).toMatchObject({ name: "My airport", host: "sub.example", usage: { totalBytes: 100, downloadBytes: 40 } });
  const listed = await (await call("")).text();
  expect(listed).not.toContain("secret-token");
  expect(listed).not.toContain("ANYPASS");
  const body = JSON.parse(listed);
  expect(body.subscriptions).toHaveLength(1);
  expect(body.nodes.map((n: { protocol: string; maxProfiles: number | null }) => [n.protocol, n.maxProfiles])).toEqual([["anytls", null], ["vless", null]]);

  fail = true;
  const failed = await direct("/subscriptions/refresh", { id: added.subscription.id });
  expect(failed.status).toBe(502);
  expect(store.proxyPool.getSubscription(added.subscription.id)!.lastError).toBe("The subscription server answered 403");
  // A failed refresh leaves the nodes as they were.
  expect(store.proxyPool.list()).toHaveLength(2);

  expect(await (await direct("/subscriptions/delete", { id: added.subscription.id })).json()).toEqual({ ok: true, removedNodes: 2, keptNodes: 0 });
  expect((await direct("/subscriptions/add", { url: "http://sub.example/x" })).status).toBe(400);
});

test("kernel nodes are checked through a temporary kernel that stops afterwards; without one they are unknown", async () => {
  const { store, options } = setup();
  const parsed = parseSubscription("anytls://ANYPASS@sg.node.example:443?sni=sg.node.example#SG\nsocks5://198.51.100.9:1080#plain");
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/a" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const [kernelNode, plain] = store.proxyPool.list();
  const checked: string[] = [];
  options.proxyCheck = async (proxy) => { checked.push(`${proxy.type}://${proxy.host}:${proxy.port}`); return { status: "working", attempts: 3, successes: 3, ip: "203.0.113.1" }; };
  let stopped = 0;
  const kernels = {
    startTemporary: async (entries: Array<{ tag: string }>) => ({
      process: { pid: 1, spec: {} as any, exited: new Promise<number>(() => {}), stop: () => { stopped++; } },
      specs: new Map(entries.map((entry, i) => [entry.tag, { type: "socks5" as const, host: "127.0.0.1", port: String(40000 + i), user: "k", pass: "k" }])),
    }),
  };
  const { handleProxyPoolRequest } = await import("./proxy-pool-api.ts");
  const run = (deps: object) => handleProxyPoolRequest(new Request("http://localhost/ui/api/proxy-pool/check", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), store, options, { assign: async () => null, ...deps }).then((r) => r.text());
  await run({ kernels });
  expect(checked.sort()).toEqual(["socks5://127.0.0.1:40000", "socks5://198.51.100.9:1080"]);
  expect(stopped).toBe(1);
  expect(store.proxyPool.get(kernelNode!.id)!.check!.status).toBe("working");
  checked.length = 0;
  await run({});
  expect(checked).toEqual(["socks5://198.51.100.9:1080"]);
  expect(store.proxyPool.get(kernelNode!.id)!.check).toMatchObject({ status: "unavailable" });
  expect(store.proxyPool.get(plain!.id)!.check!.status).toBe("working");
});

test("switching goes through one route; each stop reason has its own status, and history lists who changed what", async () => {
  const { store } = setup();
  const { handleProxyPoolRequest } = await import("./proxy-pool-api.ts");
  const { ProxySwitchError } = await import("./proxy-switch.ts");
  const calls: string[] = [];
  let failWith: InstanceType<typeof ProxySwitchError> | null = null;
  const deps = {
    assign: async () => null,
    switchProxy: async (profileId: string, nodeId: string, by: string) => {
      calls.push(`${profileId} ${nodeId} ${by}`);
      if (failWith) throw failWith;
      store.proxyPool.recordSwitch({ profileId, at: 5, by, from: "a", to: "b", outcome: "reopened" });
      return { applied: "reopened" as const, previous: "a", next: "b", sharedWith: [] };
    },
  };
  const call = (path: string, body?: unknown) => handleProxyPoolRequest(new Request(`http://localhost/ui/api/proxy-pool${path}`, body === undefined
    ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), store, {}, deps);
  expect(await (await call("/switch", { profileId: "p1", nodeId: "n1" })).json()).toEqual({ ok: true, applied: "reopened", previous: "a", next: "b", sharedWith: [] });
  expect(calls).toEqual(["p1 n1 dashboard"]);
  for (const [code, status] of [["rate_limited", 429], ["pool_exhausted", 409], ["switch_check_failed", 422], ["exit_is_direct", 500]] as const) {
    failWith = new ProxySwitchError(code, "stopped", code === "rate_limited" ? { retryAfterMs: 1000 } : {});
    const response = await call("/switch", { profileId: "p1", nodeId: "n1" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code, ...(code === "rate_limited" ? { retryAfterMs: 1000 } : {}) });
  }
  expect(await (await call("/history?profileId=p1")).json()).toEqual({ ok: true, history: [{ profileId: "p1", at: 5, by: "dashboard", from: "a", to: "b", outcome: "reopened" }] });
});

test("runPoolChecks bisects kernel batch failures to isolate broken nodes while checking healthy siblings", async () => {
  const { store } = setup();
  const { parseSubscription } = await import("./subscription.ts");
  const { runPoolChecks } = await import("./proxy-pool-api.ts");
  const { KernelBinaryError } = await import("./kernel.ts");
  const parsed = parseSubscription([
    "anytls://A@n1.example:443#N1",
    "anytls://B@bad1.example:443#BAD1",
    "anytls://C@n2.example:443#N2",
    "anytls://D@bad2.example:443#BAD2",
    "anytls://E@n3.example:443#N3",
  ].join("\n"));
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/bisect" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const all = store.proxyPool.list();
  const badIds = new Set(all.filter((n) => n.name.startsWith("BAD")).map((n) => n.id));

  let startCalls = 0;
  let binaryBroken = false;
  const kernels = {
    startTemporary: async (entries: Array<{ tag: string }>) => {
      startCalls++;
      if (binaryBroken) throw new KernelBinaryError("binary missing");
      if (entries.some((entry) => badIds.has(entry.tag))) {
        throw new Error("invalid reality public key");
      }
      return {
        process: { pid: 1, spec: {} as any, exited: new Promise<number>(() => {}), stop: () => {} },
        specs: new Map(entries.map((entry, i) => [entry.tag, { type: "socks5" as const, host: "127.0.0.1", port: String(41000 + i), user: entry.tag, pass: "k" }])),
      };
    },
  };

  const events: string[] = [];
  await runPoolChecks(store, all, {
    kernels,
    direct: async () => null,
    check: async (proxy) => ({
      status: "working",
      attempts: 3,
      successes: 3,
      ip: `203.0.113.${proxy.port.slice(-1)}`,
      timezone: "Asia/Tokyo",
    }),
    onResult: (node) => events.push(node.name),
  });

  expect(startCalls).toBeGreaterThan(1);
  expect(events.sort()).toEqual(["BAD1", "BAD2", "N1", "N2", "N3"]);
  for (const node of store.proxyPool.list()) {
    if (badIds.has(node.id)) {
      expect(node.check).toMatchObject({ status: "failed", reason: "connection_failed" });
    } else {
      expect(node.check).toMatchObject({ status: "working", timezone: "Asia/Tokyo" });
    }
  }

  // KernelBinaryError short-circuits without bisecting (1 startTemporary call only).
  startCalls = 0;
  binaryBroken = true;
  await runPoolChecks(store, all, { kernels, direct: async () => null });
  expect(startCalls).toBe(1);
  for (const node of store.proxyPool.list()) {
    expect(node.check).toMatchObject({ status: "unavailable", reason: "check_unavailable" });
  }
});

test("subscription routes accept and update refreshHours", async () => {
  const { store } = setup();
  const { parseSubscription } = await import("./subscription.ts");
  const { handleProxyPoolRequest } = await import("./proxy-pool-api.ts");
  const fetchSubscription = (async () => ({
    parsed: parseSubscription("vless://11111111-2222-3333-4444-555555555555@jp.example:443?security=tls#JP"),
    usage: undefined,
  })) as any;
  const call = (path: string, body?: unknown) => handleProxyPoolRequest(new Request(`http://localhost/ui/api/proxy-pool${path}`, body === undefined
    ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  store, {}, { assign: async () => null, fetchSubscription });

  const added = await (await call("/subscriptions/add", { url: "https://sub.example/s1", name: "Sub 1", refreshHours: 12 })).json();
  expect(added.subscription.refreshHours).toBe(12);

  const updated = await (await call("/subscriptions/update", { id: added.subscription.id, refreshHours: 24, name: "Sub One" })).json();
  expect(updated).toMatchObject({ ok: true, subscription: { name: "Sub One", refreshHours: 24 } });

  const disabled = await (await call("/subscriptions/update", { id: added.subscription.id, refreshHours: null })).json();
  expect(disabled.subscription.refreshHours).toBeNull();

  expect((await call("/subscriptions/update", { id: added.subscription.id, refreshHours: 999 })).status).toBe(400);
});

test("aborted pool check stops cleanly without emitting done and drainPoolTasks awaits active checks", async () => {
  const { store } = setup();
  const { drainPoolTasks, handleProxyPoolRequest } = await import("./proxy-pool-api.ts");
  const { added } = store.proxyPool.importText("10.1.0.1:8080#N1\n10.1.0.2:8080#N2");
  const releases: Array<() => void> = [];
  let firstStarted!: () => void;
  const started = new Promise<void>((r) => { firstStarted = r; });
  const shutdown = new AbortController();

  const response = await handleProxyPoolRequest(
    new Request("http://localhost/ui/api/proxy-pool/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: added.map((n) => n.id) }),
    }),
    store,
    {
      shutdownSignal: shutdown.signal,
      proxyCheck: async () => {
        firstStarted();
        await new Promise<void>((r) => { releases.push(r); });
        return { status: "working", attempts: 1, successes: 1 };
      },
    },
    { assign: async () => null },
  );

  await started;
  shutdown.abort();
  let drained = false;
  const drain = drainPoolTasks(store).then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  while (releases.length) releases.shift()!();
  await drain;
  expect(drained).toBe(true);
  const body = await response.text();
  expect(body).not.toContain('"type":"done"');
});

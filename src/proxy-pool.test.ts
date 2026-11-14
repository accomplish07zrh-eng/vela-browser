import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  checkPoolNodes,
  defaultMaxProfiles,
  parsePoolSelection,
  planPoolAssignment,
  poolNodeViews,
  poolUsage,
  ProxyPool,
  ProxyPoolError,
  regionHintFromName,
  type PoolNode,
  type PoolProfileRef,
} from "./proxy-pool.ts";
import type { ProxySpec } from "./types.ts";

const pool = () => new ProxyPool(new Database(":memory:"), (() => { let t = 1_000; return () => t++; })());
const spec = (host: string, user = "", pass = "", type: ProxySpec["type"] = "http", port = "8080"): ProxySpec => ({ type, host, port, user, pass });
const profile = (id: string, proxy: ProxySpec | null): PoolProfileRef => ({ id, name: `p-${id}`, group: "g", proxy });

test("import takes URLs and host:port:user:pass lines, names after #, and skips blanks and comments", () => {
  const p = pool();
  const result = p.importText([
    "socks5://u1:p%3A1@10.0.0.1:1080#🇯🇵 东京 01",
    "",
    "// a comment",
    "10.0.0.2:3128:u2:pass:with:colons#HK-02",
    "https://10.0.0.3:8443",
  ].join("\n"), { type: "http", tags: ["residential", "residential", " team-a "] });
  expect(result.invalid).toEqual([]);
  expect(result.duplicates).toBe(0);
  const [a, b, c] = result.added;
  expect(a!.proxy).toEqual(spec("10.0.0.1", "u1", "p:1", "socks5", "1080"));
  expect(a!.name).toBe("🇯🇵 东京 01");
  expect(a!.regionHint).toBe("JP");
  expect(b!.proxy).toEqual(spec("10.0.0.2", "u2", "pass:with:colons", "http", "3128"));
  expect(b!.regionHint).toBe("HK");
  expect(c!.proxy).toEqual(spec("10.0.0.3", "", "", "https", "8443"));
  expect(c!.name).toBe("10.0.0.3:8443");
  for (const node of result.added) {
    expect(node.tags).toEqual(["residential", "team-a"]);
    expect(node.kind).toBe("manual");
    expect(node.maxProfiles).toBe(1);
  }
  expect(p.list().map((node) => node.id)).toEqual(result.added.map((node) => node.id));
});

test("import reports bad lines by number and never adds a proxy twice", () => {
  const p = pool();
  p.importText("10.0.0.1:8080:u:p");
  const result = p.importText([
    "10.0.0.1:8080:u:p",          // already in the pool
    "10.0.0.9:8080",
    "10.0.0.9:8080#same again",   // repeats line 2
    "not a proxy",
    "ftp://10.0.0.5:21",
    "10.0.0.1:8080:u:other",      // same host, other credentials: another proxy
  ].join("\n"));
  expect(result.added.map((node) => node.proxy.host + ":" + node.proxy.user)).toEqual(["10.0.0.9:", "10.0.0.1:u"]);
  expect(result.duplicates).toBe(2);
  expect(result.invalid.map((row) => row.line)).toEqual([4, 5]);
  expect(() => p.importText("   ")).toThrow(ProxyPoolError);
});

test("sharing limits follow where a node came from: hand-added is exclusive, a provider's is shared", () => {
  expect(defaultMaxProfiles("manual")).toBe(1);
  expect(defaultMaxProfiles("provider")).toBeNull();
  const p = pool();
  expect(p.importText("10.0.0.1:8080", { kind: "provider" }).added[0]!.maxProfiles).toBeNull();
});

test("a node's name, tags, limit and disabled state change; its proxy never does", () => {
  const p = pool();
  const node = p.importText("10.0.0.1:8080:u:p#old").added[0]!;
  const updated = p.update(node.id, { name: " 美西 LA ", tags: ["a"], maxProfiles: 3, disabled: true });
  expect(updated).toMatchObject({ name: "美西 LA", tags: ["a"], maxProfiles: 3, disabled: true, regionHint: "US" });
  expect(p.get(node.id)).toMatchObject({ name: "美西 LA", maxProfiles: 3, disabled: true });
  expect(p.update(node.id, { maxProfiles: null }).maxProfiles).toBeNull();
  for (const bad of [{ host: "10.9.9.9" }, { proxy: spec("x") }, { pass: "x" }, { maxProfiles: 0 }, { maxProfiles: 1.5 }, { name: "" }, { disabled: "yes" }]) {
    expect(() => p.update(node.id, bad)).toThrow(ProxyPoolError);
  }
  expect(p.get(node.id)!.proxy).toEqual(spec("10.0.0.1", "u", "p"));
  expect(() => p.update("missing", { name: "x" })).toThrow(ProxyPoolError);
});

test("which profiles use a node is read from their proxies, credentials included", () => {
  const p = pool();
  const [a, b] = p.importText("10.0.0.1:8080:u:p\n10.0.0.2:8080").added;
  const profiles = [
    profile("1", spec("10.0.0.1", "u", "p")),
    profile("2", spec("10.0.0.1", "u", "OTHER")),
    profile("3", spec("10.0.0.2")),
    profile("4", spec("10.0.0.2")),
    profile("5", null),
  ];
  const usage = poolUsage(p.list(), profiles);
  expect(usage.get(a!.id)!.map((x) => x.id)).toEqual(["1"]);
  expect(usage.get(b!.id)!.map((x) => x.id)).toEqual(["3", "4"]);
});

test("node views never carry credentials, and show nodes that left through the same IP", () => {
  const p = pool();
  const [a, b, c] = p.importText("10.0.0.1:8080:secret-user:secret-pass\n10.0.0.2:8080\n10.0.0.3:8080").added;
  p.recordCheck(a!.id, { status: "working", ip: "203.0.113.5", checkedAt: 1 });
  p.recordCheck(b!.id, { status: "working", ip: "203.0.113.5", checkedAt: 1 });
  p.recordCheck(c!.id, { status: "working", ip: "203.0.113.6", checkedAt: 1 });
  const views = poolNodeViews(p.list(), [profile("1", spec("10.0.0.1", "secret-user", "secret-pass"))]);
  const text = JSON.stringify(views);
  expect(text).not.toContain("secret-user");
  expect(text).not.toContain("secret-pass");
  expect(views[0]).toMatchObject({ proxy: "http://10.0.0.1:8080", hasAuth: true, profiles: [{ id: "1", name: "p-1", group: "g" }], sameExitAs: [b!.id] });
  expect(views[2]!.sameExitAs).toEqual([]);
});

test("removing a node leaves profiles with the proxy they have", () => {
  const p = pool();
  const [a] = p.importText("10.0.0.1:8080").added;
  expect(p.remove([a!.id, "missing"])).toBe(1);
  expect(p.list()).toEqual([]);
});

test("names say where nodes are: flags, place names and capital codes; English words are not codes", () => {
  expect(regionHintFromName("🇺🇸 Los Angeles 01")).toBe("US");
  expect(regionHintFromName("🇬🇧 London")).toBe("GB");
  expect(regionHintFromName("香港 IPLC 02")).toBe("HK");
  expect(regionHintFromName("SG新加坡-01")).toBe("SG");
  expect(regionHintFromName("JP|01")).toBe("JP");
  expect(regionHintFromName("美西 高速")).toBe("US");
  expect(regionHintFromName("印尼 01")).toBe("ID");
  expect(regionHintFromName("印度 01")).toBe("IN");
  expect(regionHintFromName("node in a box")).toBeUndefined();
  expect(regionHintFromName("ca-backup id 7")).toBeUndefined();
  expect(regionHintFromName("10.0.0.1:8080")).toBeUndefined();
});

function nodes(count: number, opts: Partial<PoolNode> = {}): PoolNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`, name: `node ${i}`, kind: "manual" as const, proxy: spec(`10.0.1.${i}`), protocol: "http" as const, tags: [], maxProfiles: 1,
    disabled: false, check: { status: "working" as const, country: "US", durationMs: 100 + i, checkedAt: 1 }, createdAt: i, ...opts,
  }));
}

test("assignment gives each profile its own exclusive node and reports when the pool runs out", () => {
  const pool = nodes(2);
  const selected = [profile("a", null), profile("b", spec("9.9.9.9")), profile("c", null)];
  const plan = planPoolAssignment(selected, pool, selected, {});
  expect(plan.map((row) => [row.profileId, row.node?.id ?? null, row.code ?? null])).toEqual([
    ["a", "n0", null], ["b", "n1", null], ["c", null, "pool_exhausted"],
  ]);
});

test("assignment keeps a profile on the fitting node it already uses", () => {
  const pool = nodes(3);
  const all = [profile("a", spec("10.0.1.2")), profile("b", null)];
  const plan = planPoolAssignment(all, pool, all, {});
  expect(plan.find((row) => row.profileId === "a")).toMatchObject({ code: "unchanged", node: { id: "n2" } });
  expect(plan.find((row) => row.profileId === "b")!.node!.id).toBe("n0");
});

test("assignment counts profiles outside the selection, and picks the least-used node with room", () => {
  const pool = nodes(2, { maxProfiles: 2 });
  const outside = [profile("x", spec("10.0.1.0")), profile("y", spec("10.0.1.0"))];
  const selected = [profile("a", null), profile("b", null), profile("c", null)];
  const plan = planPoolAssignment(selected, pool, [...outside, ...selected], {});
  expect(plan.map((row) => row.node?.id ?? row.code)).toEqual(["n1", "n1", "pool_exhausted"]);
  // A node with no limit takes everyone.
  const open = planPoolAssignment(selected, nodes(1, { maxProfiles: null }), selected, {});
  expect(open.map((row) => row.node?.id)).toEqual(["n0", "n0", "n0"]);
});

test("assignment filters by node, country, tag and health, and never uses a disabled node", () => {
  const pool: PoolNode[] = [
    ...nodes(1, { id: "us", tags: ["team"] }),
    ...nodes(1, { id: "jp", proxy: spec("10.0.2.1"), check: { status: "working", country: "JP", checkedAt: 1 }, tags: ["team"] }),
    ...nodes(1, { id: "dead", proxy: spec("10.0.2.2"), check: { status: "failed", country: "US", checkedAt: 1 } }),
    ...nodes(1, { id: "never", proxy: spec("10.0.2.3"), check: undefined, regionHint: "JP" }),
    ...nodes(1, { id: "off", proxy: spec("10.0.2.4"), disabled: true }),
  ];
  const one = [profile("a", null)];
  const pick = (selection: object) => planPoolAssignment(one, pool, one, parsePoolSelection(selection))[0]!.node?.id ?? null;
  expect(pick({ country: "jp" })).toBe("jp");
  expect(pick({ country: "JP", onlyWorking: false, nodeIds: ["never"] })).toBe("never");
  expect(pick({ nodeIds: ["never"] })).toBeNull();
  expect(pick({ nodeIds: ["dead"] })).toBeNull();
  expect(pick({ nodeIds: ["off"], onlyWorking: false })).toBeNull();
  expect(pick({ tag: "team", country: "US" })).toBe("us");
  for (const bad of ['{"country":"USA"}', "not json", { extra: 1 }, { nodeIds: "n0" }, { onlyWorking: "yes" }]) {
    expect(() => parsePoolSelection(bad)).toThrow(ProxyPoolError);
  }
});

test("checks record each node's result, with the shared direct address and a failure as unavailable", async () => {
  const p = pool();
  const [a, b] = p.importText("10.0.0.1:8080\nhttps://10.0.0.2:8443").added;
  const seen: string[] = [];
  let clock = 0;
  await checkPoolNodes(p, p.list(), {
    direct: async () => ({ ip: "198.51.100.1" }),
    check: async (proxy, opts) => {
      expect(opts.direct).toEqual({ ip: "198.51.100.1" });
      if (proxy.type === "https") throw new Error("boom");
      clock += 250;
      return { status: "working", attempts: 3, successes: 3, ip: "203.0.113.9", country: "US", city: "X", rotating: false };
    },
    onResult: (node) => seen.push(node.id),
    now: () => clock,
  });
  expect(seen.sort()).toEqual([a!.id, b!.id].sort());
  expect(p.get(a!.id)!.check).toMatchObject({ status: "working", ip: "203.0.113.9", country: "US", durationMs: 250 });
  expect(p.get(b!.id)!.check).toMatchObject({ status: "unavailable", reason: "check_unavailable" });
});

import { parseSubscription } from "./subscription.ts";

const SUB_V1 = [
  "vless://11111111-2222-3333-4444-555555555555@jp.node.example:443?security=tls&sni=jp.node.example#%F0%9F%87%AF%F0%9F%87%B5%20JP",
  "anytls://ANYPASS@sg.node.example:443?sni=sg.node.example#SG",
  "socks5://su:sp@198.51.100.9:1080#plain",
].join("\n");

test("a subscription's nodes join the pool as shared provider nodes; kernel ones are reached by id", () => {
  const p = pool();
  const sub = p.addSubscription({ url: "https://sub.example/token-secret" });
  const parsed = parseSubscription(SUB_V1);
  expect(p.syncSubscription(sub.id, parsed.nodes, parsed)).toEqual({ added: 3, kept: 0, removed: 0 });
  const [jp, sg, plain] = p.list();
  expect(jp).toMatchObject({ kind: "provider", maxProfiles: null, protocol: "vless", subscriptionId: sub.id, regionHint: "JP" });
  expect(jp!.proxy).toEqual({ type: "pool", host: jp!.id, port: "0", user: "", pass: "" });
  expect(jp!.outbound).toMatchObject({ type: "vless", server: "jp.node.example" });
  expect(sg!.protocol).toBe("anytls");
  // A plain SOCKS5 node needs no kernel: profiles get the proxy itself.
  expect(plain).toMatchObject({ protocol: "socks5", proxy: { type: "socks5", host: "198.51.100.9", port: "1080", user: "su", pass: "sp" } });
  expect(plain!.outbound).toBeUndefined();
  // Views never carry credentials or the link.
  const views = poolNodeViews(p.list(), []);
  expect(views.map((v) => v.proxy)).toEqual(["vless://jp.node.example:443", "anytls://sg.node.example:443", "socks5://198.51.100.9:1080"]);
  const text = JSON.stringify(views);
  for (const secret of ["11111111-2222-3333-4444-555555555555", "ANYPASS", "sp", "token-secret"]) expect(text).not.toContain(secret);
});

test("refreshing keeps listed nodes, adds new ones, and marks gone ones without removing them", () => {
  const p = pool();
  const sub = p.addSubscription({ url: "https://sub.example/a" });
  const first = parseSubscription(SUB_V1);
  p.syncSubscription(sub.id, first.nodes, first);
  const before = p.list();
  const second = parseSubscription([
    "vless://11111111-2222-3333-4444-555555555555@jp.node.example:443?security=tls&sni=jp.node.example#renamed%20by%20provider",
    "trojan://NEW@tw.node.example:443?sni=tw.node.example#TW",
  ].join("\n"));
  expect(p.syncSubscription(sub.id, second.nodes, second)).toEqual({ added: 1, kept: 1, removed: 2 });
  const after = p.list();
  // The JP node keeps its id, so profiles on it stay on it.
  expect(after.find((n) => n.id === before[0]!.id)!.removedFromSource).toBeUndefined();
  expect(after.filter((n) => n.removedFromSource).map((n) => n.id).sort()).toEqual([before[1]!.id, before[2]!.id].sort());
  expect(after.map((n) => n.protocol)).toContain("trojan");
  // A node whose credentials changed is a different node: the old one stays for the profiles on it.
  const third = parseSubscription("vless://99999999-2222-3333-4444-555555555555@jp.node.example:443?security=tls&sni=jp.node.example#JP");
  expect(p.syncSubscription(sub.id, third.nodes, third)).toEqual({ added: 1, kept: 0, removed: 2 });
  expect(p.get(before[0]!.id)!.removedFromSource).toBe(true);
  expect(p.getSubscription(sub.id)!.lastImport).toMatchObject({ nodes: 1, added: 1 });
});

test("removing a subscription removes its unused nodes and keeps the ones profiles use", () => {
  const p = pool();
  const sub = p.addSubscription({ url: "https://sub.example/a" });
  const parsed = parseSubscription(SUB_V1);
  p.syncSubscription(sub.id, parsed.nodes, parsed);
  const [jp] = p.list();
  expect(p.removeSubscription(sub.id, (node) => node.id === jp!.id)).toEqual({ removedNodes: 2, keptNodes: 1 });
  expect(p.list().map((n) => [n.id, n.removedFromSource, n.subscriptionId])).toEqual([[jp!.id, true, undefined]]);
  expect(p.listSubscriptions()).toEqual([]);
});

test("subscriptions need an https link, once", () => {
  const p = pool();
  expect(() => p.addSubscription({ url: "http://sub.example/a" })).toThrow("https");
  expect(() => p.addSubscription({ url: "not a url" })).toThrow("valid URL");
  p.addSubscription({ url: "https://sub.example/a" });
  expect(() => p.addSubscription({ url: "https://sub.example/a" })).toThrow("already");
});

test("a pool node id is a proxy no one can connect to directly", () => {
  const p = pool();
  expect(p.importText("pool://00000000-0000-0000-0000-000000000000:0").invalid.length).toBe(1);
});

test("switch history retains at most the newest 100 entries per profile", () => {
  const p = pool();
  for (let i = 1; i <= 105; i++) {
    p.recordSwitch({ profileId: "p1", at: i, by: "dashboard", from: `old-${i}`, to: `new-${i}`, outcome: "saved" });
  }
  p.recordSwitch({ profileId: "p2", at: 1, by: "dashboard", from: "a", to: "b", outcome: "saved" });
  const history1 = p.switchHistory("p1", 200);
  expect(history1).toHaveLength(100);
  expect(history1[0]!.to).toBe("new-105");
  expect(history1.at(-1)!.to).toBe("new-6");
  expect(p.switchHistory("p2", 10)).toHaveLength(1);
});

test("planPoolAssignment avoids already-occupied exit IPs when distinctExitIp is enabled and keeps unknown-IP nodes flexible", () => {
  const p = pool();
  const nodes = p.importText([
    "http://10.0.0.1:8080#exit10-a",
    "http://10.0.0.2:8080#exit10-b",
    "http://10.0.0.3:8080#exit10-v6mapped",
    "http://10.0.0.4:8080#exit11",
    "http://10.0.0.5:8080#unchecked-1",
    "http://10.0.0.6:8080#unchecked-2",
  ].join("\n")).added;
  for (const n of nodes) p.update(n.id, { maxProfiles: 2 });
  p.recordCheck(nodes[0]!.id, { status: "working", ip: "198.51.100.10", timezone: "America/New_York", checkedAt: 1, durationMs: 10 });
  p.recordCheck(nodes[1]!.id, { status: "working", ip: "198.51.100.10", checkedAt: 1, durationMs: 20 });
  p.recordCheck(nodes[2]!.id, { status: "working", ip: "::ffff:198.51.100.10", checkedAt: 1, durationMs: 30 });
  p.recordCheck(nodes[3]!.id, { status: "working", ip: "198.51.100.11", checkedAt: 1, durationMs: 40 });
  p.update(nodes[3]!.id, { tags: ["vip"] });
  // Outside profile already occupies 198.51.100.11 via an unrelated disabled node sharing the same exit IP.
  const [outsideNode] = p.importText("http://10.0.0.7:8080#outside").added;
  p.update(outsideNode!.id, { disabled: true });
  p.recordCheck(outsideNode!.id, { status: "working", ip: "198.51.100.11", checkedAt: 1 });

  const allNodes = p.list();
  const out = profile("out", outsideNode!.proxy);
  const p1 = profile("p1", null);
  const p2 = profile("p2", null);

  // Off by default: both p1 and p2 can get 198.51.100.10 nodes.
  const defaultPlan = planPoolAssignment([p1, p2], allNodes, [out, p1, p2], {});
  expect(defaultPlan.map((a) => a.node?.name)).toEqual(["exit10-a", "exit10-b"]);

  // distinctExitIp: p1 takes exit10-a (198.51.100.10); exit10-b & exit10-v6mapped share that IP, and exit11 is occupied by `out`, so p2 is exhausted.
  const distinctPlan = planPoolAssignment([p1, p2], allNodes, [out, p1, p2], { distinctExitIp: true });
  expect(distinctPlan[0]!.node?.name).toBe("exit10-a");
  expect(distinctPlan[1]!.code).toBe("pool_exhausted");

  // With onlyWorking: false, unchecked nodes are treated as unknown and can fill remaining profiles up to maxProfiles.
  const withUnknown = planPoolAssignment([p1, p2], allNodes, [out, p1, p2], { onlyWorking: false, distinctExitIp: true });
  expect(withUnknown.map((a) => a.node?.name)).toEqual(["exit10-a", "unchecked-1"]);
  expect(parsePoolSelection({ distinctExitIp: true })).toEqual({ distinctExitIp: true });
  expect(() => parsePoolSelection({ distinctExitIp: "yes" })).toThrow("Invalid pool selection");
});

test("subscription refreshHours validates bounds and lists only due readable subscriptions", () => {
  let clock = 10_000_000;
  const p = new ProxyPool(new Database(":memory:"), () => clock);
  expect(() => p.addSubscription({ url: "https://sub.example/bad", refreshHours: 0 })).toThrow("between 1 and 720");
  expect(() => p.addSubscription({ url: "https://sub.example/bad2", refreshHours: 721 })).toThrow("between 1 and 720");
  expect(() => p.addSubscription({ url: "https://sub.example/bad3", refreshHours: 1.5 })).toThrow("between 1 and 720");

  const subAuto = p.addSubscription({ url: "https://sub.example/auto", refreshHours: 6 });
  const subManual = p.addSubscription({ url: "https://sub.example/manual" });
  expect(subAuto.refreshHours).toBe(6);
  expect(subManual.refreshHours).toBeNull();
  // Initially never fetched -> due.
  expect(p.listDueSubscriptions(clock).map((s) => s.id)).toEqual([subAuto.id]);

  // Sync sets lastFetchedAt to `clock`; not due until +6h.
  const parsed = parseSubscription(SUB_V1);
  p.syncSubscription(subAuto.id, parsed.nodes, parsed);
  expect(p.listDueSubscriptions(clock + 5 * 3_600_000)).toEqual([]);
  expect(p.listDueSubscriptions(clock + 6 * 3_600_000).map((s) => s.id)).toEqual([subAuto.id]);

  // Turning off / changing refreshHours via updateSubscription.
  expect(p.updateSubscription(subAuto.id, { refreshHours: 12 }).refreshHours).toBe(12);
  expect(p.listDueSubscriptions(clock + 6 * 3_600_000)).toEqual([]);
  expect(p.updateSubscription(subAuto.id, { refreshHours: null }).refreshHours).toBeNull();

  // Private/loopback subscription URLs are rejected.
  expect(() => p.addSubscription({ url: "https://127.0.0.1/private" })).toThrow();
  expect(() => p.addSubscription({ url: "https://localhost/private" })).toThrow();
});

test("legacy schema migration, switch-history pruning, failure backoff, monotonic recordCheck, and removedFromSource planning", () => {
  const db = new Database(":memory:");
  // Simulate pre-0.1.8 schema without refresh_hours / retry_after / failure_count and > 100 switch history rows.
  db.exec(`
    CREATE TABLE proxy_subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      last_fetched_at INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      usage_json TEXT NOT NULL DEFAULT '',
      last_import_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE proxy_switch_history (
      profile_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      by_whom TEXT NOT NULL,
      from_label TEXT NOT NULL,
      to_label TEXT NOT NULL,
      outcome TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      exit_country TEXT NOT NULL DEFAULT ''
    );
  `);
  for (let i = 1; i <= 115; i++) {
    db.query(`INSERT INTO proxy_switch_history (profile_id, at, by_whom, from_label, to_label, outcome) VALUES ('p1', ?, 'dashboard', 'a', 'b', 'saved')`).run(i);
  }
  let clock = 5_000_000;
  const p = new ProxyPool(db, () => clock);
  // Startup pruning trims oversized history to 100 newest rows per profile.
  expect(p.switchHistory("p1", 200)).toHaveLength(100);
  expect(p.switchHistory("p1", 100)[99]!.at).toBe(16);

  // Migrated subscription columns work, failure backoff defers retries without wiping lastFetchedAt.
  const sub = p.addSubscription({ url: "https://sub.example/migrated", refreshHours: 6 });
  const parsed = parseSubscription("vless://11111111-2222-3333-4444-555555555555@jp.example:443?security=tls#JP");
  p.syncSubscription(sub.id, parsed.nodes, parsed);
  const fetchedAt = clock;
  clock += 6 * 3_600_000;
  p.recordSubscriptionFailure(sub.id, "The subscription could not be downloaded");
  const failedSub = p.getSubscription(sub.id)!;
  expect(failedSub.lastFetchedAt).toBe(fetchedAt);
  const storedFailureCount = db.query<{ failure_count: number }, [string]>(
    `SELECT failure_count FROM proxy_subscriptions WHERE id = ?`,
  ).get(sub.id)!.failure_count;
  expect(storedFailureCount).toBe(1);
  // First failure backs off for 5 minutes from `clock`.
  expect(p.listDueSubscriptions(clock + 60_000)).toEqual([]);
  expect(p.listDueSubscriptions(clock + 5 * 60_000).map((s) => s.id)).toEqual([sub.id]);

  // recordCheck ignores older timestamps, and removedFromSource nodes are skipped in planning.
  const [node] = p.importText("10.0.0.9:8080#Test").added;
  p.recordCheck(node!.id, { status: "working", ip: "198.51.100.9", country: "US", checkedAt: 200 });
  p.recordCheck(node!.id, { status: "failed", reason: "timeout", checkedAt: 100 });
  expect(p.get(node!.id)!.check).toMatchObject({ status: "working", checkedAt: 200 });

  const removedNode: PoolNode = { ...node!, removedFromSource: true };
  expect(planPoolAssignment([profile("p1", null)], [removedNode], [profile("p1", null)], { onlyWorking: true })[0]!.node).toBeUndefined();
});

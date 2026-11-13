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
    id: `n${i}`, name: `node ${i}`, kind: "manual" as const, proxy: spec(`10.0.1.${i}`), tags: [], maxProfiles: 1,
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

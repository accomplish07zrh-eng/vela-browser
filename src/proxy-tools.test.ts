import { afterEach, expect, test } from "bun:test";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { handleUiRequest, type UiRuntimeOptions } from "./ui.ts";
import { CloudApiError } from "./cloud-client.ts";
import type { Launcher } from "./launcher.ts";
import type { ProxyPreview, ProxyProgressEvent } from "./proxy-tools-types.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const proxy = { type: "http" as const, host: "old.example", port: "8080", user: "test-user", pass: "test-private-proxy" };
function setup(ids = ["p1", "p2"]) {
  const store = new ProfileStore(":memory:"); stores.push(store);
  for (const id of ids) store.upsertProfile({ ...buildNewProfile({ name: id, group: "folder", proxy }, () => false), id });
  const blocked = new Set<string>();
  const launcher = { cacheCleanupSettled: async () => {}, profileDeletionBlocked: (id: string) => blocked.has(id) } as unknown as Launcher;
  const options: UiRuntimeOptions = { timezoneFetch: async () => new Response('{"status":"success","timezone":"Europe/London"}') };
  const request = (action: string, body: unknown, extra: UiRuntimeOptions = options, headers = { "Content-Type": "application/json" }) =>
    handleUiRequest(new Request(`http://localhost/ui/api/proxies/${action}`, { method: "POST", headers, body: JSON.stringify(body) }), launcher, store, null, extra).then((r) => r!);
  const preview = async () => (await request("preview", { scope: { all: true }, mode: "list", input: "new.example:9000\nnew.example:9001" })).json() as Promise<ProxyPreview>;
  return { store, launcher, blocked, options, request, preview };
}
async function events(response: Response): Promise<ProxyProgressEvent[]> {
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
}

test("preview changes nothing; apply changes only the reviewed proxies and retains sessions", async () => {
  const { store, request, preview } = setup();
  store.saveSessionBundle("p1", "saved-session");
  const before = store.getProfile("p1")!;
  const result = await preview();
  expect(store.getProfile("p1")).toEqual(before);
  expect(JSON.stringify(result)).not.toContain("test-private-proxy");
  expect(result.rows.every((r) => r.status === "ready")).toBe(true);
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(output.filter((e) => e.type === "replacement").map((e) => e.row.status)).toEqual(["updated", "updated"]);
  const after = store.getProfile("p1")!;
  expect(after.proxy!.host).toBe("new.example");
  expect(after.fingerprintSeed).toBe(before.fingerprintSeed);
  expect(after.cookies).toEqual(before.cookies);
  expect(store.getSessionBundle("p1")).toBe("saved-session");
});

test("stale and running rows are skipped independently; failed-only retry requires a new preview", async () => {
  const { store, request, preview, blocked } = setup();
  const result = await preview();
  const changed = store.getProfile("p1")!;
  changed.proxy = { ...proxy, port: "9999" }; store.upsertProfile(changed);
  blocked.add("p2");
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.filter((e) => e.type === "replacement").map((e) => e.row.code)).toEqual(["version_conflict", "profile_open"]);
  blocked.clear();
  const retried = await (await request("retry-preview", { previewId: result.previewId, ids: ["p2"] })).json();
  expect(retried.previewId).not.toBe(result.previewId);
  expect(retried.rows.map((r: any) => r.profileId)).toEqual(["p2"]);
  expect((await request("apply", { previewId: result.previewId })).status).toBe(409);
  await events(await request("apply", { previewId: retried.previewId }));
  expect(store.getProfile("p1")!.proxy!.port).toBe("9999");
  expect(store.getProfile("p2")!.proxy!.port).toBe("9001");
});

test("bulk replacements set the new proxy's timezone and keep the saved one when the lookup fails", async () => {
  for (const [body, timezone] of [['{"status":"success","timezone":"Europe/Paris"}', "Europe/Paris"], ["{}", "America/Los_Angeles"]] as const) {
    const { store, request, preview, options } = setup(["p1"]);
    const before = store.getProfile("p1")!;
    before.timezone = "America/Los_Angeles";
    store.upsertProfile(before);
    options.timezoneFetch = async () => new Response(body);
    const result = await preview();
    const output = await events(await request("apply", { previewId: result.previewId }));
    expect(output.find((e) => e.type === "replacement")?.row.status).toBe("updated");
    expect(store.getProfile("p1")!.proxy!.host).toBe("new.example");
    expect(store.getProfile("p1")!.timezone).toBe(timezone);
  }
});

test("a profile starting while timezone lookup runs is never changed", async () => {
  const { store, request, preview, blocked, options } = setup(["p1"]);
  options.timezoneFetch = async () => { blocked.add("p1"); return new Response("{}"); };
  const result = await preview();
  const output = await events(await request("apply", { previewId: result.previewId }));
  expect(output.find((e) => e.type === "replacement")?.row.code).toBe("profile_open");
  expect(store.getProfile("p1")!.proxy!.host).toBe("old.example");
});

test("bulk checks stream redacted deduplicated results without opening a browser", async () => {
  const { request, options } = setup();
  let calls = 0;
  options.proxyCheck = async () => { calls++; return { status: "working", attempts: 3, successes: 3 }; };
  const result = await request("check", { scope: { groups: ["folder"] } });
  expect(result.headers.get("cache-control")).toBe("no-store");
  const output = await events(result);
  expect(calls).toBe(1);
  expect(output).toContainEqual({ type: "summary", selectedProfiles: 2, uniqueProxies: 1, duplicatesSkipped: 1 });
  expect(output.at(-1)).toEqual({ type: "done" });
  expect(JSON.stringify(output)).not.toContain("test-private-proxy");
});

test("bulk routes enforce JSON origin checks and never use a remote launch cache", async () => {
  const { request, launcher, store } = setup();
  expect((await request("preview", {}, {}, { "Content-Type": "application/json", Origin: "https://other.example" } as any)).status).toBe(403);
  expect((await request("preview", {}, {}, { "Content-Type": "text/plain" })).status).toBe(415);
  const response = await handleUiRequest(new Request("http://localhost/ui/api/proxies/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scope":{"all":true}}' }), launcher, store, {} as any);
  expect(response!.status).toBe(400);
});

function cloudOptions(overrides: Record<string, unknown> = {}): UiRuntimeOptions {
  return {
    cloudBrowser: {} as any,
    cloudConnection: {
      accountId: () => "account1",
      client: {
        status: async () => ({ account: { id: "account1" }, workspace: { id: "workspace1", role: "owner" } }),
        listProfileProxies: async () => ({ ok: true, profiles: [{ id: "p1", name: "p1", group: "folder", proxy, version: 5, permission: "edit", activeOpens: [] }] }),
        ...overrides,
      },
    } as any,
    proxyCheck: async () => ({ status: "working", attempts: 3, successes: 3 }),
  };
}

test("repeating apply replays completed outcomes without writing twice", async () => {
  const { request, preview, options } = setup();
  let lookups = 0;
  options.timezoneFetch = async () => { lookups++; return new Response("{}"); };
  const result = await preview();
  await events(await request("apply", { previewId: result.previewId }));
  const before = lookups;
  const replay = await events(await request("apply", { previewId: result.previewId }));
  expect(replay.filter((e) => e.type === "replacement").map((e) => e.row.status)).toEqual(["updated", "updated"]);
  expect(lookups).toBe(before);
});

test("failed retry previews show the current proxy and folder without changing assignments", async () => {
  const { request, preview, store } = setup();
  const result = await preview();
  store.upsertProfile({ ...store.getProfile("p1")!, name: "Renamed", group: "new folder", proxy: { ...proxy, host: "changed.example" } });
  await events(await request("apply", { previewId: result.previewId }));
  const retry = await (await request("retry-preview", { previewId: result.previewId, ids: ["p1"] })).json();
  expect(retry.rows).toHaveLength(1);
  expect(retry.rows[0]).toMatchObject({ name: "Renamed", group: "new folder", previousProxy: "http://changed.example:8080", proxy: "http://new.example:9000", status: "ready" });
  expect(store.getProfile("p1")!.proxy!.host).toBe("changed.example");
});

test("pool mode gives each profile its own node, keeps a profile on its node, and re-checks room when applying", async () => {
  const { store, request } = setup(["p1", "p2", "p3"]);
  const pool = store.proxyPool;
  const [a, b] = pool.importText("pool-a.example:7001:pool-user:pool-secret\npool-b.example:7002").added;
  for (const node of [a!, b!]) pool.recordCheck(node.id, { status: "working", country: "US", checkedAt: 1 });
  // p3 already uses node b.
  store.upsertProfile({ ...store.getProfile("p3")!, proxy: b!.proxy });

  const previewed = await (await request("preview", { scope: { all: true }, mode: "pool", input: JSON.stringify({ country: "US" }) })).json() as ProxyPreview;
  expect(JSON.stringify(previewed)).not.toContain("pool-secret");
  expect(previewed.rows.map((row) => [row.profileId, row.status, row.code ?? null, row.proxy])).toEqual([
    ["p1", "ready", null, "http://pool-a.example:7001"],
    ["p2", "skipped", "pool_exhausted", null],
    ["p3", "unchanged", null, "http://pool-b.example:7002"],
  ]);

  // Someone takes node a before the apply: it is full now, so p1 is skipped, not doubled up.
  store.upsertProfile({ ...store.getProfile("p2")!, proxy: a!.proxy });
  const output = await events(await request("apply", { previewId: previewed.previewId }));
  expect(output.filter((e) => e.type === "replacement").map((e) => [e.row.profileId, e.row.code ?? e.row.status]))
    .toContainEqual(["p1", "pool_exhausted"]);
  expect(store.getProfile("p1")!.proxy!.host).toBe("old.example");

  // With room again (limit raised), the same plan applies and the node's credentials go with it.
  pool.update(a!.id, { maxProfiles: 2 });
  const again = await (await request("preview", { scope: { ids: ["p1"], all: true }, mode: "pool", input: JSON.stringify({ nodeIds: [a!.id] }) })).json() as ProxyPreview;
  await events(await request("apply", { previewId: again.previewId }));
  expect(store.getProfile("p1")!.proxy).toEqual(a!.proxy);
});

test("pool mode refuses a node that left the pool after the preview, and a bad selection", async () => {
  const { store, request } = setup(["p1"]);
  const [a] = store.proxyPool.importText("pool-a.example:7001").added;
  store.proxyPool.recordCheck(a!.id, { status: "working", checkedAt: 1 });
  const previewed = await (await request("preview", { scope: { all: true }, mode: "pool", input: "{}" })).json() as ProxyPreview;
  expect(previewed.rows[0]!.status).toBe("ready");
  store.proxyPool.remove([a!.id]);
  const output = await events(await request("apply", { previewId: previewed.previewId }));
  expect(output.find((e) => e.type === "replacement")!.row.code).toBe("pool_node_unavailable");
  expect(store.getProfile("p1")!.proxy!.host).toBe("old.example");
  const bad = await request("preview", { scope: { all: true }, mode: "pool", input: '{"country":"USA"}' });
  expect(bad.status).toBe(400);
});

test("bulk pool mode pre-fills closed profile timezone from checked kernel node", async () => {
  const { store, request } = setup(["p1", "p2"]);
  const { parseSubscription } = await import("./subscription.ts");
  const parsed = parseSubscription("anytls://P@sg.node.example:443?sni=sg.node.example#SG");
  const sub = store.proxyPool.addSubscription({ url: "https://sub.example/sg" });
  store.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const kernelNode = store.proxyPool.list().find((n) => n.protocol === "anytls")!;
  store.proxyPool.recordCheck(kernelNode.id, { status: "working", country: "SG", timezone: "Asia/Singapore", checkedAt: 1 });
  store.upsertProfile({ ...store.getProfile("p2")!, timezone: "Europe/Berlin", timezoneManual: true });

  const previewed = await (await request("preview", {
    scope: { all: true },
    mode: "pool",
    input: JSON.stringify({ nodeIds: [kernelNode.id] }),
  })).json() as ProxyPreview;
  await events(await request("apply", { previewId: previewed.previewId }));

  expect(store.getProfile("p1")!.timezone).toBe("Asia/Singapore");
  expect(store.getProfile("p2")!.timezone).toBe("Europe/Berlin");
});

test("distinctExitIp blocks second node sharing an exit IP when occupied after preview", async () => {
  const { store, request } = setup(["p1", "p2"]);
  const [n1, n2] = store.proxyPool.importText("10.2.0.1:8080#Exit1\n10.2.0.2:8080#Exit2").added;
  store.proxyPool.recordCheck(n1!.id, { status: "working", ip: "198.51.100.77", country: "US", checkedAt: 1 });
  store.proxyPool.recordCheck(n2!.id, { status: "working", ip: "198.51.100.77", country: "US", checkedAt: 1 });
  // Only give p1 a single candidate so p2 would need n2 (same IP) — already filtered at preview OR raced before apply:
  const previewed = await (await request("preview", {
    scope: { all: true, ids: ["p1"] },
    mode: "pool",
    input: JSON.stringify({ nodeIds: [n1!.id], distinctExitIp: true }),
  })).json() as ProxyPreview;
  expect(previewed.rows[0]!.status).toBe("ready");

  // Meanwhile p2 takes n2, occupying exit IP 198.51.100.77 before apply runs.
  store.upsertProfile({ ...store.getProfile("p2")!, proxy: n2!.proxy });
  const output = await events(await request("apply", { previewId: previewed.previewId }));
  expect(output.find((e) => e.type === "replacement")!.row.code).toBe("pool_exhausted");
});

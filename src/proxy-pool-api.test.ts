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

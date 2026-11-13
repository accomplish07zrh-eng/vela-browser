import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dpapiProtector, SecretBox, secretBoxForDatabase, SecretUnavailableError, type KeyProtector } from "./secret-box.ts";
import { ProxyPool, subscriptionView, UNREADABLE_SUBSCRIPTION } from "./proxy-pool.ts";
import { ProfileStore } from "./store.ts";
import { parseSubscription } from "./subscription.ts";

const SUB_URL = "https://sub.example/api/v1/client/subscribe?token=TOKEN-SECRET-123";
const SUB_TEXT = [
  "vless://11111111-2222-3333-4444-555555555555@jp.node.example:443?security=tls&sni=jp.node.example#JP",
  "anytls://ANYPASS-SECRET@sg.node.example:443?sni=sg.node.example#SG",
  "socks5://su:SOCKS-PASS@198.51.100.9:1080#plain",
].join("\n");

/** Everything the database file holds for the pool, as text. */
function rawPoolText(db: Database): string {
  const rows = [
    ...db.query("SELECT * FROM proxy_pool_nodes").all(),
    ...db.query("SELECT * FROM proxy_subscriptions").all(),
  ];
  return JSON.stringify(rows);
}

function fakeProtector(): KeyProtector & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: "dpapi", calls,
    protect: (key) => { calls.push("protect"); return Buffer.from(key.map((b) => b ^ 0x5a)); },
    unprotect: (blob) => { calls.push("unprotect"); return Buffer.from(blob.map((b) => b ^ 0x5a)); },
  };
}

test("sealed values open with the same key only, and tampering is caught", () => {
  const box = SecretBox.ephemeral();
  const sealed = box.seal(SUB_URL);
  expect(sealed.startsWith("vs1:")).toBe(true);
  expect(sealed).not.toContain("TOKEN");
  expect(box.seal(SUB_URL)).not.toBe(sealed); // a fresh IV each time
  expect(box.open(sealed)).toBe(SUB_URL);
  expect(box.open("plain older value")).toBe("plain older value");
  expect(() => SecretBox.ephemeral().open(sealed)).toThrow(SecretUnavailableError);
  const raw = Buffer.from(sealed.slice(4), "base64");
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
  expect(() => box.open("vs1:" + raw.toString("base64"))).toThrow(SecretUnavailableError);
  expect(box.digest("a")).toBe(box.digest("a"));
  expect(box.digest("a")).not.toBe(SecretBox.ephemeral().digest("a"));
  const none = new SecretBox(null, "unavailable");
  expect(() => none.seal("x")).toThrow(SecretUnavailableError);
  expect(() => none.open(sealed)).toThrow(SecretUnavailableError);
  expect(none.open("plain")).toBe("plain");
});

test("the key is made once per data directory, protected, and found again", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-secret-"));
  try {
    const protector = fakeProtector();
    const db = join(dir, "profiles.sqlite");
    const first = secretBoxForDatabase(db, { protector });
    expect(first.protection).toBe("dpapi");
    const file = JSON.parse(readFileSync(join(dir, "proxy-pool.key"), "utf8"));
    expect(file).toMatchObject({ v: 1, protection: "dpapi" });
    const sealed = first.seal("secret");
    const second = secretBoxForDatabase(db, { protector });
    expect(second.open(sealed)).toBe("secret");
    expect(protector.calls).toEqual(["protect", "unprotect"]);
    expect(secretBoxForDatabase(":memory:", { protector }).protection).toBe("memory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key from another account is set aside, never deleted; an unsure read keeps the key and locks the box", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-secret-"));
  try {
    const db = join(dir, "profiles.sqlite");
    const original = secretBoxForDatabase(db, { protector: fakeProtector() });
    const sealed = original.seal("secret");
    const before = readFileSync(join(dir, "proxy-pool.key"), "utf8");

    const unsure: KeyProtector = { kind: "dpapi", protect: () => { throw new Error("no"); }, unprotect: () => "error" };
    const locked = secretBoxForDatabase(db, { protector: unsure });
    expect(locked.available).toBe(false);
    expect(() => locked.open(sealed)).toThrow(SecretUnavailableError);
    expect(readFileSync(join(dir, "proxy-pool.key"), "utf8")).toBe(before);

    const otherAccount: KeyProtector = { ...fakeProtector(), unprotect: () => "denied" };
    const fresh = secretBoxForDatabase(db, { protector: otherAccount });
    expect(fresh.available).toBe(true);
    expect(() => fresh.open(sealed)).toThrow(SecretUnavailableError);
    const aside = readdirSync(dir).filter((name) => name.startsWith("proxy-pool.key.unreadable-"));
    expect(aside.length).toBe(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged key file is set aside and replaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-secret-"));
  try {
    writeFileSync(join(dir, "proxy-pool.key"), "{not json");
    const box = secretBoxForDatabase(join(dir, "profiles.sqlite"), { protector: fakeProtector() });
    expect(box.available).toBe(true);
    expect(readdirSync(dir).some((name) => name.startsWith("proxy-pool.key.unreadable-"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the database holds no subscription link, node address or credential in readable form", () => {
  const db = new Database(":memory:");
  const box = SecretBox.ephemeral();
  const p = new ProxyPool(db, Date.now, box);
  const sub = p.addSubscription({ url: SUB_URL });
  const parsed = parseSubscription(SUB_TEXT);
  p.syncSubscription(sub.id, parsed.nodes, parsed);
  p.importText("socks5://hand:HAND-PASS@203.0.113.40:1080#hand");
  const raw = rawPoolText(db);
  // The provider's host stays readable: it is the subscription's display name. The token is the secret.
  for (const secret of ["TOKEN-SECRET-123", "/api/v1/client/subscribe", "ANYPASS-SECRET", "SOCKS-PASS", "HAND-PASS", "203.0.113.40",
    "198.51.100.9", "jp.node.example", "11111111-2222-3333-4444-555555555555"]) {
    expect(raw).not.toContain(secret);
  }
  // The pool itself reads them back.
  expect(p.getSubscription(sub.id)!.url).toBe(SUB_URL);
  expect(p.list().map((node) => node.name)).toEqual(["JP", "SG", "plain", "hand"]);
  expect(p.list()[3]!.proxy).toMatchObject({ host: "203.0.113.40", user: "hand", pass: "HAND-PASS" });
  expect(p.list()[1]!.outbound).toMatchObject({ type: "anytls", password: "ANYPASS-SECRET" });
  // Equal proxies are still recognised.
  expect(p.importText("socks5://hand:HAND-PASS@203.0.113.40:1080").duplicates).toBe(1);
  expect(p.syncSubscription(sub.id, parsed.nodes, parsed)).toEqual({ added: 0, kept: 3, removed: 0 });
  expect(() => p.addSubscription({ url: SUB_URL })).toThrow("This subscription is already added");
});

test("older plain rows are sealed when the pool opens, and stay usable", () => {
  const db = new Database(":memory:");
  new ProxyPool(db, Date.now, SecretBox.ephemeral()); // creates the tables
  // Rows as the previous version wrote them: plain link, plain proxy JSON, raw identity keys.
  db.query(`INSERT INTO proxy_subscriptions (id, name, url, user_agent, created_at) VALUES ('s1', 'old', ?, '', 1)`).run(SUB_URL);
  const hand = { type: "socks5", host: "203.0.113.40", port: "1080", user: "hand", pass: "HAND-PASS" };
  db.query(`INSERT INTO proxy_pool_nodes (id, name, kind, proxy_json, identity_key, created_at, protocol) VALUES ('n1', 'hand', 'manual', ?, ?, 2, 'socks5')`)
    .run(JSON.stringify(hand), JSON.stringify(["socks5", "203.0.113.40", "1080", "hand", "HAND-PASS"]));
  const N2 = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const outbound = { type: "anytls", server: "sg.node.example", server_port: 443, password: "ANYPASS-SECRET" };
  db.query(`INSERT INTO proxy_pool_nodes (id, name, kind, proxy_json, identity_key, created_at, protocol, outbound_json, subscription_id)
    VALUES (?, 'SG', 'provider', ?, 'kernel:abc', 3, 'anytls', ?, 's1')`)
    .run(N2, JSON.stringify({ type: "pool", host: N2, port: "0", user: "", pass: "" }), JSON.stringify(outbound));
  expect(rawPoolText(db)).toContain("HAND-PASS");

  const box = SecretBox.ephemeral();
  const p = new ProxyPool(db, Date.now, box);
  const raw = rawPoolText(db);
  for (const secret of ["HAND-PASS", "203.0.113.40", "TOKEN-SECRET-123", "ANYPASS-SECRET", "sg.node.example"]) expect(raw).not.toContain(secret);
  expect(p.getSubscription("s1")!.url).toBe(SUB_URL);
  expect(p.get("n1")!.proxy).toMatchObject(hand);
  expect(p.get(N2)!.outbound).toMatchObject(outbound);
  expect(p.importText("socks5://hand:HAND-PASS@203.0.113.40:1080").duplicates).toBe(1);
  // Opening again changes nothing further.
  const sealedOnce = rawPoolText(db);
  new ProxyPool(db, Date.now, box);
  expect(rawPoolText(db)).toBe(sealedOnce);
});

test("entries sealed under a key this account cannot read are left out, and their subscription says so", () => {
  const db = new Database(":memory:");
  const old = new ProxyPool(db, Date.now, SecretBox.ephemeral());
  const sub = old.addSubscription({ url: SUB_URL });
  const parsed = parseSubscription(SUB_TEXT);
  old.syncSubscription(sub.id, parsed.nodes, parsed);
  const nodeId = old.list()[0]!.id;

  const p = new ProxyPool(db, Date.now, SecretBox.ephemeral());
  expect(p.list()).toEqual([]);
  expect(p.get(nodeId)).toBeNull();
  const unreadable = p.getSubscription(sub.id)!;
  expect(unreadable.url).toBe("");
  expect(unreadable.unreadable).toBe(true);
  // Adding it again works: it is a new entry under the current key.
  const again = p.addSubscription({ url: SUB_URL });
  expect(p.syncSubscription(again.id, parsed.nodes, parsed).added).toBe(3);
});

test.skipIf(process.platform !== "win32")("DPAPI protects and opens the key for this Windows account", () => {
  const key = Buffer.alloc(32, 7);
  const blob = dpapiProtector.protect(key);
  expect(blob.equals(key)).toBe(false);
  const opened = dpapiProtector.unprotect(blob);
  expect(opened instanceof Buffer && opened.equals(key)).toBe(true);
  expect(dpapiProtector.unprotect(Buffer.from("not a dpapi blob"))).toBe("denied");
}, 60_000);

test("an unreadable subscription is shown without a host and asks to be added again", () => {
  const db = new Database(":memory:");
  const old = new ProxyPool(db, Date.now, SecretBox.ephemeral());
  const sub = old.addSubscription({ url: SUB_URL, name: "provider" });
  const view = subscriptionView(new ProxyPool(db, Date.now, SecretBox.ephemeral()).getSubscription(sub.id)!);
  expect(view).toMatchObject({ name: "provider", host: "", unreadable: true, lastError: UNREADABLE_SUBSCRIPTION });
  expect(JSON.stringify(view)).not.toContain("TOKEN");
});

test("a profile store seals the pool with its data directory's key, and reads it back after a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-secret-store-"));
  const path = join(dir, "profiles.sqlite");
  try {
    const first = new ProfileStore(path);
    first.proxyPool.addSubscription({ url: SUB_URL });
    first.proxyPool.importText("socks5://hand:HAND-PASS@203.0.113.40:1080#hand");
    first.close();
    const file = readFileSync(path).toString("latin1") + (() => { try { return readFileSync(`${path}-wal`).toString("latin1"); } catch { return ""; } })();
    expect(file).not.toContain("TOKEN-SECRET-123");
    expect(file).not.toContain("HAND-PASS");
    expect(JSON.parse(readFileSync(join(dir, "proxy-pool.key"), "utf8")).protection).toBe(process.platform === "win32" ? "dpapi" : "file");
    const second = new ProfileStore(path);
    expect(second.proxyPool.listSubscriptions()[0]!.url).toBe(SUB_URL);
    expect(second.proxyPool.list()[0]!.proxy).toMatchObject({ user: "hand", pass: "HAND-PASS" });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

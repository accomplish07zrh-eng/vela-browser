import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExport } from "./parse.ts";
import { fileProtector } from "./secret-box.ts";
import { ProfileStore, UNREADABLE } from "./store.ts";

const SAMPLE = `id=enc1
name=Shop
password=hunter2-secret
twofa=JBSWY3DPEHPK3PXP
cookie=[{"name":"sid","value":"cookie-secret","domain":".shop.test","path":"/","session":false,"expires":1788000000}]
******************`;

function rawRow(path: string): Record<string, string> {
  const db = new Database(path, { readonly: true });
  try { return db.query<Record<string, string>, []>("SELECT password, twofa, cookies_json, session_json, pending_cookies_json FROM profiles").get()!; }
  finally { db.close(); }
}

test("turned on, sensitive fields are sealed on disk and read back unchanged; turned off, they are opened again", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-enc-"));
  const path = join(dir, "profiles.sqlite");
  let store: ProfileStore | undefined;
  try {
    if (process.platform !== "win32") { /* the file protector is the default elsewhere */ }
    store = new ProfileStore(path);
    // Use the plain file key in tests, so no DPAPI call is needed.
    (store as any).box = (await_box(path));
    store!.upsertProfile(parseExport(SAMPLE).profiles[0]!);
    store!.saveSessionBundle("enc1", "session-secret");
    store!.addPendingCookies("enc1", [{ name: "p", value: "pending-secret", domain: ".shop.test", path: "/" } as any]);
    expect(rawRow(path).password).toBe("hunter2-secret");

    store!.setFieldEncryption(true);
    expect(store!.reencryptFields()).toEqual({ changed: 4, unreadable: 0 });
    const sealed = rawRow(path);
    for (const secret of ["hunter2-secret", "cookie-secret", "session-secret", "pending-secret"]) {
      expect(JSON.stringify(sealed)).not.toContain(secret);
    }
    const profile = store!.getProfile("enc1")!;
    expect(profile.password).toBe("hunter2-secret");
    expect(profile.cookies[0]!.value).toBe("cookie-secret");
    expect(store!.getSessionBundle("enc1")).toBe("session-secret");
    expect(store!.pendingCookieCounts().get("enc1")).toBe(1);
    // Edits keep working and stay sealed.
    store!.upsertProfile({ ...profile, password: "new-secret" });
    expect(rawRow(path).password).not.toContain("new-secret");
    expect(store!.getProfile("enc1")!.password).toBe("new-secret");
    // A restore marker survives the sealed comparison.
    store!.armSessionRestore("enc1", "armed");
    expect(store!.getPendingSessionBundle("enc1")).toBe("armed");
    store!.markSessionRestored("enc1", "armed");
    expect(store!.getPendingSessionBundle("enc1")).toBeNull();

    store!.setFieldEncryption(false);
    store!.reencryptFields();
    expect(rawRow(path).password).toBe("new-secret");
  } finally { try { store?.close(); } catch { /* closed */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } }
});

test("a value sealed under another key reads as unreadable and is never overwritten by a save", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-enc-"));
  const path = join(dir, "profiles.sqlite");
  let store: ProfileStore | undefined;
  try {
    store = new ProfileStore(path);
    (store as any).box = await_box(path);
    store!.setFieldEncryption(true);
    store!.upsertProfile(parseExport(SAMPLE).profiles[0]!);
    const before = rawRow(path);
    // Another computer's key.
    rmSync(join(dir, "proxy-pool.key"));
    (store as any).box = await_box(path);
    const profile = store!.getProfile("enc1")!;
    expect(profile.password).toBe(UNREADABLE);
    expect(() => store!.upsertProfile({ ...profile, name: "Renamed" })).toThrow("cannot be read on this computer");
    expect(rawRow(path)).toEqual(before);
    expect(store!.reencryptFields().unreadable).toBeGreaterThan(0);
    // The values it cannot read stay exactly as they were.
    const after = rawRow(path);
    expect([after.password, after.cookies_json]).toEqual([before.password, before.cookies_json]);
  } finally { try { store?.close(); } catch { /* closed */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } }
});

function await_box(path: string) {
  const { secretBoxForDatabase } = require("./secret-box.ts");
  return secretBoxForDatabase(path, { protector: fileProtector });
}
void writeFileSync;

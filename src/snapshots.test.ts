import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExport } from "./parse.ts";
import { SecretBox } from "./secret-box.ts";
import { backupSessions, restoreSnapshot, SnapshotStore } from "./snapshots.ts";
import { ProfileStore } from "./store.ts";

const SAMPLE = `id=snap1
name=Shop
group=g1
password=hunter2
proxytype=http
proxy=1.2.3.4:8080:u:p
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vela-snap-"));
  const store = new ProfileStore(":memory:");
  const box = SecretBox.ephemeral();
  let now = 1_000_000;
  const snapshots = new SnapshotStore(join(dir, "snapshots"), () => box, () => now);
  store.attachSnapshots(snapshots);
  store.upsertProfile(parseExport(SAMPLE).profiles[0]!);
  return { dir, store, snapshots, tick: (ms: number) => { now += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a proxy or fingerprint change saves the old state first, sealed; other edits do not", () => {
  const { store, snapshots, dir, cleanup } = setup();
  try {
    store.saveSessionBundle("snap1", JSON.stringify({ cookies: [{ name: "sid", value: "secret-cookie", domain: ".shop.test", path: "/" }] }));
    store.upsertProfile({ ...store.getProfile("snap1")!, tags: ["new tag"] });
    expect(snapshots.list("snap1")).toEqual([]);
    store.upsertProfile({ ...store.getProfile("snap1")!, proxy: { type: "socks5", host: "5.6.7.8", port: "1080", user: "", pass: "" } });
    const [meta] = snapshots.list("snap1");
    expect(meta).toMatchObject({ reason: "before-change", changed: ["proxy"], hasSession: true });
    // Nothing readable on disk: no password, no cookie, no proxy address.
    const raw = readFileSync(join(dir, "snapshots", "snap1", `${meta!.id}.vsnap`), "utf8");
    for (const secret of ["hunter2", "secret-cookie", "1.2.3.4"]) expect(raw).not.toContain(secret);
    expect(readFileSync(join(dir, "snapshots", "snap1", "index.json"), "utf8")).not.toContain("1.2.3.4");
  } finally { cleanup(); }
});

test("rolling back restores the identity and arms the sign-ins, keeps the name and group, and can be undone", () => {
  const { store, snapshots, cleanup } = setup();
  try {
    store.saveSessionBundle("snap1", "old-session");
    store.upsertProfile({ ...store.getProfile("snap1")!, proxy: { type: "socks5", host: "5.6.7.8", port: "1080", user: "", pass: "" } });
    store.saveSessionBundle("snap1", "new-session");
    store.upsertProfile({ ...store.getProfile("snap1")!, name: "Renamed", group: "g2" });
    const target = snapshots.list("snap1").find((meta) => meta.reason === "before-change")!;
    const result = restoreSnapshot(store, snapshots, "snap1", target.id);
    const profile = store.getProfile("snap1")!;
    expect(profile.proxy).toMatchObject({ type: "http", host: "1.2.3.4", port: "8080" });
    expect(profile.name).toBe("Renamed");
    expect(profile.group).toBe("g2");
    expect(store.getPendingSessionBundle("snap1")).toBe("old-session");
    expect(result.saved.reason).toBe("before-rollback");
    // The rollback itself took no automatic "before-change" snapshot.
    expect(snapshots.list("snap1").filter((meta) => meta.reason === "before-change").length).toBe(1);
    const undo = snapshots.read("snap1", result.saved.id);
    expect(undo.profile.proxy).toMatchObject({ host: "5.6.7.8" });
    expect(undo.session).toBe("new-session");
  } finally { cleanup(); }
});

test("backups run only when sign-ins changed and at most once a day, and deleting a profile removes its snapshots", () => {
  const { store, snapshots, tick, dir, cleanup } = setup();
  try {
    store.saveSessionBundle("snap1", "s1");
    expect(backupSessions(store, snapshots, 1_000_000)).toBe(1);
    expect(backupSessions(store, snapshots, 1_000_000 + 25 * 3600_000)).toBe(0);
    store.saveSessionBundle("snap1", "s2");
    expect(backupSessions(store, snapshots, 1_000_000 + 3600_000)).toBe(0);
    tick(25 * 3600_000);
    expect(backupSessions(store, snapshots, 1_000_000 + 25 * 3600_000)).toBe(1);
    store.deleteProfile("snap1");
    expect(readdirSync(join(dir, "snapshots"))).toEqual([]);
  } finally { cleanup(); }
});

test("a rollback is refused while the browser is open", () => {
  const { store, snapshots, cleanup } = setup();
  try {
    const meta = snapshots.save(store.getProfile("snap1")!, null, "manual");
    const open = { ...store, getLaunch: () => ({ profileId: "snap1" }) } as any;
    open.getProfile = store.getProfile.bind(store);
    expect(() => restoreSnapshot(open, snapshots, "snap1", meta.id)).toThrow("Close this profile's browser");
  } finally { cleanup(); }
});

import { expect, test } from "bun:test";
import { AgentCredentials } from "./agent-credentials.ts";
import type { Launcher } from "./launcher.ts";
import { parseExport } from "./parse.ts";
import { POOL_PROXY_NOT_PORTABLE } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest, SUPPORT_DIAGNOSTICS_PATH } from "./ui.ts";
import { WORKSPACE_BACKUP_PATH, WorkspaceBackup } from "./workspace-backup.ts";

const PASSPHRASE = "workspace test passphrase";
const PASSWORD = "workspace-test-account-secret";
const COOKIE = { name: "session", value: "workspace-test-session-secret", domain: "example.com", path: "/" };
const SESSION = JSON.stringify({
  cookies: [COOKIE],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "workspace", value: "restored" }] }],
  tabs: ["https://example.com/"],
});

function seed(store: ProfileStore) {
  const base = parseExport(`id=workchromium
name=Workspace fixture
group=Team/Research
password=${PASSWORD}
******************`).profiles[0]!;
  store.createGroup("Team");
  store.createGroup("Research", "Team");
  store.createGroup("Empty");
  store.upsertProfile({ ...base, chromiumRuntime: "aliasmode", cookies: [COOKIE], seeded: true });
  store.setKernelRevision(base.id, "155.0.1.2-aliasmode.1");
  store.saveSessionBundle(base.id, SESSION);
  store.addPendingCookies(base.id, [{ ...COOKIE, name: "next" }]);
  store.setDeletionProtection([base.id], true);
  store.setPortableProfileDigest(base.id, "b".repeat(64));
  const firefox = { ...base, id: "workfirefox", engine: "firefox" as const, firefox: {
    version: 1 as const, runtimeVersion: "fixture-firefox", config: { timezone: "UTC" },
  } };
  store.upsertProfile({ ...firefox, proxy: { type: "pool", host: "12345678-1234-1234-1234-123456789abc", port: "0", user: "", pass: "" } });
  store.saveSessionBundle(firefox.id, JSON.stringify({ cookies: [COOKIE] }));
  store.setProfileHandoff(firefox.id, "a".repeat(64));
  expect(store.trashProfile(firefox.id)).toBe(true);
  return { base, firefox };
}

function blob(bytes: Uint8Array): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

test("encrypted workspace recovery preserves protected profiles, Trash and browser sessions on a new key", async () => {
  const source = new ProfileStore(":memory:");
  const destination = new ProfileStore(":memory:");
  try {
    source.setFieldEncryption(true);
    destination.setFieldEncryption(true);
    const { base, firefox } = seed(source);
    const data = await new WorkspaceBackup(source, () => false).export(PASSPHRASE);
    expect(data.subarray(0, 8).toString()).toBe("VELAWKS1");
    expect(data.includes(PASSWORD)).toBe(false);
    expect(data.includes(COOKIE.value)).toBe(false);
    const restore = new WorkspaceBackup(destination, () => false);
    const expected = { profiles: 2, folders: 3, trashed: 1, savedSessions: 2, protectedProfiles: 1, heldProxies: 1, conflicts: [] };
    expect(await restore.inspect(blob(data), PASSPHRASE, false)).toMatchObject(expected);
    expect(destination.workspaceBackupProfileIds()).toEqual([]);
    expect(await restore.inspect(blob(data), PASSPHRASE, true)).toMatchObject(expected);
    expect(destination.listFolders()).toEqual(source.listFolders());
    expect(destination.getProfile(base.id)).toMatchObject({
      password: PASSWORD, chromiumRuntime: "aliasmode", kernelRevision: "155.0.1.2-aliasmode.1", seeded: false,
    });
    expect(destination.getPendingSessionBundle(base.id)).toBe(SESSION);
    expect(destination.getPendingCookies(base.id)).toEqual([{ ...COOKIE, name: "next" }]);
    expect(destination.isDeletionProtected(base.id)).toBe(true);
    expect(destination.portableProfileDigest(base.id)).toBe("b".repeat(64));
    expect(destination.listTrashed()).toEqual(source.listTrashed());
    expect(destination.restoreProfile(firefox.id)).toBe(true);
    expect(destination.getProfile(firefox.id)).toMatchObject({ engine: "firefox", proxy: null, proxyError: POOL_PROXY_NOT_PORTABLE });
    expect(destination.getPendingSessionBundle(firefox.id)).toBe(JSON.stringify({ cookies: [COOKIE] }));
    expect(destination.profileHandoff(firefox.id)).toBe("a".repeat(64));
  } finally {
    source.close();
    destination.close();
  }
});

test("wrong passphrases, damaged ciphertext, cancellation and late conflicts leave the destination intact", async () => {
  const source = new ProfileStore(":memory:");
  const destination = new ProfileStore(":memory:");
  try {
    const { base } = seed(source);
    const data = await new WorkspaceBackup(source, () => false).export(PASSPHRASE);
    let orphan = false;
    const restore = new WorkspaceBackup(destination, id => orphan && id === base.id);
    const opened = restore.inspect(blob(data), PASSPHRASE, false);
    await expect(restore.inspect(blob(data), PASSPHRASE, true)).rejects.toMatchObject({ status: 409 });
    expect((await opened).conflicts).toEqual([]);
    await expect(restore.inspect(blob(data), "incorrect test passphrase", true)).rejects.toMatchObject({ status: 400 });
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1]! ^= 1;
    await expect(restore.inspect(blob(tampered), PASSPHRASE, true)).rejects.toMatchObject({ status: 400 });
    await expect(restore.inspect(blob(data), PASSPHRASE, true, AbortSignal.abort())).rejects.toThrow();
    orphan = true;
    expect((await restore.inspect(blob(data), PASSPHRASE, false)).conflicts).toEqual([{ kind: "profile", id: base.id }]);
    await expect(restore.inspect(blob(data), PASSPHRASE, true)).rejects.toMatchObject({ status: 409 });
    expect(destination.workspaceBackupProfileIds()).toEqual([]);
    expect(destination.listFolders()).toEqual([]);
    orphan = false;
    // An existing trashed profile is also a conflict even though it has no active roster entry.
    destination.upsertProfile(base);
    expect(destination.trashProfile(base.id)).toBe(true);
    await expect(restore.inspect(blob(data), PASSPHRASE, true)).rejects.toMatchObject({ status: 409 });
    expect(destination.workspaceBackupProfileIds()).toEqual([base.id]);
  } finally {
    source.close();
    destination.close();
  }
});

test("a write failure after creating the first profile rolls back the entire recovery", async () => {
  const source = new ProfileStore(":memory:");
  const destination = new ProfileStore(":memory:");
  try {
    const { firefox } = seed(source);
    const data = await new WorkspaceBackup(source, () => false).export(PASSPHRASE);
    const write = destination.restoreWorkspaceBackupProfile.bind(destination);
    destination.restoreWorkspaceBackupProfile = record => {
      if (record.profile.id === firefox.id) throw new Error("fixture write failure");
      write(record);
    };
    await expect(new WorkspaceBackup(destination, () => false).inspect(blob(data), PASSPHRASE, true)).rejects.toThrow("fixture write failure");
    expect(destination.workspaceBackupProfileIds()).toEqual([]);
    expect(destination.listFolders()).toEqual([]);
  } finally {
    source.close();
    destination.close();
  }
});

test("workspace file download and multipart restore require the separate desktop capability", async () => {
  const source = new ProfileStore(":memory:");
  const destination = new ProfileStore(":memory:");
  try {
    seed(source);
    const nonce = "a".repeat(64);
    const launcher = {} as Launcher;
    const call = async (store: ProfileStore, body: BodyInit, authorization: string, headers: Record<string, string> = {}) => (await handleUiRequest(
      new Request(`http://127.0.0.1${WORKSPACE_BACKUP_PATH}`, { method: "POST", body, headers: { authorization: `Bearer ${authorization}`, ...headers } }),
      launcher, store, null, { desktopAdministration: {
        nonce, credentials: new AgentCredentials("unused-fixture-credentials.json"),
        workspaceBackup: new WorkspaceBackup(store, () => false), changed() {},
      } },
    ))!;
    const exportBody = JSON.stringify({ passphrase: PASSPHRASE });
    const headers = { "Content-Type": "application/json" };
    expect((await call(source, exportBody, "b".repeat(64), headers)).status).toBe(401);
    expect((await call(source, exportBody, nonce, { ...headers, Origin: "https://other.example" })).status).toBe(403);
    const downloaded = await call(source, exportBody, nonce, headers);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    expect(downloaded.headers.get("content-disposition")).toContain(".vela-workspace");
    const file = await downloaded.blob();
    for (const action of ["preview", "restore"]) {
      const form = new FormData();
      form.set("file", file, "fixture.vela-workspace");
      form.set("passphrase", PASSPHRASE);
      form.set("action", action);
      const response = await call(destination, form, nonce);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain(COOKIE.value);
      expect(body).not.toContain(PASSWORD);
      expect(JSON.parse(body)).toMatchObject({ ok: true, summary: { profiles: 2, savedSessions: 2, conflicts: [] } });
      expect(destination.workspaceBackupProfileIds().length).toBe(action === "preview" ? 0 : 2);
    }
  } finally {
    source.close();
    destination.close();
  }
});

test("support diagnostics contain only authorized structured outcomes and never include stored profile data", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store);
    const nonce = "a".repeat(64);
    const log = [{ durationMs: 64, outcome: "proxy_invalid" }];
    const launcher = { launchDiagnostics: () => log } as unknown as Launcher;
    const options = { desktopAdministration: {
      nonce, credentials: new AgentCredentials("unused-fixture-credentials.json"),
      workspaceBackup: new WorkspaceBackup(store, () => false), changed() {},
    } };
    const call = (token: string) => handleUiRequest(new Request(`http://127.0.0.1${SUPPORT_DIAGNOSTICS_PATH}`, {
      headers: { authorization: `Bearer ${token}` },
    }), launcher, store, null, options);
    expect((await call("b".repeat(64)))?.status).toBe(401);
    const response = (await call(nonce))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    for (const value of [PASSWORD, COOKIE.value, nonce, "workchromium", "example.com"]) expect(body).not.toContain(value);
    expect(JSON.parse(body)).toMatchObject({ ok: true, report: { schemaVersion: 1, recentStarts: log } });
  } finally { store.close(); }
});

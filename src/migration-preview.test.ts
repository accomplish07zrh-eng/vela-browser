import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileImportError } from "./inbox.ts";
import type { Launcher } from "./launcher.ts";
import { MigrationPreviewService } from "./migration-preview.ts";
import { parseExport } from "./parse.ts";
import { SecretBox } from "./secret-box.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

const upload = (text: string, name = "fixture.txt") => ({ name, bytes: new TextEncoder().encode(text) });
const record = (id: string, fields: string) => `id=${id}\n${fields}\n******************\n`;

function seed(store: ProfileStore, id: string, fields = "name=original") {
  store.upsertProfile(parseExport(record(id, fields)).profiles[0]!);
}

function open(store: ProfileStore, profileId: string) {
  store.recordLaunch({ profileId, pid: 123, debugPort: 9333, startedAt: Date.now(), ws: "ws://127.0.0.1:9333/test" });
}

test("dashboard migration previews offline and commits only the reviewed plan before guarded undo", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "keep", "name=keep\ngroup=reviewed");
    seed(store, "edit");
    store.onProfileSaved = () => { throw new Error("migration must not prewarm runtimes"); };
    const post = async (action: string, form: FormData) => (await handleUiRequest(
      new Request(`http://localhost/ui/api/import/upload?migration=${action}`, { method: "POST", body: form }),
      { profileDeletionBlocked: () => false } as unknown as Launcher,
      store,
      null,
      { timezoneFetch: () => { throw new Error("migration must not look up proxy timezones"); } },
    ))!;

    const form = new FormData();
    form.set("group", "reviewed");
    form.append("files", new File([record("keep", "name=keep") + record("edit", "name=updated")], "existing.txt"));
    form.append("files", new File(["name,password,proxy\nFixture,FIXTURE_PASSWORD,http://user:FIXTURE_PROXY@proxy.example.test:8080\n"], "new.csv"));
    const response = await post("preview", form);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const preview = await response.json();
    expect(preview).toMatchObject({ ok: true, created: 1, updated: 1, unchanged: 1, conflicts: [] });
    expect(JSON.stringify(preview)).not.toContain("FIXTURE_");
    expect(store.count()).toBe(2);
    expect(store.getProfile("edit")?.name).toBe("original");

    const commit = new FormData();
    commit.set("previewId", preview.previewId);
    const result = await (await post("commit", commit)).json();
    expect(result).toMatchObject({ ok: true, created: 1, updated: 1, unchanged: 1 });
    expect(typeof result.undoId).toBe("string");
    expect(await (await post("commit", commit)).json()).toEqual(result);
    expect(store.getProfile("edit")?.name).toBe("updated");
    const created = store.listProfiles().find(profile => profile.id !== "keep" && profile.id !== "edit")!;
    expect(created).toMatchObject({ name: "Fixture", group: "reviewed", password: "FIXTURE_PASSWORD" });

    const undo = new FormData();
    undo.set("undoId", result.undoId);
    expect(await (await post("undo", undo)).json()).toEqual({ ok: true, trashed: 1, restored: 1 });
    expect(store.isTrashed(created.id)).toBe(true);
    expect(store.getProfile("edit")?.name).toBe("original");
    expect((await post("undo", undo)).status).toBe(409);
  } finally { store.close(); }
});

test("migration reports sanitized conflicts across selected exports", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "busy");
    seed(store, "trashed");
    seed(store, "saved-proxy", "name=proxy\nproxy=http://user:FIXTURE_PROXY@proxy.example.test:8080");
    open(store, "busy");
    store.trashProfile("trashed");
    const service = new MigrationPreviewService(store);
    const result = await service.preview([
      upload(record("duplicate", "name=one\npassword=FIXTURE_PASSWORD")
        + record("busy", "name=change")
        + record("trashed", "name=change")
        + record("saved-proxy", "proxy=")),
      upload(record("duplicate", "name=two"), "second.txt"),
      upload('{ "password": "FIXTURE_MALFORMED", ', "FIXTURE_FILENAME.json"),
    ]);
    expect(result.previewId).toBeUndefined();
    expect(result.conflicts).toEqual(expect.arrayContaining([
      { file: 1, record: 1, profileId: "duplicate", code: "duplicate" },
      { file: 2, record: 1, profileId: "duplicate", code: "duplicate" },
      { file: 1, record: 2, profileId: "busy", code: "busy" },
      { file: 1, record: 3, profileId: "trashed", code: "trashed" },
      { file: 1, record: 4, profileId: "saved-proxy", code: "incompatible", field: "proxy" },
      { file: 3, code: "invalid_export" },
    ]));
    expect(JSON.stringify(result)).not.toContain("FIXTURE_");
    expect(store.getProfile("duplicate")).toBeNull();
  } finally { store.close(); }
});

test("commit rejects a changed or starting profile as one batch", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "edit");
    const service = new MigrationPreviewService(store);
    const files = [upload(record("new", "name=new") + record("edit", "name=updated"))];
    const stale = await service.preview(files);
    store.upsertProfile({ ...store.getProfile("edit")!, name: "edited elsewhere" });
    expect(() => service.commit(stale.previewId)).toThrow(ProfileImportError);
    expect(store.getProfile("new")).toBeNull();

    const ready = await service.preview(files);
    expect(() => service.commit(ready.previewId, id => id === "edit")).toThrow(ProfileImportError);
    expect(store.getProfile("new")).toBeNull();
    expect(store.getProfile("edit")?.name).toBe("edited elsewhere");
  } finally { store.close(); }
});

test.each(["edited", "opened and closed"] as const)("undo is atomic when a created profile was %s", async (change) => {
  const store = new ProfileStore(":memory:");
  try {
    const service = new MigrationPreviewService(store);
    const preview = await service.preview([upload(record("a", "name=a") + record("b", "name=b"))]);
    const result = service.commit(preview.previewId);
    if (change === "edited") store.upsertProfile({ ...store.getProfile("b")!, name: "modified" });
    else { open(store, "b"); store.clearLaunch("b"); }
    expect(() => service.undo(result.undoId)).toThrow(ProfileImportError);
    expect(store.isTrashed("a")).toBe(false);
    expect(store.isTrashed("b")).toBe(false);
  } finally { store.close(); }
});

test("sealed update preimages restore the exact SQLite row after reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "vela-migration-"));
  const path = join(folder, "profiles.sqlite");
  let store = new ProfileStore(path);
  try {
    store.setFieldEncryption(true);
    seed(store, "edit", "name=original\npassword=FIXTURE_ORIGINAL_PASSWORD\ngroup=old");
    store.markSeeded("edit");
    store.addPendingCookies("edit", [{ name: "queued", value: "FIXTURE_PENDING", domain: "local.test", path: "/" }]);
    const originalSession = JSON.stringify({ cookies: [{ name: "login", value: "FIXTURE_SESSION", domain: "local.test", path: "/" }], origins: [] });
    store.armSessionRestore("edit", originalSession);
    const before = store.migrationProfileVersion("edit");

    const service = new MigrationPreviewService(store);
    const incomingSession = JSON.stringify({ cookies: [{ name: "login", value: "FIXTURE_NEW_SESSION", domain: "local.test", path: "/" }], origins: [] });
    const preview = await service.preview([upload(record("edit", `name=revised\ngroup=new\npassword=updated\nsession=${incomingSession}`))]);
    const result = service.commit(preview.previewId);
    expect(store.getPendingSessionBundle("edit")).toContain("FIXTURE_NEW_SESSION");
    const receipt = store.loadMigrationUndo(result.undoId!);
    expect(receipt?.updated).toHaveLength(1);
    expect(SecretBox.isSealed(receipt!.updated[0]!.before)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("FIXTURE_");

    store.close();
    store = new ProfileStore(path);
    expect(new MigrationPreviewService(store).undo(result.undoId)).toEqual({ trashed: 0, restored: 1 });
    expect(store.migrationProfileVersion("edit")).toBe(before);
    expect(store.getProfile("edit")).toMatchObject({ name: "original", group: "old", seeded: true, password: "FIXTURE_ORIGINAL_PASSWORD" });
    expect(store.getPendingSessionBundle("edit")).toBe(originalSession);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test.each(["opened and closed", "pending cookies changed", "queued launch", "different encryption key", "schema changed"] as const)(
  "mixed undo preserves the whole import if an updated profile has %s",
  async (change) => {
    const store = new ProfileStore(":memory:");
    try {
      seed(store, "edit");
      const service = new MigrationPreviewService(store);
      const preview = await service.preview([upload(record("new", "name=new") + record("edit", "name=revised"))]);
      const result = service.commit(preview.previewId);
      if (change === "opened and closed") { open(store, "edit"); store.clearLaunch("edit"); }
      if (change === "pending cookies changed") store.addPendingCookies("edit", [{ name: "later", value: "fixture", domain: "local.test", path: "/" }]);
      if (change === "different encryption key") store.secretBox = () => SecretBox.ephemeral();
      if (change === "schema changed") {
        const { db } = store as unknown as { db: Database };
        db.exec("ALTER TABLE profiles ADD COLUMN fixture_added_column TEXT NOT NULL DEFAULT ''");
      }
      expect(() => service.undo(result.undoId, id => change === "queued launch" && id === "edit")).toThrow(ProfileImportError);
      expect(store.isTrashed("new")).toBe(false);
      expect(store.getProfile("edit")?.name).toBe("revised");
    } finally { store.close(); }
  },
);

test("a missing original group rolls back every attempted restoration", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "a", "name=original");
    seed(store, "b", "name=original\ngroup=former");
    const service = new MigrationPreviewService(store);
    const preview = await service.preview([upload(
      record("a", "name=revised") + record("b", "name=revised\ngroup=destination") + record("new", "name=new"),
    )]);
    const result = service.commit(preview.previewId);
    store.deleteGroup("former");
    expect(() => service.undo(result.undoId)).toThrow(ProfileImportError);
    expect(store.getProfile("a")?.name).toBe("revised");
    expect(store.getProfile("b")).toMatchObject({ name: "revised", group: "destination" });
    expect(store.isTrashed("new")).toBe(false);
  } finally { store.close(); }
});

test("expired undo receipts are refused and can be pruned", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "edit");
    let now = Date.now();
    const service = new MigrationPreviewService(store, () => now);
    const preview = await service.preview([upload(record("edit", "name=revised"))]);
    const result = service.commit(preview.previewId);
    now = result.undoExpiresAt!;
    expect(() => service.undo(result.undoId)).toThrow(ProfileImportError);
    expect(store.getProfile("edit")?.name).toBe("revised");
    store.pruneMigrationUndo(now);
    expect(store.loadMigrationUndo(result.undoId!)).toBeNull();
  } finally { store.close(); }
});

test("a full undo journal rolls back creates and updates", async () => {
  const store = new ProfileStore(":memory:");
  try {
    seed(store, "edit");
    const service = new MigrationPreviewService(store);
    const preview = await service.preview([upload(record("edit", "name=revised") + record("new", "name=new"))]);
    store.saveMigrationUndo = () => false;
    expect(() => service.commit(preview.previewId)).toThrow("The import exceeds the undo storage limit");
    expect(store.getProfile("edit")?.name).toBe("original");
    expect(store.getProfile("new")).toBeNull();
  } finally { store.close(); }
});

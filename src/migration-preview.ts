import { randomBytes } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import type { ProfileStore, MigrationUndoRecord } from "./store.ts";
import { prepareLocalMigration, ProfileImportError } from "./inbox.ts";
import type { ImportOverrides, LocalMigrationPlan, MigrationSummary, MigrationConflict } from "./inbox.ts";

export type MigrationPreviewResult = MigrationSummary & { conflicts: MigrationConflict[]; previewId?: string };
export type MigrationCommitResult = MigrationSummary & { undoId?: string; undoExpiresAt?: number };
export type MigrationUndoResult = { trashed: number; updated: number };

const MAX_PREVIEWS = 4;
const PREVIEW_TTL_MS = 5 * 60_000;
const UNDO_TTL_MS = 10 * 60_000;
const TOKEN_BYTES = 32;
type Busy = (id: string) => boolean;
const neverBusy: Busy = () => false;

type SavedPreview = {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
} & (
  { profiles: LocalMigrationPlan["profiles"]; summary: MigrationSummary }
  | { result: MigrationCommitResult }
);

function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

function requireToken(value: unknown): string {
  if (typeof value !== "string" || value.length !== TOKEN_BYTES * 2 || /[^0-9a-f]/.test(value)) {
    throw new ProfileImportError("Invalid migration token", 400);
  }
  return value;
}

function stalePreview(): ProfileImportError {
  return new ProfileImportError("Preview expired or profiles changed. Preview the import again.", 409);
}

function unavailableUndo(): ProfileImportError {
  return new ProfileImportError("Undo expired or a new profile changed or was opened.", 409);
}

export class MigrationPreviewService {
  private readonly previews = new Map<string, SavedPreview>();

  constructor(private readonly store: ProfileStore, private readonly now: () => number = Date.now) {}

  async preview(
    files: { name: string; bytes: Uint8Array }[],
    overrides: ImportOverrides = {},
    busy: Busy = neverBusy,
  ): Promise<MigrationPreviewResult> {
    try {
      this.prunePreviews(this.now());
      const { summary, conflicts, profiles } = await prepareLocalMigration(this.store, files, overrides, busy);
      const result = { ...summary, conflicts };
      const now = this.now();
      this.prunePreviews(now);
      if (conflicts.length > 0 || profiles.length === 0) return result;

      const previewId = randomToken();
      if (this.previews.size >= MAX_PREVIEWS) {
        const oldest = this.previews.keys().next();
        if (!oldest.done) this.removePreview(oldest.value);
      }
      const timer = setTimeout(this.removePreview.bind(this, previewId), PREVIEW_TTL_MS).unref();
      this.previews.set(previewId, { profiles, summary, expiresAt: now + PREVIEW_TTL_MS, timer });
      return { ...result, previewId };
    } catch {
      throw new ProfileImportError("Migration preview could not be prepared", 500);
    }
  }

  commit(previewId: unknown, busy: Busy = neverBusy): MigrationCommitResult {
    const token = requireToken(previewId);
    const now = this.now();
    this.prunePreviews(now);
    const pending = this.previews.get(token);
    if (!pending) throw stalePreview();
    if ("result" in pending) return { ...pending.result };

    const result = this.runTransaction(() => {
      const { profiles, summary } = pending;
      for (const { profile, version } of profiles) {
        if (!this.profileMatches(profile.id, version, busy)) throw stalePreview();
      }

      const changed = profiles.filter(({ action }) => action !== "unchanged");
      const sessions = new Map<string, string>();
      for (const { profile, sessionBundle } of changed) {
        if (sessionBundle !== undefined) sessions.set(profile.id, sessionBundle);
      }
      this.store.pruneMigrationUndo(now);
      if (changed.length > 0) {
        this.store.upsertProfiles(changed.map(({ profile }) => profile), sessions, { notify: false });
      }

      const created: MigrationUndoRecord["created"] = [];
      for (const { profile: { id }, action } of changed) {
        if (action !== "create") continue;
        const version = this.store.migrationProfileVersion(id);
        if (version === null) throw new Error("Migration did not persist the created profile");
        created.push({ id, version });
      }
      if (created.length === 0) return { ...summary };

      const receipt: MigrationUndoRecord = {
        id: randomToken(),
        expiresAt: this.now() + UNDO_TTL_MS,
        created,
        updated: summary.updated,
      };
      this.store.saveMigrationUndo(receipt);
      return { ...summary, undoId: receipt.id, undoExpiresAt: receipt.expiresAt };
    });

    // A retry after a lost reply gets the original outcome. Drop the imported data as soon as it is saved.
    this.previews.set(token, { expiresAt: pending.expiresAt, timer: pending.timer, result });
    return { ...result };
  }

  undo(undoId: unknown, busy: Busy = neverBusy): MigrationUndoResult {
    const token = requireToken(undoId);
    return this.runTransaction(() => {
      const now = this.now();
      const receipt = this.store.loadMigrationUndo(token);
      if (!receipt || receipt.expiresAt <= now) throw unavailableUndo();
      for (const { id, version } of receipt.created) {
        if (!this.profileMatches(id, version, busy)) throw unavailableUndo();
      }
      for (const { id } of receipt.created) {
        if (!this.store.trashProfile(id)) throw unavailableUndo();
      }
      this.store.deleteMigrationUndo(token);
      this.store.pruneMigrationUndo(now);
      return { trashed: receipt.created.length, updated: receipt.updated };
    });
  }

  private runTransaction<T>(operation: () => T): T {
    try {
      return this.store.runTransaction(operation);
    } catch (error) {
      if (error instanceof ProfileImportError) throw error;
      throw new ProfileImportError("The migration could not be completed", 500);
    }
  }

  private profileMatches(id: string, version: string | null, busy: Busy): boolean {
    return this.store.migrationProfileVersion(id) === version
      && !this.store.isTrashed(id)
      && !this.store.getLaunch(id)
      && !busy(id);
  }

  private prunePreviews(now: number): void {
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.removePreview(id);
    }
  }

  private removePreview(id: string): void {
    const preview = this.previews.get(id);
    if (preview) clearTimeout(preview.timer);
    this.previews.delete(id);
  }
}

const services = new WeakMap<ProfileStore, MigrationPreviewService>();

export function migrationPreviewService(store: ProfileStore): MigrationPreviewService {
  let service = services.get(store);
  if (!service) {
    service = new MigrationPreviewService(store);
    services.set(store, service);
  }
  return service;
}

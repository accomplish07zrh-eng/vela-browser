import { isArchive, openArchive, sealArchive } from "./encrypted-archive.ts";
import { POOL_PROXY_NOT_PORTABLE } from "./portable-profile.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { parseCapturedSessionBundle } from "./session.ts";
import type { ProfileStore, WorkspaceBackupProfile } from "./store.ts";
import { ALIASMODE_VERSION } from "./version.ts";

export const WORKSPACE_BACKUP_PATH = "/ui/api/workspace-backup";
export const MAX_WORKSPACE_BACKUP_BYTES = 95 * 1024 * 1024;
const MAGIC = Buffer.from("VELAWKS1");

interface WorkspaceArchive {
  version: 1;
  productVersion: string;
  createdAt: number;
  folders: ReturnType<ProfileStore["listFolders"]>;
  profiles: WorkspaceBackupProfile[];
}

export interface WorkspaceBackupPreview {
  createdAt: number;
  productVersion: string;
  profiles: number;
  trashed: number;
  protectedProfiles: number;
  savedSessions: number;
  folders: number;
  heldProxies: number;
  conflicts: Array<{ kind: "profile" | "folder"; id: string }>;
}

export class WorkspaceBackupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function requirePassphrase(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 12 || value.length > 4096) {
    throw new WorkspaceBackupError("Use a backup passphrase of at least 12 characters.");
  }
  return value;
}

function backupBytes(store: ProfileStore): Buffer {
  return store.runTransaction(() => {
    const folders = store.listFolders();
    validateFolders(folders);
    const header = JSON.stringify({ version: 1, productVersion: ALIASMODE_VERSION, createdAt: Date.now(), folders });
    const profiles: string[] = [];
    let bytes = Buffer.byteLength(header) + 16;
    if (bytes > MAX_WORKSPACE_BACKUP_BYTES) throw new WorkspaceBackupError("Workspace data exceeds the backup size limit.", 413);
    for (const record of store.workspaceBackupProfiles()) {
      validateProfile(record);
      const entry = JSON.stringify(record);
      bytes += Buffer.byteLength(entry) + 1;
      if (bytes > MAX_WORKSPACE_BACKUP_BYTES) throw new WorkspaceBackupError("Workspace data exceeds the backup size limit.", 413);
      profiles.push(entry);
    }
    return Buffer.from(`${header.slice(0, -1)},"profiles":[${profiles.join(",")}]}`);
  });
}

function validateFolders(entries: WorkspaceArchive["folders"]): void {
  const names = new Set<string>();
  for (const folder of entries) {
    if (!folder || typeof folder.label !== "string" || !folder.label.trim() || folder.label.trim() !== folder.label
      || (folder.parentName !== null && (typeof folder.parentName !== "string" || !folder.parentName))
      || folder.name !== (folder.parentName === null ? folder.label : `${folder.parentName}/${folder.label}`)
      || names.has(folder.name)) throw new Error("Invalid folder in workspace archive");
    names.add(folder.name);
  }
  if (entries.some(folder => folder.parentName !== null && !names.has(folder.parentName))) {
    throw new Error("Workspace archive is missing a parent folder");
  }
}

function validateProfile(entry: WorkspaceBackupProfile): void {
  assertValidProfile(entry?.profile);
  const digest = (value: unknown) => value === null || (typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  if (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || !Number.isSafeInteger(entry.trashedAt) || entry.trashedAt < 0
    || typeof entry.deletionProtected !== "boolean" || !Array.isArray(entry.pendingCookies)
    || !digest(entry.handedOff) || !digest(entry.portableDigest)) {
    throw new Error("Invalid profile in workspace archive");
  }
  if (entry.pendingCookies.length) parseCapturedSessionBundle(JSON.stringify({ cookies: entry.pendingCookies, origins: [] }));
  if (entry.session !== null) {
    if (typeof entry.session !== "string") throw new Error("Invalid workspace session");
    // Earlier portable profiles could omit origins altogether. Retain that shape for the browser restore path.
    const session = JSON.parse(entry.session);
    parseCapturedSessionBundle(session?.origins === undefined ? JSON.stringify({ ...session, origins: [] }) : entry.session);
  }
}

function validateArchive(input: unknown): WorkspaceArchive {
  if (!input || typeof input !== "object") throw new Error("Invalid workspace archive");
  const archive = input as WorkspaceArchive;
  if (archive.version !== 1 || typeof archive.productVersion !== "string" || archive.productVersion.length > 64
    || !Number.isSafeInteger(archive.createdAt) || !Array.isArray(archive.folders) || !Array.isArray(archive.profiles)) {
    throw new Error("Invalid workspace archive header");
  }
  validateFolders(archive.folders);
  const ids = new Set<string>();
  for (const entry of archive.profiles) {
    validateProfile(entry);
    if (ids.has(entry.profile.id)) throw new Error("Duplicate profile in workspace archive");
    ids.add(entry.profile.id);
  }
  archive.folders.sort((a, b) => a.name.length - b.name.length);
  return archive;
}

export class WorkspaceBackup {
  private busy = false;

  constructor(private readonly store: ProfileStore, private readonly nativeExists: (id: string) => boolean) {}

  async export(passphrase: unknown, signal?: AbortSignal): Promise<Buffer> {
    const password = requirePassphrase(passphrase);
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const bytes = backupBytes(this.store);
      try {
        const data = await sealArchive(bytes, password, MAGIC);
        if (data.length > MAX_WORKSPACE_BACKUP_BYTES) throw new WorkspaceBackupError("Workspace data exceeds the backup size limit.", 413);
        signal?.throwIfAborted();
        return data;
      } finally { bytes.fill(0); }
    });
  }

  async inspect(file: Blob, passphrase: unknown, restore: boolean, signal?: AbortSignal): Promise<WorkspaceBackupPreview> {
    const password = requirePassphrase(passphrase);
    if (file.size > MAX_WORKSPACE_BACKUP_BYTES) throw new WorkspaceBackupError("Workspace data exceeds the backup size limit.", 413);
    return this.exclusive(async () => {
      signal?.throwIfAborted();
      const encrypted = Buffer.from(await file.arrayBuffer());
      if (!isArchive(encrypted, MAGIC, MAX_WORKSPACE_BACKUP_BYTES)) throw new WorkspaceBackupError("Choose a Vela workspace backup file.");
      let archive: WorkspaceArchive;
      try {
        const bytes = await openArchive(encrypted, password, MAGIC, MAX_WORKSPACE_BACKUP_BYTES);
        try { archive = validateArchive(JSON.parse(bytes.toString("utf8"))); }
        finally { bytes.fill(0); }
      } catch { throw new WorkspaceBackupError("The workspace backup could not be decrypted or is damaged."); }
      signal?.throwIfAborted();
      return this.store.runTransaction(() => {
        const folders = new Map(this.store.listFolders().map(folder => [folder.name, folder]));
        const directoryId = (id: string) => process.platform === "linux" ? id : id.toLowerCase();
        const occupied = new Set(this.store.workspaceBackupProfileIds().map(directoryId));
        const conflicts: WorkspaceBackupPreview["conflicts"] = [];
        for (const folder of archive.folders) {
          const existing = folders.get(folder.name);
          if (existing && (existing.label !== folder.label || existing.parentName !== folder.parentName)) conflicts.push({ kind: "folder", id: folder.name });
        }
        let trashed = 0, protectedProfiles = 0, savedSessions = 0, heldProxies = 0;
        for (const row of archive.profiles) {
          const { id } = row.profile;
          const directory = directoryId(id);
          if (occupied.has(directory) || this.nativeExists(id)) conflicts.push({ kind: "profile", id });
          occupied.add(directory);
          if (row.trashedAt) trashed++;
          if (row.deletionProtected) protectedProfiles++;
          if (row.session) savedSessions++;
          if (row.profile.proxy?.type === "pool") heldProxies++;
        }
        if (restore) {
          if (conflicts.length) throw new WorkspaceBackupError("Resolve the workspace backup conflicts before restoring.", 409);
          for (const folder of archive.folders) {
            if (!folders.has(folder.name)) this.store.createGroup(folder.label, folder.parentName);
          }
          for (const row of archive.profiles) {
            if (row.profile.proxy?.type === "pool") row.profile = { ...row.profile, proxy: null, proxyError: POOL_PROXY_NOT_PORTABLE };
            this.store.restoreWorkspaceBackupProfile(row);
          }
        }
        return { createdAt: archive.createdAt, productVersion: archive.productVersion, profiles: archive.profiles.length,
          folders: archive.folders.length, trashed, protectedProfiles, savedSessions, heldProxies, conflicts };
      });
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new WorkspaceBackupError("A workspace backup operation is already running.", 409);
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
}

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretBox } from "./secret-box.ts";
import type { Profile } from "./types.ts";

/**
 * Snapshots of a profile: everything that makes it the same browser to a website (fingerprint,
 * proxy, accounts) and its saved sign-ins (cookies, site storage, tabs). They are sealed with the
 * data directory's own key, so a copied folder cannot read them, and kept per profile:
 *
 * - "before-change": taken by itself just before a fingerprint or proxy change;
 * - "backup": the sign-ins, taken on a schedule when they changed since the last one;
 * - "manual": taken by hand;
 * - "before-rollback": the state a rollback replaced, so a rollback can be undone.
 */
export type SnapshotReason = "before-change" | "backup" | "manual" | "before-rollback";
export interface SnapshotMeta {
  id: string;
  profileId: string;
  at: number;
  reason: SnapshotReason;
  /** The fields that were about to change ("before-change"). Names only, never values. */
  changed?: string[];
  hasSession: boolean;
  /** A digest of the saved sign-ins, to skip backups that would repeat the last one. */
  sessionHash?: string;
  bytes: number;
}
interface SnapshotBody { v: 1; profile: Profile; session: string | null }

const KEEP: Record<SnapshotReason, number> = { "before-change": 20, backup: 7, manual: 20, "before-rollback": 5 };
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The fields whose change makes a profile look like a different browser or computer. */
export const IDENTITY_FIELDS = ["engine", "chromiumRuntime", "ua", "timezone", "locale", "screenWidth", "screenHeight", "fingerprintSeed", "platformOs", "hardware", "firefox", "webkit", "proxy", "displayScale"] as const;

export function identityChanges(before: Profile, after: Profile): string[] {
  const out: string[] = [];
  for (const field of IDENTITY_FIELDS) {
    const a = JSON.stringify((before as any)[field] ?? null), b = JSON.stringify((after as any)[field] ?? null);
    if (a !== b) out.push(field);
  }
  return out;
}

export function sessionDigest(session: string | null): string | undefined {
  return session ? createHash("sha256").update(session).digest("hex").slice(0, 32) : undefined;
}

export class SnapshotStore {
  private suspended = 0;
  constructor(readonly dir: string, private readonly box: () => SecretBox, private readonly now: () => number = Date.now) {}

  private profileDir(profileId: string): string {
    if (!SAFE_ID.test(profileId)) throw new Error("Invalid profile id");
    return join(this.dir, profileId);
  }

  private indexPath(profileId: string): string { return join(this.profileDir(profileId), "index.json"); }

  list(profileId: string): SnapshotMeta[] {
    try {
      const index = JSON.parse(readFileSync(this.indexPath(profileId), "utf8")) as SnapshotMeta[];
      return Array.isArray(index) ? index.filter((meta) => existsSync(join(this.profileDir(profileId), `${meta.id}.vsnap`))).sort((a, b) => b.at - a.at) : [];
    } catch { return []; }
  }

  private writeIndex(profileId: string, index: SnapshotMeta[]): void {
    const path = this.indexPath(profileId), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(index), { mode: 0o600 });
    renameSync(temp, path);
  }

  /** Runs fn without automatic snapshots (a rollback writes the profile it restores). */
  quietly<T>(fn: () => T): T {
    this.suspended++;
    try { return fn(); } finally { this.suspended--; }
  }

  get paused(): boolean { return this.suspended > 0; }

  save(profile: Profile, session: string | null, reason: SnapshotReason, changed?: string[]): SnapshotMeta {
    const box = this.box();
    const dir = this.profileDir(profile.id);
    mkdirSync(dir, { recursive: true });
    const at = this.now();
    const id = `${at}-${randomBytes(4).toString("hex")}`;
    const body: SnapshotBody = { v: 1, profile, session };
    const sealed = box.seal(JSON.stringify(body));
    writeFileSync(join(dir, `${id}.vsnap`), sealed, { mode: 0o600 });
    const meta: SnapshotMeta = { id, profileId: profile.id, at, reason, ...(changed?.length ? { changed } : {}), hasSession: !!session, ...(session ? { sessionHash: sessionDigest(session) } : {}), bytes: sealed.length };
    const index = [meta, ...this.list(profile.id)];
    // Each kind keeps its own newest few, so many small changes never push out the backups.
    const keep: SnapshotMeta[] = [], counts = new Map<SnapshotReason, number>();
    for (const item of index) {
      const count = (counts.get(item.reason) ?? 0) + 1;
      counts.set(item.reason, count);
      if (count <= KEEP[item.reason]) keep.push(item);
      else rmSync(join(dir, `${item.id}.vsnap`), { force: true });
    }
    this.writeIndex(profile.id, keep);
    return meta;
  }

  read(profileId: string, snapshotId: string): { meta: SnapshotMeta; profile: Profile; session: string | null } {
    if (!SAFE_ID.test(snapshotId)) throw new Error("Invalid snapshot id");
    const meta = this.list(profileId).find((item) => item.id === snapshotId);
    if (!meta) throw new Error("This snapshot no longer exists");
    const body = JSON.parse(this.box().open(readFileSync(join(this.profileDir(profileId), `${snapshotId}.vsnap`), "utf8"))) as SnapshotBody;
    if (body.v !== 1 || body.profile?.id !== profileId) throw new Error("This snapshot belongs to another profile");
    return { meta, profile: body.profile, session: body.session };
  }

  remove(profileId: string, snapshotId: string): void {
    if (!SAFE_ID.test(snapshotId)) throw new Error("Invalid snapshot id");
    rmSync(join(this.profileDir(profileId), `${snapshotId}.vsnap`), { force: true });
    this.writeIndex(profileId, this.list(profileId).filter((item) => item.id !== snapshotId));
  }

  /** Every snapshot of a profile, when the profile itself is deleted for good. */
  removeProfile(profileId: string): void {
    rmSync(this.profileDir(profileId), { recursive: true, force: true });
  }

  /** Total size and count, for the settings page. */
  usage(): { profiles: number; snapshots: number; bytes: number } {
    let profiles = 0, snapshots = 0, bytes = 0;
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return { profiles, snapshots, bytes }; }
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue;
      const list = this.list(name);
      if (!list.length) continue;
      profiles++; snapshots += list.length;
      for (const meta of list) { try { bytes += statSync(join(this.dir, name, `${meta.id}.vsnap`)).size; } catch { /* gone */ } }
    }
    return { profiles, snapshots, bytes };
  }
}

/**
 * Backs up sign-ins that changed since their last backup, at most once a day per profile.
 * Returns how many profiles were backed up.
 */
export function backupSessions(store: { listProfiles(): Profile[]; getSessionBundle(id: string): string | null }, snapshots: SnapshotStore, now = Date.now()): number {
  let saved = 0;
  for (const profile of store.listProfiles()) {
    const session = store.getSessionBundle(profile.id);
    if (!session) continue;
    const last = snapshots.list(profile.id).find((meta) => meta.reason === "backup");
    if (last && (last.sessionHash === sessionDigest(session) || now - last.at < 20 * 3600_000)) continue;
    try { snapshots.save(profile, session, "backup"); saved++; } catch { /* the key may be unavailable this run */ }
  }
  return saved;
}

export interface SnapshotTarget {
  getLaunch(id: string): unknown;
  getProfile(id: string): Profile | null;
  getSessionBundle(id: string): string | null;
  upsertProfile(profile: Profile): void;
  armSessionRestore(id: string, bundle: string): void;
}

/**
 * Puts a profile back as a snapshot had it. Its name, group, tags and number stay as they are now:
 * those are how you organise profiles, not what a website sees. The sign-ins come back at the
 * browser's next start. What it replaces is saved first, so the rollback can be undone.
 */
export function restoreSnapshot(store: SnapshotTarget, snapshots: SnapshotStore, profileId: string, snapshotId: string): { restored: SnapshotMeta; saved: SnapshotMeta; session: boolean } {
  if (store.getLaunch(profileId)) throw new Error("Close this profile's browser before rolling it back");
  const current = store.getProfile(profileId);
  if (!current) throw new Error("Profile not found");
  const snapshot = snapshots.read(profileId, snapshotId);
  const saved = snapshots.save(current, store.getSessionBundle(profileId), "before-rollback");
  const restored: Profile = {
    ...snapshot.profile,
    id: current.id, name: current.name, group: current.group, tags: current.tags, customNo: current.customNo,
  };
  snapshots.quietly(() => store.upsertProfile(restored));
  if (snapshot.session) store.armSessionRestore(profileId, snapshot.session);
  return { restored: snapshot.meta, saved, session: !!snapshot.session };
}

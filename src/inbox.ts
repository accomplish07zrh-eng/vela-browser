/**
 * Drop-in import: put AdsPower export `.txt` files in `inbox/`
 * and they get imported into the profile store — no flags, no file paths.
 *
 * Re-importing is presence-aware: fields absent from a refreshed export keep
 * their stored values, manager-owned identity state is never imported, and a
 * malformed batch is rejected before any row changes.
 */

import { readdirSync, existsSync, mkdirSync, watch, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { completeProfileFingerprint } from "./firefox-config.ts";
import { withDefaultBrowser } from "./create.ts";
import type { ParsedProfileImport } from "./parse.ts";
import { parseImportFile } from "./import-formats.ts";
import { FP_BLOCK_KEYS } from "./fingerprint-attestation.ts";
import { attachTimezones, type FetchLike } from "./geoip.ts";
import { proxyIdentityKey } from "./proxy.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { assertValidProfile } from "./profile-validation.ts";
import type { Profile } from "./types.ts";
import type { ProfileStore } from "./store.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * True once every `.txt` in `dir` has held the same size across `gapMs`.
 * The watcher uses this to avoid importing a file that's still being copied —
 * presence-aware merging protects existing rows, while stability also avoids
 * creating a brand-new profile from an incomplete record. Exports legitimately
 * vary in which columns they include, so completeness cannot be inferred from
 * a fixed required-column list.
 */
async function inboxStable(dir: string, gapMs = 500): Promise<boolean> {
  const sizes = () =>
    readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .map((f) => {
        try {
          return `${f}:${statSync(join(dir, f)).size}`;
        } catch {
          return `${f}:?`;
        }
      })
      .join("|");
  const before = sizes();
  await sleep(gapMs);
  return before === sizes();
}

export const DEFAULT_INBOX = "inbox";

export interface InboxResult {
  files: number;
  profiles: number;
  cookiesStripped: number;
  skipped: number;
  errors: Array<{ file: string; id: string; error: string; quarantined?: boolean }>;
}

export interface ImportOverrides {
  /** When set, import every uploaded profile into this group. */
  group?: string;
  /** When set, import every uploaded profile as this platform. */
  platform?: string;
}

function applyOverrides(entry: ParsedProfileImport, overrides: ImportOverrides): ParsedProfileImport {
  let profile = entry.profile;
  const present = new Set(entry.presentFields);
  if (overrides.group !== undefined) {
    profile = { ...profile, group: overrides.group.trim() };
    present.add("group");
  }
  if (overrides.platform !== undefined) {
    profile = { ...profile, platform: overrides.platform.trim() };
    present.add("platform");
  }
  return { ...entry, profile, presentFields: [...present] };
}

interface SourcedImport extends ParsedProfileImport {
  source: string;
}

type ImportFile = { name: string; bytes: Uint8Array };

async function readSourcedImport(file: ImportFile, overrides: ImportOverrides, exists: (id: string) => boolean) {
  const summary = await parseImportFile(file.name, file.bytes, exists);
  return {
    ...summary,
    imports: summary.imports.map(entry => ({ ...applyOverrides(entry, overrides), source: file.name })),
  };
}

export class ProfileImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ProfileImportError";
  }
}

function unsafeImportError(problems: string[], status = 400): ProfileImportError {
  return new ProfileImportError(`unsafe import rejected; no profiles were changed: ${problems.join("; ")}`, status);
}

function sameFirefoxConfig(existing: Profile, incoming: Profile): boolean {
  return isDeepStrictEqual(
    completeProfileFingerprint(existing).firefox,
    completeProfileFingerprint({ ...existing, firefox: incoming.firefox }).firefox,
  );
}

/** Merge only fields actually present in an AdsPower re-export. */
function mergeExisting(existing: Profile, incoming: SourcedImport): Profile {
  const p = incoming.profile;
  const present = new Set(incoming.presentFields);
  const out: Profile = { ...existing };

  if (present.has("acc_id")) out.accId = p.accId;
  if (present.has("name")) out.name = p.name;
  if (present.has("group")) out.group = p.group;
  if (present.has("platform")) out.platform = p.platform ?? "";
  if (p.remark !== undefined) out.remark = p.remark;
  if (p.startupUrls !== undefined) out.startupUrls = p.startupUrls;
  if (present.has("username")) out.username = p.username;
  if (present.has("password")) out.password = p.password;
  if (present.has("email")) out.email = p.email ?? "";
  if (present.has("emailpassword") || present.has("email_password")) out.emailPassword = p.emailPassword ?? "";
  if (present.has("fakey")) out.twofa = p.twofa;
  if (present.has("ua")) out.ua = p.ua;
  if (present.has("resolution")) {
    out.screenWidth = p.screenWidth;
    out.screenHeight = p.screenHeight;
  }
  if (present.has("cookie") || incoming.sessionBundle !== undefined) out.cookies = p.cookies;
  if (present.has("seed")) {
    const seed = Number(incoming.sourceFields.seed?.trim());
    if (Number.isInteger(seed) && seed >= 1 && seed <= 0xffff_ffff) out.fingerprintSeed = p.fingerprintSeed;
  }
  if (present.has("timezone") && p.timezone) out.timezone = p.timezone;
  if (present.has("locale") && p.locale) out.locale = p.locale;
  if (present.has("platform_os") && p.platformOs) out.platformOs = p.platformOs;
  if (present.has("extensions")) out.extensions = [...(p.extensions ?? [])];
  if (present.has("tags")) out.tags = [...(p.tags ?? [])];
  if (FP_BLOCK_KEYS.some((key) => present.has(key))) {
    if (p.fpExpected) out.fpExpected = { ...p.fpExpected };
    else delete out.fpExpected;
    delete out.fpVerdict;
  }
  if (present.has("proxy")) {
    const proxyHasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(incoming.sourceFields.proxy?.trim() ?? "");
    out.proxy = p.proxy && !incoming.sourceFields.proxytype?.trim() && !proxyHasScheme && existing.proxy
      ? { ...p.proxy, type: existing.proxy.type }
      : p.proxy;
    delete out.proxyError;
    // A resolved timezone belongs to a new proxy. An unchanged proxy or a failed lookup keeps the saved one.
    if (p.timezone && existing.engine !== "firefox" && proxyIdentityKey(out.proxy) !== proxyIdentityKey(existing.proxy)) {
      out.timezone = p.timezone;
    }
  }
  return out;
}

function importBrowser(entry: SourcedImport): Profile {
  const { profile } = entry;
  return profile.engine === "firefox" || profile.engine === "webkit" || profile.hardware || entry.sourceFields.chromium_runtime?.trim()
    ? profile : withDefaultBrowser(profile);
}

function incompatibleFields(existing: Profile, entry: SourcedImport): Array<{ field: string; message: string }> {
  const present = new Set(entry.presentFields);
  const issues: Array<{ field: string; message: string }> = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  if (present.has("engine") || present.has("firefox_config") || present.has("webkit_config")) {
    if ((entry.profile.engine ?? "chromium") !== (existing.engine ?? "chromium")) {
      add("engine", "profile engine cannot change in place");
    } else if (existing.engine === "webkit" && JSON.stringify(existing.webkit) !== JSON.stringify(entry.profile.webkit)) {
      add("webkit_config", "WebKit config cannot change through import");
    } else if (existing.engine === "firefox" && !sameFirefoxConfig(existing, entry.profile)) {
      add("firefox_config", "Firefox config cannot change through import");
    }
  }
  if (present.has("chromium_runtime") && (entry.profile.chromiumRuntime ?? "") !== (existing.chromiumRuntime ?? "")) {
    add("chromium_runtime", "Chrome version cannot change through import");
  }
  if (present.has("hardware_cores") && (entry.profile.hardware?.cores ?? 0) !== (existing.hardware?.cores ?? 0)) {
    add("hardware_cores", "stored hardware cannot change through import");
  }
  if (present.has("proxy") && !entry.profile.proxy && (existing.proxy || existing.proxyError)) {
    add("proxy", "blank proxy would erase the stored proxy; use profile edit to remove it explicitly");
  }
  if (present.has("ua") && !entry.profile.ua.trim() && existing.ua.trim()) {
    add("ua", "blank ua would erase the stored browser identity");
  }
  if (
    present.has("resolution") && !entry.sourceFields.resolution?.trim()
    && (existing.screenWidth !== entry.profile.screenWidth || existing.screenHeight !== entry.profile.screenHeight)
  ) {
    add("resolution", "blank resolution would erase the stored screen identity");
  }
  if (!entry.sessionBundle && present.has("cookie") && existing.cookies.length) {
    if (!entry.sourceFields.cookie?.trim()) {
      add("cookie", "blank cookie field would erase stored cookies; use [] to clear them explicitly");
    }
    if (entry.cookiesStripped > 0 && entry.profile.cookies.length === 0) {
      add("cookie", "cookie field contained only stripped extension cookies; use [] to clear stored cookies explicitly");
    }
  }
  return issues;
}

export interface MigrationSummary {
  files: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  cookiesStripped: number;
}

export interface MigrationConflict {
  file: number;
  record?: number;
  profileId?: string;
  code: "invalid_export" | "invalid_records" | "invalid_fields" | "duplicate" | "busy" | "trashed" | "handed_off" | "incompatible";
  field?: string;
}

export interface LocalMigrationPlan {
  summary: MigrationSummary;
  conflicts: MigrationConflict[];
  profiles: Array<{ profile: Profile; action: "create" | "update" | "unchanged"; version: string | null; sessionBundle?: string }>;
}

/** Build an offline preview without persisting profiles or resolving proxies. */
export async function prepareLocalMigration(
  store: ProfileStore,
  files: ImportFile[],
  overrides: ImportOverrides,
  busy: (id: string) => boolean,
): Promise<LocalMigrationPlan> {
  const summary: MigrationSummary = { files: files.length, created: 0, updated: 0, unchanged: 0, skipped: 0, cookiesStripped: 0 };
  const conflicts: MigrationConflict[] = [];
  const collected: Array<{ entry: SourcedImport; file: number; record: number }> = [];
  const exists = (id: string) => !!store.getProfile(id) || store.isTrashed(id);
  const counts = new Map<string, number>();
  for (const [index, file] of files.entries()) {
    try {
      const imported = await readSourcedImport(file, overrides, id => counts.has(id) || exists(id));
      summary.skipped += imported.skipped;
      summary.cookiesStripped += imported.cookiesStripped;
      if (imported.skipped) conflicts.push({ file: index + 1, code: "invalid_records" });
      for (const [record, entry] of imported.imports.entries()) {
        const id = entry.profile.id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        collected.push({ entry, file: index + 1, record: record + 1 });
      }
    } catch {
      // File names and parser errors can contain arbitrary input, including credentials.
      conflicts.push({ file: index + 1, code: "invalid_export" });
    }
  }

  return store.runTransaction(() => {
    // Read the values used for merging and their version from one SQLite snapshot.
    const profiles: LocalMigrationPlan["profiles"] = [];
    for (const { entry, file, record } of collected) {
      const id = entry.profile.id;
      const location = { file, record, profileId: isSafeProfileId(id) ? id : undefined };
      const before = conflicts.length;
      if (counts.get(id)! > 1) conflicts.push({ ...location, code: "duplicate" });
      if (!location.profileId || entry.validationErrors.length) conflicts.push({ ...location, code: "invalid_fields" });
      if (!location.profileId) continue;
      if (store.isTrashed(id)) conflicts.push({ ...location, code: "trashed" });
      if (store.getLaunch(id) || busy(id)) conflicts.push({ ...location, code: "busy" });
      if (store.profileHandoff(id)) conflicts.push({ ...location, code: "handed_off" });
      const existing = store.getProfile(id);
      if (existing && !entry.validationErrors.length) {
        for (const { field } of incompatibleFields(existing, entry)) conflicts.push({ ...location, code: "incompatible", field });
      }
      if (conflicts.length !== before) continue;

      const profile = existing ? mergeExisting(existing, entry) : importBrowser(entry);
      try { assertValidProfile(profile); }
      catch {
        conflicts.push({ ...location, code: "invalid_fields" });
        continue;
      }
      const sessionBundle = entry.sessionBundle;
      const version = store.migrationProfileVersion(id);
      if (!existing) {
        summary.created++;
        profiles.push({ profile, version, action: "create", sessionBundle });
      } else if (!isDeepStrictEqual(existing, profile) || (sessionBundle !== undefined && store.getPendingSessionBundle(id) !== sessionBundle)) {
        summary.updated++;
        profiles.push({ profile, version, action: "update", sessionBundle });
      } else {
        summary.unchanged++;
        profiles.push({ profile, version, action: "unchanged" });
      }
    }
    return { summary, profiles, conflicts };
  });
}

export interface PreparedImportBatch {
  imports: SourcedImport[];
  profiles: Profile[];
  result: InboxResult;
}

/** Decode, parse, validate, override, and enrich uploaded profile exports. */
export async function prepareImportBuffers(
  files: { name: string; bytes: Uint8Array }[],
  log: (msg: string) => void = console.log,
  overrides: ImportOverrides = {},
  exists: (id: string) => boolean = () => false,
  timezoneFetch?: FetchLike,
  saved: (id: string) => Profile | null = () => null,
): Promise<PreparedImportBatch> {
  let cookiesStripped = 0;
  let skipped = 0;
  const errors: InboxResult["errors"] = [];
  const collected: SourcedImport[] = [];
  for (const file of files) {
    let summary;
    try {
      summary = await readSourcedImport(file, overrides, exists);
    } catch (error) {
      if (error instanceof ProfileImportError) throw error;
      throw new ProfileImportError(error instanceof Error ? error.message : String(error));
    }
    collected.push(...summary.imports);
    cookiesStripped += summary.cookiesStripped;
    skipped += summary.skipped;
    for (const error of summary.errors) errors.push({ file: file.name, ...error });
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of collected) {
    if (seen.has(entry.profile.id)) problems.push(`${entry.source}: duplicate profile id ${entry.profile.id}`);
    seen.add(entry.profile.id);
    for (const issue of entry.validationErrors) problems.push(`${entry.source}: profile ${entry.profile.id}: ${issue}`);
  }
  if (problems.length) throw unsafeImportError(problems);

  // Look up the proxy the merge will save, and only when it differs from the saved one.
  // Firefox keeps its saved configuration, which an import cannot change.
  const toResolve = collected.flatMap((entry) => {
    const current = saved(entry.profile.id);
    const proxy = current ? mergeExisting(current, entry).proxy : entry.profile.proxy;
    if (!entry.presentFields.includes("proxy") || !proxy || entry.profile.timezone || (current ?? entry.profile).engine === "firefox") return [];
    if (current && proxyIdentityKey(proxy) === proxyIdentityKey(current.proxy)) return [];
    return [{ entry, profile: { ...entry.profile, proxy } }];
  });
  const { resolved } = await attachTimezones(toResolve.map((item) => item.profile), timezoneFetch);
  for (const { entry, profile } of toResolve) Object.assign(entry.profile, { timezone: profile.timezone, locale: profile.locale });
  if (toResolve.length) log(`import: resolved timezone for ${resolved}/${toResolve.length} supplied proxy/proxies`);

  // A new profile whose import names no browser gets this computer's default. Stored
  // hardware belongs to CloakBrowser. A saved profile never changes its browser.
  for (const entry of collected) {
    if (!saved(entry.profile.id)) entry.profile = importBrowser(entry);
  }

  return {
    imports: collected,
    profiles: collected.map((entry) => entry.profile),
    result: { files: files.length, profiles: collected.length, cookiesStripped, skipped, errors },
  };
}

/**
 * Import AdsPower exports from in-memory buffers — the shared core used by both
 * the inbox folder and UI uploads. Local re-imports merge sparse fields before
 * one atomic store write.
 */
export async function importBuffers(
  store: ProfileStore,
  files: { name: string; bytes: Uint8Array }[],
  log: (msg: string) => void = console.log,
  overrides: ImportOverrides = {},
  /** Optional hub-side lock/CAS guard, called synchronously immediately before the atomic write. */
  beforeCommit?: (profiles: readonly Profile[]) => void,
  timezoneFetch?: FetchLike,
): Promise<InboxResult> {
  const batch = await prepareImportBuffers(files, log, overrides, (id) => !!store.getProfile(id) || store.isTrashed(id), timezoneFetch, (id) => store.getProfile(id));
  const collected = batch.imports;
  const trashedIds = collected.map((entry) => entry.profile.id).filter((id) => store.isTrashed(id));
  if (trashedIds.length) throw unsafeImportError([
    `profile(s) ${trashedIds.join(", ")} are in Trash; restore them before importing`,
  ], 409);
  const problems: string[] = [];

  // All parsing, validation and timezone lookups completed before this point. No await occurs
  // between reading the current rows and committing the merged batch.
  const prepared: Profile[] = [];
  for (const entry of collected) {
    const existing = store.getProfile(entry.profile.id);
    if (!existing) {
      prepared.push(entry.profile);
      continue;
    }
    for (const { message } of incompatibleFields(existing, entry)) {
      problems.push(`${entry.source}: profile ${entry.profile.id}: ${message}`);
    }
    prepared.push(mergeExisting(existing, entry));
  }
  if (problems.length) throw unsafeImportError(problems);

  const liveIds = prepared.map((profile) => profile.id).filter((id) => !!store.getLaunch(id));
  if (liveIds.length > 0) {
    throw unsafeImportError([
      `profile(s) ${[...new Set(liveIds)].join(", ")} are currently open; close them before importing identity changes`,
    ], 409);
  }
  // Keep these checks adjacent to the single batch write: the hub guard closes
  // the claim-vs-import race after all parsing/timezone I/O has completed.
  beforeCommit?.(prepared);
  store.upsertProfiles(prepared, new Map(collected
    .filter((entry) => entry.sessionBundle !== undefined)
    .map((entry) => [entry.profile.id, entry.sessionBundle!])));
  return batch.result;
}

/** Import every `*.txt` in `dir` into the store. Creates `dir` if missing. */
export async function importInbox(
  store: ProfileStore,
  dir = DEFAULT_INBOX,
  log: (msg: string) => void = console.log,
): Promise<InboxResult> {
  mkdirSync(dir, { recursive: true });
  const txts = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
  const files = await Promise.all(
    txts.map(async (f) => ({ name: f, bytes: new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer()) })),
  );
  return importBuffers(store, files, log);
}

/**
 * Watch the inbox and re-import whenever a file appears or changes. Debounced
 * so a burst of editor/copy events collapses into one import. Returns a stop
 * function that waits for any active import. Best-effort: watch failures are
 * logged, not thrown.
 */
export function watchInbox(
  store: ProfileStore,
  dir = DEFAULT_INBOX,
  log: (msg: string) => void = console.log,
): () => Promise<void> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let stopped = false;
  let inFlight = Promise.resolve();

  // Signature of the inbox's .txt files (name+size). Used to skip re-importing
  // when a watch event did not actually change an export (for example, a
  // null-filename directory event on Linux inotify).
  const inboxSig = () =>
    readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".txt"))
      .map((f) => {
        try {
          const st = statSync(join(dir, f));
          // Size alone misses a same-length content edit (different cookies/proxy
          // at the same byte count) — include mtime so the edit still re-imports.
          return `${f}:${st.size}:${st.mtimeMs}`;
        } catch {
          return `${f}:?`;
        }
      })
      .sort()
      .join("|");
  let lastSig = "";

  const runImport = async () => {
    if (stopped) return;
    // Don't import a file that's still being copied in. If it isn't settled yet,
    // reschedule instead of dropping — a completed export must never sit
    // unimported because the copy happened to finish between two size samples.
    if (!(await inboxStable(dir).catch(() => true))) {
      if (!stopped) {
        log(`inbox: a file is still being written — will retry shortly`);
        timer = setTimeout(tryImport, 1000);
      }
      return;
    }
    if (stopped) return;
    // No-op events shouldn't re-run the import (and burn ip-api's budget).
    const current = inboxSig();
    if (current === lastSig) return;
    const r = await importInbox(store, dir).catch((err) => {
      log(`inbox import failed: ${err}`);
      return null;
    });
    if (r) {
      lastSig = current;
      log(`inbox: imported ${r.profiles} profile(s) from ${r.files} file(s)`);
    }
  };

  const tryImport = () => {
    inFlight = inFlight.then(runImport, runImport);
    return inFlight;
  };

  try {
    watcher = watch(dir, (_event, filename) => {
      if (stopped) return;
      // When the OS gives a filename (always on Windows) filter to .txt up
      // front. A null filename (some Linux/dir events) falls through to
      // tryImport, whose signature check no-ops when nothing actually changed.
      if (filename && !filename.toLowerCase().endsWith(".txt")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tryImport, 500);
    });
    log(`watching ${dir} — drop AdsPower export .txt files here to import`);
  } catch (err) {
    log(`inbox watch unavailable (${err}); use \`import\` manually instead`);
  }
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    await inFlight;
  };
}

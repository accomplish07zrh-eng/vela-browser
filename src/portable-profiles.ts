import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isArchive, openArchive, sealArchive } from "./encrypted-archive.ts";
import type { Launcher } from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import type { ProfileWrites } from "./profile-writes.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { parseCapturedSessionBundle } from "./session.ts";
import type { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const magic = Buffer.from("VELAPRF1");
export const MAX_PORTABLE_BYTES = 96 * 1024 * 1024;
const chromeFiles = [
  "Default/Bookmarks", "Default/IndexedDB", "Default/Local Storage", "Default/Session Storage",
  "Default/Service Worker", "Default/Storage", "Default/WebStorage", "Default/QuotaManager",
  "Default/QuotaManager-journal", "Default/QuotaManager-wal", "Default/QuotaManager-shm", "Default/Extension State",
  "Default/Local Extension Settings", "Default/Sync Extension Settings",
];
const firefoxFiles = [
  "cookies.sqlite", "storage.sqlite", "storage", "places.sqlite", "browser-extension-data", "extension-preferences.json",
  "sessionstore.jsonlz4", "sessionstore-backups",
];
const fileFormat = /^[A-Za-z0-9][A-Za-z0-9._-]{0,118}\.vela-profile$/;
const importMarker = ".vela-portable-import";
type PortableFile = { path: string; data: string };
type PortablePayload = { platform: NodeJS.Platform; arch: string; profile: Profile; session?: string; files: PortableFile[] };

function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 4096) throw new Error("Use a portable profile passphrase of at least 12 characters");
  return value;
}

export async function sealPortableProfile(value: PortablePayload, passphrase: string): Promise<Buffer> {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > MAX_PORTABLE_BYTES) throw new Error("The selected profile state exceeds the portable file size limit");
  return sealArchive(data, password(passphrase), magic);
}

export async function openPortableProfile(data: Buffer, passphrase: string): Promise<PortablePayload> {
  if (!isArchive(data, magic, MAX_PORTABLE_BYTES)) throw new Error("Invalid Vela portable profile");
  const pass = password(passphrase);
  let raw: PortablePayload;
  try {
    const plain = await openArchive(data, pass, magic, MAX_PORTABLE_BYTES);
    raw = JSON.parse(plain.toString("utf8"));
  } catch { throw new Error("The portable profile could not be decrypted or is damaged"); }
  assertValidProfile(raw?.profile);
  if (!Array.isArray(raw.files) || raw.files.length > 20000) throw new Error("Invalid portable profile files");
  if (raw.session !== undefined) parseCapturedSessionBundle(raw.session);
  return raw;
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function nativeRoots(profile: Profile) {
  return profile.engine === "firefox" ? firefoxFiles : profile.engine === "webkit" ? [] : chromeFiles;
}

function collectFiles(root: string, directories: readonly string[]): PortableFile[] {
  if (!existsSync(root)) return [];
  if (!lstatSync(root).isDirectory()) throw new Error("Invalid profile data directory");
  const real = realpathSync(root), files: PortableFile[] = [];
  let bytes = 0;
  const collect = (path: string) => {
    const target = join(real, path), stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !contained(real, realpathSync(target))) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(target)) collect(path + "/" + name);
    } else if (stat.isFile() && stat.size > 0) {
      if (bytes + stat.size > MAX_PORTABLE_BYTES * 0.65 || files.length >= 20000) throw new Error("The selected profile state is too large");
      const content = readFileSync(target);
      bytes += content.length;
      files.push({ path, data: content.toString("base64") });
    }
  };
  for (const path of directories) collect(path);
  return files;
}

function validatedFiles(payload: PortablePayload): PortableFile[] {
  const seen = new Set<string>();
  const roots = nativeRoots(payload.profile);
  for (const item of payload.files) {
    if (!item || typeof item.path !== "string" || item.path.length > 2048 || typeof item.data !== "string"
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data) || item.data.length % 4 !== 0
      || !roots.some(root => item.path === root || item.path.startsWith(root + "/"))
      || item.path.split("/").some(part => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part)
        || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || seen.has(item.path.toLowerCase())) throw new Error("Invalid path or data in the portable profile");
    seen.add(item.path.toLowerCase());
  }
  return payload.files;
}

export class PortableProfiles {
  private readonly root: string;
  constructor(private readonly options: { root: string; launcher: Launcher; store: ProfileStore; writes: ProfileWrites; admission: LifecycleAdmissionController }) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(options.root);
  }

  async export(profileId: string, name: unknown, passphrase: unknown, handoff?: boolean, signal?: AbortSignal) {
    const key = password(passphrase);
    const path = this.file(name ?? (profileId + "-" + randomUUID() + ".vela-profile"));
    return this.exclusive(profileId, async () => {
      const { launcher, store } = this.options;
      const profile = store.getProfile(profileId);
      if (!profile) throw new Error("Profile was not found");
      const frozen = store.profileHandoff(profileId);
      if (frozen) {
        if (!handoff || typeof name !== "string") throw new Error("The profile is already handed off");
        const data = this.read(name, frozen);
        const { files } = await openPortableProfile(data, key);
        return { profileId, file: path, digest: frozen, bytes: data.length, nativeFiles: files.length, handoff: true };
      }
      if (existsSync(path)) throw new Error("A portable profile with this file name already exists");
      const pending = path + ".pending";
      if (!handoff && existsSync(pending)) throw new Error("A portable profile with this file name is being handed off");
      if (handoff && existsSync(pending)) {
        const pendingProfile = await openPortableProfile(this.readFile(pending), key);
        if (pendingProfile.profile.id !== profileId) throw new Error("The portable file name belongs to another profile");
        await rm(pending);
      }
      const launch = store.getLaunch(profileId);
      let completed = false;
      let stopped = false;
      try {
        const native = launcher.userDataDir(profileId);
        const readNativeCookies = profile.engine !== "firefox" && profile.engine !== "webkit"
          && ["Default/Network/Cookies", "Default/Cookies"].some(name => existsSync(join(native, name)));
        if (!launch && readNativeCookies && !store.getPendingSessionBundle(profileId)) {
          await launcher.start(profileId, [], { headless: true, autoNavigate: false });
        }
        if (store.getLaunch(profileId) && profile.engine !== "firefox" && !await launcher.captureLocalSession(profileId)) {
          throw new Error("Could not capture the profile's current browser session");
        }
        if (profile.engine === "firefox" && launch) await launcher.captureLocalSession(profileId);
        if (!await launcher.stopForStateTransfer(profileId)) throw new Error("Close the profile before creating a portable copy");
        stopped = true;
        await launcher.cacheCleanupSettled(profileId);
        const session = store.getSessionBundle(profileId) ?? undefined;
        const files = collectFiles(native, nativeRoots(profile));
        const data = await sealPortableProfile({ profile, session, platform: process.platform, arch: process.arch, files }, key);
        const digest = createHash("sha256").update(data).digest("hex");
        if (existsSync(path)) throw new Error("A portable profile with this file name already exists");
        writeFileSync(handoff ? pending : path, data, { mode: 0o600, flag: "wx", flush: true });
        if (handoff) {
          store.setProfileHandoff(profileId, digest);
          renameSync(pending, path);
        }
        completed = true;
        return { profileId, file: path, digest, bytes: data.length, nativeFiles: files.length, handoff: handoff === true };
      } finally {
        if (!launch && !stopped && store.getLaunch(profileId) && !await launcher.stopForStateTransfer(profileId)) {
          throw new Error("The temporary browser used to export the profile could not be closed");
        }
        if (launch && stopped && (!handoff || !completed) && !store.profileHandoff(profileId)) {
          await launcher.start(profileId, [], { headless: launch.headless });
        }
      }
    }, signal);
  }

  read(name: unknown, handoffDigest?: string): Buffer {
    const path = this.file(name);
    const staged = !existsSync(path) && !!handoffDigest;
    const data = this.readFile(staged ? path + ".pending" : path);
    if (handoffDigest && createHash("sha256").update(data).digest("hex") !== handoffDigest) {
      throw new Error("This profile has a different handoff in progress");
    }
    if (staged) renameSync(path + ".pending", path);
    return data;
  }

  private readFile(path: string): Buffer {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_PORTABLE_BYTES || !contained(this.root, realpathSync(path))) throw new Error("Invalid portable profile file");
    return readFileSync(path);
  }

  async inspect(data: Buffer, passphrase: unknown) {
    const payload = await openPortableProfile(data, password(passphrase));
    return { profileId: payload.profile.id, group: payload.profile.group, engine: payload.profile.engine ?? "chromium", nativeFiles: payload.files.length };
  }

  checkDestination(profileId: string, revision?: string, requireNewDirectory = false) {
    assertSafeProfileId(profileId);
    const { launcher, store } = this.options;
    if (store.getProfile(profileId) || store.isTrashed(profileId)) throw new Error("A profile with this ID already exists");
    if (revision && !launcher.kernelRevisions().includes(revision)) throw new Error("The pinned browser build is unavailable on this host");
    if (requireNewDirectory && existsSync(launcher.userDataDir(profileId))) throw new Error("Native profile files already exist on this worker");
  }

  async restore(data: Buffer, passphrase: unknown, authorize: (profile: Profile) => void, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const payload = await openPortableProfile(data, password(passphrase)), { profile } = payload;
    authorize(profile);
    const files = validatedFiles(payload);
    if (files.length && (payload.platform !== process.platform || payload.arch !== process.arch)) {
      throw new Error("Restore native browser data on the same operating system and architecture");
    }
    return this.exclusive(profile.id, async () => {
      const { launcher, store } = this.options;
      signal?.throwIfAborted();
      authorize(profile);
      const digest = createHash("sha256").update(data).digest("hex");
      if (store.getProfile(profile.id) && store.portableProfileDigest(profile.id) === digest) {
        return { profileId: profile.id, imported: false, digest, nativeFiles: files.length };
      }
      this.checkDestination(profile.id, profile.kernelRevision);
      const destination = launcher.userDataDir(profile.id);
      const parent = dirname(destination);
      const marker = join(destination, importMarker);
      if (existsSync(destination)) {
        if (lstatSync(destination).isSymbolicLink() || !lstatSync(marker, { throwIfNoEntry: false })?.isFile()
          || dirname(realpathSync(destination)) !== realpathSync(parent) || readFileSync(marker, "utf8") !== digest) {
          throw new Error("Existing native profile files must be resolved before importing");
        }
        store.commitPortableProfile(profile, payload.session, digest);
        await rm(marker, { force: true }).catch(() => {});
        return { profileId: profile.id, imported: true, digest, nativeFiles: files.length };
      }
      mkdirSync(parent, { recursive: true });
      const staging = join(realpathSync(parent), ".vela-profile-import-" + randomUUID());
      mkdirSync(staging, { mode: 0o700 });
      try {
        for (const file of files) {
          const target = resolve(staging, file.path);
          if (!contained(staging, target)) throw new Error("Portable file escaped the staging directory");
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, Buffer.from(file.data, "base64"), { mode: 0o600, flag: "wx" });
        }
        writeFileSync(join(staging, importMarker), digest, { mode: 0o600, flag: "wx", flush: true });
        signal?.throwIfAborted();
        authorize(profile);
        renameSync(staging, destination);
        store.commitPortableProfile(profile, payload.session, digest);
        await rm(marker, { force: true }).catch(() => {});
      } finally {
        if (existsSync(staging) && realpathSync(staging) === staging && dirname(staging) === realpathSync(parent)) {
          await rm(staging, { recursive: true, force: true });
        }
      }
      return { profileId: profile.id, imported: true, digest, nativeFiles: files.length,
        missingExtensions: (profile.extensions ?? []).filter(id => !store.getExtension(id)) };
    }, signal);
  }

  private file(name: unknown): string {
    if (typeof name !== "string" || !fileFormat.test(name)) throw new Error("Use a file name ending in .vela-profile");
    return join(this.root, name);
  }

  private exclusive<T>(profileId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.options.writes.run(profileId, () => this.options.admission.run({ kind: "cleanup", profileIds: [profileId], signal }, action), signal);
  }
}

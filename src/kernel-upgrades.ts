import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_CHROMIUM_REVISION } from "./aliasmode-chromium.ts";
import type { Launcher } from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { assertSafeProfileId } from "./profile-id.ts";
import type { ProfileWrites } from "./profile-writes.ts";
import type { ProfileStore } from "./store.ts";

type Change = {
  id: string;
  profileId: string;
  previous?: string;
  revision: string;
  state: "testing" | "applied" | "restoring" | "restored";
  data: boolean;
  wasOpen: boolean;
  headless: boolean;
};

interface RolloutOptions {
  canaryCount?: number;
}

export class KernelUpgrades {
  private readonly root: string;
  constructor(private readonly options: {
    root: string;
    store: ProfileStore;
    launcher: Launcher;
    admission: LifecycleAdmissionController;
    writes: ProfileWrites;
    log?(message: string): void;
  }) {
    this.root = resolve(options.root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  revisions() {
    return this.options.launcher.kernelRevisions().map(revision => ({ revision, default: revision === DEFAULT_CHROMIUM_REVISION }));
  }

  status(profileId: string) {
    return { revision: this.profile(profileId).kernelRevision ?? DEFAULT_CHROMIUM_REVISION, change: this.read(profileId) ?? null };
  }

  async upgrade(profileId: string, revision: string, signal?: AbortSignal) {
    this.profile(profileId);
    signal?.throwIfAborted();
    if (!this.revisions().some(entry => entry.revision === revision)) throw new Error("This kernel revision is unavailable on this host");
    await this.options.launcher.prepareKernel(revision);
    return this.exclusive(profileId, async () => {
      const { launcher, store } = this.options;
      if (store.profileHandoff(profileId)) throw new Error("The profile has been handed off to another worker");
      const interrupted = this.read(profileId);
      if (interrupted && ["testing", "restoring"].includes(interrupted.state)) await this.restore(interrupted);
      const profile = this.profile(profileId);
      if (profile.kernelRevision === revision) return this.status(profileId);

      const launch = store.getLaunch(profileId);
      if (launch) await launcher.captureLocalSession(profileId);
      await this.stop(profileId);
      const live = launcher.userDataDir(profileId);
      this.verifyDirectory(live);
      const change: Change = {
        id: randomUUID(), profileId, previous: profile.kernelRevision, revision, state: "testing",
        data: existsSync(live), wasOpen: !!launch, headless: launch?.headless ?? true,
      };
      const directory = this.directory(change);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (change.data) await cp(live, join(directory, "snapshot"), { recursive: true, verbatimSymlinks: true });
      this.save(change);
      try {
        store.setKernelRevision(profileId, revision);
        await launcher.start(profileId, [], { headless: change.headless });
        if (!await launcher.certifiedActive(profileId)) throw new Error("The new kernel could not be certified");
        if (!change.wasOpen) await this.stop(profileId);
        change.state = "applied";
        this.save(change);
      } catch (error) {
        await this.restore(change);
        throw error;
      }
      if (interrupted && interrupted.id !== change.id) await this.remove(this.directory(interrupted)).catch(() => {});
      return this.status(profileId);
    }, signal);
  }

  async upgradeBatch(profileIds: string[], revision: string, signal?: AbortSignal, options: RolloutOptions = {}) {
    const ids = [...new Set(profileIds)];
    const canaryCount = options.canaryCount ?? 0;
    if (!Number.isInteger(canaryCount) || canaryCount < 0 || canaryCount > ids.length) throw new Error("Invalid kernel canary size");
    for (const profileId of ids) this.profile(profileId);
    if (!this.revisions().some(entry => entry.revision === revision)) throw new Error("This kernel revision is unavailable on this host");
    const completed: Array<{ profileId: string; change: ReturnType<KernelUpgrades["status"]>; canary?: true }> = [];
    for (const [index, profileId] of ids.entries()) {
      try {
        signal?.throwIfAborted();
        const change = await this.upgrade(profileId, revision, signal);
        completed.push({ profileId, change, ...(index < canaryCount ? { canary: true as const } : {}) });
      } catch (error) {
        return { completed, failure: { profileId, message: error instanceof Error ? error.message : String(error) },
          pending: ids.slice(index + 1) };
      }
      // The Agent can advance with the returned pending IDs after checking its own fixture.
      if (canaryCount && completed.length === canaryCount && canaryCount < ids.length) {
        return { completed, awaitingVerification: true, pending: ids.slice(canaryCount) };
      }
    }
    return { completed, pending: [] };
  }

  async rollback(profileId: string, signal?: AbortSignal) {
    return this.exclusive(profileId, async () => {
      const change = this.read(profileId);
      if (!change) throw new Error("No kernel upgrade snapshot is available for this profile");
      if (change.state !== "restored") await this.restore(change);
      return this.status(profileId);
    }, signal);
  }

  recover() {
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      const profileId = name.slice(0, -5);
      try {
        const change = this.read(profileId);
        if (change?.state === "testing" || change?.state === "restoring") {
          void this.rollback(profileId).catch(error => this.options.log?.(`Kernel recovery for ${profileId}: ${error.message}`));
        }
      } catch (error) { this.options.log?.(`Could not read a kernel upgrade: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private profile(profileId: string) {
    assertSafeProfileId(profileId);
    const profile = this.options.store.getProfile(profileId);
    if (profile?.chromiumRuntime !== "aliasmode") throw new Error("Select a Vela Chromium profile");
    return profile;
  }

  private exclusive<T>(profileId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.profile(profileId);
    return this.options.writes.run(profileId, () => this.options.admission.run({ kind: "cleanup", profileIds: [profileId], signal }, action), signal);
  }

  private async stop(profileId: string) {
    if (!await this.options.launcher.stopForStateTransfer(profileId)) throw new Error("The previous browser generation is still running");
    await this.options.launcher.cacheCleanupSettled(profileId);
  }

  private async restore(change: Change) {
    const { launcher, store } = this.options, { profileId } = change;
    await this.stop(profileId);
    const live = launcher.userDataDir(profileId);
    this.verifyDirectory(live);
    const directory = this.directory(change);
    this.verifyDirectory(directory);
    const restoreRoot = join(dirname(live), ".vela-kernel-" + change.id);
    this.verifyDirectory(restoreRoot);
    mkdirSync(restoreRoot, { recursive: true, mode: 0o700 });
    const staging = join(restoreRoot, "restore-ready"), displaced = join(restoreRoot, "displaced");
    if (change.state !== "restoring") {
      const snapshot = join(directory, "snapshot");
      if (change.data) {
        this.verifyDirectory(snapshot);
        await this.remove(staging, restoreRoot);
        await cp(snapshot, staging, { recursive: true, verbatimSymlinks: true });
      }
      change.state = "restoring";
      this.save(change);
    }
    if (!existsSync(displaced) && existsSync(live) && (!change.data || existsSync(staging))) await rename(live, displaced);
    if (change.data && existsSync(staging)) await rename(staging, live);
    if (change.data && !existsSync(live)) throw new Error("The staged profile restoration is unavailable");
    store.setKernelRevision(profileId, change.previous);
    if (change.wasOpen) {
      await launcher.start(profileId, [], { headless: change.headless });
      if (!await launcher.certifiedActive(profileId)) throw new Error("The restored kernel could not be certified");
    }
    change.state = "restored";
    this.save(change);
    await this.remove(restoreRoot, dirname(live)).catch(() => {});
  }

  private path(profileId: string) {
    assertSafeProfileId(profileId);
    return join(this.root, profileId + ".json");
  }

  private directory(change: Change) {
    if (!/^[0-9a-f-]{36}$/.test(change.id)) throw new Error("Invalid kernel snapshot identifier");
    return join(this.root, change.id);
  }

  private read(profileId: string): Change | undefined {
    const path = this.path(profileId);
    if (!existsSync(path)) return;
    const change = JSON.parse(readFileSync(path, "utf8")) as Change;
    if (change.profileId !== profileId) throw new Error("Invalid kernel upgrade owner");
    this.directory(change);
    return change;
  }

  private save(change: Change) {
    const path = this.path(change.profileId), temporary = path + ".tmp";
    writeFileSync(temporary, JSON.stringify(change), { mode: 0o600, flush: true });
    renameSync(temporary, path);
  }

  private verifyDirectory(path: string) {
    if (!existsSync(path)) return;
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== resolve(realpathSync(dirname(path)), basename(path))) {
      throw new Error("Unexpected browser data directory");
    }
  }

  private async remove(path: string, rootPath = this.root) {
    if (!existsSync(path)) return;
    this.verifyDirectory(path);
    const root = realpathSync(rootPath), target = realpathSync(path);
    if (dirname(target) !== root) throw new Error("Kernel backup directory escaped its storage root");
    await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 });
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname } from "node:path";

/**
 * Cooling: when the computer runs short of memory, the browser nobody has touched for the
 * longest gets the same safe close as the Close button. Its session is captured first, so it
 * comes back signed in. It keeps its tile on the workbench, marked cooled, until it starts again.
 */
export interface CoolingSettings {
  enabled: boolean;
  /** Memory use, in percent of physical memory, at which cooling starts. */
  threshold: number;
  /** A browser touched more recently than this is never cooled. */
  idleMinutes: number;
}

export const COOLING_DEFAULTS: CoolingSettings = { enabled: true, threshold: 85, idleMinutes: 10 };
export const COOLING_LIMITS = { threshold: [60, 95], idleMinutes: [1, 240] } as const;

export function normalizeCoolingSettings(value: unknown): CoolingSettings {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const clamp = (raw: unknown, [low, high]: readonly [number, number], fallback: number) =>
    typeof raw === "number" && Number.isFinite(raw) ? Math.min(high, Math.max(low, Math.round(raw))) : fallback;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : COOLING_DEFAULTS.enabled,
    threshold: clamp(input.threshold, COOLING_LIMITS.threshold, COOLING_DEFAULTS.threshold),
    idleMinutes: clamp(input.idleMinutes, COOLING_LIMITS.idleMinutes, COOLING_DEFAULTS.idleMinutes),
  };
}

export interface MemorySample { total: number; available: number }

/**
 * Physical memory the system can hand out without swapping. Windows and Linux report it as free
 * memory; macOS counts its file cache as used, so there the cache it can drop counts as available.
 */
export function readMemory(platform = process.platform): MemorySample {
  const total = totalmem();
  if (platform === "darwin") {
    try {
      const result = Bun.spawnSync(["vm_stat"], { stdout: "pipe", stderr: "ignore" });
      const text = result.stdout.toString();
      const page = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
      const available = (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page;
      if (available > 0) return { total, available: Math.min(total, available) };
    } catch {}
  }
  if (platform === "linux") {
    try {
      const available = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
      if (Number.isFinite(available)) return { total, available: Math.min(total, available * 1024) };
    } catch {}
  }
  return { total, available: freemem() };
}

const MIB = 1024 * 1024;
const START_MEMORY = 450 * MIB;

function launchReserve(sample: MemorySample): number {
  return Math.min(1536 * MIB, sample.total / 4);
}

/**
 * How many costly operations the host can admit, with up to 1.5 GiB reserved for the system.
 */
export function launchBatchSize(sample: MemorySample, cpus: number): number {
  return Math.max(0, Math.min(8, cpus, Math.floor((sample.available - launchReserve(sample)) / START_MEMORY)));
}

export interface HostWorkPermit { release(): void }

/** One memory budget for browser launches and Agent jobs, including jobs that open a browser. */
export class HostWorkBudget {
  private readonly active = new Set<HostWorkPermit>();
  private sample?: MemorySample;
  private sampledAt = -Infinity;
  private paused = false;

  constructor(
    private readonly processors: number,
    private readonly memory = readMemory,
    private readonly now = () => performance.now(),
  ) {}

  status() {
    const now = this.now();
    if (!this.sample || now - this.sampledAt >= 500) {
      this.sample = this.memory();
      this.sampledAt = now;
      const threshold = launchReserve(this.sample) + START_MEMORY + (this.paused ? 128 * MIB : 0);
      this.paused = this.sample.available < threshold;
    }
    const limit = this.paused ? 0 : launchBatchSize(this.sample, this.processors);
    return { ...this.sample, limit, inUse: this.active.size, paused: this.paused };
  }

  canStart(permit?: HostWorkPermit): boolean {
    const { limit, inUse } = this.status();
    return (permit !== undefined && this.active.has(permit)) || inUse < limit;
  }

  acquire(): HostWorkPermit | undefined {
    if (!this.canStart()) return;
    const permit = { release: () => { this.active.delete(permit); } };
    this.active.add(permit);
    return permit;
  }
}

export interface CoolingDeps {
  settings(): CoolingSettings;
  /** Profiles with a browser running now. */
  running(): { profileId: string; startedAt: number }[];
  /** True while a script, an AI connection or the workbench is using the browser. */
  busy(profileId: string): boolean;
  /** When the user last worked in this browser, 0 if never. */
  lastActive(profileId: string): number;
  /** Capture the session and close the browser exactly as the Close button does. */
  cool(profileId: string): Promise<boolean>;
  exists(profileId: string): boolean;
  memory?: () => MemorySample;
  now?: () => number;
  /** Where cooled tiles are remembered across restarts. */
  file?: string;
  log?: (message: string) => void;
}

/** Two samples in a row must be high, so a short spike never closes anything. */
const HIGH_SAMPLES = 2;
/** After one browser cools, the system gets this long to hand its memory back. */
const SETTLE_MS = 30_000;
/** A browser that would not close is left alone this long before cooling tries it again. */
const RETRY_MS = 5 * 60_000;

export class CoolingMonitor {
  private readonly cooled = new Map<string, number>();
  private readonly failed = new Map<string, number>();
  private high = 0;
  private lastCooled = 0;
  private cooling = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: CoolingDeps) {
    if (!deps.file || !existsSync(deps.file)) return;
    try {
      const saved = JSON.parse(readFileSync(deps.file, "utf8")) as { cooled?: Record<string, unknown> };
      for (const [id, at] of Object.entries(saved.cooled ?? {})) {
        if (typeof at === "number" && deps.exists(id)) this.cooled.set(id, at);
      }
    } catch {}
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  /** When this profile was cooled, or undefined while it runs or after the user closed it. */
  cooledAt(profileId: string): number | undefined { return this.cooled.get(profileId); }

  /** The user closed or deleted it: it is no longer a cooled tile. */
  forget(profileId: string): void { if (this.cooled.delete(profileId)) this.save(); }

  usage(): number {
    const { total, available } = (this.deps.memory ?? readMemory)();
    return total > 0 ? Math.round((1 - available / total) * 1000) / 10 : 0;
  }

  /** One check. Returns the profile it cooled, if any. */
  async tick(): Promise<string | null> {
    const running = this.deps.running();
    // A cooled browser that started again is just running.
    let changed = false;
    for (const { profileId } of running) if (this.cooled.delete(profileId)) changed = true;
    for (const id of [...this.cooled.keys()]) if (!this.deps.exists(id)) { this.cooled.delete(id); changed = true; }
    if (changed) this.save();

    const settings = this.deps.settings();
    if (!settings.enabled || this.cooling) { this.high = 0; return null; }
    if (this.usage() < settings.threshold) { this.high = 0; return null; }
    if (++this.high < HIGH_SAMPLES) return null;
    const now = this.now();
    if (now - this.lastCooled < SETTLE_MS) return null;

    const idleSince = now - settings.idleMinutes * 60_000;
    const candidate = running
      .filter(({ profileId }) => !this.deps.busy(profileId) && !(now - (this.failed.get(profileId) ?? -Infinity) < RETRY_MS))
      .map(({ profileId, startedAt }) => ({ profileId, active: Math.max(startedAt, this.deps.lastActive(profileId)) }))
      .filter(({ active }) => active <= idleSince)
      .sort((a, b) => a.active - b.active)[0];
    if (!candidate) return null;

    this.cooling = true;
    try {
      const closed = await this.deps.cool(candidate.profileId);
      if (!closed) { this.failed.set(candidate.profileId, this.now()); return null; }
      this.failed.delete(candidate.profileId);
      this.cooled.set(candidate.profileId, this.now());
      this.lastCooled = this.now();
      this.high = 0;
      this.save();
      this.deps.log?.(`cooled ${candidate.profileId}: memory use reached ${settings.threshold}%`);
      return candidate.profileId;
    } catch (error) {
      this.failed.set(candidate.profileId, this.now());
      this.deps.log?.(`cooling ${candidate.profileId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.cooling = false;
    }
  }

  private save(): void {
    if (!this.deps.file) return;
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      const temporary = `${this.deps.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, cooled: Object.fromEntries(this.cooled) }));
      renameSync(temporary, this.deps.file);
    } catch {}
  }
}

/** Last user activity per browser, fed by the workbench and the AI connection. */
export class ActivityLog {
  private readonly last = new Map<string, number>();
  private readonly holds = new Map<string, number>();
  touch(profileId: string, at = Date.now()): void { this.last.set(profileId, at); }
  lastActive(profileId: string): number { return this.last.get(profileId) ?? 0; }
  /** Held while something keeps using it right now, such as a focused workbench viewport. */
  hold(profileId: string): () => void {
    this.holds.set(profileId, (this.holds.get(profileId) ?? 0) + 1);
    this.touch(profileId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.touch(profileId);
      const count = (this.holds.get(profileId) ?? 1) - 1;
      if (count > 0) this.holds.set(profileId, count); else this.holds.delete(profileId);
    };
  }
  held(profileId: string): boolean { return (this.holds.get(profileId) ?? 0) > 0; }
}

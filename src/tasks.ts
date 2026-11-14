/**
 * Automated tasks: saved scripts run in order over a chosen set of profiles, by hand or on a
 * schedule, with retries for the profiles that failed and a report of every run. A task only
 * drives the existing script runner; it never runs while another script run is in progress.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ScriptRun } from "./scripts.ts";

export type TaskSchedule =
  | { kind: "manual" }
  /** Every day at local time HH:MM, or only on `days` (0 = Sunday … 6 = Saturday). */
  | { kind: "daily"; time: string; days?: number[] }
  | { kind: "interval"; minutes: number };

export interface TaskStep { scriptId: string; inputs: Record<string, unknown> }

export interface TaskTarget { profileIds?: string[]; groups?: string[]; tags?: string[] }

export interface TaskDefinition {
  id: string;
  name: string;
  enabled: boolean;
  target: TaskTarget;
  /** Run in order; each step continues with the profiles that succeeded the step before. */
  steps: TaskStep[];
  concurrency: number;
  /** How many more times a step is tried for the profiles that failed it. */
  retries: number;
  useCredentials: boolean;
  schedule: TaskSchedule;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

export interface TaskStepReport {
  scriptId: string;
  scriptName: string;
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  failures: Array<{ profileId: string; name: string; error?: string }>;
}

export interface TaskRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "schedule" | "manual";
  startedAt: number;
  finishedAt?: number;
  outcome: "running" | "succeeded" | "partial" | "failed" | "skipped";
  note?: string;
  profiles: number;
  steps: TaskStepReport[];
}

export class TaskError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const MAX_STEPS = 10;
const MAX_HISTORY = 100;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Checks a task from the dashboard or an AI; returns it with defaults filled in. */
export function normalizeTask(input: unknown, existing?: TaskDefinition, now = Date.now()): TaskDefinition {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 80) throw new TaskError("A task needs a name of at most 80 characters");
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) throw new TaskError(`A task runs 1 to ${MAX_STEPS} scripts`);
  const normalizedSteps = steps.map((step, index) => {
    const value = (step && typeof step === "object" ? step : {}) as Record<string, unknown>;
    if (typeof value.scriptId !== "string" || !value.scriptId) throw new TaskError(`Step ${index + 1} needs a script`);
    const inputs = value.inputs === undefined ? {} : value.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new TaskError(`Step ${index + 1}: inputs must be a JSON object`);
    return { scriptId: value.scriptId, inputs: inputs as Record<string, unknown> };
  });
  const targetRaw = (raw.target && typeof raw.target === "object" ? raw.target : {}) as Record<string, unknown>;
  const list = (value: unknown, label: string) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 1000 || !value.every((item) => typeof item === "string")) throw new TaskError(`${label} must be a list of text`);
    const items = [...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))];
    return items.length ? items : undefined;
  };
  const target: TaskTarget = {};
  const profileIds = list(targetRaw.profileIds, "Profiles"), groups = list(targetRaw.groups, "Groups"), tags = list(targetRaw.tags, "Tags");
  if (profileIds) target.profileIds = profileIds;
  if (groups) target.groups = groups;
  if (tags) target.tags = tags;
  if (!profileIds && !groups && !tags) throw new TaskError("Choose the profiles, groups or tags the task runs in");
  const concurrency = raw.concurrency === undefined ? 5 : Number(raw.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new TaskError("Parallel browsers must be 1 to 50");
  const retries = raw.retries === undefined ? 1 : Number(raw.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new TaskError("Retries must be 0 to 3");
  return {
    id: existing?.id ?? randomUUID(),
    name,
    enabled: raw.enabled !== false,
    target,
    steps: normalizedSteps,
    concurrency,
    retries,
    useCredentials: raw.useCredentials === true,
    schedule: normalizeSchedule(raw.schedule),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
  };
}

export function normalizeSchedule(value: unknown): TaskSchedule {
  const raw = (value && typeof value === "object" ? value : { kind: "manual" }) as Record<string, unknown>;
  if (raw.kind === "manual" || raw.kind === undefined) return { kind: "manual" };
  if (raw.kind === "daily") {
    if (typeof raw.time !== "string" || !TIME.test(raw.time)) throw new TaskError("The time must be HH:MM");
    if (raw.days === undefined) return { kind: "daily", time: raw.time };
    if (!Array.isArray(raw.days) || !raw.days.length || !raw.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
      throw new TaskError("Days must be 0 (Sunday) to 6 (Saturday)");
    }
    const days = [...new Set(raw.days as number[])].sort();
    return days.length === 7 ? { kind: "daily", time: raw.time } : { kind: "daily", time: raw.time, days };
  }
  if (raw.kind === "interval") {
    const minutes = Number(raw.minutes);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) throw new TaskError("The interval must be 15 minutes to 7 days");
    return { kind: "interval", minutes };
  }
  throw new TaskError("Unknown schedule");
}

/** When a task is next due after `from` (local time), or null for one run by hand. */
export function nextRunAt(task: Pick<TaskDefinition, "schedule" | "lastRunAt" | "createdAt">, from: number): number | null {
  const schedule = task.schedule;
  if (schedule.kind === "manual") return null;
  if (schedule.kind === "interval") return Math.max(from, (task.lastRunAt ?? task.createdAt) + schedule.minutes * 60_000);
  const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    day.setHours(hours, minutes, 0, 0);
    if (day.getTime() <= from) continue;
    if (schedule.days && !schedule.days.includes(day.getDay())) continue;
    return day.getTime();
  }
  return null;
}

interface TaskFile { tasks: TaskDefinition[]; history: TaskRunRecord[] }

/** Tasks and their run history, kept in one JSON file in the data folder. */
export class TaskStore {
  constructor(private readonly path: string) {}
  read(): TaskFile {
    if (!existsSync(this.path)) return { tasks: [], history: [] };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return { tasks: Array.isArray(raw?.tasks) ? raw.tasks : [], history: Array.isArray(raw?.history) ? raw.history : [] };
    } catch {
      return { tasks: [], history: [] };
    }
  }
  write(file: TaskFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify({ tasks: file.tasks, history: file.history.slice(-MAX_HISTORY) }, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

export interface TaskRunnerDeps {
  store: TaskStore;
  runner: { start(request: { scriptId: string; profileIds: string[]; inputs: Record<string, unknown>; useCredentials: boolean; concurrency?: number; startedBy?: { kind: "ai" | "task" | "user"; name: string } }): ScriptRun; settled(): Promise<void>; status(): ScriptRun | null };
  /** The profiles a target names right now, in a stable order. */
  resolveProfiles(target: TaskTarget): string[];
  scriptName(scriptId: string): Promise<string>;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Runs tasks by hand and on schedule, one at a time. A due task waits for nothing: when a script
 * is already running, that run is recorded as skipped and the task is due again at its next time.
 */
export class TaskRunner {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<TaskRunRecord> | null = null;
  private currentId: string | null = null;
  constructor(private readonly deps: TaskRunnerDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }

  list(): { tasks: Array<TaskDefinition & { nextRunAt: number | null }>; history: TaskRunRecord[]; runningTaskId: string | null } {
    const file = this.deps.store.read();
    const now = this.now();
    return {
      tasks: file.tasks.map((task) => ({ ...task, nextRunAt: task.enabled ? nextRunAt(task, now) : null })),
      history: [...file.history].reverse(),
      runningTaskId: this.currentId,
    };
  }

  save(input: unknown): TaskDefinition {
    const file = this.deps.store.read();
    const id = input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id : undefined;
    const existing = id ? file.tasks.find((task) => task.id === id) : undefined;
    if (id && !existing) throw new TaskError("This task no longer exists", 404);
    const task = normalizeTask(input, existing, this.now());
    file.tasks = existing ? file.tasks.map((item) => item.id === task.id ? task : item) : [...file.tasks, task];
    this.deps.store.write(file);
    return task;
  }

  delete(id: string): void {
    const file = this.deps.store.read();
    if (!file.tasks.some((task) => task.id === id)) throw new TaskError("This task no longer exists", 404);
    if (this.currentId === id) throw new TaskError("This task is running; stop its script run first", 409);
    file.tasks = file.tasks.filter((task) => task.id !== id);
    this.deps.store.write(file);
  }

  /** Starts a task now. Resolves with its record once it finished. */
  run(id: string, trigger: TaskRunRecord["trigger"] = "manual"): Promise<TaskRunRecord> {
    const task = this.deps.store.read().tasks.find((item) => item.id === id);
    if (!task) throw new TaskError("This task no longer exists", 404);
    if (this.running) throw new TaskError("Another task is running", 409);
    const run = this.execute(task, trigger).finally(() => { this.running = null; this.currentId = null; });
    this.running = run;
    this.currentId = id;
    return run;
  }

  /** Checks every 30 seconds for tasks that are due. */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(): Promise<void> {
    if (this.running) return;
    const now = this.now();
    for (const task of this.deps.store.read().tasks) {
      if (!task.enabled || task.schedule.kind === "manual") continue;
      // Due when its next time after the last run (or after it was saved) has come.
      const due = nextRunAt(task, task.lastRunAt ?? task.updatedAt);
      if (due === null || due > now) continue;
      try { await this.run(task.id, "schedule"); } catch (error) { this.deps.log?.(`task ${task.name} could not start: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
  }

  private record(record: TaskRunRecord, lastRunAt?: number): void {
    const file = this.deps.store.read();
    const index = file.history.findIndex((item) => item.id === record.id);
    if (index >= 0) file.history[index] = record; else file.history.push(record);
    if (lastRunAt) file.tasks = file.tasks.map((task) => task.id === record.taskId ? { ...task, lastRunAt } : task);
    this.deps.store.write(file);
  }

  private async execute(task: TaskDefinition, trigger: TaskRunRecord["trigger"]): Promise<TaskRunRecord> {
    const startedAt = this.now();
    const record: TaskRunRecord = { id: randomUUID(), taskId: task.id, taskName: task.name, trigger, startedAt, outcome: "running", profiles: 0, steps: [] };
    const busy = this.deps.runner.status();
    if (busy && busy.status !== "finished") {
      const skipped = { ...record, finishedAt: startedAt, outcome: "skipped" as const, note: "Another script was running" };
      this.record(skipped, startedAt);
      return skipped;
    }
    let profiles = this.deps.resolveProfiles(task.target);
    record.profiles = profiles.length;
    if (!profiles.length) {
      const empty = { ...record, finishedAt: startedAt, outcome: "failed" as const, note: "No profiles match the task's target" };
      this.record(empty, startedAt);
      return empty;
    }
    this.record(record, startedAt);
    this.deps.log?.(`task ${task.name}: started (${trigger}, ${profiles.length} profiles)`);
    for (const step of task.steps) {
      const report: TaskStepReport = { scriptId: step.scriptId, scriptName: await this.deps.scriptName(step.scriptId).catch(() => step.scriptId), attempts: 0, succeeded: 0, failed: 0, cancelled: 0, failures: [] };
      record.steps.push(report);
      let pending = profiles;
      const succeeded: string[] = [];
      let last: ScriptRun | null = null;
      while (pending.length && report.attempts <= task.retries) {
        report.attempts++;
        try {
          this.deps.runner.start({ scriptId: step.scriptId, profileIds: pending, inputs: step.inputs, useCredentials: task.useCredentials, concurrency: task.concurrency, startedBy: { kind: "task", name: task.name } });
        } catch (error) {
          report.failed = pending.length;
          report.failures = pending.map((profileId) => ({ profileId, name: profileId, error: error instanceof Error ? error.message : String(error) }));
          pending = [];
          break;
        }
        await this.deps.runner.settled();
        last = this.deps.runner.status();
        const results = last?.profiles ?? [];
        succeeded.push(...results.filter((item) => item.status === "succeeded").map((item) => item.id));
        if (results.some((item) => item.status === "cancelled")) {
          report.cancelled = results.filter((item) => item.status === "cancelled").length;
          pending = results.filter((item) => item.status === "failed").map((item) => item.id);
          break;
        }
        pending = results.filter((item) => item.status === "failed").map((item) => item.id);
      }
      report.succeeded = succeeded.length;
      if (pending.length && last) {
        report.failed = pending.length;
        report.failures = last.profiles.filter((item) => pending.includes(item.id)).map((item) => ({ profileId: item.id, name: item.name, ...(item.error ? { error: item.error.slice(0, 300) } : {}) }));
      }
      this.record(record);
      profiles = succeeded;
      if (!profiles.length || report.cancelled) break;
    }
    const steps = record.steps;
    const allDone = steps.length === task.steps.length && steps.every((step) => step.failed === 0 && step.cancelled === 0);
    const anyDone = steps.some((step) => step.succeeded > 0);
    const finished = { ...record, finishedAt: this.now(), outcome: allDone ? "succeeded" as const : anyDone ? "partial" as const : "failed" as const };
    this.record(finished);
    this.deps.log?.(`task ${task.name}: ${finished.outcome}`);
    return finished;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

type StepState = "pending" | "uncertain" | "completed";
type RunState = "running" | "paused" | "interrupted" | "needs_verification" | "completed" | "cancelled";
type Phase = "run" | "verify";
type Step = { id: string; run: string; verify?: string; timeoutMs?: number };
type Definition = { profileId: string; name: string; argument?: unknown; screenshots: boolean; steps: Step[] };
type Checkpoint = { id: string; state: StepState; attempts: number; evidence?: number; error?: string };
type BrowserTask = {
  version: 1; runId: string; client: string; definition: Definition; state: RunState;
  createdAt: string; updatedAt: string; steps: Checkpoint[]; evidenceCount: number; error?: string;
};
type BrowserProgram = {
  code: string; argument: unknown; screenshots: boolean; timeoutMs: number;
};
type ProgramReceipt = { completed: boolean; value?: unknown; error?: string; [key: string]: unknown };
export interface BrowserTaskConnection {
  program(input: BrowserProgram): Promise<ProgramReceipt>;
  close(): Promise<void>;
}

export class BrowserTaskError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function badRequest(message: string): never { throw new BrowserTaskError("invalid_request", message); }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }

function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function taskDefinition(profileId: string, params: Record<string, unknown>): Definition {
  if (!Array.isArray(params.steps) || !params.steps.length) badRequest("Provide an ordered array of steps");
  const seen = new Set<string>();
  const steps = params.steps.map((step: Step) => {
    if (!step || typeof step.id !== "string" || !step.id.trim() || seen.has(step.id)
      || typeof step.run !== "string" || !step.run.trim() || (step.verify !== undefined && (typeof step.verify !== "string" || !step.verify.trim()))
      || (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 2 ** 31 - 1))) {
      badRequest("Each step needs a unique id, a JavaScript function in run, and an optional verifier and positive timeoutMs");
    }
    seen.add(step.id);
    return { id: step.id, run: step.run, ...(step.verify ? { verify: step.verify } : {}), ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}) };
  });
  return { profileId, name: typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 120) : profileId,
    ...(params.argument === undefined ? {} : { argument: params.argument }), screenshots: params.screenshots === true, steps };
}

function view(task: BrowserTask) {
  return {
    runId: task.runId, client: task.client, profileId: task.definition.profileId, name: task.definition.name, state: task.state,
    createdAt: task.createdAt, updatedAt: task.updatedAt, steps: structuredClone(task.steps),
    evidenceCount: task.evidenceCount, ...(task.error ? { error: task.error } : {}),
  };
}
export type BrowserTaskView = ReturnType<typeof view>;

interface ActiveTask {
  task: BrowserTask;
  stop?: "paused" | "cancelled" | "interrupted";
  done: Promise<void>;
}

export class BrowserTaskSupervisor {
  private readonly running = new Map<string, ActiveTask>();
  private readonly history = new Map<string, BrowserTask>();
  private closing = false;

  constructor(private readonly options: {
    root: string;
    open(profileId: string, client: string): Promise<BrowserTaskConnection>;
    authorize(profileId: string, client: string): void;
    hold?(profileId: string): () => void;
    log?(text: string): void;
  }) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(options.root)) {
      if (!/^[0-9a-f]{32}$/.test(id)) continue;
      try {
        const task: BrowserTask = JSON.parse(readFileSync(this.path(id, "state.json"), "utf8"));
        if (task.version !== 1 || task.runId !== id) continue;
        if (task.state === "running") {
          task.state = "interrupted";
          this.save(task);
        }
        this.history.set(id, task);
      } catch (error) { options.log?.(`Could not read browser task ${id}: ${message(error)}`); }
    }
  }

  private path(id: string, filename = ""): string { return join(this.options.root, id, filename); }

  private save(task: BrowserTask) {
    task.updatedAt = new Date().toISOString();
    atomicJson(this.path(task.runId, "state.json"), task);
  }

  private get(runId: string): BrowserTask {
    const task = this.history.get(runId);
    if (!task) throw new BrowserTaskError("task_not_found", "Browser task was not found", 404);
    return task;
  }

  status(runId: string): BrowserTaskView { return view(this.get(runId)); }

  list(allowed: (profileId: string) => boolean, offset = 0, limit = 50) {
    const matches = [...this.history.values()].filter(task => allowed(task.definition.profileId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
    const tasks = matches.slice(offset, offset + limit).map(view);
    return { tasks, nextOffset: offset + tasks.length, hasMore: offset + tasks.length < matches.length };
  }

  keeps(profileId: string): boolean {
    return [...this.history.values()].some(task => task.definition.profileId === profileId && !["completed", "cancelled"].includes(task.state));
  }

  start(profileId: string, client: string, params: Record<string, unknown>): BrowserTaskView {
    this.options.authorize(profileId, client);
    const definition = taskDefinition(profileId, params);
    const key = params.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 256)) badRequest("idempotencyKey must be 1 to 256 characters");
    const runId = key ? createHash("sha256").update(JSON.stringify([profileId, key])).digest("hex").slice(0, 32) : randomUUID().replaceAll("-", "");
    const previous = this.history.get(runId);
    if (previous) {
      if (!isDeepStrictEqual(previous.definition, definition)) throw new BrowserTaskError("key_conflict", "This idempotency key already identifies a different plan", 409);
      return view(previous);
    }
    this.assertAvailable(profileId);
    const now = new Date().toISOString();
    const task: BrowserTask = {
      version: 1, runId, client, definition, state: "running", createdAt: now, updatedAt: now,
      steps: definition.steps.map(step => ({ id: step.id, state: "pending", attempts: 0 })), evidenceCount: 0,
    };
    mkdirSync(this.path(runId), { mode: 0o700 });
    try { this.save(task); } catch (error) { rmSync(this.path(runId), { recursive: true, force: true }); throw error; }
    this.history.set(runId, task);
    this.launch(task);
    return view(task);
  }

  resume(runId: string, client: string, verify?: unknown): BrowserTaskView {
    const task = this.get(runId);
    this.options.authorize(task.definition.profileId, client);
    if (this.running.has(runId) || task.state === "completed" || task.state === "cancelled") return view(task);
    this.assertAvailable(task.definition.profileId);
    const step = task.steps.find(item => item.state === "uncertain");
    if (verify !== undefined && (!step || typeof verify !== "string" || !verify.trim())) badRequest("Supply a verification function for the uncertain step");
    task.client = client;
    // A replacement verifier belongs to the next execution only. The original plan is immutable
    // so a lost start reply can still be recovered with the original idempotency key.
    task.state = "running"; delete task.error;
    this.save(task);
    this.launch(task, typeof verify === "string" ? verify : undefined);
    return view(task);
  }

  stop(runId: string, state: "paused" | "cancelled") {
    const task = this.get(runId);
    const active = this.running.get(runId);
    if (active) {
      active.stop = active.stop === "cancelled" ? active.stop : state;
      return { task: view(task), stopping: true };
    }
    if (task.state !== "completed" && task.state !== "cancelled" && state === "cancelled") {
      task.state = state; this.save(task);
    }
    return { task: view(task), stopping: false };
  }

  evidence(runId: string, sequence: number, part: string, offset: number, bytes: number) {
    const task = this.get(runId);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > task.evidenceCount) throw new BrowserTaskError("evidence_not_found", "Evidence was not found", 404);
    const data = this.readEvidence(runId, sequence);
    if (part === "summary") {
      const { sequence, stepId, attempt, phase, startedAt, endedAt, completed, error, screenshot, network, events, logs, value } = data;
      return { sequence, stepId, attempt, phase, startedAt, endedAt, completed, error,
        available: { screenshot: !!screenshot, network: !!network, events: !!events, logs: !!logs, value: value !== undefined } };
    }
    if (!["value", "network", "events", "logs", "screenshot"].includes(part)) badRequest("Unknown evidence part");
    const buffer = Buffer.from(JSON.stringify(data[part] ?? null));
    const page = buffer.subarray(offset, offset + bytes);
    return { part, offset, returnedBytes: page.length, totalBytes: buffer.length, nextOffset: offset + page.length,
      hasMore: offset + page.length < buffer.length, base64: page.toString("base64") };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const active of this.running.values()) active.stop ??= "interrupted";
    await Promise.allSettled([...this.running.values()].map(active => active.done));
  }

  private assertAvailable(profileId: string) {
    if (this.closing) throw new BrowserTaskError("shutting_down", "The browser task service is shutting down", 409);
    if ([...this.running.values()].some(run => run.task.definition.profileId === profileId)) {
      throw new BrowserTaskError("profile_task_running", "A browser task is running in this profile", 409);
    }
  }

  private launch(task: BrowserTask, verify?: string) {
    const active: ActiveTask = { task, done: Promise.resolve() };
    this.running.set(task.runId, active);
    active.done = Promise.resolve().then(() => this.execute(active, verify)).catch(error => {
      this.options.log?.(`Could not persist browser task ${task.runId}: ${message(error)}`);
    }).finally(() => { if (this.running.get(task.runId) === active) this.running.delete(task.runId); });
  }

  private readEvidence(runId: string, sequence: number) {
    return JSON.parse(readFileSync(this.path(runId, `evidence-${sequence}.json`), "utf8")) as ProgramReceipt;
  }

  private async execute(active: ActiveTask, replacementVerifier?: string) {
    const { task } = active, { profileId, screenshots, argument, steps } = task.definition;
    const release = this.options.hold?.(profileId);
    let connection: BrowserTaskConnection | undefined;
    let state: RunState = "interrupted";
    const values: Record<string, unknown> = Object.create(null);
    try {
      if (!active.stop) connection = await this.options.open(profileId, task.client);
      for (const [index, checkpoint] of task.steps.entries()) {
        if (active.stop) break;
        const step = steps[index]!;
        if (checkpoint.state === "completed") {
          if (checkpoint.evidence) {
            const recorded = this.readEvidence(task.runId, checkpoint.evidence);
            values[step.id] = recorded.phase === "verify" ? (recorded.value as { value?: unknown })?.value : recorded.value;
          }
          continue;
        }
        const verifier = checkpoint.state === "uncertain" ? replacementVerifier ?? step.verify : step.verify;
        replacementVerifier = undefined;
        const act = async (phase: Phase, code: string) => {
          this.options.authorize(profileId, task.client);
          const startedAt = new Date().toISOString();
          const receipt: ProgramReceipt = await connection!.program({ code, screenshots, timeoutMs: step.timeoutMs ?? 120_000, argument: {
            input: argument, runId: task.runId, stepId: step.id, actionKey: `${task.runId}:${step.id}`, attempt: checkpoint.attempts, previous: values,
          } }).catch(error => ({ completed: false, error: message(error) } satisfies ProgramReceipt));
          const sequence = task.evidenceCount + 1;
          atomicJson(this.path(task.runId, `evidence-${sequence}.json`), {
            ...receipt, sequence, stepId: step.id, attempt: checkpoint.attempts, phase, startedAt, endedAt: new Date().toISOString(),
          });
          task.evidenceCount = sequence; checkpoint.evidence = sequence;
          return receipt;
        };
        const reconcile = async (): Promise<"applied" | "absent" | "unknown"> => {
          if (!verifier) { checkpoint.error = "Provide a verifier to resolve the last attempt"; return "unknown"; }
          const receipt = await act("verify", verifier);
          const verified = receipt.value as { state?: unknown; value?: unknown } | undefined;
          if (receipt.completed && verified?.state === "applied") {
            // Store the verifier's value as the canonical receipt while keeping the full verifier evidence.
            values[step.id] = verified.value;
            checkpoint.state = "completed"; delete checkpoint.error;
            this.save(task);
            return "applied";
          }
          if (receipt.completed && verified?.state === "absent") return "absent";
          checkpoint.error = receipt.error ?? "The verifier could not confirm the effect of the action";
          return "unknown";
        };
        if (checkpoint.state === "uncertain") {
          const state = await reconcile();
          if (state === "applied") continue;
          if (state === "unknown") break;
          if (active.stop) break;
        }
        checkpoint.state = "uncertain"; checkpoint.attempts++; delete checkpoint.error;
        this.save(task);
        const receipt = await act("run", step.run);
        if (!receipt.completed) {
          checkpoint.error = receipt.error ?? "The action did not acknowledge completion";
          state = "needs_verification"; break;
        }
        if (verifier) {
          const verified = await reconcile();
          if (verified === "applied") continue;
          if (verified === "absent") checkpoint.error = "The verifier reported that the effect is absent";
          state = "needs_verification"; break;
        }
        checkpoint.state = "completed"; values[step.id] = receipt.value;
        this.save(task);
      }
      if (task.steps.every(step => step.state === "completed")) state = "completed";
      else if (active.stop) state = active.stop;
      else if (task.steps.some(step => step.state === "uncertain")) state = "needs_verification";
    } catch (error) {
      state = active.stop ?? "interrupted";
      task.error = message(error);
    } finally {
      release?.();
      await connection?.close().catch(error => this.options.log?.(`Browser task detach: ${message(error)}`));
      task.state = state;
      this.save(task);
    }
  }
}

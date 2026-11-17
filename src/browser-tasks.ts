import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProfileWriteLease, ProfileWrites } from "./profile-writes.ts";

type StepState = "pending" | "uncertain" | "completed";
type RunState = "queued" | "running" | "recovering" | "blocked" | "paused" | "interrupted" | "needs_verification" | "completed" | "cancelled";
type Phase = "run" | "verify";
type Step = { id: string; run: string; verify?: string; readOnly?: true; timeoutMs?: number; pageUrl?: string; frameUrl?: string; recoveryUrl?: string };
type TaskTarget = { startUrl: string; tabId?: string };
type TaskTab = { id: string; generation: string; lost?: true };
type Definition = { profileId: string; name: string; argument?: unknown; screenshots: boolean; steps: Step[]; target?: TaskTarget };
type Checkpoint = { id: string; state: StepState; attempts: number; evidence?: number; error?: string };
type TaskBlock = { code: string; message?: string };
type SiteSkill = { id: string; sourceRunId: string; name: string; origin: string; path: string; createdAt: string; sourceGroup?: string };
type QueueState = { order: number; recoveries: number; consecutiveRecoveries: number; retryAt?: number; verifier?: { stepId: string; code: string } };
type BrowserTask = {
  version: 1; runId: string; client: string; definition: Definition; state: RunState;
  createdAt: string; updatedAt: string; steps: Checkpoint[]; evidenceCount: number; error?: string;
  stopRequested?: "paused" | "cancelled";
  queue?: QueueState; tab?: TaskTab; blocked?: TaskBlock;
};
type BrowserProgram = {
  code: string; argument: unknown; screenshots: boolean; timeoutMs: number; pageUrl?: string; frameUrl?: string;
  tabId?: string;
};
type ProgramReceipt = { completed: boolean; value?: unknown; error?: string; fault?: string; [key: string]: unknown };
export interface BrowserTaskConnection {
  program(input: BrowserProgram): Promise<ProgramReceipt>;
  bindTab?(target: TaskTarget, previous?: TaskTab): Promise<TaskTab>;
  close(): Promise<void>;
}

export class BrowserTaskError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

function badRequest(message: string): never { throw new BrowserTaskError("invalid_request", message); }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }

const recoveryDelays = [500, 1500, 4500];
const recoverableFaults = new Set(["browser_changed", "browser_not_running", "browser_disconnected", "task_tab_lost"]);
function faultOf(error: unknown): string | undefined { return error instanceof BrowserTaskError ? error.code : undefined; }
function isFinished(state: RunState) { return state === "completed" || state === "cancelled"; }

function webUrl(value: unknown, field: string): URL {
  if (typeof value !== "string" || value.length > 8192) badRequest(`Provide an HTTP(S) URL in ${field}`);
  let url: URL;
  try { url = new URL(value); } catch { badRequest(`Provide an HTTP(S) URL in ${field}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) badRequest(`Provide an HTTP(S) URL without credentials in ${field}`);
  return url;
}

function taskBlock(value: unknown): TaskBlock | undefined {
  const blocked = (value as { blocked?: Partial<TaskBlock> } | undefined)?.blocked;
  if (!blocked || typeof blocked.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(blocked.code)) return;
  return { code: blocked.code, ...(typeof blocked.message === "string" ? { message: blocked.message.slice(0, 1000) } : {}) };
}

function matchesSite(skill: SiteSkill, url: URL) {
  return url.origin === skill.origin && (skill.path === "/" || url.pathname === skill.path || url.pathname.startsWith(skill.path + "/"));
}

function skillView({ sourceGroup: _sourceGroup, ...skill }: SiteSkill) { return skill; }

function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally { closeSync(fd); }
}

function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
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
    for (const url of [step.pageUrl, step.frameUrl]) {
      if (url !== undefined && (typeof url !== "string" || !url.trim())) badRequest("Task pageUrl and frameUrl must be non-empty URL strings");
    }
    if (step.readOnly !== undefined && typeof step.readOnly !== "boolean") badRequest("Step readOnly must be a boolean");
    if (step.readOnly && step.verify) badRequest("Provide a read-only step or a write verifier");
    seen.add(step.id);
    return { id: step.id, run: step.run, ...(step.verify ? { verify: step.verify } : {}), ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.pageUrl ? { pageUrl: step.pageUrl } : {}), ...(step.frameUrl ? { frameUrl: step.frameUrl } : {}),
      ...(step.recoveryUrl !== undefined ? { recoveryUrl: webUrl(step.recoveryUrl, "recoveryUrl").href } : {}),
      ...(step.readOnly ? { readOnly: true as const } : {}) };
  });
  if (params.unattended !== undefined && typeof params.unattended !== "boolean") badRequest("unattended must be a boolean");
  if (params.unattended === false && (params.startUrl !== undefined || params.tabId !== undefined)) {
    badRequest("startUrl and tabId require unattended execution");
  }
  const unattended = params.unattended === true || params.startUrl !== undefined || params.tabId !== undefined;
  if (params.tabId !== undefined && (typeof params.tabId !== "string" || !params.tabId.trim() || params.tabId.length > 256)) badRequest("Invalid tabId");
  const target: TaskTarget | undefined = unattended ? {
    startUrl: webUrl(params.startUrl, "startUrl").href,
    ...(typeof params.tabId === "string" ? { tabId: params.tabId } : {}),
  } : undefined;
  return { profileId, name: typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 120) : profileId,
    ...(params.argument === undefined ? {} : { argument: params.argument }), screenshots: params.screenshots === true, steps,
    ...(target ? { target } : {}) };
}

function view(task: BrowserTask) {
  return {
    runId: task.runId, client: task.client, profileId: task.definition.profileId, name: task.definition.name, state: task.state,
    createdAt: task.createdAt, updatedAt: task.updatedAt, steps: structuredClone(task.steps),
    evidenceCount: task.evidenceCount, ...(task.error ? { error: task.error } : {}),
    ...(task.stopRequested ? { stopRequested: task.stopRequested } : {}),
    ...(task.queue ? { recoveries: task.queue.recoveries } : {}),
    ...(task.queue?.retryAt ? { retryAt: new Date(task.queue.retryAt).toISOString() } : {}),
    ...(task.tab && !task.tab.lost ? { tabId: task.tab.id } : {}),
    ...(task.blocked ? { blocked: { ...task.blocked } } : {}),
  };
}
export type BrowserTaskView = ReturnType<typeof view>;

interface ActiveTask {
  task: BrowserTask;
  waiting: AbortController;
  stop?: "paused" | "cancelled" | "interrupted";
  done: Promise<void>;
}

export class BrowserTaskSupervisor {
  private readonly running = new Map<string, ActiveTask>();
  private readonly history = new Map<string, BrowserTask>();
  private readonly skills = new Map<string, SiteSkill>();
  private closing = false;
  private order = 0;
  private queueTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    root: string;
    open(profileId: string, client: string): Promise<BrowserTaskConnection>;
    authorize(profileId: string, client: string, savedGroup?: string): string | void;
    capacity?(): number;
    writes?: ProfileWrites;
    hold?(profileId: string): () => void;
    log?(text: string): void;
  }) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(options.root)) {
      if (!/^[0-9a-f]{32}$/.test(id)) continue;
      try {
        const manifest = this.path(id, "state.json");
        if (!existsSync(manifest)) continue;
        const task: BrowserTask = JSON.parse(readFileSync(manifest, "utf8"));
        if (task.version !== 1 || task.runId !== id) continue;
        if (task.queue) this.order = Math.max(this.order, task.queue.order);
        if (task.state === "running") {
          task.state = task.steps.every(step => step.state === "completed") ? "completed"
            : task.stopRequested ?? (task.queue ? "queued" : "interrupted");
          delete task.stopRequested;
          this.save(task);
        }
        this.history.set(id, task);
      } catch (error) { options.log?.(`Could not read browser task ${id}: ${message(error)}`); }
    }
    const skills = join(options.root, "skills");
    if (existsSync(skills)) for (const file of readdirSync(skills)) {
      if (!/^[0-9a-f]{32}\.json$/.test(file)) continue;
      try {
        const skill: SiteSkill = JSON.parse(readFileSync(join(skills, file), "utf8"));
        if (file === `${skill.id}.json` && this.history.get(skill.sourceRunId)?.state === "completed") this.skills.set(skill.id, skill);
      } catch (error) { options.log?.(`Could not read site skill ${file}: ${message(error)}`); }
    }
  }

  startRecovery() { this.wakeQueue(); }

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
    return [...this.history.values()].some(task => task.definition.profileId === profileId && !isFinished(task.state));
  }

  replayTarget(runId: string, generation: (profileId: string) => string | undefined) {
    const task = this.get(runId);
    const profileId = task.definition.profileId;
    if (!task.tab || task.tab.lost || task.tab.generation !== generation(profileId)) {
      throw new BrowserTaskError("task_tab_unavailable", "The task has no live bound tab in the current browser", 409);
    }
    return { profileId, tabId: task.tab.id };
  }

  saveSkill(runId: string, client: string, params: Record<string, unknown>) {
    const task = this.get(runId);
    const sourceGroup = this.options.authorize(task.definition.profileId, client);
    if (task.state !== "completed") throw new BrowserTaskError("task_incomplete", "Complete the browser task before saving it as a site skill", 409);
    const source = task.definition.target?.startUrl;
    const site = webUrl(params.url ?? source, "url");
    if (source && site.origin !== new URL(source).origin) badRequest("Use a site URL on the completed task's origin");
    const path = site.pathname.replace(/\/+$/, "") || "/";
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim().slice(0, 120) : task.definition.name;
    const id = createHash("sha256").update(JSON.stringify([runId, site.origin, path, name])).digest("hex").slice(0, 32);
    const existing = this.skills.get(id);
    if (existing) return skillView(existing);
    const skill: SiteSkill = { id, sourceRunId: runId, name, origin: site.origin, path, createdAt: new Date().toISOString(),
      ...(typeof sourceGroup === "string" ? { sourceGroup } : {}) };
    const directory = join(this.options.root, "skills");
    mkdirSync(directory, { mode: 0o700, recursive: true });
    syncDirectory(this.options.root);
    atomicJson(join(directory, `${id}.json`), skill);
    this.skills.set(id, skill);
    return skillView(skill);
  }

  findSkills(client: string, url: unknown, offset: number, limit: number) {
    const site = webUrl(url, "url");
    const matches = [...this.skills.values()].filter(skill => {
      const source = this.history.get(skill.sourceRunId);
      if (!source || !matchesSite(skill, site)) return false;
      try { this.options.authorize(source.definition.profileId, client, skill.sourceGroup); return true; } catch { return false; }
    }).sort((a, b) => b.path.length - a.path.length || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const skills = matches.slice(offset, offset + limit).map(skillView);
    return { skills, nextOffset: offset + skills.length, hasMore: offset + skills.length < matches.length };
  }

  canUseProfile(profileId: string, client: string): boolean {
    try { this.options.authorize(profileId, client); return true; } catch { return false; }
  }

  checkSkill(skillId: unknown, client: string, startUrl?: unknown) {
    const skill = typeof skillId === "string" ? this.skills.get(skillId) : undefined;
    if (!skill) throw new BrowserTaskError("skill_not_found", "Site skill was not found", 404);
    const source = this.get(skill.sourceRunId);
    this.options.authorize(source.definition.profileId, client, skill.sourceGroup);
    const site = webUrl(startUrl ?? skill.origin + skill.path, "startUrl");
    if (!matchesSite(skill, site)) badRequest("The task's startUrl must match the site skill");
    return { startUrl: site.href, steps: source.definition.steps, name: skill.name };
  }

  start(profileId: string, client: string, params: Record<string, unknown>): BrowserTaskView {
    this.options.authorize(profileId, client);
    if (params.skillId !== undefined) {
      const plan = this.checkSkill(params.skillId, client, params.startUrl);
      params = { ...params, ...plan, name: params.name ?? plan.name };
    }
    const definition = taskDefinition(profileId, params);
    const key = params.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 256)) badRequest("idempotencyKey must be 1 to 256 characters");
    const runId = key ? createHash("sha256").update(JSON.stringify([profileId, key])).digest("hex").slice(0, 32) : randomUUID().replaceAll("-", "");
    const previous = this.history.get(runId);
    if (previous) {
      if (!isDeepStrictEqual(previous.definition, definition)) throw new BrowserTaskError("key_conflict", "This idempotency key already identifies a different plan", 409);
      return view(previous);
    }
    this.assertOpen();
    if (!definition.target) this.assertAvailable(profileId);
    const now = new Date().toISOString();
    const task: BrowserTask = {
      version: 1, runId, client, definition, state: definition.target ? "queued" : "running", createdAt: now, updatedAt: now,
      steps: definition.steps.map(step => ({ id: step.id, state: "pending", attempts: 0 })), evidenceCount: 0,
      ...(definition.target ? { queue: { order: ++this.order, recoveries: 0, consecutiveRecoveries: 0 } } : {}),
    };
    const directory = this.path(runId);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    if (readdirSync(directory).some(name => !name.endsWith(".tmp"))) {
      throw new BrowserTaskError("task_storage_unreadable", "This key has task data that could not be loaded", 409);
    }
    syncDirectory(this.options.root);
    try { this.save(task); } catch (error) { rmSync(this.path(runId), { recursive: true, force: true }); throw error; }
    this.history.set(runId, task);
    if (task.queue) this.wakeQueue();
    else this.launch(task);
    return view(task);
  }

  resume(runId: string, client: string, verify?: unknown): BrowserTaskView {
    const task = this.get(runId);
    this.options.authorize(task.definition.profileId, client);
    if (this.running.has(runId) || isFinished(task.state) || task.state === "queued" || task.state === "recovering") return view(task);
    this.assertOpen();
    if (!task.queue) this.assertAvailable(task.definition.profileId);
    const step = task.steps.find(item => item.state === "uncertain");
    if (verify !== undefined && (!step || typeof verify !== "string" || !verify.trim())) badRequest("Supply a verification function for the uncertain step");
    task.client = client;
    task.state = task.queue ? "queued" : "running";
    delete task.error;
    delete task.blocked;
    if (task.queue) {
      task.queue.consecutiveRecoveries = 0;
      delete task.queue.retryAt;
      if (typeof verify === "string" && step) task.queue.verifier = { stepId: step.id, code: verify };
    }
    this.save(task);
    if (task.queue) this.wakeQueue();
    else this.launch(task, typeof verify === "string" ? verify : undefined);
    return view(task);
  }

  stop(runId: string, state: "paused" | "cancelled") {
    const task = this.get(runId);
    const active = this.running.get(runId);
    if (active) {
      const requested = active.stop === "cancelled" ? active.stop : state;
      task.stopRequested = requested;
      this.save(task);
      active.stop = requested;
      active.waiting.abort();
      return { task: view(task), stopping: true };
    }
    if (!isFinished(task.state) && (state === "cancelled" || task.state === "queued" || task.state === "recovering")) {
      task.state = state;
      if (task.queue) delete task.queue.retryAt;
      this.save(task);
      this.wakeQueue();
    }
    return { task: view(task), stopping: false };
  }

  evidence(runId: string, sequence: number, part: string, offset: number, bytes: number) {
    const task = this.get(runId);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > task.evidenceCount) throw new BrowserTaskError("evidence_not_found", "Evidence was not found", 404);
    const data = this.readEvidence(runId, sequence);
    if (part === "summary") {
      const { sequence, stepId, attempt, phase, startedAt, endedAt, completed, error, screenshot, screenshotError, network, events, logs, value } = data;
      return { sequence, stepId, attempt, phase, startedAt, endedAt, completed, error, screenshotError,
        available: { screenshot: !!screenshot, network: !!network, events: !!events, logs: !!logs, value: value !== undefined } };
    }
    if (!["value", "network", "events", "logs", "screenshot"].includes(part)) badRequest("Unknown evidence part");
    const browserEvents = (data.events as { records?: Array<{ kind: string }> } | undefined)?.records;
    const value = part === "logs" ? { program: data.logs ?? [], browser: browserEvents?.filter(event => ["console", "exception", "crash"].includes(event.kind)) ?? [] } : data[part];
    const buffer = Buffer.from(JSON.stringify(value ?? null));
    const page = buffer.subarray(offset, offset + bytes);
    return { part, offset, returnedBytes: page.length, totalBytes: buffer.length, nextOffset: offset + page.length,
      hasMore: offset + page.length < buffer.length, base64: page.toString("base64") };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    clearTimeout(this.queueTimer);
    for (const active of this.running.values()) {
      active.stop ??= "interrupted";
      active.waiting.abort();
    }
    await Promise.allSettled([...this.running.values()].map(active => active.done));
  }

  private assertOpen() {
    if (this.closing) throw new BrowserTaskError("shutting_down", "The browser task service is shutting down", 409);
  }

  private assertAvailable(profileId: string) {
    if ([...this.running.values()].some(run => run.task.definition.profileId === profileId)
      || [...this.history.values()].some(task => task.definition.profileId === profileId && task.queue && !isFinished(task.state))) {
      throw new BrowserTaskError("profile_task_running", "A browser task is running or waiting in this profile", 409);
    }
  }

  private wakeQueue(delay = 0) {
    if (this.closing) return;
    clearTimeout(this.queueTimer);
    this.queueTimer = setTimeout(() => this.dispatch(), delay).unref();
  }

  private dispatch() {
    if (this.closing) return;
    const tasks = [...this.history.values()].filter(task => task.queue && !isFinished(task.state))
      .sort((a, b) => a.queue!.order - b.queue!.order);
    const lanes = new Set([...this.running.values()].map(active => active.task.definition.profileId));
    const now = Date.now();
    let capacity: number | undefined, next = Infinity;
    for (const task of tasks) {
      const profileId = task.definition.profileId;
      if (lanes.has(profileId)) continue;
      // An earlier unresolved task retains its place in this profile's queue.
      lanes.add(profileId);
      if (task.state !== "queued" && task.state !== "recovering") continue;
      const queue = task.queue!;
      if (queue.retryAt && queue.retryAt > now) {
        next = Math.min(next, queue.retryAt - now);
        continue;
      }
      capacity ??= this.options.capacity?.() ?? 1;
      if (this.running.size >= capacity) { next = Math.min(next, 1000); break; }
      task.state = "running";
      delete queue.retryAt;
      try { this.save(task); }
      catch (error) {
        task.state = "interrupted";
        task.error = message(error);
        this.options.log?.(`Could not queue browser task ${task.runId}: ${task.error}`);
        continue;
      }
      this.launch(task);
    }
    if (Number.isFinite(next)) this.wakeQueue(next);
  }

  private launch(task: BrowserTask, verify?: string) {
    const active: ActiveTask = { task, waiting: new AbortController(), done: Promise.resolve() };
    this.running.set(task.runId, active);
    active.done = Promise.resolve().then(() => this.execute(active, verify)).catch(error => {
      this.options.log?.(`Could not persist browser task ${task.runId}: ${message(error)}`);
    }).finally(() => {
      if (this.running.get(task.runId) === active) this.running.delete(task.runId);
      this.wakeQueue();
    });
  }

  private readEvidence(runId: string, sequence: number) {
    return JSON.parse(readFileSync(this.path(runId, `evidence-${sequence}.json`), "utf8")) as ProgramReceipt;
  }

  private recover(task: BrowserTask, fallback: RunState): RunState {
    const queue = task.queue;
    if (!queue || queue.consecutiveRecoveries >= recoveryDelays.length) return fallback;
    queue.retryAt = Date.now() + recoveryDelays[queue.consecutiveRecoveries++]!;
    queue.recoveries++;
    return "recovering";
  }

  private async execute(active: ActiveTask, replacementVerifier?: string) {
    const { task } = active, { profileId, screenshots, argument, steps, target } = task.definition;
    const release = this.options.hold?.(profileId);
    let connection: BrowserTaskConnection | undefined;
    let lease: ProfileWriteLease | undefined;
    let state: RunState = "interrupted";
    const values: Record<string, unknown> = Object.create(null);
    const uncertain = () => task.steps.find(checkpoint => checkpoint.state === "uncertain");
    const block = (blocked: TaskBlock) => { task.blocked = blocked; state = "blocked"; };
    try {
      if (!active.stop) lease = await this.options.writes?.acquire(profileId, active.waiting.signal);
      if (!active.stop) {
        this.options.authorize(profileId, task.client);
        connection = await this.options.open(profileId, task.client);
      }
      if (!active.stop && target) {
        if (!connection?.bindTab) throw new BrowserTaskError("unsupported", "This task runtime cannot bind a browser tab");
        const next = steps[task.steps.findIndex(checkpoint => checkpoint.state !== "completed")];
        const startUrl = task.tab && next?.recoveryUrl ? next.recoveryUrl : target.startUrl;
        task.tab = await connection.bindTab({ ...target, startUrl }, task.tab);
        delete task.error;
        this.save(task);
      }
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
        const queuedVerifier = task.queue?.verifier?.stepId === step.id ? task.queue.verifier.code : undefined;
        const verifier = checkpoint.state === "uncertain" ? queuedVerifier ?? replacementVerifier ?? step.verify : step.verify;
        replacementVerifier = undefined;
        const complete = (value: unknown) => {
          checkpoint.state = "completed";
          delete checkpoint.error;
          values[step.id] = value;
          if (task.queue) {
            task.queue.consecutiveRecoveries = 0;
            if (queuedVerifier) delete task.queue.verifier;
          }
          this.save(task);
        };
        const act = async (phase: Phase, code: string) => {
          this.options.authorize(profileId, task.client);
          const startedAt = new Date().toISOString();
          const receipt: ProgramReceipt = await connection!.program({
            code, screenshots, timeoutMs: step.timeoutMs ?? 120_000, pageUrl: step.pageUrl, frameUrl: step.frameUrl, tabId: task.tab?.id, argument: {
            input: argument, runId: task.runId, stepId: step.id, actionKey: `${task.runId}:${step.id}`, attempt: checkpoint.attempts, previous: values,
          } }).catch(error => ({ completed: false, error: message(error), fault: faultOf(error) } satisfies ProgramReceipt));
          if (task.tab && receipt.fault === "task_tab_lost") task.tab.lost = true;
          const sequence = task.evidenceCount + 1;
          atomicJson(this.path(task.runId, `evidence-${sequence}.json`), {
            ...receipt, sequence, stepId: step.id, attempt: checkpoint.attempts, phase, startedAt, endedAt: new Date().toISOString(),
          });
          task.evidenceCount = sequence; checkpoint.evidence = sequence;
          return receipt;
        };
        const reconcile = async (): Promise<"applied" | "absent" | "unknown"> => {
          state = "needs_verification";
          if (!verifier) { checkpoint.error = "Provide a verifier to resolve the last attempt"; return "unknown"; }
          const receipt = await act("verify", verifier);
          const verified = receipt.value as { state?: unknown; value?: unknown } | undefined;
          if (receipt.completed && verified?.state === "applied") {
            // Store the verifier's value as the canonical receipt while keeping the full verifier evidence.
            complete(verified.value);
            return "applied";
          }
          if (receipt.completed && verified?.state === "absent") return "absent";
          checkpoint.error = receipt.error ?? "The verifier could not confirm the effect of the action";
          const blocked = task.queue && receipt.completed ? taskBlock(receipt.value) : undefined;
          if (blocked) block(blocked);
          else if (recoverableFaults.has(receipt.fault ?? "")) state = this.recover(task, "needs_verification");
          return "unknown";
        };
        if (checkpoint.state === "uncertain") {
          if (task.queue && step.readOnly) checkpoint.state = "pending";
          else {
            const verified = await reconcile();
            if (verified === "applied") continue;
            if (verified === "unknown" || active.stop) break;
          }
        }
        this.options.authorize(profileId, task.client);
        checkpoint.state = "uncertain"; checkpoint.attempts++; delete checkpoint.error;
        this.save(task);
        const receipt = await act("run", step.run);
        if (!receipt.completed) {
          checkpoint.error = receipt.error ?? "The action did not acknowledge completion";
          if (receipt.invoked === false || (task.queue && step.readOnly)) checkpoint.state = "pending";
          state = checkpoint.state === "pending" ? "interrupted" : "needs_verification";
          if (task.queue && !active.stop && (checkpoint.state === "uncertain" ? verifier : recoverableFaults.has(receipt.fault ?? ""))) {
            state = this.recover(task, state);
          }
          break;
        }
        const blocked = task.queue ? taskBlock(receipt.value) : undefined;
        if (blocked) {
          // This result certifies the step stopped before issuing a write.
          checkpoint.state = "pending";
          block(blocked);
          break;
        }
        if (verifier) {
          const verified = await reconcile();
          if (verified === "applied") continue;
          if (verified === "absent") {
            checkpoint.error = "The verifier reported that the effect is absent";
            state = this.recover(task, "needs_verification");
          }
          break;
        }
        complete(receipt.value);
      }
    } catch (error) {
      const fault = faultOf(error);
      state = uncertain() ? "needs_verification" : "interrupted";
      if (!active.stop) task.error = message(error);
      if (task.queue && (fault === "not_permitted" || fault === "no_such_profile" || fault === "profile_handed_off")) {
        block({ code: fault, message: task.error });
      }
      else if (task.queue && !active.stop && (recoverableFaults.has(fault ?? "") || (fault === "browser_launch_failed" && task.tab))) {
        state = this.recover(task, state);
      }
    } finally {
      release?.();
      await connection?.close().catch(error => this.options.log?.(`Browser task detach: ${message(error)}`));
      lease?.release();
      if (task.steps.every(step => step.state === "completed")) state = "completed";
      else if (active.stop) state = active.stop === "interrupted" && task.queue ? "queued" : active.stop;
      task.state = state;
      if (task.queue && state !== "recovering") delete task.queue.retryAt;
      delete task.stopRequested;
      this.save(task);
    }
  }
}

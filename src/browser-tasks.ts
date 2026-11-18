import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProfileWriteLease, ProfileWrites } from "./profile-writes.ts";
import type { HostWorkBudget, HostWorkPermit } from "./cooling.ts";
import { agentKey } from "./ai-access.ts";

type StepState = "pending" | "uncertain" | "completed";
type RunState = "queued" | "running" | "recovering" | "blocked" | "paused" | "interrupted" | "needs_verification" | "completed" | "cancelled";
type Phase = "run" | "verify";
type Step = { id: string; run: string; verify?: string; readOnly?: true; timeoutMs?: number; pageUrl?: string; frameUrl?: string; recoveryUrl?: string };
type TaskTarget = { startUrl: string; tabId?: string };
type TaskTab = { id: string; generation: string; lost?: true };
type Definition = { profileId: string; name: string; argument?: unknown; screenshots: boolean; steps: Step[]; target?: TaskTarget };
type Checkpoint = { id: string; state: StepState; attempts: number; evidence?: number; error?: string;
  result?: { value?: unknown }; verification?: "applied" | "absent" | "unknown" };
type TaskBlock = { code: string; message?: string };
type SiteSkill = { id: string; sourceRunId: string; name: string; origin: string; path: string; createdAt: string; sourceGroup?: string };
type QueueState = { order: number; recoveries: number; consecutiveRecoveries: number; retryAt?: number;
  verifier?: { stepId: string; code: string; suppliedBy?: BrowserTaskActor } };
type BrowserTask = {
  version: 1; runId: string; client: string; definition: Definition; state: RunState;
  owner?: BrowserTaskActor; delegates?: string[]; firstEvidence?: number;
  waitReason?: "profile_write" | "memory" | "capacity";
  createdAt: string; updatedAt: string; steps: Checkpoint[]; evidenceCount: number; error?: string;
  stopRequested?: "paused" | "cancelled";
  queue?: QueueState; tab?: TaskTab; blocked?: TaskBlock;
};
export interface BrowserTaskActor { name: string; scope: string }
type TaskClient = string | BrowserTaskActor;
function taskActor(client: TaskClient): BrowserTaskActor {
  return typeof client === "string" ? { scope: "local", name: client } : client;
}
function ownerOf(task: BrowserTask): BrowserTaskActor {
  return task.owner ?? (task.client.startsWith("worker:")
    ? { scope: "worker-legacy:" + task.client.slice(7), name: task.client }
    : taskActor(task.client));
}
const actorKey = (actor: BrowserTaskActor) => JSON.stringify([actor.scope, agentKey(actor.name)]);
const EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_TASK_STEPS = 100;
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
  if (!Array.isArray(params.steps) || !params.steps.length || params.steps.length > MAX_TASK_STEPS) badRequest("Provide 1 to 100 ordered steps");
  const seen = new Set<string>();
  const steps = params.steps.map((step: Step) => {
    if (!step || typeof step.id !== "string" || !step.id.trim() || step.id.length > 120 || seen.has(step.id)
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
    createdAt: task.createdAt, updatedAt: task.updatedAt, steps: task.steps.map(({ result: _result, ...step }) => ({
      ...step, actionKey: `${task.runId}:${step.id}`,
      ...(step.state === "uncertain" ? { expectedAttempt: `${step.id}:${step.attempts}:${step.evidence ?? 0}` } : {}),
    })),
    evidenceCount: task.evidenceCount, firstEvidence: task.firstEvidence ?? 1,
    ...(task.delegates?.length ? { delegates: [...task.delegates] } : {}), ...(task.error ? { error: task.error } : {}),
    ...(task.stopRequested ? { stopRequested: task.stopRequested } : {}),
    ...(task.queue ? { recoveries: task.queue.recoveries } : {}),
    ...(task.waitReason ? { waitReason: task.waitReason } : {}),
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
  lease?: ProfileWriteLease;
  hostPermit?: HostWorkPermit;
}

export class BrowserTaskSupervisor {
  private readonly running = new Map<string, ActiveTask>();
  private readonly history = new Map<string, BrowserTask>();
  private readonly skills = new Map<string, SiteSkill>();
  private closing = false;
  private order = 0;
  private queueTimer?: ReturnType<typeof setTimeout>;
  private evidenceTimer?: ReturnType<typeof setInterval>;
  private readonly receipts: { runId: string; sequence: number; bytes: number; at: number }[] = [];
  private receiptBytes = 0;
  private nextEvidencePrune = 0;

  constructor(private readonly options: {
    root: string;
    open(profileId: string, client: string, signal?: AbortSignal, hostPermit?: HostWorkPermit, actor?: BrowserTaskActor): Promise<BrowserTaskConnection>;
    authorize(profileId: string, client: string, savedGroup?: string, actor?: BrowserTaskActor): string | void;
    capacity?(): number;
    hostWork?: HostWorkBudget;
    writes?: ProfileWrites;
    hold?(profileId: string): () => void;
    log?(text: string): void;
    record?(receipt: { runId: string; profileId: string; client: string; stepId: string; sequence: number; phase: Phase; ok: boolean }): void;
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
            : task.stopRequested ?? (task.definition.target ? "queued" : "interrupted");
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
    for (const task of this.history.values()) try {
      let first = task.evidenceCount + 1;
      for (const file of readdirSync(this.path(task.runId))) {
        const match = /^evidence-(\d+)\.json$/.exec(file);
        if (!match) continue;
        const sequence = Number(match[1]);
        if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
        const stat = statSync(this.path(task.runId, file), { throwIfNoEntry: false });
        if (!stat?.isFile()) continue;
        this.trackReceipt(task.runId, sequence, stat.size, stat.mtimeMs);
        first = Math.min(first, sequence);
        task.evidenceCount = Math.max(task.evidenceCount, sequence);
      }
      task.firstEvidence = first;
    } catch (error) { options.log?.(`Could not read receipts for ${task.runId}: ${message(error)}`); }
    this.pruneEvidence();
  }

  startRecovery() {
    this.evidenceTimer ??= setInterval(() => this.pruneEvidence(), 60_000).unref();
    this.wakeQueue();
  }

  private path(id: string, filename = ""): string { return join(this.options.root, id, filename); }

  private save(task: BrowserTask) {
    const updatedAt = new Date().toISOString();
    const steps = isFinished(task.state) ? task.steps.map(({ result: _result, ...step }) => step) : task.steps;
    atomicJson(this.path(task.runId, "state.json"), { ...task, updatedAt, steps });
    task.steps = steps;
    task.updatedAt = updatedAt;
  }

  private get(runId: string): BrowserTask {
    const task = this.history.get(runId);
    if (!task) throw new BrowserTaskError("task_not_found", "Browser task was not found", 404);
    return task;
  }

  private authorize(task: BrowserTask, client?: TaskClient, ownerOnly = false): void {
    if (client === undefined) return; // Desktop and scheduler callers already cross their own local boundary.
    const actor = taskActor(client), owner = ownerOf(task);
    const legacyName = owner.scope === "local" && actor.scope === "local-auth" && agentKey(owner.name) === agentKey(actor.name);
    if (actorKey(owner) !== actorKey(actor) && !legacyName &&
      (ownerOnly || owner.scope !== actor.scope || !task.delegates?.includes(agentKey(actor.name)))) {
      throw new BrowserTaskError("not_permitted", "This browser task belongs to a different Agent", 403);
    }
    this.options.authorize(task.definition.profileId, actor.name, undefined, actor);
  }

  queueStatus() {
    let waiting = 0;
    for (const task of this.history.values()) if (task.state === "queued" || task.state === "recovering") waiting++;
    return { running: this.running.size, waiting };
  }

  status(runId: string, client?: TaskClient): BrowserTaskView {
    const task = this.get(runId);
    this.authorize(task, client);
    return view(task);
  }

  list(allowed: (profileId: string) => boolean, offset = 0, limit = 50, client?: TaskClient) {
    const matches = [...this.history.values()].filter(task => {
      if (!allowed(task.definition.profileId)) return false;
      try { this.authorize(task, client); return true; } catch { return false; }
    })
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

  saveSkill(runId: string, client: TaskClient, params: Record<string, unknown>) {
    const task = this.get(runId);
    this.authorize(task, client);
    const actor = taskActor(client);
    const sourceGroup = this.options.authorize(task.definition.profileId, actor.name, undefined, actor);
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

  canUseProfile(profileId: string, client: TaskClient): boolean {
    const actor = taskActor(client);
    try { this.options.authorize(profileId, actor.name, undefined, actor); return true; } catch { return false; }
  }

  checkSkill(skillId: unknown, client: TaskClient, startUrl?: unknown) {
    const skill = typeof skillId === "string" ? this.skills.get(skillId) : undefined;
    if (!skill) throw new BrowserTaskError("skill_not_found", "Site skill was not found", 404);
    const source = this.get(skill.sourceRunId);
    const actor = taskActor(client);
    this.options.authorize(source.definition.profileId, actor.name, skill.sourceGroup, actor);
    const site = webUrl(startUrl ?? skill.origin + skill.path, "startUrl");
    if (!matchesSite(skill, site)) badRequest("The task's startUrl must match the site skill");
    return { startUrl: site.href, steps: source.definition.steps, name: skill.name };
  }

  start(profileId: string, client: TaskClient, params: Record<string, unknown>, previousKey?: string): BrowserTaskView {
    const owner = taskActor(client);
    this.options.authorize(profileId, owner.name, undefined, owner);
    if (params.skillId !== undefined) {
      const plan = this.checkSkill(params.skillId, client, params.startUrl);
      params = { ...params, ...plan, name: params.name ?? plan.name };
    }
    const definition = taskDefinition(profileId, params);
    const key = params.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 256)) badRequest("idempotencyKey must be 1 to 256 characters");
    const legacyId = key ? createHash("sha256").update(JSON.stringify([profileId, key])).digest("hex").slice(0, 32) : undefined;
    const runId = key && (owner.scope === "local" || owner.scope.startsWith("worker-legacy:")) ? legacyId!
      : key ? createHash("sha256").update(JSON.stringify([profileId, actorKey(owner), key])).digest("hex").slice(0, 32)
      : randomUUID().replaceAll("-", "");
    const legacy = legacyId && owner.scope === "local-auth" ? this.history.get(legacyId) : undefined;
    const previous = this.history.get(runId) ?? (legacy && agentKey(legacy.client) === agentKey(owner.name) ? legacy : undefined);
    if (previous) {
      this.authorize(previous, owner, true);
      if (!isDeepStrictEqual(previous.definition, definition)) throw new BrowserTaskError("key_conflict", "This idempotency key already identifies a different plan", 409);
      if (this.canAdoptLocalOwner(previous, owner)) {
        const savedOwner = previous.owner, savedDelegates = previous.delegates;
        previous.owner = owner;
        delete previous.delegates;
        try { this.save(previous); }
        catch (error) { previous.owner = savedOwner; previous.delegates = savedDelegates; throw error; }
      }
      return view(previous);
    }
    if (previousKey) {
      const previousId = createHash("sha256").update(JSON.stringify([profileId, previousKey])).digest("hex").slice(0, 32);
      if (this.history.has(previousId)) throw new BrowserTaskError("key_conflict", "A run with this key exists under the previous Worker identity", 409);
    }
    this.assertOpen();
    if (!definition.target) this.assertAvailable(profileId);
    const now = new Date().toISOString();
    const task: BrowserTask = {
      version: 1, runId, client: owner.name, owner, definition, state: "queued", createdAt: now, updatedAt: now,
      steps: definition.steps.map(step => ({ id: step.id, state: "pending", attempts: 0 })), evidenceCount: 0,
      queue: { order: ++this.order, recoveries: 0, consecutiveRecoveries: 0 },
    };
    const directory = this.path(runId);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    if (readdirSync(directory).some(name => !name.endsWith(".tmp"))) {
      throw new BrowserTaskError("task_storage_unreadable", "This key has task data that could not be loaded", 409);
    }
    syncDirectory(this.options.root);
    try { this.save(task); } catch (error) { rmSync(this.path(runId), { recursive: true, force: true }); throw error; }
    this.history.set(runId, task);
    if (definition.target) this.wakeQueue();
    else this.dispatch();
    return view(task);
  }

  resume(runId: string, client?: TaskClient, verify?: unknown, expectedAttempt?: unknown): BrowserTaskView {
    const saved = this.get(runId);
    this.authorize(saved, client);
    if (this.running.has(runId) || isFinished(saved.state) || saved.state === "queued" || saved.state === "recovering") return view(saved);
    this.assertOpen();
    const task = structuredClone(saved);
    if (!task.definition.target) this.assertAvailable(task.definition.profileId, task);
    const step = task.steps.find(item => item.state === "uncertain");
    if (verify !== undefined && (!step || typeof verify !== "string" || !verify.trim() || Buffer.byteLength(verify) > 256 * 1024)) {
      badRequest("Supply a verification function for the uncertain step");
    }
    if (expectedAttempt !== undefined && (!step || expectedAttempt !== `${step.id}:${step.attempts}:${step.evidence ?? 0}`)) {
      throw new BrowserTaskError("checkpoint_changed", "The task checkpoint changed. Reload the evidence before supplying a verifier.", 409);
    }
    if (client !== undefined) {
      const actor = taskActor(client);
      if (this.canAdoptLocalOwner(task, actor)) {
        task.owner = actor;
        delete task.delegates;
      }
    }
    const owner = ownerOf(task);
    this.options.authorize(task.definition.profileId, owner.name, undefined, owner);
    task.state = "queued";
    delete task.waitReason;
    delete task.error;
    delete task.blocked;
    const queue = task.queue ??= { order: ++this.order, recoveries: 0, consecutiveRecoveries: 0 };
    queue.consecutiveRecoveries = 0;
    delete queue.retryAt;
    if (typeof verify === "string" && step) {
      queue.verifier = { stepId: step.id, code: verify, ...(client === undefined ? {} : { suppliedBy: taskActor(client) }) };
    }
    this.save(task);
    this.history.set(runId, task);
    this.wakeQueue();
    return view(task);
  }

  private canAdoptLocalOwner(task: BrowserTask, actor: BrowserTaskActor) {
    return actor.scope === "local-auth" && ownerOf(task).scope === "local" && agentKey(actor.name) === agentKey(task.client);
  }

  setDelegates(runId: string, value: unknown, client?: TaskClient) {
    const task = this.get(runId);
    this.authorize(task, client, true);
    if (!Array.isArray(value) || value.length > 32 || value.some(name => typeof name !== "string" || !name.trim() || name.length > 64)) {
      badRequest("Provide up to 32 Agent names");
    }
    const previousOwner = task.owner;
    const previous = task.delegates;
    if (client !== undefined && this.canAdoptLocalOwner(task, taskActor(client))) task.owner = taskActor(client);
    task.delegates = [...new Set(value.map(agentKey))].filter(name => name !== agentKey(ownerOf(task).name) && name !== "unknown");
    try { this.save(task); }
    catch (error) { task.owner = previousOwner; task.delegates = previous; throw error; }
    return view(task);
  }

  stop(runId: string, state: "paused" | "cancelled", client?: TaskClient) {
    const task = this.get(runId);
    this.authorize(task, client);
    const active = this.running.get(runId);
    if (active) {
      const requested = active.stop === "cancelled" ? active.stop : state;
      const previous = task.stopRequested;
      task.stopRequested = requested;
      try { this.save(task); }
      catch (error) { task.stopRequested = previous; throw error; }
      active.stop = requested;
      active.waiting.abort();
      return { task: view(task), stopping: true };
    }
    if (!isFinished(task.state) && (state === "cancelled" || task.state === "queued" || task.state === "recovering")) {
      task.state = state;
      delete task.waitReason;
      if (task.queue) delete task.queue.retryAt;
      this.save(task);
      this.wakeQueue();
    }
    return { task: view(task), stopping: false };
  }

  evidence(runId: string, sequence: number, part: string, offset: number, bytes: number, client?: TaskClient) {
    const task = this.get(runId);
    this.authorize(task, client);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > task.evidenceCount) throw new BrowserTaskError("evidence_not_found", "Evidence was not found", 404);
    const data = this.readEvidence(runId, sequence);
    if (part === "summary") {
      const { sequence, stepId, attempt, phase, startedAt, endedAt, completed, error, screenshot, screenshotError, network, events, logs, value, detailsExpired } = data;
      return { sequence, stepId, actionKey: `${runId}:${stepId}`, attempt, phase, startedAt, endedAt, completed, error, screenshotError, detailsExpired,
        available: { screenshot: !!screenshot, network: !!network, events: !!events, logs: !!logs, value: value !== undefined } };
    }
    if (!["value", "network", "events", "logs", "screenshot"].includes(part)) badRequest("Unknown evidence part");
    if (data.detailsExpired) throw new BrowserTaskError("evidence_too_large", "The evidence details exceeded the storage limit", 410);
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
    clearInterval(this.evidenceTimer);
    for (const active of this.running.values()) {
      active.stop ??= "interrupted";
      active.waiting.abort();
    }
    await Promise.allSettled([...this.running.values()].map(active => active.done));
  }

  private assertOpen() {
    if (this.closing) throw new BrowserTaskError("shutting_down", "The browser task service is shutting down", 409);
  }

  private assertAvailable(profileId: string, resuming?: BrowserTask) {
    if ([...this.history.values()].some(task => task.runId !== resuming?.runId && task.definition.profileId === profileId &&
      (this.running.has(task.runId) || task.queue && !isFinished(task.state) &&
        (resuming?.queue === undefined || task.queue.order < resuming.queue.order)))) {
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
    const host = tasks.length ? this.options.hostWork?.status() : undefined;
    let capacity: number | undefined, next = Infinity;
    for (const task of tasks) {
      const profileId = task.definition.profileId;
      delete task.waitReason;
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
      if (host?.paused) { task.waitReason = "memory"; next = Math.min(next, 500); continue; }
      if (this.running.size >= capacity || (this.options.hostWork && !this.options.hostWork.canStart())) {
        task.waitReason = "capacity"; next = Math.min(next, 500); continue;
      }
      const lease = this.options.writes?.tryAcquire(profileId);
      if (this.options.writes && !lease) { task.waitReason = "profile_write"; next = Math.min(next, 250); continue; }
      const hostPermit = this.options.hostWork?.acquire();
      if (this.options.hostWork && !hostPermit) {
        lease?.release();
        next = Math.min(next, 500);
        break;
      }
      task.state = "running";
      delete task.waitReason;
      delete queue.retryAt;
      try { this.save(task); }
      catch (error) {
        lease?.release();
        hostPermit?.release();
        task.state = "interrupted";
        task.error = message(error);
        this.options.log?.(`Could not queue browser task ${task.runId}: ${task.error}`);
        continue;
      }
      this.launch(task, lease, hostPermit);
    }
    if (Number.isFinite(next)) this.wakeQueue(next);
  }

  private launch(task: BrowserTask, lease?: ProfileWriteLease, hostPermit?: HostWorkPermit) {
    const active: ActiveTask = { task, waiting: new AbortController(), done: Promise.resolve(), lease, hostPermit };
    this.running.set(task.runId, active);
    active.done = Promise.resolve().then(() => this.execute(active)).catch(error => {
      this.options.log?.(`Could not persist browser task ${task.runId}: ${message(error)}`);
    }).finally(() => {
      active.lease?.release();
      active.hostPermit?.release();
      if (this.running.get(task.runId) === active) this.running.delete(task.runId);
      this.wakeQueue();
    });
  }

  private readEvidence(runId: string, sequence: number) {
    const path = this.path(runId, `evidence-${sequence}.json`);
    try { return JSON.parse(readFileSync(path, "utf8")) as ProgramReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BrowserTaskError("evidence_expired", "This evidence has expired", 410);
      throw error;
    }
  }

  private trackReceipt(runId: string, sequence: number, bytes: number, at: number) {
    this.receipts.push({ runId, sequence, bytes, at });
    this.receiptBytes += bytes;
  }

  private pruneEvidence() {
    const now = Date.now();
    if (this.receiptBytes <= MAX_EVIDENCE_BYTES && now < this.nextEvidencePrune) return;
    this.nextEvidencePrune = now + 60_000;
    if (this.receiptBytes <= MAX_EVIDENCE_BYTES && !this.receipts.some(receipt => now - receipt.at >= EVIDENCE_RETENTION_MS)) return;
    const expired = new Set<(typeof this.receipts)[number]>();
    for (const receipt of [...this.receipts].sort((a, b) => a.at - b.at)) {
      if (this.receiptBytes <= MAX_EVIDENCE_BYTES && now - receipt.at < EVIDENCE_RETENTION_MS) break;
      const task = this.history.get(receipt.runId);
      if (!task) continue;
      // Older manifests use the receipt itself to restore a previously completed step.
      if (!isFinished(task.state) && task.steps.some(step =>
        step.state === "completed" && step.evidence === receipt.sequence && !step.result)) continue;
      try {
        rmSync(this.path(receipt.runId, `evidence-${receipt.sequence}.json`), { force: true });
        expired.add(receipt);
        this.receiptBytes -= receipt.bytes;
      } catch (error) { this.options.log?.(`Could not rotate browser task evidence ${receipt.runId}: ${message(error)}`); }
    }
    if (!expired.size) return;
    const kept = this.receipts.filter(receipt => !expired.has(receipt));
    this.receipts.length = 0;
    for (const receipt of kept) this.receipts.push(receipt);
    const first = new Map<string, number>();
    for (const receipt of kept) first.set(receipt.runId, Math.min(first.get(receipt.runId) ?? receipt.sequence, receipt.sequence));
    for (const task of this.history.values()) task.firstEvidence = first.get(task.runId) ?? task.evidenceCount + 1;
  }

  private recover(task: BrowserTask, fallback: RunState): RunState {
    const queue = task.queue;
    if (!task.definition.target || !queue || queue.consecutiveRecoveries >= recoveryDelays.length) return fallback;
    queue.retryAt = Date.now() + recoveryDelays[queue.consecutiveRecoveries++]!;
    queue.recoveries++;
    return "recovering";
  }

  private async execute(active: ActiveTask) {
    const { task } = active, { profileId, screenshots, argument, steps, target } = task.definition;
    const release = this.options.hold?.(profileId);
    let connection: BrowserTaskConnection | undefined;
    const authorize = () => {
      const owner = ownerOf(task);
      this.options.authorize(profileId, owner.name, undefined, owner);
      return owner;
    };
    let state: RunState = "interrupted";
    const values: Record<string, unknown> = Object.create(null);
    const uncertain = () => task.steps.find(checkpoint => checkpoint.state === "uncertain");
    const block = (blocked: TaskBlock) => { task.blocked = blocked; state = "blocked"; };
    try {
      if (!active.stop) {
        const owner = authorize();
        connection = await this.options.open(profileId, owner.name, active.waiting.signal, active.hostPermit, owner);
      }
      if (!active.stop && target) {
        authorize();
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
          if (checkpoint.result) {
            values[step.id] = checkpoint.result.value;
          } else if (checkpoint.evidence) {
            const recorded = this.readEvidence(task.runId, checkpoint.evidence);
            values[step.id] = recorded.phase === "verify" ? (recorded.value as { value?: unknown })?.value : recorded.value;
          }
          continue;
        }
        const queuedVerifier = task.queue?.verifier?.stepId === step.id ? task.queue.verifier : undefined;
        const verifier = checkpoint.state === "uncertain" ? queuedVerifier?.code ?? step.verify : step.verify;
        const complete = (value: unknown) => {
          checkpoint.state = "completed";
          delete checkpoint.error;
          checkpoint.result = { value };
          values[step.id] = value;
          if (task.queue) {
            task.queue.consecutiveRecoveries = 0;
            if (queuedVerifier) delete task.queue.verifier;
          }
          this.save(task);
        };
        const act = async (phase: Phase, code: string) => {
          const owner = authorize();
          const startedAt = new Date().toISOString();
          const receipt: ProgramReceipt = await connection!.program({
            code, screenshots, timeoutMs: step.timeoutMs ?? 120_000, pageUrl: step.pageUrl, frameUrl: step.frameUrl, tabId: task.tab?.id, argument: {
            input: argument, runId: task.runId, stepId: step.id, actionKey: `${task.runId}:${step.id}`, attempt: checkpoint.attempts, previous: values,
          } }).catch(error => ({ completed: false, error: message(error), fault: faultOf(error) } satisfies ProgramReceipt));
          if (task.tab && receipt.fault === "task_tab_lost") task.tab.lost = true;
          const sequence = task.evidenceCount + 1;
          const evidence: ProgramReceipt = {
            ...receipt, sequence, stepId: step.id, attempt: checkpoint.attempts, phase, startedAt, endedAt: new Date().toISOString(),
          };
          const metadata = { sequence, stepId: step.id, attempt: checkpoint.attempts, phase, startedAt, endedAt: evidence.endedAt,
            completed: receipt.completed, error: receipt.error };
          const path = this.path(task.runId, `evidence-${sequence}.json`);
          const size = Buffer.byteLength(JSON.stringify(evidence));
          atomicJson(path, size > MAX_RECEIPT_BYTES ? { ...metadata, detailsExpired: true } : evidence);
          this.trackReceipt(task.runId, sequence, statSync(path).size, Date.now());
          task.evidenceCount = sequence; checkpoint.evidence = sequence;
          if ((task.firstEvidence ?? 1) > sequence) task.firstEvidence = sequence;
          this.save(task);
          this.options.record?.({ runId: task.runId, profileId, client: owner.name, stepId: step.id, sequence, phase, ok: receipt.completed });
          if (this.receiptBytes > MAX_EVIDENCE_BYTES) this.pruneEvidence();
          return receipt;
        };
        const reconcile = async (): Promise<"applied" | "absent" | "unknown"> => {
          state = "needs_verification";
          checkpoint.verification = "unknown";
          if (!verifier) { checkpoint.error = "Provide a verifier to resolve the last attempt"; return "unknown"; }
          if (queuedVerifier?.suppliedBy) {
            try { this.authorize(task, queuedVerifier.suppliedBy); }
            catch {
              if (task.queue) delete task.queue.verifier;
              checkpoint.error = "The replacement verifier's Agent authorization was revoked";
              return "unknown";
            }
          }
          const receipt = await act("verify", verifier);
          const verified = receipt.value as { state?: unknown; value?: unknown } | undefined;
          if (receipt.completed && verified?.state === "applied") {
            checkpoint.verification = "applied";
            // Store the verifier's value as the canonical receipt while keeping the full verifier evidence.
            complete(verified.value);
            return "applied";
          }
          if (receipt.completed && verified?.state === "absent") { checkpoint.verification = "absent"; return "absent"; }
          checkpoint.error = receipt.error ?? "The verifier could not confirm the effect of the action";
          const blocked = target && receipt.completed ? taskBlock(receipt.value) : undefined;
          if (blocked) block(blocked);
          else if (recoverableFaults.has(receipt.fault ?? "")) state = this.recover(task, "needs_verification");
          return "unknown";
        };
        if (checkpoint.state === "uncertain") {
          if (target && step.readOnly) checkpoint.state = "pending";
          else {
            const verified = await reconcile();
            if (verified === "applied") continue;
            if (verified === "unknown" || active.stop) break;
          }
        }
        authorize();
        delete checkpoint.verification;
        checkpoint.state = "uncertain"; checkpoint.attempts++; delete checkpoint.error;
        this.save(task);
        const receipt = await act("run", step.run);
        if (!receipt.completed) {
          checkpoint.error = receipt.error ?? "The action did not acknowledge completion";
          if (receipt.invoked === false || (target && step.readOnly)) checkpoint.state = "pending";
          state = checkpoint.state === "pending" ? "interrupted" : "needs_verification";
          if (target && !active.stop && (checkpoint.state === "uncertain" ? verifier : recoverableFaults.has(receipt.fault ?? ""))) {
            state = this.recover(task, state);
          }
          break;
        }
        const blocked = target ? taskBlock(receipt.value) : undefined;
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
      if (target && (fault === "not_permitted" || fault === "no_such_profile" || fault === "profile_handed_off")) {
        block({ code: fault, message: task.error });
      }
      else if (target && !active.stop && (recoverableFaults.has(fault ?? "") || (fault === "browser_launch_failed" && task.tab))) {
        state = this.recover(task, state);
      }
    } finally {
      release?.();
      await connection?.close().catch(error => this.options.log?.(`Browser task detach: ${message(error)}`));
      if (task.steps.every(step => step.state === "completed")) state = "completed";
      else if (active.stop) state = active.stop === "interrupted" && target ? "queued" : active.stop;
      task.state = state;
      delete task.waitReason;
      if (task.queue && state !== "recovering") delete task.queue.retryAt;
      delete task.stopRequested;
      this.save(task);
      this.pruneEvidence();
    }
  }
}

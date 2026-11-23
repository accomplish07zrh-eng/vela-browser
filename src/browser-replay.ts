import { randomUUID } from "node:crypto";
import type { WorkbenchAdapter, WorkbenchFrame, WorkbenchViewport } from "./workbench-protocol.ts";
import { diagnosticUrl, type ReplayRequestEvent } from "./replay-network.ts";

export const BROWSER_REPLAY_PATH = "/ui/replay";
const RETENTION_MS = 60_000;
const FRAME_INTERVAL_MS = 160;
const MAX_FRAME_BYTES = 512 * 1024;
// Leave room for base64 and JSON within the agent connection's 1 MiB message limit.
const MAX_SAMPLE_BYTES = 640 * 1024;
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;
const MAX_CAPTURES = 4;
const MAX_LINKS_PER_CAPTURE = 16;
const MAX_REQUESTS = 256;
const MAX_STEPS = 24;
const MAX_STEP_EVENTS = 8;
const STREAM_OPTIONS = { maxWidth: 960, maxHeight: 960, quality: 62, minInterval: FRAME_INTERVAL_MS };

interface ReplaySource {
  adapter: Pick<WorkbenchAdapter, "tabs" | "select" | "stream" | "frame" | "viewport" | "observeNetwork" | "dispose">;
  generation?: string;
  current(): boolean;
}

interface Frame {
  id: number;
  at: number;
  jpeg: Buffer<ArrayBuffer>;
  viewport?: WorkbenchViewport;
}

export interface ReplayStepInput {
  profileId: string;
  tabId: string;
  generation: string;
  runId: string;
  stepId: string;
  sequence: number;
  attempt: number;
  phase: "run" | "verify";
  startedAt: string;
  endedAt: string;
  receipt: { completed: boolean; error?: string; network?: unknown; events?: unknown };
}

type StepNote = { at: number; kind: string; message?: string; status?: number; url?: string; method?: string; durationMs?: number };
type ReplayStep = Pick<ReplayStepInput, "runId" | "stepId" | "sequence" | "attempt" | "phase"> & {
  start: number; end: number; completed: boolean; notes: StepNote[];
};
type RequestStart = Extract<ReplayRequestEvent, { kind: "start" }>;
type ReplayRequest = Pick<RequestStart, "key" | "time" | "method" | "url" | "origin"> & {
  id: number; at: number; updatedAt: number; status?: number; failure?: string; durationMs?: number;
  redirectedFrom?: number; redirectedTo?: number; fromServiceWorker?: boolean;
};

interface Capture {
  owner: AbortSignal;
  profileId: string;
  allowed(): boolean;
  onAbort(): void;
  startedAt?: number;
  source?: ReplaySource;
  tabId?: string;
  stopStream?: () => Promise<void>;
  stopNetwork?: () => Promise<void>;
  nativeNetwork: boolean;
  endsAt?: number;
  deadline?: ReturnType<typeof setTimeout>;
  ended: boolean;
  stopped: boolean;
  frames: Frame[];
  bytes: number;
  nextId: number;
  nextRequestId: number;
  requests: Map<number, ReplayRequest>;
  activeRequests: Map<string, number>;
  steps: ReplayStep[];
  viewport?: WorkbenchViewport;
  lastFrameAt: number;
  lastCheck: number;
  earlyEvictions: number;
  oversizedFrames: number;
  poll?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
  expiryAt?: number;
  links: Set<string>;
}

interface Clip {
  capture: Capture;
  firstId: number;
  lastId: number;
  focusId?: number;
  start: number;
  expires: number;
}

function bounded(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(name + " must be between 0 and " + maximum);
  }
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  const entries = (value as { records?: unknown } | undefined)?.records;
  return Array.isArray(entries) ? entries.filter(entry => entry && typeof entry === "object") : [];
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const sameViewport = (a?: WorkbenchViewport, b?: WorkbenchViewport) => a?.width === b?.width && a?.height === b?.height
  && a?.devicePixelRatio === b?.devicePixelRatio && a?.pageScale === b?.pageScale;

/** Holds compressed page frames and playback capabilities in memory for this dashboard process. */
export class BrowserReplay {
  private readonly captures = new Map<string, Capture>();
  private readonly clips = new Map<string, Clip>();
  private readonly wallOrigin: number;
  private closed = false;

  constructor(
    private readonly openSource: (profileId: string) => Promise<ReplaySource>,
    private readonly playbackOrigin: () => string,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.wallOrigin = Date.now() - clock();
  }

  async call(owner: AbortSignal, profileId: string, args: Record<string, unknown>, allowed: () => boolean): Promise<object> {
    if (this.closed || owner.aborted || !allowed()) throw new Error("The replay connection is unavailable");
    if (args.action === "tabs") {
      const source = await this.openSource(profileId);
      try {
        const tabs = await source.adapter.tabs();
        if (!source.current() || owner.aborted || !allowed()) throw new Error("The browser session changed");
        return { profileId, tabs: tabs.filter(tab => args.tabId === undefined || tab.id === args.tabId)
          .map(({ id, ...tab }) => ({ tabId: id, ...tab })) };
      } finally { await source.adapter.dispose(); }
    }
    if (args.action === "start") {
      if (args.tabId !== undefined && (typeof args.tabId !== "string" || !args.tabId)) throw new Error("Invalid tabId");
      const seconds = bounded(args.durationSeconds, 60, 300, "durationSeconds");
      if (!Number.isInteger(seconds) || seconds < 1) throw new Error("durationSeconds must be an integer between 1 and 300");
      return await this.start(owner, profileId, args.tabId, seconds * 1000, allowed);
    }
    if (args.action === "stop") {
      if (args.tabId === undefined || this.captures.get(profileId)?.tabId === args.tabId) this.discardFor(owner, profileId);
      return { profileId, active: false };
    }
    if (args.action === "diagnose") return this.diagnose(owner, profileId, args);
    if (args.action !== "play") throw new Error("Choose replay action tabs, start, play, diagnose or stop");
    return this.play(owner, profileId, args);
  }

  /** Only bounded highlights from a task step join the rolling replay. */
  noteTaskStep(input: ReplayStepInput): void {
    const capture = this.captures.get(input.profileId);
    if (!capture || capture.tabId !== input.tabId || capture.source?.generation !== input.generation
      || capture.startedAt === undefined || !this.available(capture)) return;
    const now = this.clock();
    const start = Date.parse(input.startedAt) - this.wallOrigin, end = Date.parse(input.endedAt) - this.wallOrigin;
    const first = Math.max(start, capture.startedAt, now - RETENTION_MS);
    const last = Math.min(end, capture.endsAt!, now);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return;
    this.prune(capture, now);
    const notes: StepNote[] = [];
    const time = (date: unknown) => typeof date === "string" ? Date.parse(date) - this.wallOrigin : NaN;
    for (const event of records(input.receipt.events).reverse()) {
      const at = time(event.timestamp);
      if (!(at >= first && at <= last)) continue;
      if (event.kind === "exception" || event.kind === "crash" || (event.kind === "console" && ["error", "assert", "warning"].includes(String(event.type)))) {
        notes.push({ at, kind: String(event.kind), message: text(event.text, 512) });
      }
      if (notes.length >= MAX_STEP_EVENTS) break;
    }
    const failedRequests: StepNote[] = [];
    for (const request of records(input.receipt.network).reverse()) {
      if (!request.failure && !(typeof request.status === "number" && request.status >= 400)) continue;
      const at = time(request.finishedAt ?? request.timestamp);
      if (!(at >= first && at <= last)) continue;
      failedRequests.push({ at, kind: "request", status: typeof request.status === "number" ? request.status : undefined,
        url: diagnosticUrl(request.url), method: text(request.method, 16), message: text(request.failure, 128),
        durationMs: positive((request.timing as { responseEnd?: unknown } | undefined)?.responseEnd) });
      if (failedRequests.length >= MAX_STEP_EVENTS) break;
    }
    if (!input.receipt.completed && input.receipt.error && end <= capture.endsAt! && end >= first) {
      notes.push({ at: Math.min(end, now), kind: "step-error", message: text(input.receipt.error, 512) });
    }
    capture.steps.push({ runId: input.runId, stepId: input.stepId, sequence: input.sequence, attempt: input.attempt, phase: input.phase,
      start: first, end: last, completed: input.receipt.completed, notes: notes.concat(failedRequests).sort((a, b) => a.at - b.at) });
    if (capture.steps.length > MAX_STEPS) capture.steps.shift();
    this.scheduleExpiry(capture);
  }

  discardFor(owner: AbortSignal, profileId: string): void {
    const capture = this.captures.get(profileId);
    if (capture?.owner === owner) this.discard(capture);
  }

  close(): void {
    this.closed = true;
    for (const capture of this.captures.values()) this.discard(capture);
  }

  private async start(owner: AbortSignal, profileId: string, tabId: string | undefined, durationMs: number, allowed: () => boolean) {
    const existing = this.captures.get(profileId);
    if (existing && (!existing.source || this.available(existing))) {
      if (existing.owner !== owner) throw new Error("A replay is already reserved for this profile on another MCP connection");
      if (existing.ended) this.discard(existing);
      else if (existing.tabId && (tabId === undefined || existing.tabId === tabId)) return this.status(existing);
      else throw new Error("A replay is already recording this profile. Stop it before starting a different replay.");
    }
    if (this.captures.size >= MAX_CAPTURES) throw new Error("The dashboard is already recording four profiles");
    const capture: Capture = {
      owner, profileId, allowed, onAbort: () => this.discard(capture), ended: false, stopped: false,
      frames: [], bytes: 0, nextId: 0, lastFrameAt: -Infinity, lastCheck: this.clock(), nativeNetwork: false,
      requests: new Map(), activeRequests: new Map(), nextRequestId: 0, steps: [],
      earlyEvictions: 0, oversizedFrames: 0, links: new Set(),
    };
    this.captures.set(profileId, capture);
    owner.addEventListener("abort", capture.onAbort, { once: true });
    try {
      const source = await this.openSource(profileId);
      if (capture.stopped) {
        await source.adapter.dispose();
        throw new Error("The replay connection closed");
      }
      capture.source = source;
      const tabs = await source.adapter.tabs();
      const tab = tabId === undefined && tabs.length === 1 ? tabs[0] : tabs.find((tab) => tab.id === tabId);
      if (!tab) throw new Error("Choose a tabId from the replay tabs action");
      await source.adapter.select(tab.id);
      if (!this.available(capture)) throw new Error("The browser session changed");
      capture.tabId = tab.id;
      capture.startedAt = this.clock();
      capture.endsAt = capture.startedAt + durationMs;
      capture.deadline = setTimeout(() => this.finish(capture), durationMs).unref();
      const [stop, stopNetwork] = await Promise.all([
        source.adapter.stream?.(STREAM_OPTIONS, frame => this.append(capture, frame)).catch(() => undefined),
        source.adapter.observeNetwork?.(event => this.noteRequest(capture, event)).catch(() => undefined),
        this.measureViewport(capture),
      ]);
      if (!this.available(capture)) {
        await Promise.allSettled([stop?.(), stopNetwork?.()]);
        throw new Error("The browser session changed");
      }
      capture.nativeNetwork = !!stopNetwork;
      if (capture.ended) await Promise.allSettled([stop?.(), stopNetwork?.()]);
      else { capture.stopStream = stop; capture.stopNetwork = stopNetwork; }
      this.schedulePoll(capture, 0);
      return this.status(capture);
    } catch (error) {
      this.discard(capture);
      throw error;
    }
  }

  private status(capture: Capture) {
    return { profileId: capture.profileId, tabId: capture.tabId, active: !capture.ended,
      captureEndsAt: this.iso(capture.endsAt!), retentionSeconds: RETENTION_MS / 1000, nativeNetwork: capture.nativeNetwork };
  }

  private available(capture: Capture): boolean {
    if (capture.stopped) return false;
    if (capture.source?.current() && capture.allowed()) return true;
    this.discard(capture);
    return false;
  }

  private discard(capture: Capture): void {
    if (capture.stopped) return;
    capture.stopped = true;
    this.captures.delete(capture.profileId);
    capture.owner.removeEventListener("abort", capture.onAbort);
    clearTimeout(capture.deadline);
    clearTimeout(capture.expiry);
    clearTimeout(capture.poll);
    capture.frames.length = 0;
    capture.bytes = 0;
    capture.requests.clear();
    capture.activeRequests.clear();
    capture.steps.length = 0;
    capture.viewport = undefined;
    for (const token of capture.links) this.clips.delete(token);
    capture.links.clear();
    void (async () => {
      try { await this.stopFrames(capture); }
      finally { await capture.source?.adapter.dispose(); }
    })().catch(() => {});
  }

  private async stopFrames(capture: Capture): Promise<void> {
    const { stopStream, stopNetwork } = capture;
    capture.stopStream = capture.stopNetwork = undefined;
    await Promise.allSettled([stopStream?.(), stopNetwork?.()]);
  }

  private finish(capture: Capture): void {
    if (capture.stopped || capture.ended) return;
    capture.ended = true;
    if (!this.hasData(capture)) this.discard(capture);
    else void this.stopFrames(capture);
  }

  private prune(capture: Capture, now: number): void {
    const cutoff = now - RETENTION_MS;
    while (capture.frames.length && capture.frames[0]!.at + RETENTION_MS <= now) {
      capture.bytes -= capture.frames.shift()!.jpeg.byteLength;
    }
    while (capture.requests.size && capture.requests.values().next().value!.at <= cutoff) this.dropOldestRequest(capture);
    capture.steps = capture.steps.filter(step => step.end > cutoff);
    for (const step of capture.steps) step.notes = step.notes.filter(note => note.at > cutoff);
    for (const token of capture.links) {
      if (this.clips.get(token)!.expires > now) continue;
      this.clips.delete(token);
      capture.links.delete(token);
    }
  }

  private scheduleExpiry(capture: Capture): void {
    const first = Math.min(capture.frames[0]?.at ?? Infinity, capture.requests.values().next().value?.at ?? Infinity,
      ...capture.steps.map(step => step.notes[0]?.at ?? step.end));
    const at = first + RETENTION_MS;
    if (!Number.isFinite(at) || (capture.expiryAt !== undefined && capture.expiryAt <= at)) return;
    clearTimeout(capture.expiry);
    capture.expiryAt = at;
    capture.expiry = setTimeout(() => {
      capture.expiry = undefined;
      capture.expiryAt = undefined;
      this.prune(capture, this.clock());
      if (capture.ended && !this.hasData(capture)) { this.discard(capture); return; }
      this.scheduleExpiry(capture);
    }, Math.max(1, Math.ceil(at - this.clock()))).unref();
  }

  private hasData(capture: Capture): boolean {
    return capture.frames.length > 0 || capture.requests.size > 0 || capture.steps.length > 0;
  }

  private dropOldestRequest(capture: Capture): void {
    const request = capture.requests.values().next().value!;
    capture.requests.delete(request.id);
    if (capture.activeRequests.get(request.key) === request.id) capture.activeRequests.delete(request.key);
  }

  private noteRequest(capture: Capture, event: ReplayRequestEvent): void {
    const now = this.clock();
    if (capture.stopped || capture.ended || now >= capture.endsAt!) return;
    const id = capture.activeRequests.get(event.key);
    const prior = id === undefined ? undefined : capture.requests.get(id);
    const previous = prior && prior.at > now - RETENTION_MS ? prior : undefined;
    if (event.kind === "start") {
      const nextId = ++capture.nextRequestId;
      if (previous && event.redirectStatus !== undefined) {
        Object.assign(previous, { updatedAt: now, status: event.redirectStatus, redirectedTo: nextId });
      }
      const { key, time, url, method, origin } = event;
      const redirectedFrom = event.redirectStatus !== undefined ? previous?.id : undefined;
      const source = redirectedFrom && !origin.location ? { ...origin, location: previous?.origin.location } : origin;
      capture.requests.set(nextId, { id: nextId, key, time, at: now, updatedAt: now, url, method, origin: source, redirectedFrom });
      capture.activeRequests.set(key, nextId);
      while (capture.requests.size > MAX_REQUESTS) this.dropOldestRequest(capture);
      this.scheduleExpiry(capture);
      return;
    }
    if (!previous) return;
    previous.updatedAt = now;
    if (event.kind === "response") {
      previous.status = event.status;
      previous.fromServiceWorker = event.fromServiceWorker;
    } else {
      previous.failure = event.failure;
      if (event.time !== undefined && previous.time !== undefined && event.time >= previous.time) {
        previous.durationMs = Math.round(event.time - previous.time);
      }
      capture.activeRequests.delete(event.key);
    }
  }

  private async measureViewport(capture: Capture): Promise<void> {
    const value = await capture.source?.adapter.viewport?.(true).catch(() => undefined);
    const width = positive(value?.width), height = positive(value?.height);
    if (capture.stopped || capture.ended || !width || !height) return;
    capture.viewport = { width, height, devicePixelRatio: positive(value?.devicePixelRatio), pageScale: positive(value?.pageScale) };
  }

  private append(capture: Capture, frame: WorkbenchFrame): void {
    const now = this.clock();
    if (capture.stopped || capture.ended || now >= capture.endsAt! || now - capture.lastFrameAt < FRAME_INTERVAL_MS || typeof frame.data !== "string") return;
    if (frame.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) {
      capture.oversizedFrames++;
      return;
    }
    const jpeg = Buffer.from(frame.data, "base64");
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.byteLength > MAX_FRAME_BYTES) return;
    this.prune(capture, now);
    capture.lastFrameAt = now;
    capture.frames.push({ id: ++capture.nextId, at: now, jpeg, viewport: capture.viewport });
    capture.bytes += jpeg.byteLength;
    while (capture.bytes > MAX_CAPTURE_BYTES) {
      capture.bytes -= capture.frames.shift()!.jpeg.byteLength;
      capture.earlyEvictions++;
    }
    this.scheduleExpiry(capture);
  }

  private schedulePoll(capture: Capture, delay: number): void {
    capture.poll = setTimeout(() => void this.poll(capture), delay).unref();
  }

  private async poll(capture: Capture): Promise<void> {
    try {
      if (!this.available(capture)) return;
      const adapter = capture.source!.adapter;
      const now = this.clock();
      if (now - capture.lastCheck >= 2000) {
        if (!(await adapter.tabs()).some(tab => tab.id === capture.tabId)) { this.discard(capture); return; }
        capture.lastCheck = now;
        if (!capture.ended) await this.measureViewport(capture);
      }
      // A static or occluded tab can stop pushing compositor frames.
      if (!capture.stopped && !capture.ended && (!capture.stopStream || this.clock() - capture.lastFrameAt > 1500)) {
        const frame = await adapter.frame(false, STREAM_OPTIONS.maxWidth).catch(() => undefined);
        if (frame) this.append(capture, frame);
      }
    } catch { this.discard(capture); }
    if (!capture.stopped) this.schedulePoll(capture, capture.stopStream || capture.ended ? 1000 : 250);
  }

  private iso(at: number): string { return new Date(this.wallOrigin + at).toISOString(); }

  private retained(owner: AbortSignal, profileId: string, tabId: unknown): Capture {
    const capture = this.captures.get(profileId);
    if (!capture || capture.owner !== owner || !capture.tabId || !this.available(capture)
      || (tabId !== undefined && tabId !== capture.tabId)) throw new Error("Start a replay for this tab on this MCP connection first");
    this.prune(capture, this.clock());
    return capture;
  }

  private diagnose(owner: AbortSignal, profileId: string, args: Record<string, unknown>) {
    if (typeof args.runId !== "string" || typeof args.tabId !== "string") throw new Error("Use a runId to diagnose a task's bound tab");
    if (args.sequence !== undefined && (!Number.isSafeInteger(args.sequence) || (args.sequence as number) < 1)) throw new Error("Use a positive evidence sequence");
    const frameCount = bounded(args.frameCount, 2, 4, "frameCount");
    if (!Number.isInteger(frameCount)) throw new Error("frameCount must be an integer");
    const capture = this.retained(owner, profileId, args.tabId), now = this.clock();
    const steps = capture.steps.filter(step => step.runId === args.runId);
    const step = args.sequence === undefined ? steps.findLast(step => !step.completed) ?? steps.at(-1)
      : steps.find(step => step.sequence === args.sequence);
    if (!step) return { ...this.status(capture), runId: args.runId, message: "No step evidence is retained for this task in the current replay." };
    const focus = step.notes.at(-1)?.at ?? step.end;
    const frames = capture.frames.filter(frame => frame.at >= focus - 8000 && frame.at <= focus + 1500);
    const relevant = [...capture.requests.values()].filter(request => request.at <= step.end && request.updatedAt >= step.start);
    const importance = (request: ReplayRequest) => request.failure || (request.status ?? 0) >= 400 ? 2 : request.redirectedFrom || request.redirectedTo ? 1 : 0;
    const network = relevant.sort((a, b) => importance(b) - importance(a) || b.updatedAt - a.updatedAt)
      .slice(0, 20).sort((a, b) => a.id - b.id)
      .map(({ key: _key, time: _time, at, updatedAt, ...request }) => ({ ...request, startedAt: this.iso(at), updatedAt: this.iso(updatedAt) }));
    const { notes, start, end, ...checkpoint } = step;
    return { ...this.status(capture), step: { ...checkpoint, startedAt: this.iso(start), endedAt: this.iso(end) },
      focusAt: this.iso(focus), events: notes.map(({ at, ...note }) => ({ ...note, timestamp: this.iso(at) })),
      requests: network, ...this.clip(capture, frames, now, frameCount, focus) };
  }

  private play(owner: AbortSignal, profileId: string, args: Record<string, unknown>) {
    const from = bounded(args.fromSecondsAgo, 60, 60, "fromSecondsAgo");
    const to = bounded(args.toSecondsAgo, 0, 60, "toSecondsAgo");
    const frameCount = bounded(args.frameCount, 4, 4, "frameCount");
    if (from <= to) throw new Error("fromSecondsAgo must be greater than toSecondsAgo");
    if (!Number.isInteger(frameCount)) throw new Error("frameCount must be an integer");
    const capture = this.retained(owner, profileId, args.tabId);
    const now = this.clock();
    const frames = capture.frames.filter(frame => frame.at >= now - from * 1000 && frame.at <= now - to * 1000);
    return {
      ...this.status(capture), requested: { fromSecondsAgo: from, toSecondsAgo: to },
      availableFrom: capture.frames[0] ? this.iso(capture.frames[0].at) : null,
      availableTo: capture.frames.length ? this.iso(capture.frames.at(-1)!.at) : null,
      earlyEvictions: capture.earlyEvictions, oversizedFrames: capture.oversizedFrames, ...this.clip(capture, frames, now, frameCount),
    };
  }

  private clip(capture: Capture, frames: Frame[], now: number, frameCount: number, focus?: number) {
    const first = frames[0], last = frames.at(-1);
    if (!first || !last) return { frameTotal: 0, message: "There are no retained frames in this range yet." };
    const nearest = focus === undefined ? undefined : frames.reduce((best, frame) =>
      Math.abs(frame.at - focus) < Math.abs(best.at - focus) ? frame : best);
    const changes = frames.filter((frame, index) => frame.viewport && !sameViewport(frame.viewport, frames[index - 1]?.viewport));
    const count = Math.min(frameCount, frames.length);
    const samples = [];
    let sampleBytes = 0;
    const chosen = new Set<Frame>();
    if (nearest && count) chosen.add(nearest);
    for (let i = 0; i < count && chosen.size < count; i++) {
      const index = count === 1 ? Math.floor((frames.length - 1) / 2) : Math.round(i * (frames.length - 1) / (count - 1));
      chosen.add(frames[index]!);
    }
    for (const frame of chosen) {
      if (sampleBytes + frame.jpeg.byteLength > MAX_SAMPLE_BYTES) continue;
      samples.push({ capturedAt: this.iso(frame.at), secondsAgo: (now - frame.at) / 1000, viewport: frame.viewport, data: frame.jpeg.toString("base64") });
      sampleBytes += frame.jpeg.byteLength;
    }
    const token = randomUUID();
    if (capture.links.size >= MAX_LINKS_PER_CAPTURE) {
      const oldest = capture.links.values().next().value!;
      this.clips.delete(oldest);
      capture.links.delete(oldest);
    }
    const expires = last.at + RETENTION_MS;
    capture.links.add(token);
    this.clips.set(token, { capture, firstId: first.id, lastId: last.id, start: first.at, expires, focusId: nearest?.id });
    return { frameTotal: frames.length, playbackUrl: this.playbackOrigin() + BROWSER_REPLAY_PATH + "#" + token, expiresAt: this.iso(expires),
      focusOffsetMs: nearest ? Math.round(nearest.at - first.at) : undefined,
      viewportChanges: changes.map(frame => ({ capturedAt: this.iso(frame.at), offsetMs: Math.round(frame.at - first.at), ...frame.viewport })), samples };
  }

  /** A link selects existing frames. It never extends the lifetime of their pixels. */
  read(token: string | undefined, frameId?: number) {
    const clip = token && this.clips.get(token);
    if (!clip || !this.available(clip.capture)) return null;
    const now = this.clock();
    this.prune(clip.capture, now);
    if (frameId !== undefined) {
      if (frameId < clip.firstId || frameId > clip.lastId) return null;
      return clip.capture.frames.find(frame => frame.id === frameId)?.jpeg ?? null;
    }
    const frames = clip.capture.frames.filter(frame => frame.id >= clip.firstId && frame.id <= clip.lastId);
    if (!frames.length) return null;
    return frames.map(frame => ({ id: frame.id, offsetMs: Math.round(frame.at - clip.start), remainingMs: Math.floor(frame.at + RETENTION_MS - now),
      ...(frame.viewport ? { viewport: frame.viewport } : {}), ...(clip.focusId === frame.id ? { focus: true } : {}) }));
  }
}

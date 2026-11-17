import { randomUUID } from "node:crypto";
import type { WorkbenchAdapter, WorkbenchFrame } from "./workbench-protocol.ts";

export const BROWSER_REPLAY_PATH = "/ui/replay";
const RETENTION_MS = 60_000;
const FRAME_INTERVAL_MS = 160;
const MAX_FRAME_BYTES = 512 * 1024;
// Leave room for base64 and JSON within the agent connection's 1 MiB message limit.
const MAX_SAMPLE_BYTES = 640 * 1024;
const MAX_CAPTURE_BYTES = 24 * 1024 * 1024;
const MAX_CAPTURES = 4;
const MAX_LINKS_PER_CAPTURE = 16;
const STREAM_OPTIONS = { maxWidth: 960, maxHeight: 960, quality: 62, minInterval: FRAME_INTERVAL_MS };

interface ReplaySource {
  adapter: Pick<WorkbenchAdapter, "tabs" | "select" | "stream" | "frame" | "dispose">;
  current(): boolean;
}

interface Frame {
  id: number;
  at: number;
  jpeg: Buffer<ArrayBuffer>;
}

interface Capture {
  owner: AbortSignal;
  profileId: string;
  allowed(): boolean;
  onAbort(): void;
  source?: ReplaySource;
  tabId?: string;
  stopStream?: () => Promise<void>;
  endsAt?: number;
  deadline?: ReturnType<typeof setTimeout>;
  ended: boolean;
  stopped: boolean;
  frames: Frame[];
  bytes: number;
  nextId: number;
  lastFrameAt: number;
  lastCheck: number;
  earlyEvictions: number;
  oversizedFrames: number;
  poll?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
  links: Set<string>;
}

interface Clip {
  capture: Capture;
  firstId: number;
  lastId: number;
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
    if (args.action !== "play") throw new Error("Choose replay action tabs, start, play or stop");
    return this.play(owner, profileId, args);
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
      frames: [], bytes: 0, nextId: 0, lastFrameAt: -Infinity, lastCheck: this.clock(),
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
      capture.endsAt = this.clock() + durationMs;
      capture.deadline = setTimeout(() => this.finish(capture), durationMs).unref();
      const stop = await source.adapter.stream?.(STREAM_OPTIONS, frame => this.append(capture, frame)).catch(() => undefined);
      if (!this.available(capture)) {
        await stop?.().catch(() => {});
        throw new Error("The browser session changed");
      }
      if (capture.ended) await stop?.().catch(() => {});
      else capture.stopStream = stop;
      this.schedulePoll(capture, 0);
      return this.status(capture);
    } catch (error) {
      this.discard(capture);
      throw error;
    }
  }

  private status(capture: Capture) {
    return { profileId: capture.profileId, tabId: capture.tabId, active: !capture.ended,
      captureEndsAt: this.iso(capture.endsAt!), retentionSeconds: RETENTION_MS / 1000 };
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
    for (const token of capture.links) this.clips.delete(token);
    capture.links.clear();
    void (async () => {
      try { await this.stopFrames(capture); }
      finally { await capture.source?.adapter.dispose(); }
    })().catch(() => {});
  }

  private async stopFrames(capture: Capture): Promise<void> {
    const stop = capture.stopStream;
    capture.stopStream = undefined;
    await stop?.().catch(() => {});
  }

  private finish(capture: Capture): void {
    if (capture.stopped || capture.ended) return;
    capture.ended = true;
    if (!capture.frames.length) this.discard(capture);
    else void this.stopFrames(capture);
  }

  private prune(capture: Capture, now: number): void {
    while (capture.frames.length && capture.frames[0]!.at + RETENTION_MS <= now) {
      capture.bytes -= capture.frames.shift()!.jpeg.byteLength;
    }
    for (const token of capture.links) {
      if (this.clips.get(token)!.expires > now) continue;
      this.clips.delete(token);
      capture.links.delete(token);
    }
  }

  private scheduleExpiry(capture: Capture): void {
    const first = capture.frames[0];
    if (!first || capture.expiry) return;
    capture.expiry = setTimeout(() => {
      capture.expiry = undefined;
      this.prune(capture, this.clock());
      if (capture.ended && !capture.frames.length) { this.discard(capture); return; }
      this.scheduleExpiry(capture);
    }, Math.max(1, Math.ceil(first.at + RETENTION_MS - this.clock()))).unref();
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
    capture.frames.push({ id: ++capture.nextId, at: now, jpeg });
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

  private play(owner: AbortSignal, profileId: string, args: Record<string, unknown>) {
    const from = bounded(args.fromSecondsAgo, 60, 60, "fromSecondsAgo");
    const to = bounded(args.toSecondsAgo, 0, 60, "toSecondsAgo");
    const frameCount = bounded(args.frameCount, 4, 4, "frameCount");
    if (from <= to) throw new Error("fromSecondsAgo must be greater than toSecondsAgo");
    if (!Number.isInteger(frameCount)) throw new Error("frameCount must be an integer");
    const capture = this.captures.get(profileId);
    if (!capture || capture.owner !== owner || !capture.tabId || !this.available(capture)
      || (args.tabId !== undefined && args.tabId !== capture.tabId)) throw new Error("Start a replay for this tab on this MCP connection first");
    const now = this.clock();
    this.prune(capture, now);
    const frames = capture.frames.filter(frame => frame.at >= now - from * 1000 && frame.at <= now - to * 1000);
    const first = frames[0], last = frames.at(-1);
    const info = {
      ...this.status(capture), requested: { fromSecondsAgo: from, toSecondsAgo: to },
      availableFrom: capture.frames[0] ? this.iso(capture.frames[0].at) : null,
      availableTo: capture.frames.length ? this.iso(capture.frames.at(-1)!.at) : null,
      frameTotal: frames.length, earlyEvictions: capture.earlyEvictions, oversizedFrames: capture.oversizedFrames,
    };
    if (!first || !last) return { ...info, message: "There are no retained frames in this range yet." };
    const count = Math.min(frameCount, frames.length);
    const samples = [];
    let sampleBytes = 0;
    for (let i = 0; i < count; i++) {
      const index = count === 1 ? Math.floor((frames.length - 1) / 2) : Math.round(i * (frames.length - 1) / (count - 1));
      const frame = frames[index]!;
      if (sampleBytes + frame.jpeg.byteLength > MAX_SAMPLE_BYTES) continue;
      samples.push({ capturedAt: this.iso(frame.at), secondsAgo: (now - frame.at) / 1000, data: frame.jpeg.toString("base64") });
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
    this.clips.set(token, { capture, firstId: first.id, lastId: last.id, start: first.at, expires });
    return { ...info, playbackUrl: this.playbackOrigin() + BROWSER_REPLAY_PATH + "#" + token, expiresAt: this.iso(expires), samples };
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
    return frames.map(frame => ({ id: frame.id, offsetMs: Math.round(frame.at - clip.start), remainingMs: Math.floor(frame.at + RETENTION_MS - now) }));
  }
}

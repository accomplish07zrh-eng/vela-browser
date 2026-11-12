import { createHash, timingSafeEqual } from "node:crypto";
import type { ActivityLog } from "./cooling.ts";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { LaunchInfo } from "./types.ts";
import { callWebKitOwner } from "./webkit-runtime.ts";
import { callFirefoxOwner } from "./firefox-runtime.ts";
import { CdpWorkbench } from "./workbench-cdp.ts";
import { validWorkbenchInput, workbenchFrameInterval, workbenchFrameWidth, workbenchStreamInterval, type WorkbenchRefreshTier, type WorkbenchAdapter, type WorkbenchFrame, type WorkbenchInput, type WorkbenchStreamOptions, type WorkbenchTab } from "./workbench-protocol.ts";

export const WORKBENCH_PATH = "/ui/api/workbench/connect";
export const WORKBENCH_PROTOCOL = "vela-workbench-v1";
export function validWorkbenchAuthorization(req: Request, nonce: string): boolean {
  if (req.headers.get("origin") !== new URL(req.url).origin) return false;
  const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map((part) => part.trim()) ?? [];
  const supplied = protocols.find((part) => part.startsWith("vela-capability."))?.slice(16) ?? "";
  return protocols.includes(WORKBENCH_PROTOCOL) && /^[a-f0-9]{64}$/.test(supplied) && supplied.length === nonce.length
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(nonce));
}

export function workbenchGeneration(launch: LaunchInfo): string {
  return createHash("sha256").update(JSON.stringify([launch.profileId, launch.pid, launch.startedAt, launch.ws, launch.firefoxOwner?.generation, launch.webkitOwner?.generation])).digest("hex").slice(0, 24);
}

class ContextAdapter implements WorkbenchAdapter {
  private target = "";
  constructor(private owner: NonNullable<LaunchInfo["firefoxOwner"]>, private call = callFirefoxOwner) {}
  private run<T>(action: string, payload: object = {}): Promise<T> {
    return this.call<T>(this.owner, "workbench", { action, targetId: this.target, ...payload }, { timeoutMs: 3500 });
  }
  tabs(): Promise<WorkbenchTab[]> { return this.run("tabs"); }
  async select(targetId: string): Promise<void> { await this.run("select", { targetId }); this.target = targetId; }
  newTab(): Promise<string> { return this.run("new"); }
  closeTab(targetId: string): Promise<void> { return this.run("close", { targetId }); }
  frame(focused: boolean): Promise<WorkbenchFrame> { return this.run("frame", { focused }); }
  /** The owner answers each request as soon as the page paints a newer frame, so this is a push in all but name. */
  async stream(options: WorkbenchStreamOptions, onFrame: (frame: WorkbenchFrame) => void, onPointer?: (pointer: WorkbenchPointer) => void): Promise<() => Promise<void>> {
    const targetId = this.target;
    let active = true, since = 0;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // The owner's humanizer reports its pointer with the frames, for the card to draw.
    const pointers = (answer: any) => { for (const pointer of Array.isArray(answer?.pointer) ? answer.pointer : []) if (validWorkbenchPointer(pointer)) onPointer?.(pointer); };
    // The first answer must be a frame, or the caller falls back to polling.
    const first = await this.call<any>(this.owner, "workbench", { action: "frame", targetId, stream: true, since, wait: 1000, ...options }, { timeoutMs: 3500 });
    if (!first?.data) throw new Error("No live frames for this tab");
    since = first.seq; onFrame({ data: first.data, width: first.width, height: first.height }); pointers(first);
    void (async () => {
      while (active && this.target === targetId) {
        const started = Date.now();
        try {
          const next = await this.call<any>(this.owner, "workbench", { action: "frame", targetId, stream: true, since, wait: 1500, ...options }, { timeoutMs: 3500 });
          if (!active) break;
          pointers(next);
          if (next?.data && next.seq > since) { since = next.seq; onFrame({ data: next.data, width: next.width, height: next.height }); }
        } catch { if (active) await sleep(500); }
        const rest = options.minInterval - (Date.now() - started);
        if (rest > 0 && active) await sleep(rest);
      }
    })();
    return async () => { active = false; await this.run("stop-stream").catch(() => {}); };
  }
  viewport(): Promise<{ width: number; height: number }> { return this.run("viewport"); }
  async input(input: WorkbenchInput): Promise<void> { await this.run("input", { input }); }
  dispose(): void { /* The owner and its persistent context belong to the launcher. */ }
}

export interface WorkbenchPointer { x: number; y: number; phase: "move" | "down" | "up" }
export function validWorkbenchPointer(value: unknown): value is WorkbenchPointer {
  const v = value as WorkbenchPointer;
  return !!v && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.y) && Math.abs(v.x) <= 32_768 && Math.abs(v.y) <= 32_768
    && ["move", "down", "up"].includes(v.phase);
}

export class WorkbenchHub {
  private captures = 0;
  private live = new Map<string, Set<WorkbenchConnection>>();
  /** The AI's human-like pointer in this browser, to draw over its card; never drawn in the page. */
  pointer(profileId: string, pointer: WorkbenchPointer): void {
    for (const connection of this.live.get(profileId) ?? []) connection.showPointer(pointer);
  }
  attach(connection: WorkbenchConnection): void {
    let set = this.live.get(connection.profileId);
    if (!set) this.live.set(connection.profileId, set = new Set());
    set.add(connection);
  }
  detach(connection: WorkbenchConnection): void {
    const set = this.live.get(connection.profileId);
    if (!set) return;
    set.delete(connection);
    if (!set.size) this.live.delete(connection.profileId);
  }
  constructor(readonly options: {
    launcher: Launcher; store: ProfileStore;
    canControl?: (id: string) => boolean | Promise<boolean>;
    adapter?: (launch: LaunchInfo) => WorkbenchAdapter;
    /** Input and focus here count as the user working in that browser, so it is never cooled meanwhile. */
    activity?: ActivityLog;
  }) {}
  // Polled frames are scaled to their card, so more of them can be in flight at once.
  acquireFrame(): boolean { if (this.captures >= 6) return false; this.captures++; return true; }
  releaseFrame(): void { this.captures--; }
  async connect(id: string): Promise<WorkbenchConnection> {
    if (!this.options.store.getProfile(id) || !await this.allowed(id) || !await this.options.launcher.certifiedActive(id)) throw new Error("Environment is unavailable");
    const launch = this.options.store.getLaunch(id);
    if (!launch || (launch.engine === "firefox" && !launch.firefoxOwner) || (launch?.engine === "webkit" && !launch.webkitOwner)) throw new Error("Environment is unavailable");
    const adapter = this.options.adapter?.(launch) ?? (launch.engine === "webkit" ? new ContextAdapter(launch.webkitOwner!, callWebKitOwner) : launch.engine === "firefox" ? new ContextAdapter(launch.firefoxOwner!) : new CdpWorkbench(launch.ws));
    return new WorkbenchConnection(this, launch, adapter);
  }
  allowed(id: string): boolean | Promise<boolean> { return this.options.canControl?.(id) ?? true; }
}

/** A lease owns only display/control resources, never the managed browser. */
export class WorkbenchConnection {
  readonly generation: string;
  readonly profileId: string;
  private targetId = "";
  private visible = false;
  private focused = false;
  private tier: WorkbenchRefreshTier = "hidden";
  private frozen = false;
  private following = false;
  private captureEpoch = 0;
  private capturing = false;
  private disposed = false;
  private queue = Promise.resolve();
  private queued = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private emit: (value: object) => void = () => {};
  private keys = new Map<string, Extract<WorkbenchInput, { kind: "key" }>>();
  private pointer?: Extract<WorkbenchInput, { kind: "pointer" }>;
  private tabsSignature = "";
  private releaseFocus?: () => void;
  /** Device-pixel width of the card, so frames arrive at the size they are shown. */
  private frameWidth?: number;
  private streamKey = "";
  private stopStream?: () => Promise<void>;
  private streaming = false;
  private lastStreamFrame = 0;
  /** Tabs that sent no live frame (a tab the browser is not painting): they are polled instead. */
  private polledTargets = new Set<string>();
  private streamChange = Promise.resolve();

  constructor(private hub: WorkbenchHub, launch: LaunchInfo, private adapter: WorkbenchAdapter) {
    this.generation = workbenchGeneration(launch); this.profileId = launch.profileId;
  }
  private current(): boolean {
    const launch = this.hub.options.store.getLaunch(this.profileId);
    return !!launch && workbenchGeneration(launch) === this.generation;
  }
  private send(value: object): void {
    if (!this.disposed && this.current()) this.emit({ ...value, profileId: this.profileId, generation: this.generation });
  }
  showPointer(pointer: WorkbenchPointer): void {
    if (this.visible || this.following) this.send({ type: "pointer", targetId: this.targetId, x: pointer.x, y: pointer.y, phase: pointer.phase });
  }
  async start(emit: (value: object) => void): Promise<void> {
    this.emit = emit;
    if (this.disposed || !this.current()) return;
    this.hub.attach(this);
    try {
      const tabs = await this.adapter.tabs();
      if (!tabs.length) throw new Error("No open tabs");
      await this.adapter.select(tabs[0]!.id);
      if (this.disposed) return;
      this.targetId = tabs[0]!.id; this.tabsSignature = JSON.stringify(tabs);
      const viewport = await this.adapter.viewport?.().catch(() => undefined);
      this.send({ type: "ready", targetId: this.targetId, tabs, viewport });
      this.heartbeat = setInterval(() => { void this.enqueue({ action: "refresh", generation: this.generation }); }, 2000);
      this.schedule();
    } catch { this.send({ type: "error", error: "Browser connection lost. Reconnect to try again." }); await this.dispose(); }
  }
  private schedule(elapsed = 0): void {
    clearTimeout(this.frameTimer);
    const polled = workbenchFrameInterval(this.tier);
    // While a stream pushes frames, polling only checks every two seconds that it has not fallen silent.
    const interval = polled && this.streaming ? Math.max(polled, 2000) : polled;
    if (!this.disposed && !this.capturing && !this.frozen && interval) this.frameTimer = setTimeout(() => void this.capture(), Math.max(16, interval - elapsed));
  }
  private async capture(): Promise<void> {
    if (this.disposed) return;
    if (!this.current()) { this.emit({ type: "ended", profileId: this.profileId, generation: this.generation }); await this.dispose(); return; }
    // A live stream is pushing frames; polling would only repeat them. A browser that is minimized or
    // covered stops painting, so its stream falls silent: then a scaled capture every two seconds
    // keeps its card current.
    if (this.streaming && performance.now() - this.lastStreamFrame < 2000) { this.schedule(); return; }
    if (!this.visible || this.frozen || !this.targetId || !this.hub.acquireFrame()) { this.schedule(); return; }
    const targetId = this.targetId, epoch = this.captureEpoch, started = performance.now();
    this.capturing = true;
    try {
      const frame = await this.adapter.frame(this.focused, this.frameWidth);
      if (targetId === this.targetId && this.visible && !this.frozen && epoch === this.captureEpoch) this.send({ type: "frame", targetId, ...frame });
    } catch { this.send({ type: "frame-error", targetId, error: "Waiting for the browser…" }); }
    finally { this.capturing = false; this.hub.releaseFrame(); this.schedule(performance.now() - started); }
  }
  enqueue(message: unknown): Promise<void> {
    if (this.disposed || this.queued >= 128) return Promise.resolve();
    this.queued++;
    const run = this.queue.then(() => this.handle(message));
    this.queue = run.catch(() => { this.send({ type: "error", error: "Browser operation failed. Reconnect to try again." }); }).finally(() => { this.queued--; });
    return this.queue;
  }
  private async handle(value: unknown): Promise<void> {
    const message = value as Record<string, any>;
    if (this.disposed) return;
    const allowed = !!message && message.generation === this.generation && this.current() && await this.hub.allowed(this.profileId);
    if (this.disposed) return;
    if (!allowed || !this.current()) {
      this.emit({ type: "ended", profileId: this.profileId, generation: this.generation }); await this.dispose(); return;
    }
    if (message.action === "visibility") {
      this.visible = message.visible === true; this.focused = message.focused === true;
      this.tier = this.visible ? message.tier === "edge" ? "edge" : message.tier === "interactive" || this.focused ? "interactive" : "visible" : "hidden";
      this.frozen = message.frozen === true; this.following = message.following === true;
      this.frameWidth = workbenchFrameWidth(message.width);
      if (this.focused && !this.releaseFocus) this.releaseFocus = this.hub.options.activity?.hold(this.profileId);
      else if (!this.focused) { this.releaseFocus?.(); this.releaseFocus = undefined; }
      this.captureEpoch++;
      if (!this.visible && !this.following) await this.releaseInput();
      this.syncStream();
      this.schedule();
      return;
    }
    if (message.action === "release") { await this.releaseInput(); return; }
    if (message.action === "input") {
      if ((!this.visible && !this.following) || message.targetId !== this.targetId || !validWorkbenchInput(message.input)) return;
      const input: WorkbenchInput = message.input;
      this.hub.options.activity?.touch(this.profileId);
      if (input.kind === "key") { if (input.event === "down") this.keys.set(input.code, input); else this.keys.delete(input.code); }
      if (input.kind === "pointer") this.pointer = input.buttons ? input : undefined;
      await this.adapter.input(input); return;
    }
    if (!["refresh", "select", "new", "close"].includes(message.action)) return;
    if (message.action !== "refresh") { await this.releaseInput(); this.hub.options.activity?.touch(this.profileId); }
    if (message.action === "new") { const id = await this.adapter.newTab(); await this.adapter.select(id); this.targetId = id; }
    if (message.action === "select") {
      if (typeof message.targetId !== "string") return;
      await this.adapter.select(message.targetId); this.targetId = message.targetId;
    }
    if (message.action === "close") {
      if (typeof message.targetId !== "string") return;
      await this.adapter.closeTab(message.targetId);
    }
    const tabs = await this.adapter.tabs();
    if (!tabs.length) { this.targetId = ""; this.send({ type: "tabs", tabs, targetId: "" }); return; }
    if (!tabs.some((tab) => tab.id === this.targetId)) { await this.releaseInput(); this.targetId = tabs[0]!.id; await this.adapter.select(this.targetId); }
    this.syncStream();
    const signature = JSON.stringify(tabs);
    if (signature !== this.tabsSignature || message.action !== "refresh") {
      const viewport = await this.adapter.viewport?.().catch(() => undefined);
      this.tabsSignature = signature; this.send({ type: "tabs", tabs, targetId: this.targetId, viewport });
    }
  }
  /**
   * Keeps one live stream matching what the card shows: its tab, refresh tier and width. Streams
   * stop while the card is hidden or the wall is being moved, and resume where they were.
   */
  private syncStream(): void {
    const adapter = this.adapter;
    const want = !!adapter.stream && this.visible && !this.frozen && !!this.targetId && !this.disposed && !this.polledTargets.has(this.targetId);
    const key = want ? JSON.stringify([this.targetId, this.tier, this.frameWidth]) : "";
    if (key === this.streamKey) return;
    this.streamKey = key;
    const targetId = this.targetId, tier = this.tier, epoch = ++this.captureEpoch;
    this.streamChange = this.streamChange.then(async () => {
      const stop = this.stopStream; this.stopStream = undefined; this.streaming = false;
      await stop?.().catch(() => {});
      if (!key || this.streamKey !== key || this.disposed) return;
      const options: WorkbenchStreamOptions = { quality: tier === "interactive" ? 80 : 65, minInterval: workbenchStreamInterval(tier), ...(this.frameWidth ? { maxWidth: this.frameWidth } : {}) };
      let received = false;
      const onFrame = (frame: WorkbenchFrame) => {
        received = true; this.lastStreamFrame = performance.now();
        if (targetId === this.targetId && this.visible && !this.frozen && this.streamKey === key && frame.width > 0) this.send({ type: "frame", targetId, ...frame });
      };
      try {
        const stop = await adapter.stream!(options, onFrame, (pointer) => this.showPointer(pointer));
        if (this.streamKey !== key || this.disposed) { await stop().catch(() => {}); return; }
        this.stopStream = stop; this.streaming = true;
        // A tab the browser is not painting sends nothing: show it by polling instead.
        setTimeout(() => {
          if (received || this.streamKey !== key || this.disposed) return;
          // A key that matches nothing makes syncStream stop this stream rather than keep it.
          this.polledTargets.add(targetId); this.streamKey = "stalled"; this.syncStream(); this.schedule();
        }, 1200);
      } catch {
        if (this.streamKey === key && epoch <= this.captureEpoch) { this.polledTargets.add(targetId); this.streamKey = ""; this.schedule(); }
      }
    }).catch(() => {});
  }
  private async releaseInput(): Promise<void> {
    for (const key of this.keys.values()) await this.adapter.input({ ...key, event: "up", modifiers: 0 }).catch(() => {});
    this.keys.clear();
    if (this.pointer) await this.adapter.input({ ...this.pointer, event: "up", buttons: 0 }).catch(() => {});
    this.pointer = undefined;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.frameTimer); clearInterval(this.heartbeat);
    this.hub.detach(this);
    this.streamKey = ""; this.streaming = false;
    const stop = this.stopStream; this.stopStream = undefined; await stop?.().catch(() => {});
    this.releaseFocus?.(); this.releaseFocus = undefined;
    await this.releaseInput(); await this.adapter.dispose();
  }
}

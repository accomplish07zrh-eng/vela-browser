import { createHash, timingSafeEqual } from "node:crypto";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { LaunchInfo } from "./types.ts";
import { callWebKitOwner } from "./webkit-runtime.ts";
import { callFirefoxOwner } from "./firefox-runtime.ts";
import { CdpWorkbench } from "./workbench-cdp.ts";
import { validWorkbenchInput, workbenchFrameInterval, type WorkbenchRefreshTier, type WorkbenchAdapter, type WorkbenchFrame, type WorkbenchInput, type WorkbenchTab } from "./workbench-protocol.ts";

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
  viewport(): Promise<{ width: number; height: number }> { return this.run("viewport"); }
  async input(input: WorkbenchInput): Promise<void> { await this.run("input", { input }); }
  dispose(): void { /* The owner and its persistent context belong to the launcher. */ }
}

export class WorkbenchHub {
  private captures = 0;
  constructor(readonly options: {
    launcher: Launcher; store: ProfileStore;
    canControl?: (id: string) => boolean | Promise<boolean>;
    adapter?: (launch: LaunchInfo) => WorkbenchAdapter;
  }) {}
  acquireFrame(): boolean { if (this.captures >= 3) return false; this.captures++; return true; }
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
  async start(emit: (value: object) => void): Promise<void> {
    this.emit = emit;
    if (this.disposed || !this.current()) return;
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
    const interval = workbenchFrameInterval(this.tier);
    if (!this.disposed && !this.capturing && !this.frozen && interval) this.frameTimer = setTimeout(() => void this.capture(), Math.max(16, interval - elapsed));
  }
  private async capture(): Promise<void> {
    if (this.disposed) return;
    if (!this.current()) { this.emit({ type: "ended", profileId: this.profileId, generation: this.generation }); await this.dispose(); return; }
    if (!this.visible || this.frozen || !this.targetId || !this.hub.acquireFrame()) { this.schedule(); return; }
    const targetId = this.targetId, epoch = this.captureEpoch, started = performance.now();
    this.capturing = true;
    try {
      const frame = await this.adapter.frame(this.focused);
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
      this.captureEpoch++;
      if (!this.visible && !this.following) await this.releaseInput();
      this.schedule();
      return;
    }
    if (message.action === "release") { await this.releaseInput(); return; }
    if (message.action === "input") {
      if ((!this.visible && !this.following) || message.targetId !== this.targetId || !validWorkbenchInput(message.input)) return;
      const input: WorkbenchInput = message.input;
      if (input.kind === "key") { if (input.event === "down") this.keys.set(input.code, input); else this.keys.delete(input.code); }
      if (input.kind === "pointer") this.pointer = input.buttons ? input : undefined;
      await this.adapter.input(input); return;
    }
    if (!["refresh", "select", "new", "close"].includes(message.action)) return;
    if (message.action !== "refresh") await this.releaseInput();
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
    const signature = JSON.stringify(tabs);
    if (signature !== this.tabsSignature || message.action !== "refresh") {
      const viewport = await this.adapter.viewport?.().catch(() => undefined);
      this.tabsSignature = signature; this.send({ type: "tabs", tabs, targetId: this.targetId, viewport });
    }
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
    await this.releaseInput(); await this.adapter.dispose();
  }
}

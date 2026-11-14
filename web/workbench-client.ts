import type { WorkbenchInput, WorkbenchTab, WorkbenchRefreshTier } from "../src/workbench-protocol.ts";

export interface ViewportState {
  status: "connecting" | "live" | "paused" | "error" | "ended";
  generation: string; targetId: string; tabs: WorkbenchTab[];
  frame?: { data: string; width: number; height: number };
  viewport?: { width: number; height: number };
  error?: string;
}

/** The UI only receives a local display lease; browser credentials stay in the sidecar. */
export class ViewportClient {
  private socket?: WebSocket;
  private disposed = false;
  private visible = false;
  private focused = false;
  private tier: WorkbenchRefreshTier = "hidden";
  private frozen = false;
  private following = false;
  private presentation = "";
  private width?: number;
  /** Reconnect attempts since the last good connection, and the one that is waiting. */
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The AI's pointer goes straight to whoever draws it, outside React, many times a second. */
  readonly pointerListeners = new Set<(pointer: { x: number; y: number; phase: "move" | "down" | "up"; agent?: string }) => void>();
  private state: ViewportState = { status: "connecting", generation: "", targetId: "", tabs: [] };
  constructor(private profileId: string, private update: (state: ViewportState) => void) { void this.connect(); }
  private publish(change: Partial<ViewportState>): void { if (!this.disposed) { this.state = { ...this.state, ...change }; this.update(this.state); } }
  private async connect(): Promise<void> {
    try {
      const invoke = (window as any).__TAURI_INTERNALS__?.invoke as ((command: string) => Promise<unknown>) | undefined;
      if (!invoke) throw new Error("Open the desktop app to use the workbench.");
      const capability = await invoke("workbench_capability");
      if (this.disposed) return;
      if (typeof capability !== "string" || !/^[a-f0-9]{64}$/.test(capability)) throw new Error("Workbench authorization failed");
      const url = new URL("/ui/api/workbench/connect", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("profileId", this.profileId);
      const socket = this.socket = new WebSocket(url, ["vela-workbench-v1", `vela-capability.${capability}`]);
      socket.onmessage = (event) => {
        if (this.disposed) return;
        let message: any;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.profileId !== this.profileId) return;
        if (message.type === "ready") {
          this.publish({ status: this.visible ? "live" : "paused", generation: message.generation, targetId: message.targetId, tabs: message.tabs, viewport: message.viewport, error: undefined });
          this.retries = 0;
          this.presentation = ""; this.activity(this.tier, this.frozen, this.following, this.width); return;
        }
        if (message.type === "error" && !this.state.generation) { this.publish({ status: "error", error: message.error }); return; }
        if (message.generation !== this.state.generation) return;
        if (message.type === "tabs") this.publish({ tabs: message.tabs, targetId: message.targetId, viewport: message.viewport, ...(message.targetId !== this.state.targetId ? { frame: undefined } : {}) });
        if (message.type === "frame" && message.targetId === this.state.targetId && !this.frozen && this.visible) this.publish({ status: "live", viewport: { width: message.width, height: message.height }, frame: { data: message.data, width: message.width, height: message.height }, error: undefined });
        if (message.type === "error") this.publish({ status: "error", error: message.error });
        if (message.type === "ended") { this.publish({ status: "ended", error: "This environment has stopped or restarted." }); socket.close(); }
        if (message.type === "frame-error" && !this.state.frame) this.publish({ error: message.error });
        if (message.type === "pointer" && (!message.targetId || message.targetId === this.state.targetId)) {
          const agent = typeof message.agent === "string" && message.agent ? message.agent.slice(0, 24) : undefined;
          for (const listener of this.pointerListeners) listener({ x: message.x, y: message.y, phase: message.phase, agent });
        }
      };
      // A dropped connection to a browser that is still open comes back by itself.
      socket.onerror = () => this.lost(socket);
      socket.onclose = () => this.lost(socket);
    } catch (error) { this.publish({ status: "error", error: error instanceof Error ? error.message : String(error) }); }
  }
  command(action: string, extra: object = {}): void {
    if (!this.disposed && this.socket?.readyState === WebSocket.OPEN && this.state.generation) {
      this.socket.send(JSON.stringify({ action, generation: this.state.generation, targetId: this.state.targetId, ...extra }));
    }
  }
  input(input: WorkbenchInput): void { this.command("input", { input }); }
  visibility(visible: boolean, focused: boolean): void {
    this.activity(visible ? focused ? "interactive" : "visible" : "hidden");
  }
  /** width: the card's width in device pixels, rounded so small resizes send nothing. */
  activity(tier: WorkbenchRefreshTier, frozen = false, following = false, width?: number): void {
    this.tier = tier; this.frozen = frozen; this.following = following;
    this.visible = tier !== "hidden"; this.focused = tier === "interactive";
    const step = width && width > 0 ? Math.ceil(width / 64) * 64 : undefined;
    if (step !== undefined) this.width = step;
    const signature = JSON.stringify([tier, frozen, following, this.width]);
    if (signature !== this.presentation && this.state.generation) {
      this.presentation = signature;
      this.command("visibility", { visible: this.visible, focused: this.focused, tier, frozen, following, ...(this.width ? { width: this.width } : {}) });
    }
    if (!this.visible && this.state.status === "live") this.publish({ status: "paused" });
  }
  /**
   * The connection dropped while the browser is still open (the app was busy, the computer slept,
   * the browser restarted): try again after 1, 2, 4, 8 and 15 seconds, then every 30. A browser that
   * stopped says so itself ("ended") and is not retried.
   */
  private lost(socket: WebSocket): void {
    if (this.disposed || socket !== this.socket || this.state.status === "ended") return;
    this.socket = undefined;
    const delay = [1000, 2000, 4000, 8000, 15000][this.retries] ?? 30000;
    this.retries++;
    this.publish({ status: "connecting", error: "Connection lost. Reconnecting…" });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.disposed) void this.connect(); }, delay);
  }
  release(): void { this.command("release"); }
  dispose(): void { this.release(); this.disposed = true; clearTimeout(this.retryTimer); this.socket?.close(); }
}

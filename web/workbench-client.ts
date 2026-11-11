import type { WorkbenchInput, WorkbenchTab, WorkbenchRefreshTier } from "../workbench-protocol.ts";

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
          this.presentation = ""; this.activity(this.tier, this.frozen, this.following); return;
        }
        if (message.type === "error" && !this.state.generation) { this.publish({ status: "error", error: message.error }); return; }
        if (message.generation !== this.state.generation) return;
        if (message.type === "tabs") this.publish({ tabs: message.tabs, targetId: message.targetId, viewport: message.viewport, ...(message.targetId !== this.state.targetId ? { frame: undefined } : {}) });
        if (message.type === "frame" && message.targetId === this.state.targetId && !this.frozen && this.visible) this.publish({ status: "live", viewport: { width: message.width, height: message.height }, frame: { data: message.data, width: message.width, height: message.height }, error: undefined });
        if (message.type === "error") this.publish({ status: "error", error: message.error });
        if (message.type === "ended") { this.publish({ status: "ended", error: "This environment has stopped or restarted." }); socket.close(); }
        if (message.type === "frame-error" && !this.state.frame) this.publish({ error: message.error });
      };
      socket.onerror = () => this.publish({ status: "error", error: "Browser connection lost. Reconnect to try again." });
      socket.onclose = () => { if (this.state.status !== "ended") this.publish({ status: "error", error: "Browser connection lost. Reconnect to try again." }); };
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
  activity(tier: WorkbenchRefreshTier, frozen = false, following = false): void {
    this.tier = tier; this.frozen = frozen; this.following = following;
    this.visible = tier !== "hidden"; this.focused = tier === "interactive";
    const signature = JSON.stringify([tier, frozen, following]);
    if (signature !== this.presentation && this.state.generation) {
      this.presentation = signature;
      this.command("visibility", { visible: this.visible, focused: this.focused, tier, frozen, following });
    }
    if (!this.visible && this.state.status === "live") this.publish({ status: "paused" });
  }
  release(): void { this.command("release"); }
  dispose(): void { this.release(); this.disposed = true; this.socket?.close(); }
}

import type { WorkbenchAdapter, WorkbenchFrame, WorkbenchInput, WorkbenchStreamOptions, WorkbenchTab } from "./workbench-protocol.ts";

interface LiveStream { session: string; onFrame(frame: WorkbenchFrame): void; minInterval: number; lastAck: number; stopped: boolean }

/** One control socket belongs to exactly one browser launch. */
export class CdpWorkbench implements WorkbenchAdapter {
  private socket: WebSocket;
  private ready: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private session?: string;
  private target?: string;
  private disposed = false;
  private live?: LiveStream;

  constructor(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Browser control must remain local");
    this.socket = new WebSocket(endpoint);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Browser connection timed out")); this.dispose(); }, 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed")); }, { once: true });
      this.socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Browser disconnected")); this.dispose(); }, { once: true });
    });
    this.ready.catch(() => {});
    this.socket.addEventListener("message", (event) => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.method === "Page.screencastFrame") { this.onScreencastFrame(message); return; }
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer); this.pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message || "Browser operation failed"));
      else call.resolve(message.result);
    });
  }

  private async send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    await this.ready;
    if (this.disposed) throw new Error("Browser disconnected");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Browser operation timed out")); }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("Browser disconnected")); }
    });
  }

  async tabs(): Promise<WorkbenchTab[]> {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.filter((tab: any) => tab.type === "page" && !tab.url.startsWith("devtools:"))
      .map((tab: any) => ({ id: tab.targetId, title: tab.title || tab.url || "New tab", url: tab.url }));
  }

  async select(targetId: string): Promise<void> {
    if (targetId === this.target && this.session) return;
    if (!(await this.tabs()).some((tab) => tab.id === targetId)) throw new Error("Tab no longer exists");
    const previous = this.session;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.stopStream();
    this.session = sessionId; this.target = targetId;
    if (previous) await this.send("Target.detachFromTarget", { sessionId: previous }).catch(() => {});
  }

  async newTab(): Promise<string> { return (await this.send("Target.createTarget", { url: "about:blank" })).targetId; }
  async closeTab(targetId: string): Promise<void> {
    if (!(await this.tabs()).some((tab) => tab.id === targetId)) throw new Error("Tab no longer exists");
    // Keep the environment alive when the last tab is closed from the workbench.
    if ((await this.tabs()).length === 1) await this.newTab();
    await this.send("Target.closeTarget", { targetId });
    if (this.target === targetId) { this.target = undefined; this.session = undefined; }
  }

  async frame(focused: boolean, maxWidth?: number): Promise<WorkbenchFrame> {
    if (!this.session) throw new Error("Select a tab first");
    const session = this.session;
    const metrics = await this.send("Page.getLayoutMetrics", {}, session);
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    // Captured at the size the card shows it, not the page's full size: far fewer bytes per frame.
    const scale = maxWidth && viewport.clientWidth > maxWidth ? maxWidth / viewport.clientWidth : undefined;
    const { data } = await this.send("Page.captureScreenshot", {
      format: "jpeg", quality: focused ? 85 : 65, fromSurface: true, captureBeyondViewport: false,
      ...(scale ? { clip: { x: viewport.pageX ?? 0, y: viewport.pageY ?? 0, width: viewport.clientWidth, height: viewport.clientHeight, scale } } : {}),
    }, session);
    return { data, width: viewport.clientWidth, height: viewport.clientHeight };
  }

  /**
   * Chromium's own screencast: the compositor pushes a frame whenever the page paints, already
   * scaled to the card. Nothing reaches the page. The next frame comes only after this one is
   * acknowledged, which is held back to the card's rate, so a busy wall never floods the app.
   */
  async stream(options: WorkbenchStreamOptions, onFrame: (frame: WorkbenchFrame) => void): Promise<() => Promise<void>> {
    if (!this.session) throw new Error("Select a tab first");
    const session = this.session;
    await this.stopStream();
    const live: LiveStream = { session, onFrame, minInterval: options.minInterval, lastAck: 0, stopped: false };
    this.live = live;
    await this.send("Page.startScreencast", {
      format: "jpeg", quality: options.quality, everyNthFrame: 1,
      ...(options.maxWidth ? { maxWidth: options.maxWidth, maxHeight: options.maxWidth * 4 } : {}),
    }, session);
    return async () => { if (this.live === live) await this.stopStream(); };
  }

  private async stopStream(): Promise<void> {
    const live = this.live;
    if (!live) return;
    live.stopped = true; this.live = undefined;
    await this.send("Page.stopScreencast", {}, live.session).catch(() => {});
  }

  private onScreencastFrame(message: any): void {
    const live = this.live, params = message.params;
    if (!live || live.stopped || message.sessionId !== live.session || !params) return;
    const metadata = params.metadata ?? {};
    live.onFrame({ data: params.data, width: Math.round(metadata.deviceWidth ?? 0), height: Math.round(metadata.deviceHeight ?? 0) });
    // Chromium keeps more than one frame in flight, so each acknowledgement takes the next free
    // slot one interval after the last: the card receives frames at its rate, not the page's.
    const at = Math.max(Date.now(), live.lastAck + live.minInterval);
    live.lastAck = at;
    setTimeout(() => {
      if (live.stopped || this.disposed) return;
      try { this.socket.send(JSON.stringify({ id: ++this.nextId, method: "Page.screencastFrameAck", params: { sessionId: params.sessionId }, sessionId: live.session })); } catch {}
    }, at - Date.now());
  }

  async viewport(): Promise<{ width: number; height: number }> {
    if (!this.session) throw new Error("Select a tab first");
    const metrics = await this.send("Page.getLayoutMetrics", {}, this.session);
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    return { width: viewport.clientWidth, height: viewport.clientHeight };
  }

  async input(input: WorkbenchInput): Promise<void> {
    if (!this.session) throw new Error("Select a tab first");
    const session = this.session;
    if (input.kind === "text") { await this.send("Input.insertText", { text: input.text }, session); return; }
    if (input.kind === "key") {
      await this.send("Input.dispatchKeyEvent", { type: input.event === "down" ? "rawKeyDown" : "keyUp", key: input.key, code: input.code,
        windowsVirtualKeyCode: input.keyCode, nativeVirtualKeyCode: input.keyCode, modifiers: input.modifiers }, session);
      return;
    }
    const params = input.kind === "wheel"
      ? { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy, modifiers: input.modifiers }
      : { type: { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[input.event], x: input.x, y: input.y,
        button: input.buttons || input.event !== "move" ? input.button : "none", buttons: input.buttons, clickCount: input.clicks, modifiers: input.modifiers };
    await this.send("Input.dispatchMouseEvent", params, session);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.live) { this.live.stopped = true; this.live = undefined; }
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("Browser disconnected")); }
    this.pending.clear();
    this.socket.close();
  }
}

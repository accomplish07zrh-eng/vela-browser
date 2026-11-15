import type { ScreenArea } from "./window-fit.ts";

/**
 * Phone mode of the phone app: the browser's real window is narrowed to a phone's width, so pages
 * lay out as they do on a phone, then given its old size back. Only the window changes, through
 * CDP's Browser.setWindowBounds. The viewport is never pinned, there is no device-metrics
 * override and the user agent stays the same: a pinned viewport draws the page in one corner of
 * the window, and innerWidth then disagrees with outerWidth, which sites read as automation.
 * The window stays inside the screen the profile claims.
 */
export const PHONE_WINDOW_WIDTH = 440;
export const PHONE_WINDOW_HEIGHT = 900;

export interface WindowBounds { left?: number; top?: number; width?: number; height?: number; windowState?: string }
type Cdp = (method: string, params?: Record<string, unknown>) => Promise<any>;

/** The phone-shaped window for `area`: never larger than the claimed screen, kept on it. */
export function phoneBounds(current: WindowBounds, area: ScreenArea): Required<Omit<WindowBounds, "windowState">> {
  const width = Math.min(PHONE_WINDOW_WIDTH, area.width);
  const height = Math.min(PHONE_WINDOW_HEIGHT, area.height);
  const left = Math.max(area.left, Math.min(current.left ?? area.left, area.left + area.width - width));
  const top = Math.max(area.top, Math.min(current.top ?? area.top, area.top + area.height - height));
  return { left, top, width, height };
}

/** One short CDP connection to a browser's endpoint: open, run, close. */
export async function withBrowserCdp<T>(ws: string, run: (cdp: Cdp) => Promise<T>, Socket: typeof WebSocket = WebSocket): Promise<T> {
  const socket = new Socket(ws);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 1;
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("The browser did not answer"));
  });
  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const call = pending.get(message?.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message ?? "CDP error")); else call.resolve(message.result);
  };
  socket.onclose = () => { for (const call of pending.values()) call.reject(new Error("The browser closed the connection")); pending.clear(); };
  const cdp: Cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 5000);
  });
  try { return await run(cdp); } finally { try { socket.close(); } catch { /* already closed */ } }
}

/** Remembers each window's size from before phone mode, per profile, so it can be given back. */
export class PhoneWindows {
  private saved = new Map<string, Array<{ windowId: number; bounds: WindowBounds }>>();
  constructor(private readonly connect: typeof withBrowserCdp = withBrowserCdp) {}

  isOn(profileId: string): boolean { return this.saved.has(profileId); }

  private async windows(cdp: Cdp): Promise<number[]> {
    const pages = ((await cdp("Target.getTargets"))?.targetInfos ?? []).filter((target: any) => target.type === "page" && !String(target.url).startsWith("chrome://"));
    const ids = new Set<number>();
    for (const page of pages) {
      const found = await cdp("Browser.getWindowForTarget", { targetId: page.targetId }).catch(() => null);
      if (typeof found?.windowId === "number") ids.add(found.windowId);
    }
    return [...ids];
  }

  /** Narrows every window of the browser to a phone's width (a maximized one is restored first). */
  async enter(profileId: string, ws: string, area: ScreenArea): Promise<void> {
    await this.connect(ws, async (cdp) => {
      const saved = this.saved.get(profileId) ?? [];
      for (const windowId of await this.windows(cdp)) {
        const bounds: WindowBounds = (await cdp("Browser.getWindowBounds", { windowId }))?.bounds ?? {};
        if (bounds.windowState === "minimized" || bounds.windowState === "fullscreen") continue;
        if (!saved.some((entry) => entry.windowId === windowId)) saved.push({ windowId, bounds });
        // Chromium ignores bounds sent together with leaving the maximized state.
        if (bounds.windowState === "maximized") await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
        await cdp("Browser.setWindowBounds", { windowId, bounds: { ...phoneBounds(bounds, area), windowState: "normal" } });
      }
      this.saved.set(profileId, saved);
    });
  }

  /** Gives every window back the size (or maximized state) it had before. */
  async leave(profileId: string, ws: string | undefined): Promise<void> {
    const saved = this.saved.get(profileId);
    this.saved.delete(profileId);
    if (!saved?.length || !ws) return;
    await this.connect(ws, async (cdp) => {
      for (const { windowId, bounds } of saved) {
        const { left, top, width, height, windowState } = bounds;
        await cdp("Browser.setWindowBounds", { windowId, bounds: { left, top, width, height, windowState: "normal" } }).catch(() => {});
        if (windowState === "maximized") await cdp("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } }).catch(() => {});
      }
    });
  }

  /** The browser is gone: nothing to give back. */
  forget(profileId: string): void { this.saved.delete(profileId); }
}

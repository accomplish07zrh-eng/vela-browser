/** Browser-independent workbench commands. No endpoint, script, or profile secrets cross this boundary. */
export interface WorkbenchTab { id: string; title: string; url: string }
export interface WorkbenchFrame { data: string; width: number; height: number }
export type WorkbenchRefreshTier = "hidden" | "edge" | "visible" | "interactive";
export function workbenchFrameInterval(tier: WorkbenchRefreshTier): number {
  return tier === "interactive" ? 50 : tier === "visible" ? 320 : tier === "edge" ? 2000 : 0;
}
/**
 * Live streams push a frame whenever the page paints. The fastest each card accepts them:
 * about 30 a second for the browser you work in, a calm rate for the rest of the wall.
 */
export function workbenchStreamInterval(tier: WorkbenchRefreshTier): number {
  return tier === "interactive" ? 33 : tier === "visible" ? 160 : tier === "edge" ? 1000 : 0;
}
/** Frames are sent at the size the card shows them, in device pixels, in steps so resizing does not churn. */
export function workbenchFrameWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(2560, Math.max(160, Math.ceil(value / 64) * 64));
}
export interface WorkbenchStreamOptions { maxWidth?: number; quality: number; minInterval: number }
export type WorkbenchInput =
  | { kind: "pointer"; event: "move" | "down" | "up"; x: number; y: number; button: "left" | "middle" | "right"; buttons: number; clicks: number; modifiers: number }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { kind: "key"; event: "down" | "up"; key: string; code: string; keyCode: number; modifiers: number }
  | { kind: "text"; text: string };

const number = (value: unknown, max: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
export function validWorkbenchInput(value: unknown): value is WorkbenchInput {
  const v = value as WorkbenchInput;
  if (!v || typeof v !== "object") return false;
  if (v.kind === "text") return typeof v.text === "string" && v.text.length > 0 && v.text.length <= 65_536;
  if (!Number.isInteger(v.modifiers) || v.modifiers < 0 || v.modifiers > 15) return false;
  if (v.kind === "key") return ["down", "up"].includes(v.event) && typeof v.key === "string" && v.key.length <= 64
    && typeof v.code === "string" && v.code.length <= 64 && Number.isInteger(v.keyCode) && v.keyCode >= 0 && v.keyCode <= 255;
  if (!number(v.x, 32_768) || !number(v.y, 32_768) || v.x < 0 || v.y < 0) return false;
  if (v.kind === "wheel") return number(v.dx, 20_000) && number(v.dy, 20_000);
  return v.kind === "pointer" && ["move", "down", "up"].includes(v.event) && ["left", "middle", "right"].includes(v.button)
    && Number.isInteger(v.buttons) && v.buttons >= 0 && v.buttons <= 7 && Number.isInteger(v.clicks) && v.clicks >= 0 && v.clicks <= 3;
}

export interface WorkbenchAdapter {
  tabs(): Promise<WorkbenchTab[]>;
  select(targetId: string): Promise<void>;
  newTab(): Promise<string>;
  closeTab(targetId: string): Promise<void>;
  frame(focused: boolean, maxWidth?: number): Promise<WorkbenchFrame>;
  /**
   * Pushes frames of the selected tab as it paints, until the returned stop is called or another
   * stream starts. Adapters without live streaming leave this out and are polled with frame().
   */
  stream?(options: WorkbenchStreamOptions, onFrame: (frame: WorkbenchFrame) => void): Promise<() => Promise<void>>;
  viewport?(): Promise<{ width: number; height: number }>;
  input(input: WorkbenchInput): Promise<void>;
  /** Detach control only; never close the managed browser or persistent context. */
  dispose(): void | Promise<void>;
}

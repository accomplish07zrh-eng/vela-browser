import type { WorkbenchInput, WorkbenchRefreshTier } from "../workbench-protocol.ts";
import { springValue } from "./motion.ts";

export interface ViewportBox { x: number; y: number; width: number; height: number }
export interface ViewportPlacement extends ViewportBox { row: number }
export interface WorkbenchLayout {
  boxes: Map<string, ViewportPlacement>;
  periods: number[];
  strides: number[];
  speeds: number[];
  /** A lane that is too short to cover both edges stays still instead of looping. */
  wraps: boolean[];
  /** Vertical extent of every lane, for the lane labels drawn over the wall. */
  tracks: { y: number; height: number }[];
  /** The lane that follows the pointer one-to-one; snapping aligns to it. */
  anchor: number;
  width: number;
  height: number;
  rows: number;
  mode: "ring" | "grid";
}
export interface WorkbenchLayoutOptions {
  overview?: boolean;
  reducedMotion?: boolean;
  /** One lane per group. Ignored when the lanes do not fit or do not cover every id. */
  lanes?: readonly (readonly string[])[];
  /** The lane the user is working in; it is drawn larger than the others. */
  active?: number | null;
}

export const VIEWPORT_FOOTER = 32;
export const WORKBENCH_GAP = 16;
/** Space kept clear on the left of a still lane for its label. */
export const LANE_GUTTER = 96;
const inset = 12, MIN_CARD = 224, MAX_CARD = 640, MAX_LANES = 4, ACTIVE_WEIGHT = 1.22;

/** Positive modulo also supports the previous lap and arbitrarily large offsets. */
export function workbenchPhase(offset: number, period: number): number {
  return period > 0 ? ((offset % period) + period) % period : 0;
}

/**
 * Lays lanes out as looping bands. Cards fill the available height. A lane loops
 * only when it can cover both edges with one DOM card per environment; with
 * `mixed`, shorter lanes stay still and every lane shrinks until they fit.
 */
function bands(lanes: readonly (readonly string[])[], width: number, height: number, options: WorkbenchLayoutOptions, mixed: boolean): WorkbenchLayout | null {
  const chosen = options.active != null && options.active >= 0 && options.active < lanes.length && lanes.length > 1;
  if (!chosen) return band(lanes, width, height, options, mixed, lanes.length === 3 ? 1.09 : 1);
  // The chosen lane grows as far as the other lanes allow, and never at their expense.
  for (const emphasis of [ACTIVE_WEIGHT, 1.1, 1]) { const plan = band(lanes, width, height, options, mixed, emphasis); if (plan) return plan; }
  return null;
}
function band(lanes: readonly (readonly string[])[], width: number, height: number, options: WorkbenchLayoutOptions, mixed: boolean, emphasis: number): WorkbenchLayout | null {
  const rows = lanes.length;
  const chosen = options.active != null && options.active >= 0 && options.active < rows && rows > 1;
  const anchor = chosen ? options.active! : rows === 3 ? 1 : 0;
  const weights = lanes.map((_, row) => row === anchor ? emphasis : 1);
  let base = Math.min(MAX_CARD, (height - inset * 2 - rows * VIEWPORT_FOOTER - (rows - 1) * WORKBENCH_GAP) * 1.6 / weights.reduce((a, b) => a + b, 0));
  const wraps = lanes.map(() => true);
  for (let pass = 0; pass <= rows; pass++) {
    let shrunk = false;
    for (let row = 0; row < rows; row++) {
      const stride = base * weights[row]! + WORKBENCH_GAP, count = lanes[row]!.length;
      // Spare card width lets one DOM card wrap entirely outside both edges.
      wraps[row] = count * stride >= width + stride;
      if (wraps[row]) continue;
      if (!mixed) return null;
      // Still cards keep clear of the label on the left and the fade on the right.
      const fit = ((width - LANE_GUTTER * 2 + WORKBENCH_GAP) / count - WORKBENCH_GAP) / weights[row]!;
      if (fit < base) { base = fit; shrunk = true; }
    }
    if (!shrunk) break;
  }
  if (base < MIN_CARD) return null;
  const boxes = new Map<string, ViewportPlacement>();
  const widths = weights.map((weight) => base * weight), strides = widths.map((value) => value + WORKBENCH_GAP);
  const heights = widths.map((value) => value / 1.6 + VIEWPORT_FOOTER);
  const usedHeight = heights.reduce((a, b) => a + b, 0) + (rows - 1) * WORKBENCH_GAP;
  const tracks: { y: number; height: number }[] = [];
  let y = Math.max(inset, (height - usedHeight) / 2);
  for (let row = 0; row < rows; row++) {
    lanes[row]!.forEach((id, index) => boxes.set(id, {
      x: wraps[row] ? index * strides[row]! + (row % 2 ? strides[row]! / 2 : 0) : LANE_GUTTER + index * strides[row]!,
      y, width: widths[row]!, height: heights[row]!, row,
    }));
    tracks.push({ y, height: heights[row]! });
    y += heights[row]! + WORKBENCH_GAP;
  }
  // Neighbouring lanes drift against each other; the anchor follows the hand exactly.
  const speeds = lanes.map((_, row) => options.reducedMotion || row === anchor ? 1 : (Math.abs(row - anchor) % 2 ? -.85 : .85));
  return { boxes, periods: strides.map((stride, row) => lanes[row]!.length * stride), strides, speeds, wraps, tracks, anchor, width, height, rows, mode: "ring" };
}

/** One DOM card per environment. A card wraps only while entirely outside the canvas. */
export function workbenchLayout(ids: readonly string[], width: number, height: number, options: WorkbenchLayoutOptions = {}): WorkbenchLayout {
  width = Math.max(1, width); height = Math.max(1, height);
  const boxes = new Map<string, ViewportPlacement>();
  if (!options.overview && ids.length) {
    const fit = Math.floor((height - inset * 2 + WORKBENCH_GAP) / 176);
    const known = new Set(ids), lanes = options.lanes?.map((lane) => lane.filter((id) => known.has(id))).filter((lane) => lane.length);
    if (lanes && lanes.length > 1 && lanes.length <= Math.min(MAX_LANES, fit) && new Set(lanes.flat()).size === ids.length && lanes.flat().length === ids.length) {
      const plan = bands(lanes, width, height, options, true);
      if (plan) return plan;
    }
    for (let rows = Math.min(3, fit); rows >= 1; rows--) {
      const plan = bands(Array.from({ length: rows }, (_, row) => ids.filter((_, index) => index % rows === row)), width, height, options, false);
      if (plan) return plan;
    }
  }
  let columns = 0, tileWidth = 0;
  if (!options.overview) {
    // A handful of environments: the largest tiles that fit without scrolling.
    for (let count = 1; count <= ids.length; count++) {
      const lines = Math.ceil(ids.length / count);
      const size = Math.min(MAX_CARD, (width - inset * 2 - (count - 1) * WORKBENCH_GAP) / count, ((height - inset * 2 - (lines - 1) * WORKBENCH_GAP) / lines - VIEWPORT_FOOTER) * 1.6);
      if (size > tileWidth) { tileWidth = size; columns = count; }
    }
    if (tileWidth < MIN_CARD) columns = 0;
  }
  if (!columns) {
    const maxColumns = Math.max(1, Math.floor((width - inset * 2 + WORKBENCH_GAP) / (options.overview ? 192 : 260)));
    columns = Math.max(1, Math.min(ids.length || 1, maxColumns));
    tileWidth = Math.max(1, Math.min(options.overview ? 440 : 420, (width - inset * 2 - (columns - 1) * WORKBENCH_GAP) / columns));
  }
  const tileHeight = tileWidth / 1.6 + VIEWPORT_FOOTER;
  const rows = Math.ceil(ids.length / columns);
  const usedHeight = rows * (tileHeight + WORKBENCH_GAP) - WORKBENCH_GAP;
  const startY = Math.max(inset, (height - usedHeight) / 2);
  ids.forEach((id, index) => {
    const row = Math.floor(index / columns), count = Math.min(columns, ids.length - row * columns);
    boxes.set(id, { x: (width - count * tileWidth - (count - 1) * WORKBENCH_GAP) / 2 + index % columns * (tileWidth + WORKBENCH_GAP), y: startY + row * (tileHeight + WORKBENCH_GAP), width: tileWidth, height: tileHeight, row });
  });
  return { boxes, periods: [], strides: [], speeds: [], wraps: [], tracks: [], anchor: 0, width, height: Math.max(height, startY + usedHeight + inset), rows, mode: "grid" };
}

export function workbenchPosition(box: ViewportPlacement, layout: WorkbenchLayout, offset: number): ViewportBox {
  if (layout.mode === "grid" || !layout.wraps[box.row]) return box;
  const stride = layout.strides[box.row]!, period = layout.periods[box.row]!;
  return { ...box, x: workbenchPhase(box.x - offset * layout.speeds[box.row]! + stride, period) - stride };
}

/** Shortest rotation to centre a specific card, including across the seam. */
export function workbenchLocate(box: ViewportPlacement, layout: WorkbenchLayout, offset: number): number {
  if (layout.mode === "grid" || !layout.wraps[box.row]) return offset;
  const speed = layout.speeds[box.row]!, period = layout.periods[box.row]!;
  const delta = box.x - offset * speed - (layout.width - box.width) / 2;
  return offset + (workbenchPhase(delta + period / 2, period) - period / 2) / speed;
}

export function workbenchSnap(offset: number, velocity: number, stride: number, anchor = 0): number {
  if (!(stride > 0)) return offset;
  const projected = offset + Math.max(-stride * 1.5, Math.min(stride * 1.5, velocity * .14));
  return anchor + Math.round((projected - anchor) / stride) * stride;
}

/** Physical inertia with a restrained rebound, stable across refresh rates. */
export function workbenchSpring(offset: number, velocity: number, target: number, seconds: number): { offset: number; velocity: number; settled: boolean } {
  const next = springValue(offset, velocity, target, seconds);
  return { offset: next.value, velocity: next.velocity, settled: next.settled };
}

export function workbenchFocusBox(width: number, height: number): ViewportBox {
  const availableWidth = Math.max(100, width * .9), availableHeight = Math.max(100, height * .9);
  const cardWidth = Math.min(availableWidth, (availableHeight - VIEWPORT_FOOTER) * 1.6);
  const cardHeight = cardWidth / 1.6 + VIEWPORT_FOOTER;
  return { x: (width - cardWidth) / 2, y: (height - cardHeight) / 2, width: cardWidth, height: cardHeight };
}

export function workbenchRefreshTier(box: ViewportBox, width: number, height: number, scrollTop = 0): WorkbenchRefreshTier {
  if (box.x + box.width <= 0 || box.x >= width || box.y + box.height <= scrollTop || box.y >= scrollTop + height) return "hidden";
  if (box.x < 48 || box.x + box.width > width - 48 || box.y < scrollTop || box.y + box.height > scrollTop + height) return "edge";
  return "visible";
}

/** Width-fit preview: every engine has the same scale; excess page height is cropped. */
export function viewportPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, source: { width: number; height: number }, clamp = false, fit: "width" | "contain" = "width"): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || source.width <= 0 || source.height <= 0) return null;
  const scale = fit === "contain" ? Math.min(rect.width / source.width, rect.height / source.height) : rect.width / source.width;
  const left = rect.left + (fit === "contain" ? (rect.width - source.width * scale) / 2 : 0);
  const top = rect.top + (fit === "contain" ? (rect.height - source.height * scale) / 2 : 0);
  const x = (clientX - left) / scale, y = (clientY - top) / scale;
  if (!clamp && (x < 0 || y < 0 || x >= source.width || y >= source.height || clientY > rect.top + rect.height)) return null;
  return { x: Math.max(0, Math.min(source.width - 1, x)), y: Math.max(0, Math.min(source.height - 1, y)) };
}

/** Broadcast coordinates are normalized separately for each isolated browser. */
export function workbenchFollowerInput(input: WorkbenchInput, source: { width: number; height: number }, destination: { width: number; height: number }): WorkbenchInput | null {
  if (input.kind !== "pointer" && input.kind !== "wheel") return input;
  if (source.width <= 0 || source.height <= 0 || destination.width <= 0 || destination.height <= 0) return null;
  return { ...input, x: Math.min(destination.width - 1, input.x / source.width * destination.width), y: Math.min(destination.height - 1, input.y / source.height * destination.height) };
}

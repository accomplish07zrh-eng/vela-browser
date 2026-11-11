import { expect, test } from "bun:test";
import { workbenchLayout, workbenchPhase, workbenchPosition, workbenchLocate, workbenchSnap, workbenchSpring, workbenchFocusBox, workbenchRefreshTier, viewportPoint, workbenchFollowerInput, VIEWPORT_FOOTER, WORKBENCH_GAP } from "./workbench-layout.ts";
import { workbenchFrameInterval } from "../workbench-protocol.ts";
const ids = (count: number) => Array.from({ length: count }, (_, i) => String(i));

test("one environment has one placement; sparse or very wide canvases become grids", () => {
  for (const count of [0, 1, 2, 3, 5, 12, 40]) for (const [width, height] of [[900, 620], [3200, 620], [800, 280]]) {
    const layout = workbenchLayout(ids(count), width!, height!);
    expect(layout.boxes.size).toBe(count);
    for (const box of layout.boxes.values()) expect(box.width / (box.height - VIEWPORT_FOOTER)).toBeCloseTo(1.6);
    if (layout.mode === "grid") {
      for (const box of layout.boxes.values()) {
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width!);
        expect(workbenchPosition(box, layout, 100000)).toEqual(box);
      }
    }
  }
  expect(workbenchLayout(ids(2), 900, 600).mode).toBe("grid");
  expect(workbenchLayout(ids(12), 900, 900).rows).toBe(3);
  expect(workbenchLayout(ids(12), 900, 620).rows).toBe(2);
  expect(workbenchLayout(ids(12), 900, 620, { overview: true }).mode).toBe("grid");
});

test("a single copy of every card covers both edges at every lap with 16px joints", () => {
  for (const count of [6, 7, 10, 12, 13, 40]) for (const [width, height] of [[900, 620], [1720, 620], [3200, 900], [800, 290], [1000, 900]]) {
    const layout = workbenchLayout(ids(count), width!, height!);
    if (layout.mode !== "ring") continue;
    for (let row = 0; row < layout.rows; row++) {
      const period = layout.periods[row]!;
      for (const offset of [-100000, -period - .1, -1, 0, .1, period / 2, period - .1, period, period + .1, 100000]) {
        const boxes = [...layout.boxes.values()].filter((box) => box.row === row).map((box) => workbenchPosition(box, layout, offset))
          .filter((box) => box.x + box.width > 0 && box.x < width!).sort((a, b) => a.x - b.x);
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes[0]!.x).toBeLessThanOrEqual(WORKBENCH_GAP + .000001);
        expect(width! - (boxes.at(-1)!.x + boxes.at(-1)!.width)).toBeLessThanOrEqual(WORKBENCH_GAP + .000001);
        for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x - boxes[i - 1]!.x - boxes[i - 1]!.width).toBeCloseTo(WORKBENCH_GAP);
      }
    }
  }
});

test("three rows emphasize the middle, neighbours drift against it, and reduced motion removes the drift", () => {
  const plan = workbenchLayout(ids(12), 900, 900), reduced = workbenchLayout(ids(12), 900, 900, { reducedMotion: true });
  expect(plan.speeds).toEqual([-.85, 1, -.85]); expect(reduced.speeds).toEqual([1, 1, 1]);
  expect(plan.anchor).toBe(1); expect(plan.wraps).toEqual([true, true, true]);
  expect(plan.boxes.get("1")!.width / plan.boxes.get("0")!.width).toBeCloseTo(1.09);
  expect(plan.boxes.get("1")!.x).toBeCloseTo(plan.strides[1]! / 2);
});

test("both directions wrap and locate uses the shortest route across the seam", () => {
  const plan = workbenchLayout(ids(13), 900, 900);
  for (const period of plan.periods) {
    expect(workbenchPhase(period, period)).toBe(0); expect(workbenchPhase(-period, period)).toBe(0);
    expect(workbenchPhase(-1, period)).toBe(period - 1);
  }
  for (const box of plan.boxes.values()) for (const offset of [-100000, -1, 0, 100000]) {
    const target = workbenchLocate(box, plan, offset), positioned = workbenchPosition(box, plan, target);
    expect(positioned.x + positioned.width / 2).toBeCloseTo(plan.width / 2);
    expect(Math.abs(target - offset)).toBeLessThanOrEqual(plan.periods[box.row]! / Math.abs(plan.speeds[box.row]!) / 2 + .001);
  }
});

test("cards fill the height instead of stopping at a fixed width", () => {
  const plan = workbenchLayout(ids(12), 1170, 800);
  expect(plan.mode).toBe("ring"); expect(plan.rows).toBe(2);
  const used = plan.tracks.reduce((sum, track) => sum + track.height, 0) + WORKBENCH_GAP;
  expect(800 - used).toBeLessThanOrEqual(24 + .001);
});

test("groups become lanes; a short lane stays still and fits beside its label", () => {
  const lanes = [ids(8), ["a", "b"], ["c", "d", "e", "f", "g", "h", "i"]], all = lanes.flat();
  const plan = workbenchLayout(all, 1400, 900, { lanes });
  expect(plan.mode).toBe("ring"); expect(plan.rows).toBe(3); expect(plan.wraps).toEqual([true, false, true]);
  for (const id of all) expect(plan.boxes.get(id)!.row).toBe(lanes.findIndex((lane) => lane.includes(id)));
  for (const id of lanes[1]!) {
    const box = plan.boxes.get(id)!;
    expect(workbenchPosition(box, plan, 98765)).toEqual(box); expect(workbenchLocate(box, plan, 40)).toBe(40);
    expect(box.x).toBeGreaterThanOrEqual(64); expect(box.x + box.width).toBeLessThanOrEqual(1400);
  }
  const active = workbenchLayout(all, 1400, 900, { lanes, active: 2 });
  expect(active.anchor).toBe(2); expect(active.speeds[2]).toBe(1);
  expect(active.boxes.get("c")!.width / active.boxes.get("0")!.width).toBeCloseTo(1.22);
  // Choosing a lane never dissolves the lanes: when there is no room to grow, it stays the same size.
  const tight = [ids(6), ["a", "b", "c", "d"], ["e", "f"]], cramped = workbenchLayout(tight.flat(), 1440, 718, { lanes: tight, active: 1 });
  expect(cramped.rows).toBe(3); expect(cramped.anchor).toBe(1);
  for (const id of tight.flat()) expect(cramped.boxes.get(id)!.row).toBe(tight.findIndex((lane) => lane.includes(id)));
  // Lanes that cannot be honoured fall back to evenly dealt rows.
  expect(workbenchLayout(all, 1400, 900, { lanes: [ids(8)] }).boxes.size).toBe(all.length);
  expect(workbenchLayout(all, 1400, 300, { lanes }).rows).toBe(1);
});

test("velocity predicts snapping, and the spring slows naturally at the target", () => {
  expect(workbenchSnap(70, 0, 320)).toBe(0); expect(workbenchSnap(70, 1500, 320)).toBe(320);
  expect(workbenchSnap(-70, -1500, 320)).toBe(-320); expect(workbenchSnap(170, 0, 320, 160)).toBe(160);
  for (const fps of [30, 60, 120]) {
    let state = { offset: 0, velocity: 0, settled: false }, peak = 0;
    for (let step = 0; step < Math.ceil(fps * .45); step++) {
      state = workbenchSpring(state.offset, state.velocity, 640, 1 / fps);
      expect(state.offset).toBeGreaterThanOrEqual(0); expect(state.offset).toBeLessThan(647);
      peak = Math.max(peak, state.offset);
    }
    expect(Math.abs(640 - state.offset)).toBeLessThan(1);
    expect(peak).toBeGreaterThan(640);
    for (let step = 0; step < fps; step++) state = workbenchSpring(state.offset, state.velocity, 640, 1 / fps);
    expect(state.settled).toBe(true); expect(state.offset).toBe(640);
  }
});

test("focus preserves 16:10, footer height and dismissal space", () => {
  const box = workbenchFocusBox(900, 620);
  expect(box.width / (box.height - VIEWPORT_FOOTER)).toBeCloseTo(1.6);
  expect(box.x).toBeGreaterThan(12); expect(box.y).toBeGreaterThan(12);
  expect(box.x * 2 + box.width).toBeCloseTo(900); expect(box.y * 2 + box.height).toBeCloseTo(620);
});

test("a delayed frame advances the spring by elapsed time without slow motion", () => {
  const delayed = workbenchSpring(0, 0, 640, .4);
  let regular = { offset: 0, velocity: 0, settled: false };
  for (let i = 0; i < 24; i++) regular = workbenchSpring(regular.offset, regular.velocity, 640, 1 / 60);
  expect(delayed.offset).toBeCloseTo(regular.offset, 6);
  expect(delayed.velocity).toBeCloseTo(regular.velocity, 6);
});

test("visibility tiers include faded edges and vertically scrolled grids", () => {
  const box = { x: 100, y: 12, width: 300, height: 220 };
  expect(workbenchRefreshTier(box, 900, 620)).toBe("visible");
  expect(workbenchRefreshTier({ ...box, x: -10 }, 900, 620)).toBe("edge");
  expect(workbenchRefreshTier({ ...box, x: -301 }, 900, 620)).toBe("hidden");
  expect(workbenchRefreshTier({ ...box, y: 900 }, 900, 620)).toBe("hidden");
  expect(workbenchRefreshTier({ ...box, y: 900 }, 900, 620, 800)).toBe("visible");
  expect(workbenchFrameInterval("hidden")).toBe(0); expect(workbenchFrameInterval("edge")).toBe(2000);
  expect(workbenchFrameInterval("visible")).toBe(320); expect(workbenchFrameInterval("interactive")).toBe(50);
});

test("all engines use width-fit image coordinates, with empty image space excluded", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 }, source = { width: 1600, height: 900 };
  expect(viewportPoint(300, 200, rect, source)).toEqual({ x: 800, y: 600 });
  expect(viewportPoint(110, 290, rect, source)).toBeNull();
  expect(viewportPoint(0, 0, rect, source, true)).toEqual({ x: 0, y: 0 });
});

test("focused view contains the complete page and maps letterboxed input precisely", () => {
  const rect = { left: 100, top: 50, width: 800, height: 500 };
  const tall = { width: 1280, height: 1000 };
  expect(viewportPoint(500, 550 - .5, rect, tall, false, "contain")).toEqual({ x: 640, y: 999 });
  expect(viewportPoint(150, 200, rect, tall, false, "contain")).toBeNull();
  expect(viewportPoint(500, 300, rect, tall, false, "contain")).toEqual({ x: 640, y: 500 });
  const wide = { width: 1600, height: 800 };
  expect(viewportPoint(500, 75, rect, wide, false, "contain")).toBeNull();
  expect(viewportPoint(500, 300, rect, wide, false, "contain")).toEqual({ x: 800, y: 400 });
  expect(viewportPoint(0, 0, rect, tall, true, "contain")).toEqual({ x: 0, y: 0 });
});

test("synchronized input maps each environment independently and rejects missing dimensions", () => {
  const input = { kind: "pointer", event: "down", x: 640, y: 450, button: "left", buttons: 1, clicks: 1, modifiers: 0 } as const;
  expect(workbenchFollowerInput(input, { width: 1280, height: 900 }, { width: 1920, height: 1080 })).toEqual({ ...input, x: 960, y: 540 });
  expect(workbenchFollowerInput(input, { width: 0, height: 0 }, { width: 1920, height: 1080 })).toBeNull();
  expect(workbenchFollowerInput({ kind: "text", text: "各自输入" }, { width: 1, height: 1 }, { width: 2, height: 2 })).toEqual({ kind: "text", text: "各自输入" });
});

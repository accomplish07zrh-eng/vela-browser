import { expect, test } from "bun:test";
import { cardPoint } from "./virtual-cursor.tsx";
import { viewportPoint } from "./workbench-layout.ts";

test("a page point lands where the card shows it, the inverse of mapping a click into the page", () => {
  const card = { width: 400, height: 300 }, page = { width: 1280, height: 720 };
  // On the wall the frame fills the card's width.
  expect(cardPoint({ x: 640, y: 360 }, card, page, "width")).toEqual({ x: 200, y: 112.5 });
  // Expanded, it is contained and centred.
  const contained = cardPoint({ x: 0, y: 0 }, { width: 1000, height: 1000 }, page, "contain")!;
  expect(contained.x).toBeCloseTo(0); expect(contained.y).toBeCloseTo((1000 - 720 * 1000 / 1280) / 2);
  for (const fit of ["width", "contain"] as const) {
    const at = cardPoint({ x: 333, y: 222 }, card, page, fit)!;
    const back = viewportPoint(at.x, at.y, { left: 0, top: 0, ...card }, page, true, fit)!;
    expect(back.x).toBeCloseTo(333); expect(back.y).toBeCloseTo(222);
  }
  expect(cardPoint({ x: 1, y: 1 }, card, { width: 0, height: 0 }, "width")).toBeNull();
});

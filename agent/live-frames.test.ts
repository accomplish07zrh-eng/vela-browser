import { expect, test } from "bun:test";
import { LiveFrames } from "../workbench-firefox.mjs";

function page(width = 1280, height = 720) {
  return { evaluate: async () => ({ width, height }) };
}

test("live frames answer at once with a newer frame, wait for paint otherwise, and stop when nobody asks", async () => {
  let push: (data: string) => void = () => {}, starts: any[] = [], stops = 0;
  const live = new LiveFrames(async (_page: any, options: any, onFrame: any) => {
    starts.push(options); push = (data) => onFrame(Buffer.from(data)); return () => { stops++; };
  });
  const p = page();
  const waiting = live.next(p, { maxWidth: 640, quality: 70, since: 0, wait: 1000 });
  await Bun.sleep(10);
  push("one");
  const first: any = await waiting;
  expect(Buffer.from(first.data, "base64").toString()).toBe("one");
  expect(first).toMatchObject({ seq: 1, width: 1280, height: 720 });
  // Sized to the card, keeping the page's proportions.
  expect(starts[0]).toMatchObject({ width: 640, height: 360, quality: 70 });
  // Nothing newer: it waits, then answers that nothing changed.
  const quiet: any = await live.next(p, { maxWidth: 640, quality: 70, since: 1, wait: 50 });
  expect(quiet).toMatchObject({ unchanged: true, seq: 1 });
  // A different card size restarts the stream.
  await live.next(p, { maxWidth: 320, quality: 70, since: 1, wait: 10 });
  expect(starts).toHaveLength(2); expect(stops).toBe(1);
  live.stop();
  expect(stops).toBe(2);
});

test("the AI's pointer rides with the next answer and wakes a waiting request", async () => {
  const live = new LiveFrames(async () => () => {});
  const p = page();
  await live.next(p, { since: 0, wait: 5 });
  const waiting = live.next(p, { since: 0, wait: 2000 });
  await Bun.sleep(10);
  live.pointer({ page: p, x: 10.04, y: 20, phase: "down" });
  const answer: any = await waiting;
  expect(answer).toMatchObject({ unchanged: true, pointer: [{ x: 10, y: 20, phase: "down" }] });
  // A pointer on another tab is not this card's.
  live.pointer({ page: page(), x: 1, y: 1, phase: "move" });
  const next: any = await live.next(p, { since: 0, wait: 5 });
  expect(next.pointer).toBeUndefined();
  live.stop();
});

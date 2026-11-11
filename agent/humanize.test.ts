import { expect, test } from "bun:test";
import { personaFor, planPath, seededRandom, targetPoint, typingDelays } from "./humanize.mjs";

test("each profile keeps stable habits, and different profiles differ", () => {
  expect(personaFor("profile-a")).toEqual(personaFor("profile-a"));
  const a = personaFor("profile-a"), b = personaFor("profile-b");
  expect([a.speed, a.cpm, a.curvature, a.hue]).not.toEqual([b.speed, b.cpm, b.curvature, b.hue]);
  for (const persona of [a, b]) {
    expect(persona.speed).toBeGreaterThanOrEqual(0.8);
    expect(persona.speed).toBeLessThanOrEqual(1.3);
    expect(persona.cpm).toBeGreaterThanOrEqual(190);
    expect(persona.cpm).toBeLessThanOrEqual(400);
  }
});

test("pointer paths curve, accelerate and land exactly on the target", () => {
  const persona = { ...personaFor("path"), overshoot: 0 };
  const random = seededRandom(7);
  const path = planPath({ x: 100, y: 500 }, { x: 900, y: 200 }, { width: 80, persona, random });
  const last = path[path.length - 1];
  expect(last).toMatchObject({ x: 900, y: 200 });
  expect(path.length).toBeGreaterThan(10);
  for (let index = 1; index < path.length; index++) expect(path[index]!.t).toBeGreaterThan(path[index - 1]!.t);
  // Not a straight line: some point leaves the chord.
  const offLine = path.some(({ x, y }) => Math.abs((300 * x + 800 * y - 300 * 100 - 800 * 500) / Math.hypot(300, 800)) > 8);
  expect(offLine).toBe(true);
  // Minimum-jerk timing: the middle covers more ground per step than the ends.
  const step = (index: number) => Math.hypot(path[index + 1]!.x - path[index]!.x, path[index + 1]!.y - path[index]!.y);
  const middle = Math.floor(path.length / 2);
  expect(step(middle)).toBeGreaterThan(step(0));
  expect(step(middle)).toBeGreaterThan(step(path.length - 2));
});

test("far moves can overshoot and correct, near moves stay short", () => {
  const persona = { ...personaFor("overshoot"), overshoot: 1 };
  const path = planPath({ x: 0, y: 0 }, { x: 1000, y: 0 }, { width: 30, persona, random: seededRandom(3) });
  expect(Math.max(...path.map((point) => point.x))).toBeGreaterThan(1000);
  expect(path[path.length - 1]).toMatchObject({ x: 1000, y: 0 });
  const near = planPath({ x: 10, y: 10 }, { x: 10.5, y: 10.5 }, { persona, random: seededRandom(3) });
  expect(near).toEqual([{ x: 10.5, y: 10.5, t: 0 }]);
});

test("landing points stay inside the element and vary", () => {
  const box = { x: 40, y: 60, width: 120, height: 32 };
  const random = seededRandom(11);
  const points = Array.from({ length: 200 }, () => targetPoint(box, random));
  for (const point of points) {
    expect(point.x).toBeGreaterThan(box.x);
    expect(point.x).toBeLessThan(box.x + box.width);
    expect(point.y).toBeGreaterThan(box.y);
    expect(point.y).toBeLessThan(box.y + box.height);
  }
  expect(new Set(points.map((point) => `${point.x},${point.y}`)).size).toBeGreaterThan(150);
});

test("typing rhythm is uneven, slower after punctuation, and paced by the profile", () => {
  const persona = personaFor("typing");
  const text = "Hello, world. This is a longer sentence typed by a person.";
  const delays = typingDelays(text, { persona, random: seededRandom(5) });
  expect(delays).toHaveLength([...text].length);
  expect(new Set(delays).size).toBeGreaterThan(20);
  const afterComma = delays[[..."Hello, "].length - 1];
  const median = [...delays].sort((a, b) => a - b)[Math.floor(delays.length / 2)];
  expect(afterComma!).toBeGreaterThan(median!);
  const fast = typingDelays(text, { persona, random: seededRandom(5), speed: 2 });
  expect(fast.reduce((a, b) => a + b, 0)).toBeLessThan(delays.reduce((a, b) => a + b, 0));
});

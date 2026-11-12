import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLog, CoolingMonitor, normalizeCoolingSettings, type CoolingDeps } from "./cooling.ts";

const MINUTE = 60_000;

function harness(overrides: Partial<CoolingDeps> = {}) {
  let now = 100 * MINUTE;
  let used = 0.9;
  const running = new Map<string, number>([["a", 10 * MINUTE], ["b", 20 * MINUTE], ["c", 30 * MINUTE]]);
  const activity = new ActivityLog();
  const cooled: string[] = [];
  const busy = new Set<string>();
  const monitor = new CoolingMonitor({
    settings: () => ({ enabled: true, threshold: 85, idleMinutes: 10 }),
    running: () => [...running].map(([profileId, startedAt]) => ({ profileId, startedAt })),
    busy: (id) => busy.has(id) || activity.held(id),
    lastActive: (id) => activity.lastActive(id),
    cool: async (id) => { cooled.push(id); running.delete(id); return true; },
    exists: () => true,
    memory: () => ({ total: 1000, available: Math.round(1000 * (1 - used)) }),
    now: () => now,
    ...overrides,
  });
  return {
    monitor, activity, cooled, busy, running,
    advance(ms: number) { now += ms; },
    setUse(value: number) { used = value; },
    now: () => now,
  };
}

test("a single high sample never cools; two in a row cool the longest idle browser", async () => {
  const h = harness();
  expect(await h.monitor.tick()).toBeNull();
  expect(await h.monitor.tick()).toBe("a");
  expect(h.cooled).toEqual(["a"]);
  expect(h.monitor.cooledAt("a")).toBeNumber();
});

test("below the threshold nothing cools and the high streak resets", async () => {
  const h = harness();
  await h.monitor.tick();
  h.setUse(0.5);
  expect(await h.monitor.tick()).toBeNull();
  h.setUse(0.9);
  expect(await h.monitor.tick()).toBeNull();
  expect(h.cooled).toEqual([]);
});

test("recent activity, holds, scripts and AI connections protect a browser", async () => {
  const h = harness();
  h.activity.touch("a", h.now() - MINUTE);
  const release = h.activity.hold("b");
  h.activity.touch("b", h.now());
  h.busy.add("c");
  await h.monitor.tick();
  expect(await h.monitor.tick()).toBeNull();
  release();
  h.activity.touch("b", h.now());
  h.busy.delete("c");
  h.advance(11 * MINUTE);
  // b was released just now, a was touched a minute before; c has been idle the longest.
  expect(await h.monitor.tick()).toBe("c");
});

test("after one browser cools the system gets time to settle before the next", async () => {
  const h = harness();
  await h.monitor.tick();
  expect(await h.monitor.tick()).toBe("a");
  await h.monitor.tick();
  expect(await h.monitor.tick()).toBeNull();
  h.advance(31_000);
  expect(await h.monitor.tick()).toBe("b");
});

test("off means never; a failed close is not marked cooled", async () => {
  const off = harness({ settings: () => ({ enabled: false, threshold: 85, idleMinutes: 10 }) });
  await off.monitor.tick();
  expect(await off.monitor.tick()).toBeNull();

  const attempts: string[] = [];
  const failing = harness({ cool: async (id) => { attempts.push(id); return id !== "a"; } });
  await failing.monitor.tick();
  expect(await failing.monitor.tick()).toBeNull();
  expect(failing.monitor.cooledAt("a")).toBeUndefined();
  // The one that would not close is left alone for a while; the next idle browser is tried instead.
  expect(await failing.monitor.tick()).toBe("b");
  expect(attempts).toEqual(["a", "b"]);
});

test("a cooled browser that starts again is just running, and forget drops the tile", async () => {
  const h = harness();
  await h.monitor.tick();
  await h.monitor.tick();
  expect(h.monitor.cooledAt("a")).toBeNumber();
  h.running.set("a", h.now());
  h.setUse(0.1);
  await h.monitor.tick();
  expect(h.monitor.cooledAt("a")).toBeUndefined();

  const other = harness();
  await other.monitor.tick();
  await other.monitor.tick();
  other.monitor.forget("a");
  expect(other.monitor.cooledAt("a")).toBeUndefined();
});

test("cooled tiles survive a restart, except for deleted profiles", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "vela-cooling-")), "cooled.json");
  const h = harness({ file });
  await h.monitor.tick();
  await h.monitor.tick();
  expect(JSON.parse(readFileSync(file, "utf8")).cooled.a).toBeNumber();
  const restarted = new CoolingMonitor({ ...harnessDeps(), file });
  expect(restarted.cooledAt("a")).toBeNumber();
  const deleted = new CoolingMonitor({ ...harnessDeps(), file, exists: () => false });
  expect(deleted.cooledAt("a")).toBeUndefined();
});

function harnessDeps(): CoolingDeps {
  return {
    settings: () => ({ enabled: true, threshold: 85, idleMinutes: 10 }),
    running: () => [], busy: () => false, lastActive: () => 0, cool: async () => true, exists: () => true,
  };
}

test("settings are clamped to safe ranges", () => {
  expect(normalizeCoolingSettings({ enabled: false, threshold: 10, idleMinutes: 9999 })).toEqual({ enabled: false, threshold: 60, idleMinutes: 240 });
  expect(normalizeCoolingSettings({})).toEqual({ enabled: true, threshold: 85, idleMinutes: 10 });
  expect(normalizeCoolingSettings({ threshold: "90" })).toMatchObject({ threshold: 85 });
});

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptRun } from "./scripts.ts";
import { nextRunAt, normalizeTask, TaskError, TaskRunner, TaskStore } from "./tasks.ts";

/** A script runner whose profiles fail on the attempts listed for them. */
function fakeRunner(failures: Record<string, number[]> = {}, busy = false) {
  const calls: Array<{ scriptId: string; profileIds: string[] }> = [];
  const attempts = new Map<string, number>();
  let last: ScriptRun | null = busy ? { id: "busy", scriptName: "other", status: "running", profiles: [] } : null;
  return {
    calls,
    runner: {
      start(request: { scriptId: string; profileIds: string[] }) {
        calls.push({ scriptId: request.scriptId, profileIds: [...request.profileIds] });
        last = {
          id: `run-${calls.length}`, scriptName: request.scriptId, status: "finished",
          profiles: request.profileIds.map((id) => {
            const key = `${request.scriptId}:${id}`;
            const attempt = (attempts.get(key) ?? 0) + 1;
            attempts.set(key, attempt);
            const fails = (failures[key] ?? []).includes(attempt);
            return { id, name: id.toUpperCase(), status: fails ? "failed" as const : "succeeded" as const, ...(fails ? { error: "Sign in button missing" } : {}) };
          }),
        };
        return last;
      },
      settled: async () => {},
      status: () => last,
    },
  };
}

function setup(failures: Record<string, number[]> = {}, busy = false) {
  const store = new TaskStore(join(mkdtempSync(join(tmpdir(), "vela-tasks-")), "tasks.json"));
  const fake = fakeRunner(failures, busy);
  const runner = new TaskRunner({
    store, runner: fake.runner,
    resolveProfiles: (target) => target.groups?.includes("shop") ? ["a", "b", "c"] : target.profileIds ?? [],
    scriptName: async (id) => `Script ${id}`,
  });
  return { store, runner, calls: fake.calls };
}

test("a task retries the profiles that failed and goes on only with those that succeeded", async () => {
  // b fails once (then passes on retry); c fails every time.
  const { runner, calls } = setup({ "s1:b": [1], "s1:c": [1, 2] });
  const task = runner.save({ name: "Daily check-in", target: { groups: ["shop"] }, steps: [{ scriptId: "s1" }, { scriptId: "s2", inputs: { url: "https://example.com" } }], retries: 1 });
  const record = await runner.run(task.id);
  expect(calls).toEqual([
    { scriptId: "s1", profileIds: ["a", "b", "c"] },
    { scriptId: "s1", profileIds: ["b", "c"] },
    { scriptId: "s2", profileIds: ["a", "b"] },
  ]);
  expect(record.outcome).toBe("partial");
  expect(record.steps[0]).toMatchObject({ scriptName: "Script s1", attempts: 2, succeeded: 2, failed: 1 });
  expect(record.steps[0]!.failures).toEqual([{ profileId: "c", name: "C", error: "Sign in button missing" }]);
  expect(record.steps[1]).toMatchObject({ succeeded: 2, failed: 0 });
  expect(runner.list().history[0]!.id).toBe(record.id);
  expect(runner.list().tasks[0]!.lastRunAt).toBeGreaterThan(0);
});

test("a task does not interrupt a script that is already running, and says why it skipped", async () => {
  const { runner, calls } = setup({}, true);
  const task = runner.save({ name: "Check", target: { profileIds: ["a"] }, steps: [{ scriptId: "s1" }] });
  const record = await runner.run(task.id);
  expect(record.outcome).toBe("skipped");
  expect(calls).toEqual([]);
});

test("tasks are checked before they are saved", () => {
  expect(() => normalizeTask({ name: "", target: { profileIds: ["a"] }, steps: [{ scriptId: "s" }] })).toThrow(TaskError);
  expect(() => normalizeTask({ name: "x", target: {}, steps: [{ scriptId: "s" }] })).toThrow("Choose the profiles");
  expect(() => normalizeTask({ name: "x", target: { profileIds: ["a"] }, steps: [] })).toThrow("1 to 10");
  expect(() => normalizeTask({ name: "x", target: { profileIds: ["a"] }, steps: [{ scriptId: "s" }], schedule: { kind: "interval", minutes: 5 } })).toThrow("15 minutes");
  expect(() => normalizeTask({ name: "x", target: { profileIds: ["a"] }, steps: [{ scriptId: "s" }], schedule: { kind: "daily", time: "25:00" } })).toThrow("HH:MM");
  expect(normalizeTask({ name: "x", target: { profileIds: ["a"] }, steps: [{ scriptId: "s" }], schedule: { kind: "daily", time: "08:30", days: [0, 1, 2, 3, 4, 5, 6] } }).schedule).toEqual({ kind: "daily", time: "08:30" });
});

test("the next run is the next matching local time, or the interval after the last run", () => {
  const monday9 = new Date(2026, 10, 16, 9, 0).getTime();
  const daily = { createdAt: 0, schedule: { kind: "daily" as const, time: "08:30" } };
  expect(nextRunAt(daily, monday9)).toBe(new Date(2026, 10, 17, 8, 30).getTime());
  expect(nextRunAt({ ...daily, schedule: { kind: "daily", time: "10:00" } }, monday9)).toBe(new Date(2026, 10, 16, 10, 0).getTime());
  // Weekdays only: from Friday evening the next is Monday.
  const friday = new Date(2026, 10, 20, 20, 0).getTime();
  expect(nextRunAt({ ...daily, schedule: { kind: "daily", time: "08:30", days: [1, 2, 3, 4, 5] } }, friday)).toBe(new Date(2026, 10, 23, 8, 30).getTime());
  expect(nextRunAt({ createdAt: 0, lastRunAt: monday9, schedule: { kind: "interval", minutes: 60 } }, monday9)).toBe(monday9 + 3_600_000);
  expect(nextRunAt({ createdAt: 0, schedule: { kind: "manual" } }, monday9)).toBeNull();
});

test("a due task runs from the scheduler tick, once", async () => {
  let now = new Date(2026, 10, 16, 8, 0).getTime();
  const store = new TaskStore(join(mkdtempSync(join(tmpdir(), "vela-tasks-")), "tasks.json"));
  const fake = fakeRunner();
  const runner = new TaskRunner({ store, runner: fake.runner, resolveProfiles: () => ["a"], scriptName: async (id) => id, now: () => now });
  runner.save({ name: "Morning", target: { profileIds: ["a"] }, steps: [{ scriptId: "s1" }], schedule: { kind: "daily", time: "08:30" } });
  await runner.tick();
  expect(fake.calls.length).toBe(0);
  now = new Date(2026, 10, 16, 8, 31).getTime();
  await runner.tick();
  expect(fake.calls.length).toBe(1);
  await runner.tick();
  expect(fake.calls.length).toBe(1);
});

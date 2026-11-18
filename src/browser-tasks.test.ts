import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTaskSupervisor, type BrowserTaskConnection } from "./browser-tasks.ts";
import { ProfileWrites } from "./profile-writes.ts";
import { HostWorkBudget } from "./cooling.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Task did not reach its expected state");
}

async function fixture(work: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "vela-task-test-"));
  try { await work(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a lost reply leaves an uncertain step; restarting reconciles the receipt exactly once", async () => fixture(async root => {
  let submissions = 0;
  const open = async (): Promise<BrowserTaskConnection> => ({
    async program({ code, argument }) {
      const { actionKey, previous } = argument as { actionKey: string; previous: Record<string, unknown> };
      expect(actionKey).toMatch(/^[0-9a-f]{32}:/);
      if (code === "submit") { submissions++; throw new Error("Connection closed after the server accepted the request"); }
      if (code === "receipt") return { completed: true, value: { state: "applied", value: "server-1" } };
      expect(previous.submit).toBe("server-1");
      return { completed: true, value: "verified", network: { records: [{ requestId: "r1" }] } };
    },
    close: async () => {},
  });
  const options = { root, open, authorize() {} };
  const first = new BrowserTaskSupervisor(options);
  const plan = { idempotencyKey: "draft-1", steps: [{ id: "submit", run: "submit", verify: "receipt" }, { id: "follow-up", run: "next" }] };
  const task = first.start("profile", "test-agent", plan);
  expect(task.state).toBe("running");
  expect(first.start("profile", "test-agent", { ...plan, steps: [...plan.steps] }).runId).toBe(task.runId);
  expect(() => first.start("profile", "test-agent", { ...plan, name: "other" })).toThrow("different plan");
  await until(() => first.status(task.runId).state === "needs_verification");
  expect(first.keeps("profile")).toBe(true);
  await first.shutdown();

  const second = new BrowserTaskSupervisor(options);
  expect(() => second.start("profile", "another-agent", plan)).toThrow("different Agent");
  const recovered = second.start("profile", "test-agent", plan);
  expect(recovered.steps[0]?.state).toBe("uncertain");
  expect(() => second.resume(task.runId, "another-agent")).toThrow("different Agent");
  second.setDelegates(task.runId, ["another-agent"], "test-agent");
  second.resume(task.runId, "another-agent");
  second.resume(task.runId, "another-agent");
  await until(() => second.status(task.runId).state === "completed");
  expect(second.status(task.runId).steps.map(step => step.attempts)).toEqual([1, 1]);
  expect(second.status(task.runId).client).toBe("test-agent");
  expect(submissions).toBe(1);
  expect(second.evidence(task.runId, 2, "summary", 0, 100)).toMatchObject({ phase: "verify", stepId: "submit", completed: true });
  const chunk = second.evidence(task.runId, 3, "network", 0, 100);
  expect(Buffer.from((chunk as { base64: string }).base64, "base64").toString()).toContain("r1");
  await second.shutdown();
}));

test("tasks stay queued under memory pressure or while waiting for a profile write lease", async () => fixture(async root => {
  const writes = new ProfileWrites();
  const mib = 1024 ** 2;
  let available = 923 * mib, now = 0;
  const hostWork = new HostWorkBudget(8, () => ({ total: 32 * 1024 * mib, available }), () => now);
  const existing = writes.tryAcquire("one")!;
  const order: string[] = [];
  const service = new BrowserTaskSupervisor({ root, writes, hostWork, capacity: () => 1, authorize() {},
    async open(profileId, _client, _signal, permit) {
      expect(hostWork.canStart(permit)).toBe(true);
      return {
        async bindTab() { return { id: profileId, generation: "one" }; },
        async program({ code }) { order.push(code); return { completed: true }; },
        async close() {},
      };
    },
  });
  try {
    const start = (id: string, run: string) => service.start(id, "test", { startUrl: "https://fixture.test", steps: [{ id: run, run }] });
    const first = start("one", "first"), second = start("one", "second"), unrelated = start("two", "other");
    await Bun.sleep(20);
    expect(service.queueStatus()).toEqual({ running: 0, waiting: 3 });
    available = 2200 * mib; now += 1000;
    await until(() => service.status(unrelated.runId).state === "completed");
    expect(order).toEqual(["other"]);
    expect(service.status(first.runId).state).toBe("queued");
    existing.release();
    await until(() => service.status(second.runId).state === "completed");
    expect(order).toEqual(["other", "first", "second"]);
    expect(hostWork.status().inUse).toBe(0);
  } finally { existing.release(); await service.shutdown(); }
}));

test("receipt expiry preserves the checkpoint result needed by later steps", async () => fixture(async root => {
  const options = { root, authorize() {}, async open(): Promise<BrowserTaskConnection> {
    return {
      async program({ code, argument }) {
        if (code === "first") return { completed: true, value: "checkpoint" };
        if (code === "uncertain") return { completed: false };
        expect((argument as { previous: Record<string, unknown> }).previous.first).toBe("checkpoint");
        return { completed: true, value: { state: "applied" } };
      },
      async close() {},
    };
  } };
  const first = new BrowserTaskSupervisor(options);
  const { runId } = first.start("one", "test", { steps: [{ id: "first", run: "first" }, { id: "uncertain", run: "uncertain" }] });
  await until(() => first.status(runId).state === "needs_verification");
  await first.shutdown();
  const old = new Date(0);
  utimesSync(join(root, runId, "evidence-1.json"), old, old);
  const reopened = new BrowserTaskSupervisor(options);
  try {
    expect(() => reopened.evidence(runId, 1, "summary", 0, 100)).toThrow("expired");
    expect(reopened.status(runId).firstEvidence).toBe(2);
    expect(() => reopened.resume(runId, "test", "verify", "uncertain:0:0")).toThrow("checkpoint changed");
    reopened.resume(runId, "test", "verify", "uncertain:1:2");
    await until(() => reopened.status(runId).state === "completed");
    expect(reopened.status(runId).steps[1]).toMatchObject({ attempts: 1, verification: "applied" });
  } finally { await reopened.shutdown(); }
}));

test("pause settles the current command, keeps its result and never starts the next command before resume", async () => fixture(async root => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const commands: string[] = [];
  const service = new BrowserTaskSupervisor({
    root, authorize() {},
    async open() {
      return {
        async program({ code }) {
          commands.push(code);
          if (code === "step1") { entered.resolve(); await release.promise; }
          return { completed: true, value: code };
        },
        async close() {},
      };
    },
  });
  const { runId } = service.start("one", "test-agent", { steps: [{ id: "one", run: "step1" }, { id: "two", run: "step2" }] });
  await entered.promise;
  expect(service.stop(runId, "paused").stopping).toBe(true);
  expect(() => service.start("one", "test-agent", { steps: [{ id: "other", run: "other" }] })).toThrow("is running");
  release.resolve();
  await until(() => service.status(runId).state === "paused");
  expect(commands).toEqual(["step1"]);
  service.resume(runId, "test-agent");
  await until(() => service.status(runId).state === "completed");
  expect(commands).toEqual(["step1", "step2"]);
  await service.shutdown();
}));

test("unknown verification never repeats the action, and an authoritative absence permits a controlled retry", async () => fixture(async root => {
  let attempts = 0;
  const service = new BrowserTaskSupervisor({
    root, authorize() {},
    async open() {
      return {
        async program({ code }) {
          if (code === "write") {
            attempts++;
            return attempts === 1 ? { completed: false, error: "Unacknowledged" } : { completed: true };
          }
          if (code === "unknown") return { completed: true, value: { state: "unknown" } };
          return { completed: true, value: { state: attempts === 1 ? "absent" : "applied" } };
        },
        async close() {},
      };
    },
  });
  const { runId } = service.start("profile", "test-agent", { steps: [{ id: "write", run: "write", verify: "unknown" }] });
  await until(() => service.status(runId).state === "needs_verification");
  service.resume(runId, "test-agent");
  await until(() => service.status(runId).state === "needs_verification");
  expect(attempts).toBe(1);
  service.resume(runId, "test-agent", "authoritative");
  await until(() => service.status(runId).state === "completed");
  expect(attempts).toBe(2);
  await service.shutdown();
}));

test("the queue responds to capacity and isolates a blocked profile without overtaking it", async () => fixture(async root => {
  let capacity = 0;
  const calls: string[] = [];
  const service = new BrowserTaskSupervisor({
    root, capacity: () => capacity, authorize() {},
    async open(profileId) {
      return {
        async bindTab() { return { generation: "first", id: profileId }; },
        async program({ code, tabId }) {
          expect(tabId).toBe(profileId);
          calls.push(code);
          if (code === "login") return { completed: true, value: { blocked: { code: "authentication_required" } } };
          return { completed: true, value: code };
        },
        async close() {},
      };
    },
  });
  const start = (profileId: string, run: string) => service.start(profileId, "test", { startUrl: "https://example.test", steps: [{ id: "step", run }] });
  const first = start("one", "login");
  const following = start("one", "following");
  const other = start("two", "other");
  expect([first.state, following.state, other.state]).toEqual(["queued", "queued", "queued"]);
  expect(calls).toEqual([]);
  capacity = 2;
  service.startRecovery();
  await until(() => service.status(other.runId).state === "completed");
  expect(service.status(first.runId)).toMatchObject({ state: "blocked", blocked: { code: "authentication_required" } });
  expect(service.status(following.runId).state).toBe("queued");
  expect(calls).toEqual(["login", "other"]);
  service.stop(first.runId, "cancelled");
  await until(() => service.status(following.runId).state === "completed");
  expect(calls).toEqual(["login", "other", "following"]);
  await service.shutdown();
}));

test("a desktop restart rebuilds the task tab at its checkpoint and saves a reusable site skill", async () => fixture(async root => {
  let writes = 0, generation = "old";
  const entered = Promise.withResolvers<void>(), lost = Promise.withResolvers<void>();
  const targets: string[] = [];
  const options = { root, authorize() {}, async open(): Promise<BrowserTaskConnection> {
    return {
      async bindTab(target) { targets.push(target.startUrl); return { id: "tab-" + generation, generation }; },
      async program({ code, tabId, argument }) {
        expect(tabId).toBe("tab-" + generation);
        if (code === "commit") { writes++; entered.resolve(); await lost.promise; return { completed: false }; }
        if (code === "receipt") return { completed: true, value: { state: "applied", value: "confirmed" } };
        if (code === "next") expect((argument as { previous: Record<string, unknown> }).previous.commit).toBe("confirmed");
        return { completed: true };
      },
      async close() {},
    };
  } };
  const first = new BrowserTaskSupervisor(options);
  const startUrl = "https://example.test/app", recoveryUrl = startUrl + "/receipt";
  const { runId } = first.start("one", "test", {
    startUrl, argument: { private: "original-argument" }, steps: [
      { id: "commit", run: "commit", verify: "receipt", recoveryUrl },
      { id: "next", run: "next", readOnly: true },
    ],
  });
  await entered.promise;
  const shutdown = first.shutdown();
  lost.resolve();
  await shutdown;
  expect(first.status(runId).state).toBe("queued");
  expect(first.status(runId).steps[0]?.state).toBe("uncertain");
  generation = "new";
  const second = new BrowserTaskSupervisor(options);
  second.startRecovery();
  await until(() => second.status(runId).state === "completed");
  expect(targets).toEqual([startUrl, recoveryUrl]);
  expect(writes).toBe(1);
  const skill = second.saveSkill(runId, "test", {});
  await second.shutdown();
  const restored = new BrowserTaskSupervisor(options);
  expect(restored.findSkills("test", recoveryUrl, 0, 10).skills).toEqual([skill]);
  expect(restored.findSkills("test", startUrl + "-other", 0, 10).skills).toEqual([]);
  expect(restored.findSkills("test", "https://www.example.test/app", 0, 10).skills).toEqual([]);
  expect(JSON.stringify(skill)).not.toContain("original-argument");
  await restored.shutdown();
}));

test.skipIf(process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux")(
  "Chromium integration rebinds cross-origin frames, captures live stream bytes and verifies a lost save once",
  async () => {
    const child = Bun.spawn([process.execPath, new URL("../scripts/browser-agent-resilience.ts", import.meta.url).pathname],
      { stdout: "pipe", stderr: "pipe" });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, output + errors).toBe(0);
  }, 90_000,
);

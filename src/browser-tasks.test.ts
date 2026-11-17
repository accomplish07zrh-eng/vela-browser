import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTaskSupervisor, type BrowserTaskConnection } from "./browser-tasks.ts";

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
  const recovered = second.start("profile", "new-connection", plan);
  expect(recovered.steps[0]?.state).toBe("uncertain");
  second.resume(task.runId, "new-connection");
  second.resume(task.runId, "new-connection");
  await until(() => second.status(task.runId).state === "completed");
  expect(second.status(task.runId).steps.map(step => step.attempts)).toEqual([1, 1]);
  expect(submissions).toBe(1);
  expect(second.evidence(task.runId, 2, "summary", 0, 100)).toMatchObject({ phase: "verify", stepId: "submit", completed: true });
  const chunk = second.evidence(task.runId, 3, "network", 0, 100);
  expect(Buffer.from((chunk as { base64: string }).base64, "base64").toString()).toContain("r1");
  await second.shutdown();
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

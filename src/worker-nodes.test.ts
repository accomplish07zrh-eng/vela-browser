import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTaskError, BrowserTaskSupervisor, type BrowserTaskActor } from "./browser-tasks.ts";
import { buildNewProfile } from "./create.ts";
import type { PortableProfiles } from "./portable-profiles.ts";
import { ProfileStore } from "./store.ts";
import { WORKER_PATH, WorkerNodes } from "./worker-nodes.ts";

test("Worker requests keep per-Agent ownership through reconnect, delegation and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "vela-worker-test-"));
  const store = new ProfileStore(":memory:");
  let ready = 0, writes = 0;
  const profile = buildNewProfile({ name: "test", group: "qa" }, () => false);
  store.upsertProfile(profile);
  let worker: WorkerNodes;
  const taskOptions = { root: join(root, "tasks"), capacity: () => ready, authorize(id: string, _name: string, _group?: string, actor?: BrowserTaskActor) {
    if (actor && !worker.allows(actor, store.getProfile(id)!.group)) throw new BrowserTaskError("not_permitted", "Worker permission revoked", 403);
  }, async open() {
    return {
      async bindTab() { return { generation: "test", id: "tab" }; },
      async program() { writes++; return { completed: true }; },
      async close() {},
    };
  } };
  let tasks = new BrowserTaskSupervisor(taskOptions);
  const token = randomBytes(32).toString("base64url");
  const config = join(root, "worker-nodes.json");
  const configure = (groups: string[]) => writeFileSync(config, JSON.stringify({ clients: [
    { name: "controller", token, groups, agents: ["first", "second"] },
  ] }));
  configure(["qa"]);
  const initialize = () => new WorkerNodes({ config, store, tasks, portable: {} as PortableProfiles, capacity: () => ({ size: 2 }) });
  worker = initialize();
  const wire = async (agent: string, input: object, authorization = token) => {
    const pathname = WORKER_PATH + "/tasks";
    return (await worker.serve(new Request("https://worker.test" + pathname, {
      method: "POST",
      headers: { authorization: "Bearer " + authorization, "x-vela-worker-agent": agent, "content-type": "application/json" },
      body: JSON.stringify(input),
    }), pathname)).json() as Promise<any>;
  };
  try {
    expect(await wire("first", { operation: "health" })).toMatchObject({ ok: true, result: { ready: true, waiting: 0, limit: 2 } });
    expect(await wire("first", { operation: "health" }, "invalid")).toMatchObject({ ok: false });
    const plan = { operation: "start", profileId: profile.id, startUrl: "https://fixture.test",
      idempotencyKey: "reconnect", steps: [{ id: "write", run: "write" }] };
    const run = (await wire("first", plan)).result.task;
    expect(await wire("second", { operation: "status", runId: run.runId })).toMatchObject({ ok: false });
    expect(await wire("first", { operation: "delegate", runId: run.runId, delegates: ["second"] })).toMatchObject({ ok: true });
    expect(await wire("second", { operation: "status", runId: run.runId })).toMatchObject({ ok: true, result: { task: { client: "first" } } });
    await tasks.shutdown();

    tasks = new BrowserTaskSupervisor(taskOptions);
    worker = initialize();
    expect((await wire("first", plan)).result.task.runId).toBe(run.runId);
    configure([]);
    ready = 1;
    tasks.startRecovery();
    for (let attempt = 0; attempt < 100 && tasks.status(run.runId).state !== "blocked"; attempt++) await Bun.sleep(10);
    expect(tasks.status(run.runId)).toMatchObject({ state: "blocked", blocked: { code: "not_permitted" } });
    expect(writes).toBe(0);
    configure(["qa"]);
    expect(await wire("second", { operation: "resume", runId: run.runId })).toMatchObject({ ok: true });
    for (let attempt = 0; attempt < 100 && tasks.status(run.runId).state !== "completed"; attempt++) await Bun.sleep(10);
    expect(tasks.status(run.runId)).toMatchObject({ state: "completed", client: "first" });
    expect(writes).toBe(1);
    expect(await wire("second", { operation: "evidence", runId: run.runId, sequence: 1 })).toMatchObject({ ok: true, result: { evidence: { stepId: "write" } } });
  } finally {
    await tasks.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run against the installed Vela Chromium and the real desktop MCP transport. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { createVelaBrowserMcp } from "../agent/mcp-host.mjs";
import { AGENT_PATH, AGENT_PROTOCOL, AgentRuntimeClient } from "../agent/runtime-client.mjs";
import { aliasmodeChromiumArchive, aliasmodeChromiumExecutable } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import type { BrowserTaskView } from "../src/browser-tasks.ts";
import { buildNewProfile } from "../src/create.ts";
import { Launcher } from "../src/launcher.ts";
import { ensureStateDirectories, statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import { serveDashboard } from "../src/web.ts";

const runtimeRoot = resolve(process.argv[2] ?? ".");
const binary = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
assert.equal(await sha256File(binary), aliasmodeChromiumArchive(process.platform).executableSha256, "Use the pinned Vela Chromium");

const temp = realpathSync(tmpdir()), root = mkdtempSync(join(temp, "vela-task-batch-"));
const paths = statePaths(root);
ensureStateDirectories(paths);
const store = new ProfileStore(paths.database);
const launcher = new Launcher({ store, dataRoot: paths.profiles, headless: true, ensureAliasmodeChromium: async () => binary, log() {} });
const nonce = randomBytes(32).toString("hex");
const dashboard = serveDashboard({ store, launcher, paths, agentNonce: nonce, port: 0, log() {} });
const profiles = ["Rebuild", "Sign-in required", "Independent"].map(name => {
  const profile = buildNewProfile({ name, chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(profile);
  return profile.id;
});
const [rebuild, blocked, independent] = profiles as [string, string, string];
const release = Promise.withResolvers<void>();
const commits = new Map<string, { count: number; key: string }>();
let signIn = true;
const site = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const slot = url.searchParams.get("slot") ?? "";
    if (url.pathname === "/commit" && request.method === "POST") {
      const key = request.headers.get("Idempotency-Key") ?? "";
      commits.set(slot, { count: (commits.get(slot)?.count ?? 0) + 1, key });
      if (slot === "crash") await release.promise;
      return Response.json({ receipt: "receipt-" + slot });
    }
    if (url.pathname === "/receipt") {
      const key = request.headers.get("Idempotency-Key");
      const applied = !!key && commits.get(slot)?.key === key;
      return Response.json(applied ? { state: "applied", value: "receipt-" + slot } : { state: "absent" });
    }
    const login = url.searchParams.has("login") && signIn;
    return new Response([
      "<!doctype html><title>Workflow</title><h1>Workflow</h1>",
      login ? '<div role="alert">Sign in required</div>' : "",
      '<form aria-label="Draft"><label>Private <input type="password" value="hidden-input-value"></label>',
      '<button type="button" id="original" onclick="document.body.dataset.clicked=\'yes\'">Continue</button></form>',
      '<div role="dialog" aria-label="Draft details"><div contenteditable="true">hidden-editable-value</div></div>',
      '<div style="display:none" role="alert">Invisible notice</div>',
    ].join(""), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
const startUrl = new URL("/workflow", site.url).href;
const sourceUrl = startUrl + "?bound=first";
const decoyUrl = startUrl + "?decoy=1";
const steps = [
  { id: "observe", readOnly: true, timeoutMs: 15_000, run: [
    "async ({devtools, page}) => {",
    " const observation = await devtools.call('observe');",
    " if (observation.notices.some(item => item.text === 'Sign in required')) return {blocked: {code: 'authentication_required'}};",
    " if (JSON.stringify(observation).includes('hidden-input-value') || JSON.stringify(observation).includes('hidden-editable-value')",
    "   || JSON.stringify(observation).includes('Invisible notice')) throw new Error('Observation exposed hidden data');",
    " const anchor = observation.controls.find(control => control.name === 'Continue')?.anchor;",
    " if (!anchor) throw new Error('Observation did not include a portable control');",
    " return {anchor, url: page.url()};",
    "}",
  ].join("\n") },
  { id: "commit", timeoutMs: 90_000, run: [
    "async ({page, devtools, argument}) => {",
    " if (page.url() !== argument.previous.observe.url || page.url().includes('decoy')) throw new Error('Task switched tabs');",
    " await page.locator('#original,#rerendered').evaluate(node => {const next = node.cloneNode(true); next.id = 'rerendered'; node.replaceWith(next);});",
    " await devtools.call('action', {action: 'press', value: 'Enter', anchor: argument.previous.observe.anchor});",
    " if (await page.locator('body').getAttribute('data-clicked') !== 'yes') throw new Error('Anchor failed to rebind');",
    " return page.evaluate(async ({actionKey, input}) => (await fetch('/commit?slot=' + input.slot, {method:'POST',",
    "   headers:{'Idempotency-Key': actionKey}})).json(), argument);",
    "}",
  ].join("\n"), verify: [
    "async ({page, argument}) => page.evaluate(async ({actionKey, input}) =>",
    " (await fetch('/receipt?slot=' + input.slot, {headers:{'Idempotency-Key': actionKey}})).json(), argument)",
  ].join("\n") },
  { id: "confirm", readOnly: true, timeoutMs: 15_000, run: "async ({argument}) => ({receipt: argument.previous.commit})" },
];

type Link = { call<T>(name: string, args: Record<string, unknown>): Promise<T>; close(): Promise<void> };
const links: Link[] = [];
async function connect(): Promise<Link> {
  const socket = new WebSocket("ws://127.0.0.1:" + dashboard.port + AGENT_PATH, AGENT_PROTOCOL,
    { headers: { authorization: "Bearer " + nonce } });
  await new Promise<void>((done, reject) => { socket.once("open", done); socket.once("error", reject); });
  const host = await createVelaBrowserMcp({ discovered: { client: new AgentRuntimeClient(socket) } });
  const client = new Client({ name: "vela-browser-task-acceptance", version: "1" }, { capabilities: {} });
  const [hostTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(hostTransport), client.connect(clientTransport)]);
  const link: Link = {
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      assert.notEqual(result.isError, true, name + " " + JSON.stringify(result.content));
      return (result.structuredContent ?? JSON.parse((result.content as [{ text: string }])[0].text)) as T;
    },
    async close() {
      await client.close();
      await host.close();
      socket.terminate();
    },
  };
  links.push(link);
  return link;
}

async function waitFor<T>(read: () => T | Promise<T>, condition: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  let result: T;
  do {
    result = await read();
    if (condition(result)) return result;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error(label + " " + JSON.stringify(result));
}

const taskTool = "vela_browser_task", replayTool = "vela_browser_replay";
const taskStatus = async (connection: Link, runId: string) =>
  (await connection.call<{ task: BrowserTaskView }>(taskTool, { operation: "status", runId })).task;
const manifest = (runId: string) => {
  const { definition, state, steps, queue, evidenceCount, error } = JSON.parse(readFileSync(join(root, "browser-tasks", runId, "state.json"), "utf8"));
  return { profileId: definition.profileId, state, steps, queue, evidenceCount, error } as
    Pick<BrowserTaskView, "profileId" | "state" | "steps" | "evidenceCount" | "error"> & { queue?: { recoveries: number } };
};
const acceptedRuns: BrowserTaskView[] = [];

try {
  const first = await connect();
  await first.call("vela_browser_open", { profileId: rebuild, startupUrls: [sourceUrl, decoyUrl] });
  const tabs = () => first.call<{ tabs: { url: string; tabId: string }[] }>(replayTool, { action: "tabs", profileId: rebuild });
  const { tabs: live } = await waitFor(tabs, view => view.tabs.some(tab => tab.url === sourceUrl) && view.tabs.some(tab => tab.url === decoyUrl), "Initial browser tabs");
  const initialTab = live.find(tab => tab.url === sourceUrl)!.tabId;
  const plan = { operation: "start_batch", name: "Batch workflow", idempotencyKey: "acceptance-1", startUrl, steps, runs: [
    { profileId: rebuild, tabId: initialTab, argument: { slot: "crash" } },
    { profileId: rebuild, idempotencyKey: "acceptance-follow", argument: { slot: "same-profile" } },
    { profileId: blocked, startUrl: startUrl + "?login=1", argument: { slot: "blocked" } },
    { profileId: independent, argument: { slot: "parallel" } },
    { profileId: "missing-profile", argument: { slot: "invalid" } },
  ] };
  const { runs } = await first.call<{ runs: ({ ok: true; task: BrowserTaskView } | { ok: false; error: { code: string } })[] }>(taskTool, plan);
  const [lostRun, queuedRun, blockedRun, parallelRun] = runs.slice(0, 4).map(item => {
    assert.equal(item.ok, true, JSON.stringify(item));
    return item.task;
  }) as [BrowserTaskView, BrowserTaskView, BrowserTaskView, BrowserTaskView];
  assert.deepEqual(runs[4], { index: 4, ok: false, error: { code: "no_such_profile", message: "The browser task profile was not found" } });
  acceptedRuns.push(lostRun, queuedRun, blockedRun, parallelRun);

  await waitFor(async () => {
    const task = await taskStatus(first, lostRun.runId);
    if (!commits.has("crash") && ["interrupted", "needs_verification", "blocked"].includes(task.state)) {
      throw new Error("The task stopped before submitting " + JSON.stringify(task));
    }
    return task;
  }, () => commits.has("crash"), "The site has accepted the write");
  await waitFor(() => taskStatus(first, parallelRun.runId), state => state.state === "completed", "Independent profile completes while the write is in flight");
  const loginResult = await waitFor(() => taskStatus(first, blockedRun.runId), state => state.state === "blocked", "Only the sign-in profile blocks");
  assert.equal(loginResult.blocked?.code, "authentication_required");
  assert.equal((await taskStatus(first, queuedRun.runId)).state, "queued");
  assert.equal((await taskStatus(first, lostRun.runId)).tabId, initialTab);
  assert.equal(commits.has("blocked") || commits.has("same-profile"), false);

  const original = store.getLaunch(rebuild);
  assert.ok(original);
  await first.close();
  assert.equal(store.getLaunch(rebuild)?.pid, original.pid, "Disconnect leaves the durable browser owned by the task");
  assert.ok(original.pid > 0 && await launcher.certifiedActive(rebuild), "The exact fixture browser still runs after the disconnect");
  assert.equal(manifest(lostRun.runId).state, "running");
  process.kill(original.pid, "SIGKILL");
  const recovered = await waitFor(() => manifest(lostRun.runId), task => task.state === "completed", "Recovery without a connected MCP client");
  assert.ok(recovered.queue && recovered.queue.recoveries >= 1);
  assert.equal(recovered.steps[1]?.attempts, 1);
  assert.equal(commits.get("crash")?.count, 1);
  assert.notEqual(store.getLaunch(rebuild)?.ws, original.ws, "The browser really restarted");
  await waitFor(() => manifest(queuedRun.runId), task => task.state === "completed", "The next same-profile write after reconciliation");

  const second = await connect();
  const after = await taskStatus(second, lostRun.runId);
  assert.notEqual(after.tabId, initialTab);
  const receipt = await second.call<{ base64: string }>(taskTool, {
    operation: "evidence", runId: lostRun.runId, sequence: after.steps[2]?.evidence, part: "value",
  });
  assert.deepEqual(JSON.parse(Buffer.from(receipt.base64, "base64").toString()), { receipt: "receipt-crash" });
  const { skill } = await second.call<{ skill: { id: string } }>(taskTool, { operation: "skill_save", runId: lostRun.runId });
  const { skills } = await second.call<{ skills: { id: string }[] }>(taskTool, { operation: "skill_find", url: startUrl });
  assert.deepEqual(skills.map(item => item.id), [skill.id]);
  const outside = await second.call<{ skills: { id: string }[] }>(taskTool, { operation: "skill_find", url: startUrl + "-other" });
  assert.equal(outside.skills.length, 0);
  await assert.rejects(second.call(replayTool, { action: "play", runId: lostRun.runId }), /Start a replay/);
  const replay = await second.call<{ tabId: string }>(replayTool, { action: "start", runId: lostRun.runId, durationSeconds: 3 });
  assert.equal(replay.tabId, after.tabId);
  await waitFor(() => second.call<{ frameTotal: number }>(replayTool, {
    action: "play", runId: lostRun.runId, fromSecondsAgo: 5, toSecondsAgo: 0, frameCount: 0,
  }), view => view.frameTotal >= 1, "The task's explicitly enabled memory replay");
  await second.call(replayTool, { action: "stop", runId: lostRun.runId });
  await assert.rejects(second.call(replayTool, { action: "play", runId: lostRun.runId }), /Start a replay/);

  assert.equal(await launcher.stop(rebuild), true);
  assert.equal(store.deleteProfile(rebuild), true, "A saved skill can outlive the profile that created it");
  const { schedule } = await second.call<{ schedule: { id: string } }>(taskTool, {
    operation: "schedule_save", name: "Reuse site skill", skillId: skill.id, argument: { slot: "skill" },
    target: { profileIds: [independent] }, schedule: { kind: "manual" },
  });
  const scheduled = await second.call<{ browser: { runs: Array<{ runId: string }> } }>(taskTool, {
    operation: "schedule_run", scheduleId: schedule.id,
  });
  const reused = scheduled.browser.runs[0]!;
  await waitFor(() => taskStatus(second, reused.runId), task => task.state === "completed", "The scheduled site skill runs with fresh inputs");
  assert.equal(commits.get("skill")?.count, 1);
  signIn = false;
  // Loading the fixture again represents the account being repaired outside the task.
  const repaired = store.getLaunch(blocked);
  assert.ok(repaired);
  const connection = await chromium.connectOverCDP(repaired.ws);
  try {
    const tab = connection.contexts()[0]?.pages().find(page => page.url() === startUrl + "?login=1");
    assert.ok(tab);
    await tab.reload();
  } finally { await connection.close(); }
  await second.call(taskTool, { operation: "resume", runId: blockedRun.runId });
  await waitFor(() => taskStatus(second, blockedRun.runId), task => task.state === "completed", "Restored account can resume its queue");
  console.log("Verified MCP disconnect, actual Chromium crash and relaunch, one committed write, profile isolation, observation, skill reuse and opt-in replay.");
} catch (error) {
  console.error("Site writes", [...commits].map(([slot, entry]) => [slot, entry.count]));
  for (const run of acceptedRuns) {
    const task = manifest(run.runId);
    const receipts = Array.from({ length: task.evidenceCount }, (_, index) => {
      const { stepId, phase, error, fault, network } = JSON.parse(readFileSync(join(root, "browser-tasks", run.runId, "evidence-" + (index + 1) + ".json"), "utf8"));
      return { stepId, phase, error, fault, responses: phase === "verify" ? network?.records?.map(({ url, status }: { url: string; status?: number }) => ({ url, status })) : undefined };
    });
    console.error(task.profileId, task.state, task.error ?? "", receipts);
  }
  throw error;
} finally {
  release.resolve();
  await Promise.allSettled(links.map(link => link.close()));
  await dashboard.stop(true);
  const stops = await Promise.all(profiles.map(id => launcher.stop(id)));
  await Promise.all(profiles.map(id => launcher.cacheCleanupSettled(id)));
  await site.stop(true);
  store.close();
  const actual = realpathSync(root);
  if (stops.every(Boolean) && dirname(actual) === temp && actual === root) {
    rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

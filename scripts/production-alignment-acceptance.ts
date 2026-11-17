/** Real Windows Chromium revisions, two isolated desktop workers, and a local site. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { AGENT_PATH, AGENT_PROTOCOL, AgentRuntimeClient } from "../agent/runtime-client.mjs";
import {
  aliasmodeChromiumArchive, aliasmodeChromiumExecutable, chromiumRuntimeRevision, DEFAULT_CHROMIUM_REVISION, ensurePinnedRuntime,
} from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import type { BrowserTaskView } from "../src/browser-tasks.ts";
import { buildNewProfile } from "../src/create.ts";
import { BrowserLaunchError, Launcher } from "../src/launcher.ts";
import { ensureStateDirectories, statePaths } from "../src/paths.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import { ProfileStore } from "../src/store.ts";
import { serveDashboard } from "../src/web.ts";

assert.equal(process.platform, "win32");
const runtimeRoot = resolve(process.argv[2] ?? ".");
const temp = realpathSync(tmpdir());
const previousArchive = resolve(process.argv[3] ?? join(temp, "vela-verified-kernels", "aliasmode-chromium-155.0.8059.85-windows-x64.zip"));
const stable = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
const previous = "155.0.8059.85-aliasmode.4";
const spec = chromiumRuntimeRevision(previous, process.platform, process.arch);
assert.equal(await sha256File(stable), aliasmodeChromiumArchive(process.platform).executableSha256);
assert.equal(await sha256File(previousArchive), spec.archiveSha256);
const root = mkdtempSync(join(temp, "vela-production-qa-"));
const runtime = join(root, "runtimes");
const nodes: Array<ReturnType<typeof node>> = [];
const connections: AgentRuntimeClient[] = [];
let profileId = "";
function node(name: string) {
  const paths = statePaths(join(root, name));
  ensureStateDirectories(paths);
  const store = new ProfileStore(paths.database);
  const launcher = new Launcher({
    store, dataRoot: paths.profiles, headless: true, chromiumRuntimeRoot: runtime, ensureAliasmodeChromium: async () => stable, log() {},
    portRange: name === "source" ? { start: 12600, end: 12649 } : { start: 12900, end: 12949 },
  });
  const nonce = randomBytes(32).toString("hex");
  const server = serveDashboard({ paths, launcher, store, agentNonce: nonce, port: 0, log() {} });
  return { paths, store, launcher, nonce, server };
}
const site = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("<!doctype html><title>Portable state QA</title>", { headers: { "content-type": "text/html" } }),
});
async function connect(target: ReturnType<typeof node>) {
  const socket = new WebSocket("ws://127.0.0.1:" + target.server.port + AGENT_PATH, AGENT_PROTOCOL,
    { headers: { authorization: "Bearer " + target.nonce } });
  await new Promise<void>((ready, reject) => { socket.once("open", ready); socket.once("error", reject); });
  const runtime = new AgentRuntimeClient(socket);
  connections.push(runtime);
  await runtime.call("session.identify", { name: "production-qa" });
  return runtime;
}
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  do {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error("The worker did not finish");
}
const initial = String.raw`async ({page, argument}) => {
  await page.goto(argument);
  return page.evaluate(async () => {
    document.cookie = 'vela_portable=receipt; path=/; Max-Age=600';
    const db = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('portable-proof', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('state');
      opening.onerror = () => reject(opening.error); opening.onsuccess = () => resolve(opening.result);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put('browser-database', 'receipt');
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    await (await caches.open('portable-proof')).put('/cached', new Response('site-cache'));
    return true;
  });
}`;
const check = String.raw`async ({page}) => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('portable-proof', 1);
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
  const stored = await new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get('receipt');
    request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
  db.close();
  const cached = await (await caches.open('portable-proof')).match('/cached');
  const recovered = {
    cookie: document.cookie.includes('vela_portable=receipt'),
    indexedDB: stored === 'browser-database',
    cacheStorage: await cached?.text() === 'site-cache',
  };
  if (Object.values(recovered).includes(false)) {
    throw new Error('Portable state missing: ' + JSON.stringify(recovered));
  }
  return 'restored';
})`;

try {
  await ensurePinnedRuntime(spec, runtime, { async download(_url, output) { copyFileSync(previousArchive, output); } }, process.platform);
  const source = node("source"), target = node("target");
  nodes.push(source, target);
  const profile = buildNewProfile({ name: "Production QA", group: "qa", chromiumRuntime: "aliasmode" }, () => false);
  profileId = profile.id;
  source.store.upsertProfile(profile);
  const peerToken = randomBytes(32).toString("base64url");
  writeFileSync(join(target.paths.root, "worker-nodes.json"), JSON.stringify({ clients: [{ name: "qa", token: peerToken, groups: ["qa"] }] }));
  writeFileSync(join(source.paths.root, "worker-nodes.json"), JSON.stringify({ nodes: {
    target: { url: "http://127.0.0.1:" + target.server.port, token: peerToken },
  } }));
  const controller = await connect(source);
  await source.launcher.start(profileId, [], { headless: true });
  const seed = await runPlaywrightWorker<{ completed: boolean; error?: string }>("devtools-program", {
    endpoint: source.store.getLaunch(profileId)!.ws, code: initial, argument: site.url.href,
  });
  assert.equal(seed.completed, true, seed.error);
  const data = source.launcher.userDataDir(profileId);
  writeFileSync(join(data, "qa-native-file"), "before-upgrade");
  const rollout = await controller.call("kernels.upgrade_batch", { profileIds: [profileId], revision: previous });
  assert.equal(rollout.completed.length, 1);
  assert.equal(source.store.getProfile(profileId)?.kernelRevision, previous);
  assert.equal(basename(dirname(source.store.getLaunch(profileId)!.binaryPath!)), "chromium-" + previous);
  writeFileSync(join(data, "qa-native-file"), "after-upgrade");
  await controller.call("kernels.rollback", { profileId });
  assert.equal(basename(dirname(source.store.getLaunch(profileId)!.binaryPath!)), "chromium-" + DEFAULT_CHROMIUM_REVISION);
  assert.equal(readFileSync(join(data, "qa-native-file"), "utf8"), "before-upgrade");
  console.log("Verified two actual Chromium builds and restored the previous native directory.");

  const handoff = { operation: "handoff", node: "target", profileId, idempotencyKey: "once" };
  const transferred = await Promise.all([controller.call("worker.call", handoff), controller.call("worker.call", handoff)]);
  assert.equal(transferred.filter(result => result.imported).length, 1);
  await assert.rejects(source.launcher.start(profileId),
    error => error instanceof BrowserLaunchError && error.preflightReason === "profile_handed_off");
  const started = await controller.call("worker.call", {
    operation: "task", node: "target", request: {
      operation: "start", idempotencyKey: "verify-state", profileId, startUrl: site.url.href,
      steps: [{ id: "verify", run: check, readOnly: true }],
    },
  }) as { task: BrowserTaskView };
  const completed = await until(async () => {
    const result = await controller.call("worker.call", {
      operation: "task", node: "target", request: { operation: "status", runId: started.task.runId },
    }) as { task: BrowserTaskView };
    return result.task;
  }, task => ["completed", "blocked", "interrupted", "needs_verification"].includes(task.state));
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  console.log("Verified encrypted handoff, source fencing, idempotent adoption, and restored state on a second local worker.");
} finally {
  for (const runtime of connections) runtime.close();
  for (const { server, launcher, store } of nodes) {
    await server.stop(true);
    if (profileId) {
      await launcher.stop(profileId).catch(() => false);
      await launcher.cacheCleanupSettled(profileId);
    }
    store.close();
  }
  await site.stop(true);
  if (existsSync(root) && realpathSync(root) === root && dirname(root) === temp) {
    rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}

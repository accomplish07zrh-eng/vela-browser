/** Real Windows Chromium revisions, two isolated desktop workers, and a local site. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
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
const targetProcess = process.argv[2] === "--worker-process";
const runtimeRoot = resolve(process.argv[targetProcess ? 3 : 2] ?? ".");
const temp = realpathSync(tmpdir());
const previousArchive = resolve(process.argv[3] ?? join(temp, "vela-verified-kernels", "aliasmode-chromium-155.0.8059.85-windows-x64.zip"));
const stable = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
const previous = "155.0.8059.85-aliasmode.4";
const spec = chromiumRuntimeRevision(previous, process.platform, process.arch);
assert.equal(await sha256File(stable), aliasmodeChromiumArchive(process.platform).executableSha256);
if (!targetProcess) assert.equal(await sha256File(previousArchive), spec.archiveSha256);
const root = targetProcess ? realpathSync(process.argv[4]!) : mkdtempSync(join(temp, "vela-production-qa-"));
assert.ok(dirname(root) === temp && basename(root).startsWith("vela-production-qa-"));
const tlsTool = Bun.which("openssl") ?? (process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/openssl.exe") : "openssl");
const runtime = join(root, "runtimes");
const nodes: Array<ReturnType<typeof node>> = [];
let primaryFailure: unknown;
const connections: AgentRuntimeClient[] = [];
let stopTarget: (() => Promise<void>) | undefined;
let profileId = "";
function node(name: string, workerTls?: Bun.TLSOptions) {
  const paths = statePaths(join(root, name));
  ensureStateDirectories(paths);
  const store = new ProfileStore(name === "target" ? paths.database : ":memory:");
  const launcher = new Launcher({
    store, dataRoot: paths.profiles, headless: true, chromiumRuntimeRoot: runtime, ensureAliasmodeChromium: async () => stable, log() {},
    portRange: name === "source" ? { start: 12600, end: 12649 } : { start: 12900, end: 12949 },
  });
  const nonce = randomBytes(32).toString("hex");
  const server = serveDashboard({ paths, launcher, store, agentNonce: nonce, port: 0, workerTls, log() {} });
  return { paths, store, launcher, nonce, server };
}
const targetReceipt = join(root, "target-ready.json");
if (targetProcess) {
  const target = node("target", { key: readFileSync(join(root, "worker.key")), cert: readFileSync(join(root, "worker.pem")) });
  try {
    writeFileSync(targetReceipt, JSON.stringify({ port: target.server.port, pid: process.pid }));
    // The controller closes this pipe to stop the independent Worker.
    await Bun.stdin.stream().getReader().read();
  } finally {
    await target.server.stop(true);
    for (const launch of target.store.listLaunches()) {
      assert.ok(await target.launcher.stop(launch.profileId), "The dedicated Worker releases each browser");
      await target.launcher.cacheCleanupSettled(launch.profileId);
    }
    target.store.close();
  }
  process.exit(0);
}

async function launchTarget() {
  rmSync(targetReceipt, { force: true });
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--worker-process", runtimeRoot, root],
    { stdin: "pipe", stdout: "ignore", stderr: "inherit", timeout: 12 * 60_000 });
  stopTarget = async () => {
    child.stdin.end();
    assert.equal(await child.exited, 0, "The dedicated Worker exited cleanly");
  };
  const receipt = await until(() => {
    if (child.exitCode !== null) throw new Error("The dedicated Worker exited before listening");
    try { return JSON.parse(readFileSync(targetReceipt, "utf8")) as { port: number; pid: number }; }
    catch { return undefined; }
  }, value => value?.pid === child.pid && Number.isSafeInteger(value?.port));
  assert.ok(receipt && receipt.pid !== process.pid);
  return "https://127.0.0.1:" + receipt.port;
}

const site = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response("<!doctype html><title>Portable state QA</title>", { headers: { "content-type": "text/html" } }),
});
async function connect(target: ReturnType<typeof node>, name = "production-qa") {
  const socket = new WebSocket("ws://127.0.0.1:" + target.server.port + AGENT_PATH, AGENT_PROTOCOL,
    { headers: { authorization: "Bearer " + target.nonce } });
  await new Promise<void>((ready, reject) => { socket.once("open", ready); socket.once("error", reject); });
  const runtime = new AgentRuntimeClient(socket);
  connections.push(runtime);
  await runtime.call("session.identify", { name });
  return runtime;
}
async function until<T>(read: () => T | Promise<T>, match: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  do {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error("The worker did not finish");
}
async function verifyReleaseSession(target: ReturnType<typeof node>, ids: [string, string], phase: "seed" | "verify") {
  const descriptor = join(root, "release-session-runtime.json");
  writeFileSync(descriptor, JSON.stringify({ port: target.server.port, nonce: target.nonce }), { mode: 0o600 });
  const check = Bun.spawn([process.execPath, join(import.meta.dir, "desktop-session-acceptance.mjs"),
    descriptor, phase, "chromium", ...ids, site.url.href], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await check.exited, 0, "The desktop release session check completed");
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
  const certFile = join(root, "worker.pem"), keyFile = join(root, "worker.key");
  const certificate = Bun.spawnSync([tlsTool, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile],
  { env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" }, stdout: "ignore", stderr: "pipe" });
  assert.equal(certificate.exitCode, 0, "A temporary TLS fixture certificate could not be made");
  await ensurePinnedRuntime(spec, runtime, { async download(_url, output) { copyFileSync(previousArchive, output); } }, process.platform);
  const source = node("source");
  nodes.push(source);
  const profile = buildNewProfile({ name: "Production QA", group: "qa", chromiumRuntime: "aliasmode" }, () => false);
  profileId = profile.id;
  source.store.upsertProfile(profile);
  const canaryPeer = buildNewProfile({ name: "Canary peer", group: "qa", chromiumRuntime: "aliasmode" }, id => !!source.store.getProfile(id));
  source.store.upsertProfile(canaryPeer);
  const peerToken = randomBytes(32).toString("base64url");
  const targetPaths = statePaths(join(root, "target"));
  ensureStateDirectories(targetPaths);
  writeFileSync(join(targetPaths.root, "worker-nodes.json"), JSON.stringify({
    clients: [{ name: "qa", token: peerToken, groups: ["qa"], agents: ["production-qa", "other-agent"] }],
  }));
  const registerTarget = (url: string) => writeFileSync(join(source.paths.root, "worker-nodes.json"), JSON.stringify({
    nodes: { target: { url, token: peerToken, caFile: certFile } },
  }));
  const targetUrl = await launchTarget();
  registerTarget(targetUrl);
  const controller = await connect(source);
  const other = await connect(source, "other-agent");
  const health = await controller.call("worker.call", { operation: "health", node: "target" });
  assert.equal(health.reachable, true);
  assert.equal(health.status.ready, true);
  const privateDashboard = await fetch(targetUrl, { tls: { ca: readFileSync(certFile, "utf8") } });
  assert.equal(privateDashboard.status, 404);
  await assert.rejects(fetch(targetUrl), "A private certificate must require explicit trust");
  await verifyReleaseSession(source, [profileId, canaryPeer.id], "seed");
  await source.launcher.start(profileId, [], { headless: true });
  const data = source.launcher.userDataDir(profileId);
  writeFileSync(join(data, "qa-native-file"), "before-upgrade");
  const rollout = await controller.call("kernels.upgrade_batch", { profileIds: [profileId, canaryPeer.id], revision: previous, canaryCount: 1 });
  assert.equal(rollout.completed.length, 1);
  assert.equal(rollout.awaitingVerification, true);
  assert.deepEqual(rollout.pending, [canaryPeer.id]);
  assert.equal(source.store.getProfile(canaryPeer.id)?.kernelRevision, undefined);
  assert.equal(source.store.getProfile(profileId)?.kernelRevision, previous);
  assert.equal(basename(dirname(source.store.getLaunch(profileId)!.binaryPath!)), "chromium-" + previous);
  writeFileSync(join(data, "qa-native-file"), "after-upgrade");
  await controller.call("kernels.rollback", { profileId });
  assert.equal(basename(dirname(source.store.getLaunch(profileId)!.binaryPath!)), "chromium-" + DEFAULT_CHROMIUM_REVISION);
  assert.equal(readFileSync(join(data, "qa-native-file"), "utf8"), "before-upgrade");
  assert.ok(await source.launcher.stop(profileId));
  await source.launcher.cacheCleanupSettled(profileId);
  await verifyReleaseSession(source, [profileId, canaryPeer.id], "verify");
  console.log("Verified two actual Chromium builds and restored the previous native directory.");

  await source.launcher.start(profileId, [], { headless: true });
  const seed = await runPlaywrightWorker<{ completed: boolean; error?: string }>("devtools-program", {
    endpoint: source.store.getLaunch(profileId)!.ws, code: initial, argument: site.url.href,
  });
  assert.equal(seed.completed, true, seed.error);
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
  await assert.rejects(other.call("worker.call", { operation: "task", node: "target",
    request: { operation: "status", runId: started.task.runId },
  }));
  await controller.call("worker.call", { operation: "task", node: "target",
    request: { operation: "delegate", runId: started.task.runId, delegates: ["other-agent"] },
  });
  controller.close();
  const reconnected = await connect(source);
  const duplicate = await reconnected.call("worker.call", {
    operation: "task", node: "target", request: {
      operation: "start", idempotencyKey: "verify-state", profileId, startUrl: site.url.href,
      steps: [{ id: "verify", run: check, readOnly: true }],
    },
  }) as { task: BrowserTaskView };
  assert.equal(duplicate.task.runId, started.task.runId);
  const completed = await until(async () => {
    const result = await other.call("worker.call", {
      operation: "task", node: "target", request: { operation: "status", runId: started.task.runId },
    }) as { task: BrowserTaskView };
    return result.task;
  }, task => ["completed", "blocked", "interrupted", "needs_verification"].includes(task.state));
  assert.equal(completed.state, "completed", JSON.stringify(completed));
  assert.equal(completed.client, "production-qa");
  const replayed = await reconnected.call("worker.call", { operation: "handoff", node: "target", profileId, idempotencyKey: "once" });
  assert.equal(replayed.imported, false, "An acknowledged handoff remains idempotent after reconnect");
  const shutdown = stopTarget!;
  stopTarget = undefined;
  await shutdown();
  registerTarget(await launchTarget());
  const restored = await other.call("worker.call", { operation: "task", node: "target",
    request: { operation: "status", runId: started.task.runId },
  }) as { task: BrowserTaskView };
  assert.equal(restored.task.state, "completed", "The delegated task receipt survives a Worker restart");
  const afterRestart = await reconnected.call("worker.call", { operation: "handoff", node: "target", profileId, idempotencyKey: "once" });
  assert.equal(afterRestart.imported, false);
  console.log("Verified authenticated HTTPS, encrypted handoff, source fencing, restored browser state and persistent Agent delegation across separate Worker processes.");
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  for (const runtime of connections) runtime.close();
  try { await stopTarget?.(); }
  catch (error) { primaryFailure ??= error; }
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
    try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); }
    catch (error) {
      if (!primaryFailure) throw error;
      console.error("Could not remove the isolated acceptance fixture after failure");
    }
  }
  if (primaryFailure) throw primaryFailure;
}

/** Measures the local HTTP launch path with disposable profiles and pinned browser binaries. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { aliasmodeChromiumExecutable, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { launchBatchSize, readMemory } from "../src/cooling.ts";
import { buildNewProfile } from "../src/create.ts";
import { captureFingerprint } from "../src/fingerprint-capture.ts";
import { callFirefoxOwner, closeFirefoxOwner, reserveFirefoxOwner, startFirefoxOwner } from "../src/firefox-runtime.ts";
import { Launcher } from "../src/launcher.ts";
import { LifecycleAdmissionController } from "../src/lifecycle-admission.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import { ProfileStore } from "../src/store.ts";
import { serveAutomationApi } from "../src/web.ts";

const { values } = parseArgs({ options: {
  "runtime-root": { type: "string", default: "." },
  engine: { type: "string", default: "chromium" },
  profiles: { type: "string", default: "8" },
  concurrency: { type: "string" },
  report: { type: "string", default: "reports/launch-batch-acceptance.json" },
} });
const count = Number(values.profiles);
const engine = values.engine;
assert.ok(engine === "chromium" || engine === "firefox", "engine must be chromium or firefox");
const concurrency = values.concurrency ? Number(values.concurrency) : launchBatchSize(readMemory(), availableParallelism());
assert.ok(Number.isInteger(count) && count > 0 && count <= 100, "profiles must be an integer between 1 and 100");
assert.ok(Number.isInteger(concurrency) && concurrency > 0, "concurrency must be a positive integer");
const runtimeRoot = resolve(values["runtime-root"]);
const chromium = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
const firefox = engine === "firefox"
  ? JSON.parse(readFileSync(join(runtimeRoot, "src-tauri/generated/browser.json"), "utf8")).firefox : undefined;
const executable = firefox ? join(runtimeRoot, "src-tauri/resources/firefox", firefox.executable) : chromium;
const binarySha256 = firefox?.sha256 ?? ALIASMODE_CHROMIUM_EXECUTABLE_SHA256;
assert.equal(await sha256File(executable), binarySha256, "Use the pinned Vela browser runtime");
const output = resolve(values.report);
mkdirSync(dirname(output), { recursive: true });
const directory = realpathSync(dirname(output));
const dataRoot = mkdtempSync(join(directory, "launch-batch-qa-"));
const store = new ProfileStore(":memory:");
interface Timing { spawned?: number; connected?: number; fingerprintMs?: number }
const events = new Map<string, Timing>();
const launcher = new Launcher({
  store, dataRoot, headless: true,
  ensureAliasmodeChromium: async () => chromium,
  ...(firefox ? { firefoxBinaryPath: executable, expectedFirefoxBinarySha256: binarySha256 } : {}),
  firefoxRuntime: {
    reserve: reserveFirefoxOwner, call: callFirefoxOwner, close: closeFirefoxOwner,
    async start(input, callbacks) {
      const timing = events.get(input.profileId);
      if (timing) timing.spawned = performance.now();
      const owner = await startFirefoxOwner(input, callbacks);
      if (timing) timing.connected = performance.now();
      return owner;
    },
  },
  async captureFingerprint(ws) {
    const launch = store.listLaunches().find(launch => launch.debugPort === Number(new URL(ws).port));
    const timing = launch && events.get(launch.profileId);
    const from = performance.now();
    try { return await captureFingerprint(ws); }
    finally { if (timing) timing.fingerprintMs = Math.round(performance.now() - from); }
  },
  log(line) {
    const stage = /^(\S+): launch stage (browser spawned|CDP ready)$/.exec(line);
    if (stage) {
      const key = stage[2] === "browser spawned" ? "spawned" : "connected";
      const timing = events.get(stage[1]!);
      if (timing) timing[key] = performance.now();
    }
  },
});
const admission = new LifecycleAdmissionController();
const server = serveAutomationApi({ store, launcher, port: 0, lifecycleAdmission: admission, log: () => {} });
let seedSession = true;
const site = engine === "firefox" ? Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const profile = new URL(req.url).pathname.slice(1);
  return new Response("<!doctype html><title>Local session fixture</title>", { headers: {
    "Content-Type": "text/html", "Cache-Control": "no-store",
    ...(seedSession && /^\d+$/.test(profile) ? { "Set-Cookie": "vela_qa_session=" + profile + "; Path=/" } : {}),
  } });
} }) : undefined;
const ids = Array.from({ length: count }, (_, index) => {
  const profile = buildNewProfile({ engine, ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}), screen: "1280x800",
    name: "Batch QA " + (index + 1) }, id => !!store.getProfile(id));
  store.upsertProfile(profile);
  return profile.id;
});
const base = "http://127.0.0.1:" + server.port;
const ms = (value: number) => Math.round(value);
const mib = (bytes: number) => Math.round(bytes / 1048576);
const runs = [];
const seededProfiles = new Set<number>();
let cleanedUp = false;
try {
  for (const label of ["fresh", "reopen"]) {
    const start = performance.now();
    const startFree = readMemory().available;
    let minimumFree = startFree;
    let peakConcurrent = 0;
    const monitor = setInterval(() => {
      minimumFree = Math.min(minimumFree, readMemory().available);
      peakConcurrent = Math.max(peakConcurrent, admission.stats().byKind.start.inFlight);
    }, 150);
    const loaded: Array<{ index: number; ok: boolean; error?: string; queueMs: number; totalMs: number;
      requestMs: number; toSpawnMs?: number; spawnToControlMs?: number; controlToReadyMs?: number; fingerprintMs?: number }> = [];
    let next = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
        while (next < ids.length) {
          const index = next++;
          const id = ids[index]!;
          const dispatched = performance.now();
          const entry: Timing = {};
          events.set(id, entry);
          let error: string | undefined;
          try {
            const response = await fetch(base + "/api/v2/browser-profile/start", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profile_id: id, headless: "1",
                ...(site && label === "fresh" ? { launch_args: [site.url.origin + "/" + index] } : {}) }),
            });
            const body = await response.json() as { code: number; msg: string; data: { engine?: string; ws?: { puppeteer?: string } } };
            const connectionReady = engine === "firefox" ? body.data?.engine === "firefox" : !!body.data?.ws?.puppeteer;
            if (body.code !== 0 || !connectionReady) error = body.code !== 0 ? body.msg : "Browser connection missing";
          } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
          const ready = performance.now();
          loaded.push({
            index, ok: error === undefined, ...(error ? { error } : {}),
            queueMs: ms(dispatched - start), totalMs: ms(ready - start), requestMs: ms(ready - dispatched),
            ...(entry.spawned !== undefined ? { toSpawnMs: ms(entry.spawned - dispatched) } : {}),
            ...(entry.connected !== undefined && entry.spawned !== undefined ? {
              spawnToControlMs: ms(entry.connected - entry.spawned), controlToReadyMs: ms(ready - entry.connected),
            } : {}),
            ...(entry.fingerprintMs === undefined ? {} : { fingerprintMs: entry.fingerprintMs }),
          });
        }
      }));
    } finally { clearInterval(monitor); }
    const successful = loaded.filter(item => item.ok);
    const elapsed = successful.map(item => item.totalMs).sort((a, b) => a - b);
    const run = {
      label, wallMs: ms(performance.now() - start), firstReadyMs: elapsed[0] ?? null,
      p95ReadyMs: elapsed[Math.ceil(elapsed.length * 0.95) - 1] ?? null,
      peakConcurrent, startFreeMiB: mib(startFree), minFreeMiB: mib(minimumFree),
      successful: successful.length, failures: loaded.length - successful.length, profiles: loaded.sort((a, b) => a.index - b.index),
    };
    runs.push(run);
    console.log(JSON.stringify({ ...run, profiles: undefined }));
    if (site) {
      seedSession = false;
      if (label === "fresh") {
        for (const item of successful) seededProfiles.add(item.index);
      } else {
        for (const index of successful.map(item => item.index).filter(index => seededProfiles.has(index))) {
          const endpoint = store.getLaunch(ids[index]!)!.ws;
          const cookies: string[] = await runPlaywrightWorker<string[]>("page", {
            endpoint, kind: "scripts", temporary: true, url: site.url.origin + "/check", scripts: ["document.cookie"],
          });
          assert.equal(cookies[0], "vela_qa_session=" + index, "Firefox session cookie survives the batch reopen");
        }
      }
    }
    for (const id of ids) await launcher.stop(id);
    assert.equal(store.listLaunches().length, 0, "All QA browsers must close before the next run");
    await Promise.all(ids.map(id => launcher.cacheCleanupSettled(id)));
  }
  cleanedUp = true;
  if (runs.some(run => run.failures)) process.exitCode = 1;
} finally {
  server.stop(true);
  site?.stop(true);
  for (const id of ids) await launcher.stop(id).catch(() => false);
  await Promise.all(ids.map(id => launcher.cacheCleanupSettled(id)));
  const target = realpathSync(dataRoot);
  if (cleanedUp && dirname(target) === directory && basename(target).startsWith("launch-batch-qa-")) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
  store.close();
  writeFileSync(output, JSON.stringify({ platform: process.platform, engine, binarySha256,
    profiles: count, concurrency, generatedAt: new Date().toISOString(), runs }, null, 2) + "\n");
}

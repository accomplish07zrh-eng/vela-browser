/** Measures the local HTTP launch path with disposable profiles and pinned browser binaries. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openCdp } from "../agent/chromium-fingerprint.mjs";
import { aliasmodeChromiumExecutable, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { HostWorkBudget, readMemory } from "../src/cooling.ts";
import { availableParallelism } from "node:os";
import { buildNewProfile } from "../src/create.ts";
import { captureFingerprint } from "../src/fingerprint-capture.ts";
import { Launcher } from "../src/launcher.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import { ProfileStore } from "../src/store.ts";
import { LifecycleAdmissionController } from "../src/lifecycle-admission.ts";
import { serveAutomationApi } from "../src/web.ts";

const { values } = parseArgs({ options: {
  "runtime-root": { type: "string", default: "." },
  engine: { type: "string", default: "chromium" },
  profiles: { type: "string", default: "8" },
  concurrency: { type: "string" },
  "close-after-ready": { type: "boolean" },
  "fresh-only": { type: "boolean" },
  "soak-seconds": { type: "string", default: "0" },
  "sample-seconds": { type: "string", default: "60" },
  "adspower-url": { type: "string" },
  "first-action": { type: "boolean" },
  visible: { type: "boolean" },
  report: { type: "string", default: "reports/launch-batch-acceptance.json" },
} });
const count = Number(values.profiles);
const closeAfterReady = values["close-after-ready"] === true;
const soakSeconds = Number(values["soak-seconds"]), sampleSeconds = Number(values["sample-seconds"]);
const engine = values.engine;
const headless = !values.visible;
const adsOrigin = values["adspower-url"] ? new URL(values["adspower-url"]) : undefined;
if (adsOrigin) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(adsOrigin.hostname) && ["http:", "https:"].includes(adsOrigin.protocol)
    && !adsOrigin.username && !adsOrigin.password && adsOrigin.pathname === "/" && !adsOrigin.search && !adsOrigin.hash,
  "AdsPower comparison uses a loopback API origin");
  assert.equal(engine, "chromium", "AdsPower comparison uses its Chrome kernel");
}
assert.ok(engine === "chromium" || engine === "firefox" || engine === "mixed", "engine must be chromium, firefox or mixed");
const engineFor = (index: number) => engine === "mixed" ? (index % 2 === 0 ? "chromium" : "firefox") : engine;
const hostWork = new HostWorkBudget(availableParallelism());
const admission = new LifecycleAdmissionController({ hostWork });
const concurrency = values.concurrency ? Number(values.concurrency) : Math.max(1, hostWork.status().limit);
assert.ok(Number.isInteger(count) && count > 0 && count <= 100, "profiles must be an integer between 1 and 100");
assert.ok(Number.isInteger(concurrency) && concurrency > 0, "concurrency must be a positive integer");
assert.ok(Number.isSafeInteger(soakSeconds) && soakSeconds >= 0 && Number.isSafeInteger(sampleSeconds) && sampleSeconds >= 1, "Use whole-second soak and sample intervals");
assert.ok(!soakSeconds || !closeAfterReady, "A resident soak cannot close profiles during admission");
const runtimeRoot = resolve(values["runtime-root"]);
const chromium = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
const firefox = engine !== "chromium"
  ? JSON.parse(readFileSync(join(runtimeRoot, "src-tauri/generated/browser.json"), "utf8")).firefox : undefined;
const firefoxExecutable = firefox ? join(runtimeRoot, "src-tauri/resources/firefox", firefox.executable) : undefined;
const binarySha256 = engine === "mixed" ? { chromium: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, firefox: firefox.sha256 }
  : firefox?.sha256 ?? ALIASMODE_CHROMIUM_EXECUTABLE_SHA256;
if (!adsOrigin && engine !== "firefox") assert.equal(await sha256File(chromium), ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, "Use the pinned Vela Chromium");
if (firefoxExecutable) assert.equal(await sha256File(firefoxExecutable), firefox.sha256, "Use the pinned Vela Firefox");
const output = resolve(values.report);
mkdirSync(dirname(output), { recursive: true });
const directory = realpathSync(dirname(output));
const dataRoot = mkdtempSync(join(directory, "launch-batch-qa-"));
const store = new ProfileStore(":memory:");
interface FirefoxStartupTiming { verifyMs: number; runtimeMs: number; browserMs: number; identifyMs: number }
interface Timing { spawned?: number; connected?: number; fingerprintMs?: number; serverQueueMs?: number; firstActionMs?: number; warmupQueueMs?: number; firefoxStartup?: FirefoxStartupTiming }
const events = new Map<string, Timing>();
const launcher = new Launcher({
  store, dataRoot, headless,
  ensureAliasmodeChromium: async () => chromium,
  ...(firefoxExecutable ? { firefoxBinaryPath: firefoxExecutable, expectedFirefoxBinarySha256: firefox.sha256 } : {}),
  async captureFingerprint(ws) {
    const launch = store.listLaunches().find(launch => launch.debugPort === Number(new URL(ws).port));
    const timing = launch && events.get(launch.profileId);
    const from = performance.now();
    try { return await captureFingerprint(ws); }
    finally { if (timing) timing.fingerprintMs = Math.round(performance.now() - from); }
  },
  log(line) {
    const warmup = /^(\S+): Firefox warmup queue ([\d.]+)ms$/.exec(line);
    if (warmup && events.has(warmup[1]!)) events.get(warmup[1]!)!.warmupQueueMs = Number(warmup[2]);
    const startup = /^(\S+): Firefox launch timings verify=(\d+) runtime=(\d+) browser=(\d+) identify=(\d+)ms$/.exec(line);
    if (startup && events.has(startup[1]!)) events.get(startup[1]!)!.firefoxStartup = {
      verifyMs: Number(startup[2]), runtimeMs: Number(startup[3]), browserMs: Number(startup[4]), identifyMs: Number(startup[5]),
    };
    const stage = /^(\S+): launch stage (browser spawned|CDP ready)$/.exec(line);
    if (stage) {
      const key = stage[2] === "browser spawned" ? "spawned" : "connected";
      const timing = events.get(stage[1]!);
      if (timing) timing[key] = performance.now();
    }
  },
});
const server = !adsOrigin ? serveAutomationApi({ store, launcher, port: 0, lifecycleAdmission: admission, log: () => {} }) : undefined;
let seedSession = true;
const site = values["first-action"] || engine !== "chromium" || soakSeconds > 0 ? Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const profile = new URL(req.url).pathname.slice(1);
  return new Response("<!doctype html><title>Local session fixture</title>", { headers: {
    "Content-Type": "text/html", "Cache-Control": "no-store",
    ...(seedSession && /^\d+$/.test(profile) ? { "Set-Cookie": "vela_qa_session=" + profile + "; Path=/; Max-Age=172800" } : {}),
  } });
} }) : undefined;
const ids: string[] = [];
const externalProfiles = new Set<string>();
const externalRunning = new Set<string>();
const endpoints = new Map<string, string>();
const base = server?.url.origin;
const fixtureLabel = "Vela Resident QA " + randomUUID().slice(0, 8);
let nextAdsRequest = 0;
let adsRequestsInFlight = 0;
let adsVersion: string | undefined;
async function adsRequest<T>(operation: string, body: object, timeout = 180_000): Promise<T> {
  const slot = Math.max(nextAdsRequest, Date.now());
  nextAdsRequest = slot + 1000;
  if (slot > Date.now()) await Bun.sleep(slot - Date.now());
  const key = process.env.ADSPOWER_LOCAL_API_KEY;
  adsRequestsInFlight++;
  try {
    const response = await fetch(new URL("/api/v2/browser-profile/" + operation, adsOrigin), {
      method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: "Bearer " + key } : {}) },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeout),
    });
    const result = await response.json() as { code: number; msg: string; data: T };
    if (!response.ok || result.code !== 0) throw new Error("AdsPower " + operation + " failed: " + result.msg);
    return result.data;
  } finally { adsRequestsInFlight--; }
}

async function startProfile(index: number, id: string, label: string) {
  if (adsOrigin) {
    externalRunning.add(id);
    const data = await adsRequest<{ ws: { puppeteer: string } }>("start", {
      profile_id: id, headless: headless ? "1" : "0", last_opened_tabs: "1", proxy_detection: "0", delete_cache: "0",
    });
    const endpoint = new URL(data.ws?.puppeteer);
    assert.ok(endpoint.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "AdsPower must return a loopback CDP endpoint");
    endpoints.set(id, endpoint.href);
    return;
  }
  const params = new URLSearchParams({ user_id: id });
  if (site && label === "fresh") params.set("launch_args", JSON.stringify([site.url.origin + "/" + index]));
  const response = await fetch(base + "/api/v1/browser/start?" + params);
  const queue = response.headers.get("server-timing")?.match(/vela_queue;dur=([\d.]+)/)?.[1];
  if (queue && events.has(id)) events.get(id)!.serverQueueMs = Number(queue);
  const result = await response.json() as { code: number; msg: string; data: { engine?: string; ws?: { puppeteer?: string } } };
  if (result.code !== 0) throw new Error(result.msg);
  const ready = engineFor(index) === "firefox" ? result.data?.engine === "firefox" : !!result.data?.ws?.puppeteer;
  if (!ready) throw new Error("Browser connection missing");
}

async function firstAction(id: string) {
  const endpoint = adsOrigin ? endpoints.get(id) : store.getLaunch(id)?.ws;
  assert.ok(endpoint, "First action requires an attached browser");
  const receipt = await runPlaywrightWorker<{ completed: boolean; value?: string; error?: string }>("devtools-program", {
    endpoint, code: "async ({ context }) => { const page = context.pages().find(p => p.url().startsWith('http://127.0.0.1:')); return page && await page.title(); }",
  }, { timeoutMs: 15_000 });
  assert.equal(receipt.completed, true, receipt.error);
  assert.equal(receipt.value, "Local session fixture");
}

async function stopProfile(id: string) {
  if (adsOrigin) {
    if (!externalRunning.has(id)) return;
    await adsRequest("stop", { profile_id: id });
    externalRunning.delete(id);
    endpoints.delete(id);
    return;
  }
  const closed = await fetch(base + "/api/v1/browser/stop?user_id=" + id);
  const result = await closed.json() as { code: number; msg: string };
  assert.equal(result.code, 0, result.msg);
  await launcher.cacheCleanupSettled(id);
}
const ms = (value: number) => Math.round(value);
const mib = (bytes: number) => Math.round(bytes / 1048576);
function availableDisk(): number | undefined {
  try {
    const stats = statfsSync(directory);
    return stats.bavail * stats.bsize;
  } catch { return undefined; }
}
const runs = [];
const seededProfiles = new Set<number>();
const checkCookie = async (index: number, id: string) => {
  if (!site || !seededProfiles.has(index)) return;
  const endpoint = adsOrigin ? endpoints.get(id)! : store.getLaunch(id)!.ws;
  if (engineFor(index) === "chromium") {
    const cdp = await openCdp(endpoint, 8_000);
    try {
      const deadline = Date.now() + 4000;
      do {
        if (adsOrigin && adsVersion === undefined) adsVersion = (await cdp.send("Browser.getVersion")).product;
        const { cookies } = await cdp.send("Storage.getCookies");
        const session = cookies.find((item: { name: string; domain: string }) => item.name === "vela_qa_session" && item.domain === site.url.hostname);
        if (session?.value === String(index)) return;
        await Bun.sleep(200);
      } while (Date.now() < deadline);
      throw new Error("The resident browser did not retain its unique session cookie");
    } finally { cdp.close(); }
  }
  const cookies: string[] = await runPlaywrightWorker<string[]>("page", {
    endpoint, kind: "scripts", temporary: true, url: site.url.origin + "/check", scripts: ["document.cookie"],
  });
  assert.equal(cookies[0], "vela_qa_session=" + index, "Each live browser keeps its own session cookie");
};
async function residentSoak(indices: number[]) {
  const started = performance.now(), deadline = started + soakSeconds * 1000;
  const samples: Array<{ elapsedMs: number; resident: number; verified: number; freeMiB: number; failures: Array<{ index: number; error: string }> }> = [];
  let failure: string | undefined;
  let recoveryMs: number | undefined;
  try {
    const sample = async () => {
      const waiting = indices.values();
      let verified = 0;
      const failures: Array<{ index: number; error: string }> = [];
      await Promise.all(Array.from({ length: Math.min(2, indices.length) }, async () => {
        for (const index of waiting) {
          try {
            const id = ids[index]!;
            if (!adsOrigin && !await launcher.certifiedActive(id)) {
              await Bun.sleep(500);
              assert.ok(await launcher.certifiedActive(id), "The test browser stopped answering");
            }
            await checkCookie(index, id);
            verified++;
          } catch (error) { failures.push({ index, error: error instanceof Error ? error.message : String(error) }); }
        }
      }));
      const freeMiB = mib(readMemory().available);
      samples.push({ elapsedMs: ms(performance.now() - started), resident: adsOrigin ? endpoints.size : store.listLaunches().length, verified, freeMiB, failures });
      if (freeMiB < 1536) throw new Error("The host's remaining memory dropped below the launch reserve");
      if (failures.length) throw new Error("Browser health checks failed for " + failures.length + " resident profiles");
    };
    assert.equal(indices.length, count, "The host must sustain the requested resident count");
    await sample();
    const id = ids[indices[0]!]!;
    const recovering = performance.now();
    if (adsOrigin) {
      await stopProfile(id);
      await startProfile(indices[0]!, id, "reopen");
    } else {
      const launch = store.getLaunch(id);
      assert.ok(launch && launch.pid > 0 && await launcher.certifiedActive(id), "Recycle only a browser of this fixture");
      await launcher.captureLocalSession(id);
      assert.ok(await launcher.stop(id, launch));
      await startProfile(indices[0]!, id, "reopen");
    }
    await checkCookie(indices[0]!, id);
    recoveryMs = ms(performance.now() - recovering);
    do {
      const remaining = deadline - performance.now();
      if (remaining > 0) await Bun.sleep(Math.min(remaining, sampleSeconds * 1000));
      await sample();
      if (samples.length % 10 === 0) console.log(engine + " resident soak " + samples.length + " samples");
    } while (performance.now() < deadline);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return { requestedSeconds: soakSeconds, elapsedMs: ms(performance.now() - started), recoveryMs, samples, failure };
}
try {
  if (adsOrigin) {
    const status = await fetch(adsOrigin, { signal: AbortSignal.timeout(3000), redirect: "error" });
    await status.body?.cancel();
  }
  for (let index = 0; index < count; index++) {
    if (adsOrigin) {
      const created = await adsRequest<{ profile_id: string }>("create", {
        name: fixtureLabel + " " + index, group_id: "0", repeat_config: [0], user_proxy_config: { proxy_soft: "no_proxy" },
        fingerprint_config: { screen_resolution: "1280_800", browser_kernel_config: { type: "chrome", version: "ua_auto" } },
        ...(site ? { tabs: [site.url.origin + "/" + index] } : {}),
      });
      assert.ok(typeof created.profile_id === "string" && /^[a-zA-Z0-9_-]+$/.test(created.profile_id) && !externalProfiles.has(created.profile_id),
        "AdsPower must return a new fixture profile ID");
      externalProfiles.add(created.profile_id);
      ids.push(created.profile_id);
    } else {
      const engine = engineFor(index);
      const profile = buildNewProfile({ engine, ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}), screen: "1280x800",
        name: fixtureLabel + " " + index }, id => !!store.getProfile(id));
      store.upsertProfile(profile);
      ids.push(profile.id);
    }
  }
  for (const label of values["fresh-only"] ? ["fresh"] : ["fresh", "reopen"]) {
    const start = performance.now();
    const startFree = readMemory().available;
    const startDiskFree = availableDisk();
    let minimumFree = startFree;
    let minimumDiskFree = startDiskFree;
    let peakConcurrent = 0;
    let peakOpen = 0;
    const monitor = setInterval(() => {
      minimumFree = Math.min(minimumFree, readMemory().available);
      if (minimumDiskFree !== undefined) minimumDiskFree = Math.min(minimumDiskFree, availableDisk() ?? minimumDiskFree);
      peakConcurrent = Math.max(peakConcurrent, adsOrigin ? adsRequestsInFlight : admission.stats().byKind.start.inFlight);
      peakOpen = Math.max(peakOpen, adsOrigin ? endpoints.size : store.listLaunches().length);
    }, 150);
    const loaded: Array<{ index: number; ok: boolean; error?: string; queueMs: number; totalMs: number;
      requestMs: number; serverQueueMs?: number; toSpawnMs?: number; spawnToControlMs?: number; controlToReadyMs?: number;
      apiToFirstActionMs?: number; firstActionMs?: number; fingerprintMs?: number; warmupQueueMs?: number; firefoxStartup?: FirefoxStartupTiming }> = [];
    let next = 0;
    try {
      const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, count) }, async () => {
        while (next < ids.length) {
          if ((closeAfterReady || soakSeconds) && readMemory().available < 1536 * 1048576) {
            const deadline = Date.now() + 30_000;
            while (readMemory().available < 1536 * 1048576 && Date.now() < deadline) await Bun.sleep(250);
            if (readMemory().available < 1536 * 1048576) {
              for (const index of Array.from({ length: ids.length - next }, () => next++)) {
                loaded.push({ index, ok: false, error: "Host memory reserve reached", queueMs: 0, totalMs: ms(performance.now() - start), requestMs: 0 });
              }
              break;
            }
          }
          if (next >= ids.length) break;
          const index = next++;
          const id = ids[index]!;
          const dispatched = performance.now();
          const entry: Timing = {};
          events.set(id, entry);
          let error: string | undefined;
          try {
            await startProfile(index, id, label);
          } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
          const ready = performance.now();
          if (error === undefined && values["first-action"]) {
            try { await firstAction(id); entry.firstActionMs = performance.now(); }
            catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
          }
          loaded.push({
            index, ok: error === undefined, ...(error ? { error } : {}),
            queueMs: ms(dispatched - start), totalMs: ms(ready - start), requestMs: ms(ready - dispatched),
            ...(entry.serverQueueMs !== undefined ? { serverQueueMs: entry.serverQueueMs } : {}),
            ...(entry.warmupQueueMs !== undefined ? { warmupQueueMs: entry.warmupQueueMs } : {}),
            ...(entry.spawned !== undefined ? { toSpawnMs: ms(Math.max(0, entry.spawned - dispatched - (entry.serverQueueMs ?? 0) - (entry.warmupQueueMs ?? 0))) } : {}),
            ...(entry.connected !== undefined && entry.spawned !== undefined ? {
              spawnToControlMs: ms(entry.connected - entry.spawned), controlToReadyMs: ms(ready - entry.connected),
            } : {}),
            ...(entry.fingerprintMs === undefined ? {} : { fingerprintMs: entry.fingerprintMs }),
            ...(entry.firefoxStartup ? { firefoxStartup: entry.firefoxStartup } : {}),
            ...(entry.firstActionMs === undefined ? {} : { apiToFirstActionMs: ms(entry.firstActionMs - ready), firstActionMs: ms(entry.firstActionMs - start) }),
          });
          if (loaded.length % 10 === 0) console.log(`${engine} ${label} ${loaded.length}/${count} ready or failed`);
          if (closeAfterReady) {
            if (label === "reopen" && error === undefined) await checkCookie(index, id);
            await stopProfile(id);
          }
        }
      }));
      const failed = settled.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    } finally { clearInterval(monitor); }
    const successful = loaded.filter(item => item.ok);
    const elapsed = successful.map(item => item.totalMs).sort((a, b) => a - b);
    const p95 = (key: keyof (typeof loaded)[number]) => {
      const samples = successful.flatMap(item => typeof item[key] === "number" ? [item[key] as number] : []).sort((a, b) => a - b);
      return samples[Math.ceil(samples.length * 0.95) - 1] ?? null;
    };
    const run = {
      label, wallMs: ms(performance.now() - start), firstReadyMs: elapsed[0] ?? null,
      p95ReadyMs: elapsed[Math.ceil(elapsed.length * 0.95) - 1] ?? null,
      p95RequestMs: p95("requestMs"), p95ClientQueueMs: p95("queueMs"), p95ServerQueueMs: p95("serverQueueMs"),
      p95ToSpawnMs: p95("toSpawnMs"), p95WarmupQueueMs: p95("warmupQueueMs"),
      p95SpawnToControlMs: p95("spawnToControlMs"), p95FirstActionMs: p95("firstActionMs"),
      peakConcurrent, peakOpen, startFreeMiB: mib(startFree), minFreeMiB: mib(minimumFree),
      ...(startDiskFree !== undefined && minimumDiskFree !== undefined ? {
        startDiskFreeMiB: mib(startDiskFree), minDiskFreeMiB: mib(minimumDiskFree),
      } : {}),
      successful: successful.length, failures: loaded.length - successful.length, profiles: loaded.sort((a, b) => a.index - b.index),
      soak: undefined as Awaited<ReturnType<typeof residentSoak>> | undefined,
      afterCloseFreeMiB: undefined as number | undefined,
    };
    runs.push(run);
    console.log(JSON.stringify({ ...run, profiles: undefined }));
    if (site) {
      seedSession = false;
      if (label === "fresh") {
        for (const item of successful) seededProfiles.add(item.index);
      } else if (!closeAfterReady) {
        for (const index of successful.map(item => item.index).filter(index => seededProfiles.has(index))) {
          await checkCookie(index, ids[index]!);
        }
      }
    }
    if (soakSeconds && label === "fresh") {
      run.soak = await residentSoak(successful.map(item => item.index));
      console.log(JSON.stringify({ soak: run.soak }));
    }
    for (const id of ids) await stopProfile(id);
    assert.equal(store.listLaunches().length, 0, "All QA browsers must close before the next run");
    await Promise.all(ids.map(id => launcher.cacheCleanupSettled(id)));
    run.afterCloseFreeMiB = mib(readMemory().available);
  }
  if (runs.some(run => run.failures || run.soak?.failure)) process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  for (const id of ids) {
    try {
      if (adsOrigin) await stopProfile(id);
      else if (!await launcher.stop(id)) cleanupErrors.push("Could not confirm fixture closure for " + id);
    } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  const disposable = [...externalProfiles].filter(id => !externalRunning.has(id));
  if (disposable.length) {
    try { await adsRequest("delete", { profile_id: disposable }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  await server?.stop(true);
  await site?.stop(true);
  await Promise.all(ids.map(id => launcher.cacheCleanupSettled(id)));
  const target = realpathSync(dataRoot);
  const allClosed = store.listLaunches().length === 0;
  store.close();
  writeFileSync(output, JSON.stringify({ platform: process.platform, engine,
    ...(adsOrigin ? { backend: "adspower", browserVersion: adsVersion, requestSpacingMs: 1000 } : { backend: "vela", binarySha256 }),
    profiles: count, concurrency, closeAfterReady, headless, generatedAt: new Date().toISOString(), runs, cleanupErrors }, null, 2) + "\n");
  if (cleanupErrors.length) {
    for (const error of cleanupErrors) console.error(error);
    process.exitCode = 1;
  }
  if (allClosed && dirname(target) === directory && basename(target).startsWith("launch-batch-qa-")) {
    rmSync(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
}

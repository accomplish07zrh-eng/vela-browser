/** Real engines, fresh profiles, local-only fixture. No third-party account or user profile is used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { ProfileStore } from "../src/store.ts";
import { Launcher } from "../src/launcher.ts";
import { buildNewProfile } from "../src/create.ts";
import { fingerprintProbe } from "../src/diagnose.ts";
import { fingerprintAudit } from "../src/fingerprint-audit.ts";
import { fingerprintContextProbe, type FingerprintContextSample } from "../src/fingerprint-contexts.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import { compareAttestation } from "../src/fingerprint-attestation.ts";
import { fingerprintDocument } from "../playwright-worker.mjs";
import type { ProfileEngine, ObservedFingerprint } from "../src/types.ts";
import { ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, aliasmodeChromiumExecutable } from "../src/aliasmode-chromium.ts";
import { WEBKIT_EXECUTABLE_SHA256 } from "../src/webkit-install.ts";

const { values } = parseArgs({ options: {
  "runtime-root": { type: "string", default: "." },
  engine: { type: "string", multiple: true, default: ["chromium", "firefox", "webkit"] },
  report: { type: "string", default: "reports/fingerprint-acceptance.json" },
} });
const engines = [...new Set(values.engine)].map((engine): ProfileEngine => {
  if (engine === "chromium" || engine === "firefox" || engine === "webkit") return engine;
  throw new Error("Unknown engine " + engine);
});
const runtimeRoot = resolve(values["runtime-root"]);
const firefoxMetadata = engines.includes("firefox")
  ? JSON.parse(readFileSync(join(runtimeRoot, "src-tauri/generated/browser.json"), "utf8")).firefox : undefined;
const firefox = firefoxMetadata ? join(runtimeRoot, "src-tauri/resources/firefox", firefoxMetadata.executable) : "";
const chromium = aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium"));
const webkit = join(runtimeRoot, "reports/webkit-native-2388/Playwright.exe");
const binaries = { chromium, firefox, webkit };
const expected = { chromium: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, firefox: firefoxMetadata?.sha256, webkit: WEBKIT_EXECUTABLE_SHA256 };
for (const engine of engines) {
  const executable = binaries[engine];
  assert.ok(existsSync(executable), "Pinned runtime is missing at " + executable);
  assert.equal(createHash("sha256").update(readFileSync(executable)).digest("hex"), expected[engine], "Pinned " + engine + " executable hash");
}
mkdirSync(resolve("reports"), { recursive: true });
const root = mkdtempSync(resolve("reports/fingerprint-acceptance-"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
const report: { root: string; generatedAt: string; checks: { name: string; pass: boolean; details?: unknown }[]; engines: Record<string, any>; fatal?: string } = { root, generatedAt: new Date().toISOString(), checks: [], engines: {} };
const probe = fingerprintProbe.toString();
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const headers = { "cache-control": "no-store", "content-type": "text/html;charset=utf-8",
    "accept-ch": "Sec-CH-UA-Platform-Version" };
  if (path === "/request-identity") {
    return Response.json(Object.fromEntries(["user-agent", "accept-language", "sec-ch-ua-platform", "sec-ch-ua-platform-version"]
      .map(key => [key, request.headers.get(key)])), { headers: { "cache-control": "no-store" } });
  }
  if (path === "/frame") return new Response(`<!doctype html><meta charset=utf-8><script>(${probe})({details:true}).then(sample=>parent.postMessage({type:'vela-fingerprint-sample',sample},'*'),error=>parent.postMessage({type:'vela-fingerprint-sample',error:String(error)},'*'))</script>`, { headers });
  if (path === "/service-worker.js") return new Response(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil((${probe})({details:true}).then(sample=>event.ports[0].postMessage({sample}),error=>event.ports[0].postMessage({error:String(error)}))));`, { headers: { ...headers, "content-type": "text/javascript", "service-worker-allowed": "/" } });
  return new Response(fingerprintDocument(`(${fingerprintContextProbe.toString()})(${JSON.stringify(probe)},${JSON.stringify(new URL(request.url).origin)})`), { headers });
} });
const origin = `http://127.0.0.1:${fixture.port}`;
const launcher = new Launcher({
  store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"), headless: true,
  portRange: { start: 13300, end: 13349 },
  ...(firefoxMetadata ? { firefoxBinaryPath: firefox, expectedFirefoxBinarySha256: firefoxMetadata.sha256 } : {}),
  ensureAliasmodeChromium: async () => chromium, ensureWebKit: async () => webkit,
  log: (message) => console.log(message),
});
const ids: string[] = [];
const check = (name: string, pass: boolean, details?: unknown) => {
  report.checks.push({ name, pass, ...(details === undefined ? {} : { details }) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};
const requestIdentity = String.raw`(async () => {
  const headers = await fetch("/request-identity", { cache: "no-store" }).then(response => response.json());
  const hints = await navigator.userAgentData?.getHighEntropyValues(["platformVersion"]);
  return { headers, ua: navigator.userAgent, language: navigator.language, hints };
})()`;
try {
  for (const engine of engines) {
    const profiles = ["a", "b"].map((name) => buildNewProfile({ engine, name: `Fingerprint ${engine} ${name}`, screen: "1280x800", ...(engine === "webkit" ? {} : { platformOs: "windows" }), ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}) }, () => false));
    for (const profile of profiles) { store.upsertProfile(profile); ids.push(profile.id); }
    const captures: ObservedFingerprint[][] = [[], []];
    for (let round = 0; round < 3; round++) {
      for (const [index, profile] of profiles.entries()) {
        await launcher.start(profile.id, [], { autoNavigate: false });
        const audit = await launcher.refreshFingerprint(profile.id);
        captures[index]!.push(store.getProfile(profile.id)!.fpObserved!);
        if (round === 0) {
          check(`${engine}/${index}: real certified independent process`, await launcher.certifiedActive(profile.id));
          report.engines[`${engine}/${index}`] = { id: profile.id, audit, binarySha256: store.getLaunch(profile.id)?.binarySha256 };
          const endpoint = store.getLaunch(profile.id)!.ws;
          const [result, identity] = await runPlaywrightWorker<any[]>("page", { endpoint, kind: "scripts", temporary: true, url: origin, scripts: [
            `new Promise((resolve,reject)=>{const started=Date.now();const read=()=>{const node=document.getElementById('__aliasmode_fingerprint_result__');if(node?.dataset.ready==='true'){const result=JSON.parse(node.textContent);result.error?reject(new Error(result.error)):resolve(result.value)}else if(Date.now()-started>90000)reject(new Error('Context probe timed out'));else setTimeout(read,50)};read()})`,
            requestIdentity,
          ] }, { timeoutMs: 120000 });
          const headerLanguage = identity?.headers?.["accept-language"]?.split(/[;,]/)[0]?.toLowerCase();
          check(`${engine}/${index}: outgoing User-Agent and language match the document`,
            !!identity?.ua && identity.headers?.["user-agent"] === identity.ua && !!headerLanguage && headerLanguage === identity.language?.toLowerCase(),
            identity);
          if (engine === "chromium") {
            check(`${engine}/${index}: outgoing platform client hints match the document`,
              !!identity?.hints?.platform && identity.headers["sec-ch-ua-platform"] === JSON.stringify(identity.hints.platform)
              && typeof identity.hints.platformVersion === "string"
              && identity.headers["sec-ch-ua-platform-version"] === JSON.stringify(identity.hints.platformVersion), identity);
          }
          const contexts = result;
          if (!Array.isArray(contexts)) throw new Error(`${engine} context probe failed: ${JSON.stringify(contexts)}`);
          report.engines[`${engine}/${index}`].contexts = contexts;
          const baseline = (contexts as FingerprintContextSample[]).find((item) => item.context === "window")?.sample;
          const required = ["platform", "language", "timezone", "hardwareConcurrency", "canvasPixelsHash", "webglHash", "fontsHash", "textMetricsHash"] as const;
          check(`${engine}/${index}: main window coverage is complete`, !!baseline && required.every((field) => baseline[field] !== undefined), { missing: required.filter((field) => baseline?.[field] === undefined), errors: baseline?.errors });
          for (const context of contexts as FingerprintContextSample[]) {
            if (context.context === "window") continue;
            if (!context.sample || !baseline) {
              check(`${engine}/${index}: ${context.context} coverage is complete`, false, { unavailable: context.unavailable });
              continue;
            }
            const comparable = required;
            const compared = comparable.filter((field) => baseline[field] !== undefined && context.sample![field] !== undefined);
            const missing = comparable.filter((field) => baseline[field] === undefined || context.sample![field] === undefined);
            const differences = compared.filter((field) => baseline[field] !== context.sample![field]);
            check(`${engine}/${index}: ${context.context} has complete consistent surfaces`, missing.length === 0 && differences.length === 0, { compared, missing, differences, errors: context.sample.errors });
          }
        }
        await launcher.stop(profile.id);
      }
    }
    for (const [index, samples] of captures.entries()) {
      report.engines[`${engine}/${index}`].restarts = samples;
      for (let round = 1; round < samples.length; round++) {
        const verdict = compareAttestation(samples[0]!, samples[round]!);
        check(`${engine}/${index}: restart ${round + 1} preserves measured identity`, verdict.verdict === "match", verdict.differences);
      }
      const consistency = JSON.parse(samples[0]!.consistency ?? "{}");
      check(`${engine}/${index}: repeated Canvas reads agree`, consistency.canvas === true);
      if (consistency.audio !== undefined) check(`${engine}/${index}: AudioBuffer read APIs agree`, consistency.audio === true);
    }
    report.engines[engine] = { separation: Object.fromEntries(["canvasPixels", "webglImage", "fonts", "textMetrics", "audioSamples"].map((field) => {
      const first = captures[0]![0]![field as keyof ObservedFingerprint], second = captures[1]![0]![field as keyof ObservedFingerprint];
      return [field, !first || !second ? "unavailable" : first === second ? "same" : "different"];
    })), limitations: engine === "webkit" ? "Native runtime; no per-profile Canvas/Audio/GPU/font spoofing" : engine === "firefox" ? "Native audio intentionally retained" : "Kernel-seeded; host rasterization remains relevant" };
  }
} catch (error) { report.fatal = String(error instanceof Error ? error.stack : error); console.error(report.fatal); process.exitCode = 1; }
finally {
  for (const id of ids) await launcher.stop(id).catch((error) => console.error(`QA cleanup ${id}: ${error}`));
  await Promise.all(ids.map(id => launcher.cacheCleanupSettled(id)));
  await fixture.stop(true);
  const allClosed = store.listLaunches().length === 0;
  store.close();
  mkdirSync(dirname(resolve(values.report)), { recursive: true });
  writeFileSync(values.report, JSON.stringify(report, null, 2));
  if (report.checks.some((item) => !item.pass)) process.exitCode = 1;
  console.log(JSON.stringify({ root, pass: report.checks.filter((item) => item.pass).length, fail: report.checks.filter((item) => !item.pass).length, fatal: report.fatal }));
  const actual = realpathSync(root);
  if (allClosed && dirname(actual) === realpathSync(resolve("reports")) && basename(actual).startsWith("fingerprint-acceptance-")) {
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

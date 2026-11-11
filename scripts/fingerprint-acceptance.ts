/** Real engines, fresh profiles, local-only fixture. No third-party account or user profile is used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ProfileStore } from "../store.ts";
import { Launcher } from "../launcher.ts";
import { buildNewProfile } from "../create.ts";
import { fingerprintProbe } from "../diagnose.ts";
import { fingerprintAudit } from "../fingerprint-audit.ts";
import { fingerprintContextProbe, type FingerprintContextSample } from "../fingerprint-contexts.ts";
import { runPlaywrightWorker } from "../playwright-runtime.ts";
import { compareAttestation } from "../fingerprint-attestation.ts";
import { fingerprintDocument } from "../playwright-worker.mjs";
import type { ProfileEngine, ObservedFingerprint } from "../types.ts";

const root = mkdtempSync(resolve("reports/fingerprint-acceptance-"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
const firefox = resolve("src-tauri/resources/firefox/aliasmode.exe");
const firefoxMetadata = JSON.parse(readFileSync("src-tauri/generated/browser.json", "utf8")).firefox;
const chromium = resolve("reports/runtimes/chromium/chromium-155.0.8059.85-aliasmode.5/chrome.exe");
const webkit = resolve("reports/webkit-native-2388/Playwright.exe");
for (const file of [firefox, chromium, webkit]) assert.ok(existsSync(file), `Pinned runtime is missing: ${file}`);
assert.equal(createHash("sha256").update(readFileSync(firefox)).digest("hex"), firefoxMetadata.sha256);
const report: { root: string; generatedAt: string; checks: { name: string; pass: boolean; details?: unknown }[]; engines: Record<string, any>; fatal?: string } = { root, generatedAt: new Date().toISOString(), checks: [], engines: {} };
const probe = fingerprintProbe.toString();
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const headers = { "cache-control": "no-store", "content-type": "text/html;charset=utf-8" };
  if (path === "/frame") return new Response(`<!doctype html><meta charset=utf-8><script>(${probe})({details:true}).then(sample=>parent.postMessage({type:'vela-fingerprint-sample',sample},'*'),error=>parent.postMessage({type:'vela-fingerprint-sample',error:String(error)},'*'))</script>`, { headers });
  if (path === "/service-worker.js") return new Response(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('message',event=>event.waitUntil((${probe})({details:true}).then(sample=>event.ports[0].postMessage({sample}),error=>event.ports[0].postMessage({error:String(error)}))));`, { headers: { ...headers, "content-type": "text/javascript", "service-worker-allowed": "/" } });
  return new Response(fingerprintDocument(`(${fingerprintContextProbe.toString()})(${JSON.stringify(probe)},${JSON.stringify(new URL(request.url).origin)})`), { headers });
} });
const origin = `http://127.0.0.1:${fixture.port}`;
const launcher = new Launcher({
  store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"), headless: true,
  firefoxBinaryPath: firefox, expectedFirefoxBinarySha256: firefoxMetadata.sha256,
  ensureAliasmodeChromium: async () => chromium, ensureWebKit: async () => webkit,
  log: (message) => console.log(message),
});
const ids: string[] = [];
const check = (name: string, pass: boolean, details?: unknown) => {
  report.checks.push({ name, pass, ...(details === undefined ? {} : { details }) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
};
try {
  for (const engine of ["chromium", "firefox", "webkit"] as ProfileEngine[]) {
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
          const [result] = await runPlaywrightWorker<any[]>("page", { endpoint, kind: "scripts", temporary: true, url: origin, scripts: [`new Promise((resolve,reject)=>{const started=Date.now();const read=()=>{const node=document.getElementById('__aliasmode_fingerprint_result__');if(node?.dataset.ready==='true'){const result=JSON.parse(node.textContent);result.error?reject(new Error(result.error)):resolve(result.value)}else if(Date.now()-started>90000)reject(new Error('Context probe timed out'));else setTimeout(read,50)};read()})`] }, { timeoutMs: 120000 });
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
  fixture.stop(true); store.close();
  mkdirSync(resolve("reports"), { recursive: true });
  writeFileSync("reports/fingerprint-acceptance.json", JSON.stringify(report, null, 2));
  if (report.checks.some((item) => !item.pass)) process.exitCode = 1;
  console.log(JSON.stringify({ root, pass: report.checks.filter((item) => item.pass).length, fail: report.checks.filter((item) => !item.pass).length, fatal: report.fatal }));
}

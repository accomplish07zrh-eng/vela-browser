import { test, expect } from "bun:test";
import { fingerprintAudit } from "./fingerprint-audit.ts";
import { handleUiRequest } from "./ui.ts";
import { Launcher } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import { parseExport, serializeAdsTxt } from "./parse.ts";
import type { FingerprintSample } from "./diagnose.ts";

const sample: FingerprintSample = {
  canvasHash: "canvas", canvasPixelsHash: "pixels", audioHash: "audio", audioSampleHash: "samples",
  webglVendor: "vendor", webglRenderer: "renderer", webglHash: "webgl", fontsHash: "fonts", textMetricsHash: "metrics",
  consistency: { canvas: true, audio: true },
};

function fixture(capture: () => Promise<FingerprintSample | null> = async () => sample) {
  const store = new ProfileStore(":memory:");
  const profile = parseExport("id=audit-profile\nname=Audit\npassword=PRIVATE_PASSWORD\nproxy=127.0.0.1:8080:user:PRIVATE_PROXY_PASSWORD").profiles[0]!;
  store.upsertProfile(profile);
  store.recordLaunch({ profileId: profile.id, ws: "ws://127.0.0.1:9222", pid: 123, debugPort: 9222, startedAt: 12 });
  const launcher = new Launcher({ store, dataRoot: "reports/fingerprint-unit", captureFingerprint: capture, log: () => {} });
  launcher.certifiedActive = async () => true;
  return { store, profile, launcher };
}

test("no observation or partial observations never become a complete audit", () => {
  expect(fingerprintAudit({}).coverage).toBe("not-measured");
  expect(fingerprintAudit({ fpObserved: { canvas: "one value" } }).coverage).toBe("partial");
  expect(fingerprintAudit({ fpObserved: { canvas: "one value" } }).surfaces[0]?.measured).toBe(false);
});

test("WebKit and Firefox audio retain their actual native implementation label", () => {
  expect(fingerprintAudit({ engine: "webkit" }).surfaces.every((item) => item.implementation === "native")).toBe(true);
  const firefox = fingerprintAudit({ engine: "firefox" });
  expect(firefox.surfaces.find((item) => item.surface === "audio")?.implementation).toBe("native");
  expect(firefox.surfaces.find((item) => item.surface === "canvas")?.implementation).toBe("kernel-seeded");
});

test("failed pixel and audio round trips remain visible even when every hash was captured", () => {
  const audit = fingerprintAudit({ fpObserved: { canvas: "hash", canvasPixels: "pixels", consistency: JSON.stringify({ canvas: true, canvasWrites: false, audioWrites: false, audioSilence: true, fonts: false }) } });
  expect(audit.surfaces.find((item) => item.surface === "canvas")?.integrity).toEqual([{ name: "canvasWrites", result: "inconsistent" }]);
  expect(audit.surfaces.find((item) => item.surface === "audio")?.integrity).toEqual([{ name: "audioWrites", result: "inconsistent" }, { name: "audioSilence", result: "consistent" }]);
  expect(audit.surfaces.find((item) => item.surface === "fonts")?.repeatedRead).toBe("inconsistent");
});

test("expanded diagnostics distinguish unavailable APIs, empty device lists and malformed old captures", () => {
  const audit = fingerprintAudit({ fpObserved: {
    details: JSON.stringify({ identity: { platform: "Win32" }, media: [], unknownPrivateField: "excluded" }),
    errors: JSON.stringify({ webgpu: "WebGPU unavailable" }),
  } });
  expect(audit.diagnostics.find((item) => item.name === "media")).toEqual({ name: "media", measured: true, value: [] });
  expect(audit.diagnostics.find((item) => item.name === "webgpu")).toEqual({ name: "webgpu", measured: false, error: "WebGPU unavailable" });
  expect(JSON.stringify(audit)).not.toContain("excluded");
  expect(fingerprintAudit({ fpObserved: { details: "[invalid", errors: "[]" } }).diagnostics.every((item) => !item.measured)).toBe(true);
});

test("a complete capture does not claim restart stability or cross-profile separation", async () => {
  const f = fixture();
  try {
    const audit = await f.launcher.refreshFingerprint(f.profile.id);
    expect(audit.coverage).toBe("complete");
    expect(audit.restartStability).toBe("not-measured");
    expect(audit.crossProfileSeparation).toBe("not-measured");
    expect(audit.surfaces.find((item) => item.surface === "canvas")?.repeatedRead).toBe("consistent");
    const saved = f.store.getProfile(f.profile.id)!;
    expect(saved.fingerprintSeed).toBe(f.profile.fingerprintSeed);
    expect(saved.cookies).toEqual(f.profile.cookies);
    expect(saved.password).toBe(f.profile.password);
    expect(parseExport(serializeAdsTxt([saved])).profiles[0]?.fpExpected?.webglImage).toBe("webgl");
  } finally { f.store.close(); }
});

test("concurrent measurements share one capture", async () => {
  let resolve!: (value: FingerprintSample) => void;
  const pending = new Promise<FingerprintSample>((done) => { resolve = done; });
  let calls = 0;
  const f = fixture(async () => { calls++; return pending; });
  try {
    const first = f.launcher.refreshFingerprint(f.profile.id);
    const second = f.launcher.refreshFingerprint(f.profile.id);
    await Bun.sleep(0);
    resolve(sample);
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  } finally { f.store.close(); }
});

test("a replaced generation cannot save a late measurement", async () => {
  let resolve!: (value: FingerprintSample) => void;
  const pending = new Promise<FingerprintSample>((done) => { resolve = done; });
  const f = fixture(() => pending);
  try {
    const operation = f.launcher.refreshFingerprint(f.profile.id);
    await Bun.sleep(0);
    f.store.recordLaunch({ ...f.store.getLaunch(f.profile.id)!, startedAt: 99 });
    resolve(sample);
    await expect(operation).rejects.toThrow("generation changed");
    expect(f.store.getProfile(f.profile.id)?.fpObserved).toBeUndefined();
  } finally { f.store.close(); }
});

test("audit responses never expose passwords or private launch endpoints", async () => {
  const f = fixture();
  try {
    const request = (method: string, headers: Record<string, string> = {}) => handleUiRequest(new Request(`http://x/ui/api/profiles/${f.profile.id}/fingerprint-audit`, { method, headers }), f.launcher, f.store);
    expect((await request("POST"))?.status).toBe(415);
    expect((await request("POST", { "content-type": "application/json", origin: "https://evil.example" }))?.status).toBe(403);
    const response = await request("POST", { "content-type": "application/json" });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const body = await response!.text();
    for (const secret of ["PRIVATE_PASSWORD", "PRIVATE_PROXY_PASSWORD", "ws://", "owner", "token"]) expect(body).not.toContain(secret);
    const stored = await request("GET");
    expect((await stored!.json()).audit.coverage).toBe("complete");
  } finally { f.store.close(); }
});

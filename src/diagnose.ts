/**
 * Diagnostics: launch imported profiles and collect hard evidence that the
 * CloakBrowser setup is sound, so the report can be eyeballed (or forwarded)
 * to confirm everything before any real campaign traffic.
 *
 * Per profile it gathers, over CDP:
 *   - egress IP + geo (is the proxy actually in use? not bypassed?)
 *   - user agent + UA Client Hints (and whether they agree)
 *   - canvas / WebGL / audio fingerprints (unique per profile? stable on relaunch?)
 *   - WebRTC candidate IPs (real-IP leak?)
 *   - timezone / locale / screen
 *   - x.com login state (did the injected cookies land?)
 *
 * The collection shell (CDP + network) is deliberately thin and untested here;
 * the verdict logic lives in `analyze()`, which is pure and unit-tested. The
 * report intentionally omits cookie values and passwords — but it DOES contain
 * proxy hosts and egress IPs, so treat it as sensitive.
 */

import type { Profile } from "./types.ts";
import { fetchDirectEgress, parseEgressResponse, resolveEgressEndpoints, type EgressInfo } from "./egress.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";

// Preserve diagnose.ts's existing public type surface while sharing the parser.
export type { EgressInfo } from "./egress.ts";

export interface FingerprintSample {
  userAgent?: string;
  uaDataPlatform?: string;
  uaDataBrands?: string[];
  uaDataPlatformVersion?: string;
  uaFullVersionList?: string[];
  uaFullVersion?: string;
  platform?: string;
  language?: string;
  languages?: string[];
  timezone?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screen?: { width: number; height: number; availWidth: number; availHeight: number; availLeft?: number; availTop?: number; colorDepth: number; dpr: number };
  webglVendor?: string;
  webglRenderer?: string;
  canvasHash?: string;
  audioHash?: string;
  /** Versioned readback probes; these do not change any browser API. */
  canvasPixelsHash?: string;
  webglHash?: string;
  fontsHash?: string;
  textMetricsHash?: string;
  audioSampleHash?: string;
  /** Opt-in QA evidence; never persisted as profile identity. */
  fontDetails?: { visible: string[]; baseWidths: number[]; widths: Record<string, number[]>; metrics: (string | number)[][] };
  consistency?: { canvas?: boolean; canvasWrites?: boolean; audio?: boolean; audioWrites?: boolean; audioSilence?: boolean; webgl?: boolean; fonts?: boolean };
  /** Observed capabilities and native values, not identity inputs or support promises. */
  details?: Record<string, unknown>;
  errors?: Record<string, string>;
}

export interface LoginInfo {
  loggedIn: boolean;
  loggedOut: boolean;
  url?: string;
  title?: string;
}

export interface ProfileReport {
  profileId: string;
  ok: boolean;
  error?: string;
  proxyConfigured: { host: string; port: string } | null;
  /** The profile's stored screen, compared against what the browser reports. */
  screenConfigured: { width: number; height: number } | null;
  egress: EgressInfo | null;
  fingerprint: FingerprintSample | null;
  /** Second sample after a relaunch, when --relaunch is used. */
  fingerprintRelaunch?: FingerprintSample | null;
  webrtcIps?: string[];
  login: LoginInfo | null;
}

export interface DiagnoseReport {
  generatedAt: number;
  baselineRealIp?: string;
  profiles: ProfileReport[];
  analysis: Analysis;
}

export interface Analysis {
  total: number;
  okCount: number;
  proxy: { ok: string[]; bypassed: string[]; matchesConfiguredHost: string[]; noEgress: string[]; inconclusive: string[] };
  webrtcLeaks: string[];
  fingerprintCollisions: { canvas: Collision[]; audio: Collision[]; webgl: Collision[]; fonts: Collision[] };
  fingerprintCoverage: { profileId: string; missing: string[] }[];
  fingerprintChanges: { profileId: string; field: string; before: string; after: string }[];
  uaInconsistencies: { profileId: string; reason: string }[];
  unstableFingerprints: string[];
  login: { loggedIn: string[]; loggedOut: string[]; unknown: string[] };
  screenMismatches: { profileId: string; configured: string; seen: string }[];
  verdicts: string[];
}

export interface Collision {
  value: string;
  profiles: string[];
}

// ---------------------------------------------------------------------------
// Pure analysis — the tested core.
// ---------------------------------------------------------------------------

function dupes(pairs: { profileId: string; value?: string }[]): Collision[] {
  const byValue = new Map<string, string[]>();
  for (const { profileId, value } of pairs) {
    if (!value) continue;
    const list = byValue.get(value) ?? [];
    list.push(profileId);
    byValue.set(value, list);
  }
  return [...byValue.entries()].filter(([, ps]) => ps.length > 1).map(([value, profiles]) => ({ value, profiles }));
}

/** Infer the expected platform token CloakBrowser's UA-CH should report. */
function expectedPlatform(ua: string | undefined): string | null {
  const s = (ua ?? "").toLowerCase();
  if (s.includes("mac os") || s.includes("macintosh")) return "macOS";
  if (s.includes("linux") && !s.includes("android")) return "Linux";
  if (s.includes("windows")) return "Windows";
  return null;
}

export function analyze(profiles: ProfileReport[], baselineRealIp?: string): Analysis {
  const a: Analysis = {
    total: profiles.length,
    okCount: profiles.filter((p) => p.ok).length,
    proxy: { ok: [], bypassed: [], matchesConfiguredHost: [], noEgress: [], inconclusive: [] },
    webrtcLeaks: [],
    fingerprintCollisions: { canvas: [], audio: [], webgl: [], fonts: [] },
    fingerprintCoverage: [],
    fingerprintChanges: [],
    uaInconsistencies: [],
    unstableFingerprints: [],
    login: { loggedIn: [], loggedOut: [], unknown: [] },
    screenMismatches: [],
    verdicts: [],
  };

  for (const p of profiles) {
    // Proxy: the critical check is bypass (browser egress == this machine's IP).
    const egressIp = p.egress?.ip;
    if (!egressIp) {
      a.proxy.noEgress.push(p.profileId);
    } else if (!baselineRealIp) {
      // Without the real-IP baseline we cannot prove the proxy isn't bypassed —
      // report as inconclusive rather than falsely green-lighting it.
      a.proxy.inconclusive.push(p.profileId);
    } else if (egressIp === baselineRealIp) {
      a.proxy.bypassed.push(p.profileId);
    } else {
      a.proxy.ok.push(p.profileId);
      if (p.proxyConfigured && egressIp === p.proxyConfigured.host) a.proxy.matchesConfiguredHost.push(p.profileId);
    }

    // WebRTC: any candidate equal to the real IP is a leak.
    if (baselineRealIp && p.webrtcIps?.includes(baselineRealIp)) a.webrtcLeaks.push(p.profileId);

    // UA vs UA-CH consistency.
    const fp = p.fingerprint;
    if (fp?.userAgent && fp.uaDataPlatform) {
      const want = expectedPlatform(fp.userAgent);
      if (want && fp.uaDataPlatform !== want) {
        a.uaInconsistencies.push({ profileId: p.profileId, reason: `UA implies ${want} but UA-CH platform is ${fp.uaDataPlatform}` });
      }
    }

    // Screen: the browser-reported resolution must match the spoofed value.
    const screen = p.fingerprint?.screen;
    if (screen && p.screenConfigured) {
      if (screen.width !== p.screenConfigured.width || screen.height !== p.screenConfigured.height) {
        a.screenMismatches.push({
          profileId: p.profileId,
          configured: `${p.screenConfigured.width}x${p.screenConfigured.height}`,
          seen: `${screen.width}x${screen.height}`,
        });
      }
    }

    // Login tally.
    if (p.login?.loggedIn) a.login.loggedIn.push(p.profileId);
    else if (p.login?.loggedOut) a.login.loggedOut.push(p.profileId);
    else a.login.unknown.push(p.profileId);

    const surfaces = ["canvasHash", "canvasPixelsHash", "audioHash", "audioSampleHash", "webglHash", "fontsHash", "textMetricsHash"] as const;
    const missing = surfaces.filter((field) => !fp?.[field]);
    if (missing.length) a.fingerprintCoverage.push({ profileId: p.profileId, missing });

    // A previously measurable surface disappearing is also a restart change.
    if (p.fingerprintRelaunch && fp) {
      for (const field of surfaces) {
        const before = fp[field], after = p.fingerprintRelaunch[field];
        if (before && before !== after) {
          a.fingerprintChanges.push({ profileId: p.profileId, field, before, after: after ?? "unavailable" });
        }
      }
      if (a.fingerprintChanges.some((change) => change.profileId === p.profileId)) a.unstableFingerprints.push(p.profileId);
    }
  }

  // Cross-profile uniqueness (noise-based surfaces should differ per seed).
  a.fingerprintCollisions.canvas = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.canvasHash })));
  a.fingerprintCollisions.audio = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.audioHash })));
  a.fingerprintCollisions.webgl = dupes(
    profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.webglHash })),
  );
  a.fingerprintCollisions.fonts = dupes(profiles.map((p) => ({ profileId: p.profileId, value: p.fingerprint?.fontsHash })));

  // Verdicts: plain-language pass/fail lines for the summary.
  const v = a.verdicts;
  v.push(`${a.okCount}/${a.total} profiles launched and probed cleanly`);
  if (a.proxy.bypassed.length) v.push(`❌ PROXY BYPASSED on ${a.proxy.bypassed.length} profile(s): ${a.proxy.bypassed.join(", ")} — egress equals this machine's IP`);
  else if (a.proxy.inconclusive.length) v.push(`⚠️  proxy bypass could NOT be checked for ${a.proxy.inconclusive.length} profile(s) — this machine's real-IP baseline was unavailable; rerun with the baseline before trusting the proxy`);
  else if (a.proxy.noEgress.length) v.push(`⚠️  no egress IP captured for ${a.proxy.noEgress.length} profile(s) — cannot confirm proxy`);
  else v.push(`✅ proxy in use on all ${a.proxy.ok.length} profile(s) (no bypass to host IP)`);
  if (a.webrtcLeaks.length) v.push(`❌ WebRTC leaks real IP on: ${a.webrtcLeaks.join(", ")}`);
  else v.push(`✅ no WebRTC real-IP leak detected`);
  if (a.fingerprintCollisions.canvas.length) v.push(`❌ canvas fingerprint COLLISION across profiles: ${a.fingerprintCollisions.canvas.map((c) => c.profiles.join("+")).join("; ")}`);
  else {
    const canvasMeasured = profiles.filter((p) => p.fingerprint?.canvasHash).length;
    if (canvasMeasured >= 2 && canvasMeasured === profiles.length) v.push(`✅ canvas fingerprints unique across profiles`);
    else v.push(`⚠️  canvas uniqueness not established (${canvasMeasured}/${profiles.length} measured; at least two required)`);
  }
  if (a.fingerprintCoverage.length) v.push(`⚠️  fingerprint coverage incomplete on ${a.fingerprintCoverage.length} profile(s); unavailable surfaces are not a pass`);
  if (a.unstableFingerprints.length) v.push(`❌ fingerprint changed across relaunch on: ${a.unstableFingerprints.join(", ")}`);
  if (a.uaInconsistencies.length) v.push(`⚠️  UA/UA-CH mismatch on ${a.uaInconsistencies.length} profile(s)`);
  const screensCompared = profiles.filter((p) => p.fingerprint?.screen && p.screenConfigured).length;
  if (a.screenMismatches.length) v.push(`⚠️  screen resolution mismatch on ${a.screenMismatches.length} profile(s): ${a.screenMismatches.map((s) => `${s.profileId} ${s.seen}≠${s.configured}`).join(", ")}`);
  else if (screensCompared) v.push(`✅ screen resolution matches the spoofed value on all ${screensCompared} profile(s)`);
  v.push(`login: ${a.login.loggedIn.length} signed in, ${a.login.loggedOut.length} signed out, ${a.login.unknown.length} unknown`);

  return a;
}

// ---------------------------------------------------------------------------
// In-browser probes (serialized to the page; must be self-contained).
// ---------------------------------------------------------------------------

export async function fingerprintProbe(options: { details?: boolean } = {}): Promise<FingerprintSample> {
  const out: FingerprintSample = { errors: {} };
  const err = (k: string, e: unknown) => {
    out.errors![k] = e instanceof Error ? e.message : String(e);
  };
  const createCanvas = () => {
    if (typeof document !== "undefined") return document.createElement("canvas");
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(300, 150) as unknown as HTMLCanvasElement;
    throw new Error("Canvas unavailable in this context");
  };
  try {
    out.userAgent = navigator.userAgent;
    out.platform = (navigator as any).platform;
    out.language = navigator.language;
    out.languages = navigator.languages as string[];
    out.hardwareConcurrency = navigator.hardwareConcurrency;
    out.deviceMemory = (navigator as any).deviceMemory;
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof screen !== "undefined") out.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: (screen as any).availLeft,
      availTop: (screen as any).availTop,
      colorDepth: screen.colorDepth,
      dpr: devicePixelRatio,
    };
  } catch (e) {
    err("nav", e);
  }
  try {
    const uaData = (navigator as any).userAgentData;
    if (uaData) {
      const hi = await uaData.getHighEntropyValues(["platform", "platformVersion", "uaFullVersion", "fullVersionList"]);
      out.uaDataPlatform = hi.platform;
      out.uaDataPlatformVersion = hi.platformVersion;
      out.uaFullVersion = hi.uaFullVersion;
      out.uaFullVersionList = hi.fullVersionList?.map((b: any) => `${b.brand} ${b.version}`);
      out.uaDataBrands = (uaData.brands ?? []).map((b: any) => `${b.brand} ${b.version}`);
    }
  } catch (e) {
    err("uaData", e);
  }
  try {
    const c = createCanvas();
    const gl = (c.getContext("webgl") || c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.webglVendor = String(gl.getParameter((dbg as any).UNMASKED_VENDOR_WEBGL));
        out.webglRenderer = String(gl.getParameter((dbg as any).UNMASKED_RENDERER_WEBGL));
      }
    } else throw new Error("WebGL unavailable");
  } catch (e) {
    err("webgl", e);
  }
  const sha = async (s: string) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  try {
    const c = createCanvas();
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext("2d")!;
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(10, 10, 100, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("Cloak fingerprint \u{1F3A8}", 2, 15);
    const url = typeof c.toDataURL === "function" ? c.toDataURL() : undefined;
    if (url !== undefined) out.canvasHash = await sha(url);
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
    const repeatedPixels = ctx.getImageData(0, 0, c.width, c.height).data;
    out.canvasPixelsHash = await sha(`canvas-pixels-v1:${Array.from(pixels).join(",")}`);
    out.consistency = { canvas: (url === undefined || c.toDataURL() === url)
      && pixels.every((byte, index) => byte === repeatedPixels[index]) };
    const written = createCanvas(); written.width = written.height = 32;
    const writeContext = written.getContext("2d")!;
    writeContext.fillText("Existing drawing", 0, 16);
    const image = writeContext.createImageData(32, 32);
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = index % 8 ? 255 : 0;
      image.data[index + 1] = index % 8 ? 17 : 0;
      image.data[index + 2] = index % 8 ? 131 : 0;
      image.data[index + 3] = index % 8 ? 255 : 0;
    }
    writeContext.putImageData(image, 0, 0);
    const readback = writeContext.getImageData(0, 0, 32, 32).data;
    out.consistency.canvasWrites = image.data.every((byte, index) => byte === readback[index]);
  } catch (e) {
    err("canvas", e);
  }
  try {
    const Ctx = (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
    if (!Ctx) throw new Error("OfflineAudioContext unavailable in this context");
    const ac = new Ctx(1, 5000, 44100);
    const osc = ac.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 10000;
    const comp = ac.createDynamicsCompressor();
    osc.connect(comp);
    comp.connect(ac.destination);
    osc.start(0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buf: AudioBuffer = await Promise.race([
      ac.startRendering(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("audio rendering timed out")), 3000); }),
    ]).finally(() => clearTimeout(timer));
    const data = buf.getChannelData(0).slice(0, 1000);
    let sum = 0;
    for (const x of data) sum += Math.abs(x);
    out.audioHash = await sha(String(sum));
    out.audioSampleHash = await sha(`audio-samples-v1:${Array.from(data).join(",")}`);
    const copied = new Float32Array(1000);
    buf.copyFromChannel(copied, 0);
    out.consistency = { ...out.consistency, audio: data.every((sample, index) => Object.is(sample, copied[index])) };
    const exact: AudioBuffer = ac.createBuffer(1, 128, 44100);
    const values = new Float32Array(128).fill(0.25); values[0] = -0.5; values[127] = 1;
    exact.copyToChannel(values, 0);
    const copiedExact = new Float32Array(128); exact.copyFromChannel(copiedExact, 0);
    out.consistency.audioWrites = exact.getChannelData(0).every((sample, index) => sample === values[index])
      && copiedExact.every((sample, index) => sample === values[index]);
    const silence: AudioBuffer = ac.createBuffer(1, 128, 44100);
    out.consistency.audioSilence = silence.getChannelData(0).every((sample) => sample === 0);
    out.details = { ...out.details, audio: { sampleRate: buf.sampleRate, channels: buf.numberOfChannels, length: buf.length } };
  } catch (e) {
    err("audio", e);
  }
  try {
    const canvas = createCanvas();
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL readback unavailable");
    try {
      const compile = (type: number, source: string) => {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("WebGL shader compilation failed");
        return shader;
      };
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, "attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.,1.);}"));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, "precision highp float;varying vec2 v;void main(){gl_FragColor=vec4(sin(v.x*7.)*.4+.5,cos(v.y*11.)*.4+.5,v.x*v.y*.3+.5,1.);}"));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("WebGL program link failed");
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0.125, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 64, 64); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(64 * 64 * 4);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR || !pixels.some((value) => value !== 0)) throw new Error("WebGL readback failed");
      out.webglHash = await sha(`webgl-image-v1:${Array.from(pixels).join(",")}`);
      const repeated = new Uint8Array(pixels.length);
      gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, repeated);
      out.consistency = { ...out.consistency, webgl: pixels.every((byte, index) => byte === repeated[index]) };
    } finally { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
  } catch (e) { err("webglImage", e); }
  try {
    const ctx = createCanvas().getContext("2d")!;
    const text = "Vela WmIl 0123 中文 العربية";
    const families = ["Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Consolas", "Courier New", "Georgia", "Helvetica", "Helvetica Neue", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Menlo", "Monaco", "PingFang SC", "Microsoft YaHei", "SimSun", "Noto Sans", "Ubuntu", "DejaVu Sans"];
    const bases = ["monospace", "sans-serif", "serif"];
    const measure = (font: string) => { ctx.font = `19px ${font}`; return ctx.measureText(text).width; };
    const widths = bases.map(measure);
    const familyWidths = Object.fromEntries(families.map((family) => [family, bases.map((base) => measure(`"${family}",${base}`))]));
    const visible = families.filter((family) => familyWidths[family]!.some((width, index) => width !== widths[index]));
    out.fontsHash = await sha(`font-set-v1:${visible.join("|")}`);
    const metrics = [...bases, ...visible].map((family) => {
      ctx.font = `19px ${bases.includes(family) ? family : `"${family}"`}`;
      const value = ctx.measureText(text);
      return [family, value.width, value.actualBoundingBoxAscent, value.actualBoundingBoxDescent, value.actualBoundingBoxLeft, value.actualBoundingBoxRight];
    });
    out.textMetricsHash = await sha(`font-metrics-v1:${JSON.stringify(metrics)}`);
    if (options.details) out.fontDetails = { visible, baseWidths: widths, widths: familyWidths, metrics };
    const repeatedWidths = bases.map(measure);
    const repeatedFamilies = Object.fromEntries(families.map((family) => [family, bases.map((base) => measure(`"${family}",${base}`))]));
    out.consistency = { ...out.consistency, fonts: widths.every((width, index) => width === repeatedWidths[index])
      && families.every((family) => familyWidths[family]!.every((width, index) => width === repeatedFamilies[family]![index])) };
  } catch (e) { err("fonts", e); }
  // These calls inspect existing values only. They never request device/location
  // permission, change a preference, enumerate account data or contact a service.
  const inspect = async (name: string, collect: () => unknown | Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(collect),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("measurement timed out")), 3000); }),
      ]);
      out.details = { ...out.details, [name]: value };
    } catch (error) { err(name, error); }
    finally { clearTimeout(timer); }
  };
  await Promise.all([
    inspect("identity", async () => {
      const nav = navigator as any;
      const uaData = nav.userAgentData;
      return { userAgent: nav.userAgent, platform: nav.platform, vendor: nav.vendor, oscpu: nav.oscpu,
        webdriver: nav.webdriver, maxTouchPoints: nav.maxTouchPoints, pdfViewerEnabled: nav.pdfViewerEnabled,
        cookieEnabled: nav.cookieEnabled, doNotTrack: nav.doNotTrack,
        ...(uaData ? { clientHints: await uaData.getHighEntropyValues(["architecture", "bitness", "model", "mobile", "platform", "platformVersion", "fullVersionList", "wow64"]) } : {}) };
    }),
    inspect("locale", () => ({ ...Intl.DateTimeFormat().resolvedOptions(),
      language: navigator.language, languages: [...navigator.languages],
      winterOffset: new Date("2026-01-15T12:00:00Z").getTimezoneOffset(), summerOffset: new Date("2026-07-15T12:00:00Z").getTimezoneOffset(),
      number: new Intl.NumberFormat().format(1234567.89) })),
    inspect("hardware", () => ({ cores: navigator.hardwareConcurrency, memory: (navigator as any).deviceMemory })),
    inspect("display", () => {
      if (typeof screen === "undefined" || typeof matchMedia !== "function") throw new Error("Screen unavailable in this context");
      const queries = ["(pointer:fine)", "(pointer:coarse)", "(hover:hover)", "(any-pointer:coarse)", "(any-hover:hover)", "(color-gamut:p3)", "(prefers-color-scheme:dark)", "(prefers-reduced-motion:reduce)"];
      return { ...out.screen, pixelDepth: screen.pixelDepth, viewport: [innerWidth, innerHeight], outer: [outerWidth, outerHeight],
        orientation: screen.orientation?.type, queries: Object.fromEntries(queries.map((query) => [query, matchMedia(query).matches])) };
    }),
    inspect("webgl2", () => {
      const gl = createCanvas().getContext("webgl2") as WebGL2RenderingContext | null;
      if (!gl) throw new Error("WebGL2 unavailable");
      try {
        const parameters = ["MAX_TEXTURE_SIZE", "MAX_CUBE_MAP_TEXTURE_SIZE", "MAX_RENDERBUFFER_SIZE", "MAX_VERTEX_ATTRIBS", "MAX_VERTEX_UNIFORM_VECTORS", "MAX_FRAGMENT_UNIFORM_VECTORS", "MAX_VARYING_VECTORS", "MAX_3D_TEXTURE_SIZE", "MAX_ARRAY_TEXTURE_LAYERS", "MAX_UNIFORM_BUFFER_BINDINGS", "MAX_SAMPLES"];
        const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        return { parameters: Object.fromEntries(parameters.map((name) => [name, gl.getParameter((gl as any)[name])])),
          extensions: (gl.getSupportedExtensions() ?? []).sort(), precision: precision && { rangeMin: precision.rangeMin, rangeMax: precision.rangeMax, precision: precision.precision } };
      } finally { gl.getExtension("WEBGL_lose_context")?.loseContext(); }
    }),
    inspect("webgpu", async () => {
      const gpu = (navigator as any).gpu;
      if (!gpu) throw new Error("WebGPU unavailable");
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter available");
      const info = adapter.info ?? (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : {});
      const names = ["maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D", "maxTextureArrayLayers", "maxBindGroups", "maxBufferSize", "maxStorageBufferBindingSize", "maxUniformBufferBindingSize", "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX", "maxComputeWorkgroupSizeY", "maxComputeWorkgroupSizeZ"];
      return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
        isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter, features: [...adapter.features].sort(),
        limits: Object.fromEntries(names.map((name) => [name, adapter.limits[name]])) };
    }),
    inspect("media", async () => {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error("Media device enumeration unavailable");
      return Promise.all((await navigator.mediaDevices.enumerateDevices()).map(async (device) => ({
        kind: device.kind, deviceId: device.deviceId ? await sha(device.deviceId) : "", groupId: device.groupId ? await sha(device.groupId) : "", labelled: !!device.label,
      })));
    }),
    inspect("voices", async () => {
      const speech = (globalThis as any).speechSynthesis as SpeechSynthesis | undefined;
      if (!speech) throw new Error("Speech synthesis unavailable in this context");
      const voices = () => speech.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang, local: voice.localService, default: voice.default }));
      if (voices().length) return voices();
      return new Promise<unknown>((resolve) => {
        const finish = () => { clearTimeout(timer); speech.removeEventListener("voiceschanged", finish); resolve(voices()); };
        const timer = setTimeout(finish, 1000); speech.addEventListener("voiceschanged", finish, { once: true });
      });
    }),
    inspect("storage", async () => {
      if (!navigator.storage?.estimate) throw new Error("Storage estimation unavailable");
      return { quota: (await navigator.storage.estimate()).quota, persisted: typeof navigator.storage.persisted === "function" ? await navigator.storage.persisted() : undefined };
    }),
    inspect("permissions", async () => {
      if (!navigator.permissions?.query) throw new Error("Permission queries unavailable");
      return Object.fromEntries(await Promise.all(["geolocation", "notifications", "camera", "microphone"].map(async (name) => {
        try { return [name, (await navigator.permissions.query({ name: name as PermissionName })).state]; }
        catch { return [name, "unavailable"]; }
      })));
    }),
  ]);
  return out;
}

function loginProbe(): LoginInfo {
  const url = location.href;
  const loggedIn = !!document.querySelector(
    '[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]',
  );
  const loggedOut =
    !!document.querySelector('input[name="text"], a[href="/login"], [data-testid="loginButton"]') ||
    /\/login|\/i\/flow\/login|logout/.test(url);
  return { url, loggedIn, loggedOut, title: document.title };
}

async function webrtcProbe(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const ips = new Set<string>();
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pc.createDataChannel("x");
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          resolve([...ips]);
          return;
        }
        const cand = e.candidate;
        // Modern browsers expose the parsed address; prefer it.
        const addr = ((cand as any).address || "").trim();
        if (addr && !addr.endsWith(".local")) {
          ips.add(addr);
          return;
        }
        // Skip mDNS-anonymized candidates (<uuid>.local) — they carry no real IP
        // and their hex would otherwise be misparsed as an address.
        const s = cand.candidate;
        if (/\.local\b/i.test(s)) return;
        const m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){2,7})/i);
        if (m) ips.add(m[0]);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o));
      setTimeout(() => resolve([...ips]), 3000);
    } catch {
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// CDP collection shell (untested; mirrors launcher's default-impl pattern).
// ---------------------------------------------------------------------------

/** Egress via the diagnostic page itself (interactive tooling only; the launch path never does this). */
async function diagnosePageEgress(page: any, timeoutMs: number): Promise<EgressInfo | null> {
  for (const endpoint of resolveEgressEndpoints()) {
    try {
      const response = await page.goto(endpoint, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (!response?.ok()) continue;
      const info = parseEgressResponse(await page.locator("body").innerText({ timeout: Math.min(timeoutMs, 5_000) }));
      if (info) return info;
    } catch {
      // next endpoint
    }
  }
  return null;
}

export interface DiagnoseProfileOptions {
  timeoutMs?: number;
  collectLogin?: boolean;
}

/** Connect over CDP and collect one profile's full sample. */
export async function diagnoseOverCDP(
  ws: string,
  profile: Profile,
  opts: DiagnoseProfileOptions = {},
): Promise<Pick<ProfileReport, "fingerprint" | "egress" | "webrtcIps" | "login">> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const result = await runPlaywrightWorker<{
    fingerprint: FingerprintSample;
    webrtcIps: string[];
    egress: string | null;
    login: LoginInfo | null;
  }>("diagnostics", {
    endpoint: ws,
    timeoutMs,
    collectLogin: opts.collectLogin !== false,
    fingerprintScript: `(${fingerprintProbe.toString()})()`,
    webrtcScript: `(${webrtcProbe.toString()})()`,
    loginScript: `(${loginProbe.toString()})()`,
    egressUrls: resolveEgressEndpoints(),
    connectTimeoutMs: timeoutMs,
  }, { timeoutMs: timeoutMs * 3 + 20_000 });
  return {
    fingerprint: result.fingerprint,
    egress: result.egress ? parseEgressResponse(result.egress) : null,
    webrtcIps: result.webrtcIps,
    login: result.login,
  };
}

// ---------------------------------------------------------------------------
// Orchestration over the manager's AdsPower-shaped HTTP API.
// ---------------------------------------------------------------------------

export interface RunDiagnosticsOptions {
  baseUrl: string;
  profiles: Profile[];
  relaunch?: boolean;
  collectLogin?: boolean;
  log?: (msg: string) => void;
  /** Called with the running report after each profile, for incremental persistence. */
  onProgress?: (report: DiagnoseReport) => void;
  /** Hard cap per profile so a hung CDP connection can't stall the whole run. */
  perProfileTimeoutMs?: number;
}

/** Reject if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function apiStart(baseUrl: string, id: string): Promise<{ ws: string; port: number } | null> {
  const r = await (await fetch(`${baseUrl}/api/v1/browser/start?user_id=${encodeURIComponent(id)}`)).json();
  if (r.code !== 0) return null;
  return { ws: r.data.ws.puppeteer, port: Number(r.data.debug_port) };
}
async function apiStop(baseUrl: string, id: string): Promise<void> {
  await fetch(`${baseUrl}/api/v1/browser/stop?user_id=${encodeURIComponent(id)}`).catch(() => {});
}

/** This machine's own outbound IP (no proxy) — the bypass baseline. */
async function baselineRealIp(): Promise<string | undefined> {
  return (await fetchDirectEgress())?.ip;
}

/** Drive every profile through the manager, collect samples, and analyze. */
export async function runDiagnostics(opts: RunDiagnosticsOptions): Promise<DiagnoseReport> {
  const log = opts.log ?? ((m) => console.log(`[diagnose] ${m}`));
  const realIp = await baselineRealIp();
  log(`this machine's real IP (proxy-bypass baseline): ${realIp ?? "unknown"}`);

  const timeout = opts.perProfileTimeoutMs ?? 90_000;
  const reports: ProfileReport[] = [];
  const snapshot = (): DiagnoseReport => ({ generatedAt: Date.now(), baselineRealIp: realIp, profiles: reports, analysis: analyze(reports, realIp) });

  for (const profile of opts.profiles) {
    const proxyConfigured = profile.proxy ? { host: profile.proxy.host, port: profile.proxy.port } : null;
    const screenConfigured = { width: profile.screenWidth, height: profile.screenHeight };
    try {
      const first = await apiStart(opts.baseUrl, profile.id);
      if (!first) {
        reports.push({ profileId: profile.id, ok: false, error: "browser/start failed", proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
        continue;
      }
      const sample = await withTimeout(
        diagnoseOverCDP(first.ws, profile, { collectLogin: opts.collectLogin }),
        timeout,
        `diagnose ${profile.id}`,
      );

      let fingerprintRelaunch: FingerprintSample | null | undefined;
      if (opts.relaunch) {
        await apiStop(opts.baseUrl, profile.id);
        const second = await apiStart(opts.baseUrl, profile.id);
        if (second) {
          const s2 = await withTimeout(diagnoseOverCDP(second.ws, profile, { collectLogin: false }), timeout, `relaunch ${profile.id}`);
          fingerprintRelaunch = s2.fingerprint;
        }
      }

      const report: ProfileReport = { profileId: profile.id, ok: true, proxyConfigured, screenConfigured, ...sample, fingerprintRelaunch };
      reports.push(report);
      const eg = report.egress?.ip ?? "?";
      const proxyTag = !realIp ? "baseline?" : eg === realIp ? "❌BYPASS" : "ok";
      const li = report.login?.loggedIn ? "logged-in" : report.login?.loggedOut ? "logged-out" : "login?";
      log(`${profile.id}: egress=${eg} ${proxyTag} canvas=${report.fingerprint?.canvasHash?.slice(0, 8) ?? "?"} ${li}`);
    } catch (e) {
      reports.push({ profileId: profile.id, ok: false, error: e instanceof Error ? e.message : String(e), proxyConfigured, screenConfigured, egress: null, fingerprint: null, login: null });
      log(`${profile.id}: FAILED ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await apiStop(opts.baseUrl, profile.id);
      opts.onProgress?.(snapshot());
    }
  }

  return snapshot();
}

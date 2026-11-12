import type { Profile } from "./types.ts";

export type FingerprintSurface = "canvas" | "audio" | "webgl" | "fonts";
export type FingerprintImplementation = "kernel-seeded" | "engine-managed" | "native";

const SURFACES = {
  canvas: ["canvas", "canvasPixels"],
  audio: ["audio", "audioSamples"],
  webgl: ["webglVendor", "webglRenderer", "webglImage"],
  fonts: ["fonts", "textMetrics"],
} as const;

const DIAGNOSTICS = ["identity", "locale", "display", "hardware", "webgl2", "webgpu", "audio", "media", "voices", "storage", "permissions"] as const;

export interface FingerprintAudit {
  engine: "chromium" | "firefox" | "webkit";
  capturedAt: string | null;
  coverage: "not-measured" | "partial" | "complete";
  /** Support describes the configured implementation; it never certifies spoofing quality. */
  surfaces: Array<{
    surface: FingerprintSurface;
    implementation: FingerprintImplementation;
    measured: boolean;
    missing: string[];
    values: Record<string, string>;
    repeatedRead: "consistent" | "inconsistent" | "not-measured";
    integrity: Array<{ name: "canvasWrites" | "audioWrites" | "audioSilence"; result: "consistent" | "inconsistent" | "not-measured" }>;
  }>;
  diagnostics: Array<{ name: typeof DIAGNOSTICS[number]; measured: boolean; value?: unknown; error?: string }>;
  /** These require distinct real captures, not a seed or a single hash. */
  restartStability: "not-measured";
  crossProfileSeparation: "not-measured";
}

/** A seed, an engine label or an empty probe must never produce a verified badge. */
export function fingerprintAudit(profile: Pick<Profile, "engine" | "chromiumRuntime" | "fpObserved">): FingerprintAudit {
  const engine = profile.engine ?? "chromium";
  const observed = profile.fpObserved;
  let consistency: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(observed?.consistency ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) consistency = parsed;
  } catch { /* Older captures have no repeated-read information. */ }
  const surfaces = (Object.keys(SURFACES) as FingerprintSurface[]).map((surface) => {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of SURFACES[surface]) {
      const value = observed?.[field];
      if (typeof value === "string" && value.trim()) values[field] = value;
      else missing.push(field);
    }
    const repeatedRead = consistency[surface] === true ? "consistent" as const
      : consistency[surface] === false ? "inconsistent" as const : "not-measured" as const;
    // Firefox intentionally keeps native audio; injecting readback noise there
    // breaks exact buffers (silence, constants) and makes it easier to detect.
    const implementation: FingerprintImplementation = engine === "webkit" || (engine === "firefox" && surface === "audio")
      ? "native" : engine === "chromium" && !profile.chromiumRuntime ? "engine-managed" : "kernel-seeded";
    const checks = surface === "canvas" ? ["canvasWrites"] as const : surface === "audio" ? ["audioWrites", "audioSilence"] as const : [];
    const integrity = checks.map((name) => ({ name, result: consistency[name] === true ? "consistent" as const
      : consistency[name] === false ? "inconsistent" as const : "not-measured" as const }));
    return { surface, implementation, measured: missing.length === 0, missing, values, repeatedRead, integrity };
  });
  const parseObject = (value: string | undefined): Record<string, unknown> => {
    if (!value || value.length > 131072) return {};
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
  };
  const details = parseObject(observed?.details);
  const errors = parseObject(observed?.errors);
  const diagnostics = DIAGNOSTICS.map((name) => ({ name, measured: Object.hasOwn(details, name),
    ...(Object.hasOwn(details, name) ? { value: details[name] } : {}),
    ...(typeof errors[name] === "string" ? { error: errors[name] as string } : {}),
  }));
  const anyMeasured = surfaces.some((surface) => Object.keys(surface.values).length > 0);
  return {
    engine, capturedAt: observed?.capturedAt ?? null,
    coverage: surfaces.every((surface) => surface.measured) ? "complete" : anyMeasured ? "partial" : "not-measured",
    surfaces, diagnostics, restartStability: "not-measured", crossProfileSeparation: "not-measured",
  };
}

import type { WebKitProfileConfig } from "./types.ts";

// Independent from the patched Playwright used by Chromium and Camoufox.
export const WEBKIT_PLAYWRIGHT_VERSION = "1.65.0";
export const WEBKIT_RUNTIME_VERSION = "27.2";
export const WEBKIT_REVISION = "2388";
export const WEBKIT_DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";

export function createWebKitProfileConfig(width: number, height: number): WebKitProfileConfig {
  return normalizeWebKitProfileConfig({
    version: 1, runtimeVersion: WEBKIT_RUNTIME_VERSION, revision: WEBKIT_REVISION,
    playwrightVersion: WEBKIT_PLAYWRIGHT_VERSION,
    viewport: { width: Math.min(width, 1280), height: Math.min(height, 800) }, deviceScaleFactor: 1,
  });
}

/** Native context settings only. No injected navigator, canvas or GPU overrides. */
export function normalizeWebKitProfileConfig(value: unknown): WebKitProfileConfig {
  const item = value as WebKitProfileConfig;
  if (!item || typeof item !== "object" || Array.isArray(item)
    || Object.keys(item).sort().join() !== "deviceScaleFactor,playwrightVersion,revision,runtimeVersion,version,viewport"
    || item.version !== 1 || typeof item.runtimeVersion !== "string" || !/^\d+\.\d+$/.test(item.runtimeVersion)
    || typeof item.revision !== "string" || !/^\d+$/.test(item.revision)
    || typeof item.playwrightVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(item.playwrightVersion)
    || !item.viewport || Object.keys(item.viewport).sort().join() !== "height,width"
    || !Number.isSafeInteger(item.viewport.width) || item.viewport.width < 320 || item.viewport.width > 8192
    || !Number.isSafeInteger(item.viewport.height) || item.viewport.height < 240 || item.viewport.height > 8192
    || ![1, 1.25, 1.5, 2, 3].includes(item.deviceScaleFactor)) {
    throw new Error("invalid WebKit profile config");
  }
  return { ...item, viewport: { ...item.viewport } };
}

export function webkitSupported(platform = process.platform, arch: string = process.arch): boolean {
  return platform === "win32" && arch === "x64";
}

/** Isolated real-engine UI acceptance. Never opens a stored user profile. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildNewProfile } from "../src/create.ts";
import { Launcher } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";
import { AppConfigStore } from "../src/app-config.ts";
import { serveDashboard } from "../src/web.ts";
import type { ProfileEngine } from "../src/types.ts";

mkdirSync(resolve("reports"), { recursive: true });
const root = mkdtempSync(resolve("reports/fingerprint-dashboard-"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
const firefox = resolve("src-tauri/resources/firefox/aliasmode.exe");
const launcher = new Launcher({
  store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"), headless: true,
  firefoxBinaryPath: firefox, expectedFirefoxBinarySha256: createHash("sha256").update(readFileSync(firefox)).digest("hex"),
  ensureAliasmodeChromium: async () => resolve("reports/runtimes/chromium/chromium-155.0.8059.85-aliasmode.5/chrome.exe"),
  ensureWebKit: async () => resolve("reports/webkit-native-2388/Playwright.exe"),
  log: (message) => console.log(message),
});
const ids: string[] = [];
const appConfig = new AppConfigStore(join(root, "app-config.json")); appConfig.setMode("local");
const dashboard = serveDashboard({ launcher, store, appConfig, hostname: "127.0.0.1", port: 0 });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  dashboard.stop(true);
  await Promise.allSettled(ids.map((id) => launcher.stop(id)));
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());
try {
  for (const engine of ["chromium", "firefox", "webkit"] as ProfileEngine[]) {
    const profile = buildNewProfile({ name: `Studio · ${engine}`, engine, group: "指纹验收", screen: "1280x800",
      ...(engine === "webkit" ? {} : { platformOs: "windows" }), ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" as const } : {}),
    }, () => false);
    store.upsertProfile(profile); ids.push(profile.id);
    await launcher.start(profile.id, [], { autoNavigate: false });
  }
  const result = { root, url: `http://127.0.0.1:${dashboard.port}`, ids, pid: process.pid };
  writeFileSync(resolve("reports/fingerprint-dashboard-session.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ready: true, url: result.url, count: ids.length }));
} catch (error) { console.error(error); await stop(); }

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, type HostProcessSnapshot, type LauncherOptions } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import { createWebKitProfileConfig, WEBKIT_DEFAULT_UA } from "./webkit-config.ts";
import { WebKitOwnerError, type WebKitOwner } from "./webkit-runtime.ts";
import { WEBKIT_SESSION_FILE } from "./webkit-session.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vela-webkit-launch-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProfileStore(":memory:"); cleanup.push(() => store.close());
  const profile: Profile = { id: "webkit-one", engine: "webkit", webkit: createWebKitProfileConfig(1920, 1080),
    accId: "", name: "WebKit", group: "", username: "", password: "", twofa: "", proxy: null,
    ua: WEBKIT_DEFAULT_UA, timezone: "Asia/Taipei", locale: "zh-TW", platformOs: "windows",
    screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 1, cookies: [], seeded: false };
  store.upsertProfile(profile);
  const binary = join(root, "runtime", "Playwright.exe"), directory = join(root, profile.id);
  let browserAlive = false, ownerAlive = false, reachable = false, incomplete = false, launches = 0, reservations = 0;
  let owner: WebKitOwner, input: any, failStart = false;
  const events: string[] = [], killed: number[] = [], restoredCookies: unknown[] = [];
  const options: LauncherOptions = { store, dataRoot: root, chromiumRuntimeRoot: join(root, "runtimes"),
    hostPlatform: "win32", hostArch: "x64", unsafeDisableIdentityGates: true, enforceHostCompatibility: true,
    ensureWebKit: async () => binary, captureFingerprint: async () => null, ensureCookies: async () => ({ injected: false }),
    addNativeSessionCookies: async (_ws, cookies) => { restoredCookies.push(cookies); events.push("native-cookies"); return { injected: true }; },
    setCookies: async () => { events.push("pending-cookies"); },
    navigate: async (_ws, urls) => { if (urls.length) events.push(`navigate:${urls.join(",")}`); },
    readProcessSnapshot: async (): Promise<HostProcessSnapshot> => ({ incomplete, records: [
      ...(ownerAlive ? [{ pid: 201, executablePath: "node", argv: ["node", "webkit-worker.mjs", `--aliasmode-webkit-owner=${owner.generation}`] }] : []),
      ...(browserAlive ? [{ pid: 202, parentPid: 201, executablePath: binary, argv: [binary, `--user-data-dir=${directory}`] },
        { pid: 203, parentPid: 202, executablePath: join(root, "runtime", "WebKitWebProcess.exe") }] : []),
      { pid: 999, executablePath: "D:\\unrelated\\node.exe", argv: ["node", "unrelated.js"] },
    ] }),
    isPidAlive: (pid) => pid === 201 ? ownerAlive : pid === 202 || pid === 203 ? browserAlive : true,
    killPid: async (pid) => { killed.push(pid); if (pid === 202) browserAlive = false; if (pid === 201) ownerAlive = false; },
    teardownTimeoutMs: 10, teardownPollMs: 1, log: () => {},
    webkitRuntime: {
      reserve: async () => { reservations++; return { endpoint: `http://127.0.0.1:${41000 + reservations}/`, token: "secret", generation: `generation-${reservations}` }; },
      start: async (value, callbacks) => {
        launches++; input = value;
        if (failStart) throw new WebKitOwnerError("runtime_unavailable", "WebKit is unavailable");
        expect(store.getLaunch(profile.id)?.webkitOwner?.generation).toBe(callbacks!.reservation!.generation);
        owner = { ...callbacks!.reservation!, pid: 201, browserPid: 202 };
        ownerAlive = true; await callbacks?.onSpawn?.({ ...owner, browserPid: 0 });
        browserAlive = true; reachable = true; await callbacks?.onReady?.(owner); return owner;
      },
      call: async (_owner, operation) => {
        if (!reachable || !ownerAlive || !browserAlive) throw new WebKitOwnerError("runtime_unavailable", "WebKit is unavailable");
        if (operation !== "status") return null as any;
        return { ...owner, profileId: profile.id, directory, executablePath: binary, hasPages: true, pageTargets: [{ id: "page-1", url: "https://example.com/" }] } as any;
      },
      close: async () => { browserAlive = false; ownerAlive = false; reachable = false; },
    },
  };
  return { root, directory, store, profile, options, launcher: new Launcher(options), events, killed, restoredCookies,
    input: () => input, launches: () => launches,
    crashOwner: () => { ownerAlive = false; reachable = false; }, setIncomplete: (value: boolean) => { incomplete = value; },
    failStart: () => { failStart = true; },
  };
}

test("WebKit saves ownership before spawn and reattaches the same generation after manager replacement", async () => {
  const f = fixture(), opened = await f.launcher.start(f.profile.id);
  expect(opened.ws).toMatch(/^webkit:\/\//); expect(opened.ws).not.toContain("secret");
  expect(f.input().config).toEqual({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-TW", timezoneId: "Asia/Taipei", userAgent: WEBKIT_DEFAULT_UA, screen: { width: 1920, height: 1080 } });
  const restarted = new Launcher(f.options);
  expect(await restarted.start(f.profile.id)).toMatchObject({ ws: opened.ws, reattached: true });
  expect(await restarted.certifiedActive(f.profile.id)).toBe(true); expect(f.launches()).toBe(1);
  expect(await restarted.stop(f.profile.id)).toBe(true); expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("a WebKit owner crash cannot double-launch or kill an unrelated process", async () => {
  const f = fixture(); await f.launcher.start(f.profile.id); f.crashOwner();
  const restarted = new Launcher(f.options);
  await expect(restarted.start(f.profile.id)).rejects.toMatchObject({ failure: "preflight", preflightReason: "browser_unresponsive" });
  expect(f.launches()).toBe(1); expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
  expect(await restarted.stop(f.profile.id)).toBe(true);
  expect(f.killed).toContain(202); expect(f.killed).not.toContain(999);
});

test("a stale WebKit stop generation leaves its replacement running", async () => {
  const f = fixture(); await f.launcher.start(f.profile.id); const old = f.store.getLaunch(f.profile.id)!;
  expect(await f.launcher.stop(f.profile.id)).toBe(true); await f.launcher.start(f.profile.id);
  expect(await f.launcher.stop(f.profile.id, old)).toBe(false);
  expect(await f.launcher.certifiedActive(f.profile.id)).toBe(true); expect(f.killed).toEqual([]);
  expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("an inconclusive WebKit process scan keeps the launch reserved", async () => {
  const f = fixture(); await f.launcher.start(f.profile.id); f.setIncomplete(true);
  await expect(new Launcher(f.options).start(f.profile.id)).rejects.toMatchObject({ failure: "preflight" });
  expect(f.launches()).toBe(1); expect(f.store.getLaunch(f.profile.id)).not.toBeNull(); expect(f.killed).toEqual([]);
  f.setIncomplete(false); expect(await f.launcher.stop(f.profile.id)).toBe(true);
});

test("WebKit restores native session cookies once before pending cookies and navigation", async () => {
  const f = fixture(); await f.launcher.start(f.profile.id); await f.launcher.stop(f.profile.id);
  const cookie = { name: "account", value: "native", domain: "example.com", path: "/", expires: -1 };
  writeFileSync(join(f.directory, WEBKIT_SESSION_FILE), JSON.stringify({ version: 1, profileId: f.profile.id, generation: "41001:1234", cookies: [cookie] }));
  f.store.addPendingCookies(f.profile.id, [{ ...cookie, value: "edited" }]); f.events.length = 0;
  const opened = await f.launcher.start(f.profile.id, ["https://example.com/"]);
  expect(opened.nativeSessionLoaded).toBe(true);
  expect(f.events).toEqual(["native-cookies", "pending-cookies", "navigate:https://example.com/"]);
  expect(f.restoredCookies).toEqual([[cookie]]); expect(existsSync(join(f.directory, WEBKIT_SESSION_FILE))).toBe(false);
  await f.launcher.stop(f.profile.id);
});

test("WebKit reports its own startup failure and clears a confirmed unused reservation", async () => {
  const f = fixture(); f.failStart();
  await expect(f.launcher.start(f.profile.id)).rejects.toMatchObject({ preflightReason: "webkit_unresponsive" });
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("WebKit rejects Chromium flags and incompatible pinned runtime before spawning", async () => {
  const f = fixture();
  await expect(f.launcher.start(f.profile.id, ["--no-first-run"])).rejects.toMatchObject({ preflightReason: "webkit_arguments" });
  f.store.upsertProfile({ ...f.profile, webkit: { ...f.profile.webkit!, revision: "2248" } });
  await expect(f.launcher.start(f.profile.id)).rejects.toMatchObject({ preflightReason: "webkit_configuration" });
  expect(f.launches()).toBe(0);
});

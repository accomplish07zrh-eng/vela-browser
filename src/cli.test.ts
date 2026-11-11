import { expect, test } from "bun:test";
import {
  browserLifecycleSmokeEngine,
  cloudRuntimeConfiguration,
  desktopFirstRunMode,
  dispatchReadSessionWorker,
  drainRemoteShutdown,
  exerciseWindowsWindowAcceptance,
  lifecycleAdmissionOptionsFromEnv,
  mapWindowsNativeWindowCandidates,
  RemoteShutdownTimeoutError,
  runCompiledSidecarSmoke,
  runCloakpitImportCommand,
} from "./cli.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import net from "node:net";
import { statePaths } from "./paths.ts";
import { applySourceRuntime, type SourceRuntime } from "./source-runtime.ts";

const cloudMode = {
  version: 1 as const,
  mode: "cloud" as const,
  localAnalytics: false,
};

const localMode = {
  version: 1 as const,
  mode: "local" as const,
  localAnalytics: false,
};

async function removeTemporaryRoot(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      // Antivirus on Windows runners can hold a fresh temporary file for several seconds.
      if ((error as { code?: string }).code !== "EBUSY" || attempt === 50) throw error;
      Bun.gc(true);
      await Bun.sleep(200);
    }
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("test loopback port is unavailable");
  return address.port;
}

test("migration-only command dispatches directly and reports required restrictions", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-"));
  const calls: unknown[][] = [];
  const result = await runCloakpitImportCommand([
    "--source", "C:\\Cloakpit",
    "--state-root", root,
    "--cloakpit-profile-root", "D:\\LegacyProfiles",
  ], async (...args) => {
    calls.push(args);
    return { status: "migrated", profileCount: 2 };
  });
  expect(calls).toEqual([["C:\\Cloakpit", statePaths(root), { profileRoot: "D:\\LegacyProfiles" }]]);
  expect(result.ok).toBe(true);
  expect(result.message).toContain("DPAPI");
  expect(result.message).toContain("persona fields are preserved");
  expect(result.message).toContain("runtime or browser differences");
});

test("internal migration command exits before normal startup creates state", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cli-import-main-"));
  const destination = join(parent, "destination");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "cli.ts"),
    "__import-cloakpit",
    "--source", join(parent, "missing"),
    "--state-root", destination,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  expect(existsSync(destination)).toBe(false);
});

test("source start reports when Node is unavailable", async () => {
  const parent = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-node-"));
  const stateRoot = join(parent, "state");
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "cli.ts"),
    "start",
    "--state-root", stateRoot,
  ], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, PATH: "", ALIASMODE_PLAYWRIGHT_RUNTIME: "" },
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("source Playwright runtime requires Node.js 18 or newer on PATH");
  expect(stderr).toContain("bun cli.ts setup");
  expect(existsSync(stateRoot)).toBe(false);
  await removeTemporaryRoot(parent);
});

test("source start loads a managed runtime from its custom state root before verification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-runtime-"));
  const root = join(cwd, "custom-state");
  mkdirSync(root);
  const node = Bun.which("node");
  if (!node) throw new Error("test Node runtime is unavailable");
  const runtime: SourceRuntime = {
    version: 1,
    node: resolve(node),
    chromium: { path: join(root, "managed-chromium"), sha256: "a".repeat(64) },
    firefox: { path: join(root, "managed-firefox"), sha256: "b".repeat(64) },
  };
  writeFileSync(join(root, "browser-runtime.json"), JSON.stringify(runtime));
  const applied: NodeJS.ProcessEnv = { PATH: "" };
  applySourceRuntime(root, applied);
  expect(applied.PATH).toStartWith(dirname(runtime.node));
  expect(applied.CLOAKBROWSER_BINARY_SHA256).toBe(runtime.chromium.sha256);
  expect(applied.ALIASMODE_FIREFOX_BINARY_SHA256).toBe(runtime.firefox.sha256);

  const port = await freeLoopbackPort();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "", ALIASMODE_PLAYWRIGHT_RUNTIME: "" };
  delete env.CLOAKBROWSER_BINARY_PATH;
  delete env.CLOAKBROWSER_BINARY_SHA256;
  delete env.ALIASMODE_FIREFOX_BINARY_PATH;
  delete env.ALIASMODE_FIREFOX_BINARY_SHA256;
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    join(import.meta.dir, "cli.ts"),
    "start",
    "--port", String(port),
    "--state-root", root,
  ], { cwd, stdout: "pipe", stderr: "ignore", env });
  const output = new Response(child.stdout).text();
  let logs = "";
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        health = await fetch(`http://127.0.0.1:${port}/ui/api/health`);
        if (health.ok) break;
      } catch {}
      if (await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
    }
    expect(health?.ok).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    logs = await output;
    await removeTemporaryRoot(cwd);
  }
  expect(logs).toContain("local mode:");
});

for (const mode of ["unconfigured", "local", "cloud"] as const) {
  test(`source start reports ${mode} recovery and serves the loopback dashboard`, async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "aliasmode-cli-source-start-"));
    if (mode !== "unconfigured") {
      writeFileSync(statePaths(stateRoot).config, JSON.stringify({ version: 1, mode, cloudUrl: "http://127.0.0.1:1", localAnalytics: false }));
    }
    const port = await freeLoopbackPort();
    const child = Bun.spawn([
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "cli.ts"),
      "start",
      "--port", String(port),
      "--state-root", stateRoot,
    ], {
      cwd: stateRoot,
      stdout: "pipe",
      stderr: "ignore",
      env: {
        ...process.env,
        HUB_URL: "",
        ALIASMODE_CLOUD_URL: "http://127.0.0.1:1",
        ALIASMODE_SUPABASE_URL: "http://127.0.0.1:1",
        ALIASMODE_SUPABASE_ANON_KEY: "source-start-fixture",
        CLOAKBROWSER_BINARY_PATH: process.execPath,
        CLOAKBROWSER_BINARY_SHA256: "0".repeat(64),
      },
    });
    const output = new Response(child.stdout).text();
    try {
      let health: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          health = await fetch(`http://127.0.0.1:${port}/ui/api/health`);
          if (health.ok) break;
        } catch {}
        if (await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)])) break;
      }
      expect(health?.ok).toBe(true);
      expect(await health?.json()).toMatchObject({ ok: true });
    } finally {
      child.kill();
      await child.exited;
      await removeTemporaryRoot(stateRoot);
    }
    const logs = await output;
    expect(logs).toContain("local mode:");
    expect(logs).not.toContain("NOT connected to a hub");
    const phases = ["initializing autofill bridge", "checking 0 saved browser process(es)", "browser recovery checks complete"];
    const positions = phases.map((phase) => logs.indexOf(`startup: ${phase}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(logs).toContain("startup: verifying surviving local browsers");
  });
}

test("compiled sidecar smoke restores before navigation and capture", async () => {
  const events: string[] = [];
  await runCompiledSidecarSmoke("http://127.0.0.1:9222", {
    async writeSession(endpoint, bundle) {
      events.push(`write:${endpoint}`);
      expect(JSON.parse(bundle)).toEqual({
        cookies: [{
          name: "aliasmode_smoke",
          value: "live",
          domain: ".x.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [{
          origin: "https://web.telegram.org",
          localStorage: [{ name: "aliasmode_smoke", value: "live" }],
        }],
      });
    },
    async assertAlive(endpoint) {
      events.push(`alive:${endpoint}`);
    },
    async webSocketEndpoint(endpoint) {
      events.push(`resolve:${endpoint}`);
      return "ws://127.0.0.1:9222/devtools/browser/current";
    },
    async navigate(endpoint) {
      events.push(`navigate:${endpoint}`);
    },
    async readSession(endpoint) {
      events.push(`read:${endpoint}`);
      return JSON.stringify({ cookies: [{ name: "aliasmode_smoke", value: "live" }] });
    },
  });
  expect(events).toEqual([
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "write:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "resolve:http://127.0.0.1:9222",
    "write:ws://127.0.0.1:9222/devtools/browser/current",
    "alive:http://127.0.0.1:9222",
    "navigate:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
    "read:http://127.0.0.1:9222",
    "alive:http://127.0.0.1:9222",
  ]);
});

test("Windows native window candidates map only one distinct HWND per profile", () => {
  expect(mapWindowsNativeWindowCandidates(["first", "second"], [
    { profileId: "unrelated", hwnd: 99, minimized: false, visible: true },
    { profileId: "first", hwnd: 101, minimized: true, visible: true },
    { profileId: "second", hwnd: 202, minimized: false, visible: true },
  ])).toEqual({
    first: { hwnd: 101, minimized: true, visible: true },
    second: { hwnd: 202, minimized: false, visible: true },
  });

  for (const candidates of [
    [{ profileId: "first", hwnd: 101, minimized: false, visible: true }],
    [
      { profileId: "first", hwnd: 101, minimized: false, visible: true },
      { profileId: "first", hwnd: 102, minimized: false, visible: true },
      { profileId: "second", hwnd: 202, minimized: false, visible: true },
    ],
    [
      { profileId: "first", hwnd: 101, minimized: false, visible: true },
      { profileId: "second", hwnd: 101, minimized: false, visible: true },
    ],
  ]) {
    expect(mapWindowsNativeWindowCandidates(["first", "second"], candidates)).toEqual({});
  }
});

test("Windows window acceptance preserves native minimize state and selects only one distinct HWND", async () => {
  const events: string[] = [];
  const stages: string[] = [];
  const windows = {
    first: { hwnd: 101, minimized: false, visible: true },
    second: { hwnd: 202, minimized: false, visible: true },
  };
  let foregroundHwnd = windows.second.hwnd;
  let pageTargets = ["page-1"];

  await exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open(profileId) { events.push(`open:${profileId}`); },
    async verifySearchProvider(profileId) { events.push(`search:${profileId}`); },
    async verifyTabsRestored() { events.push("tabs-restored"); },
    async close(profileId) { events.push(`close:${profileId}`); },
    async nativeWindows() {
      return {
        foregroundHwnd,
        windows: {
          first: { ...windows.first },
          second: { ...windows.second },
        },
      };
    },
    async minimize(profileId) {
      events.push(`minimize:${profileId}`);
      windows[profileId as keyof typeof windows].minimized = true;
    },
    async pageTargetIds(profileId) {
      events.push(`targets:${profileId}:${pageTargets.join(",")}`);
      return [...pageTargets];
    },
    async runProfileCardObserved(profileId) {
      events.push(`profile-card:${profileId}`);
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved(profileId) {
      events.push(`background-page:${profileId}`);
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved(profileId) {
      events.push(`session-capture:${profileId}`);
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront(profileId) {
      events.push(`raise:${profileId}`);
      windows[profileId as keyof typeof windows].minimized = false;
      foregroundHwnd = windows[profileId as keyof typeof windows].hwnd;
    },
    reportStage(stage) { stages.push(stage); },
  });

  expect(events).toEqual([
    "open:first",
    "open:second",
    "search:first",
    "search:second",
    "tabs-restored",
    "targets:first:page-1",
    "targets:second:page-1",
    "minimize:first",
    "targets:first:page-1",
    "profile-card:first",
    "targets:first:page-1",
    "background-page:first",
    "targets:first:page-1",
    "session-capture:first",
    "targets:first:page-1",
    "raise:first",
    "raise:second",
    "close:second",
    "close:first",
  ]);
  expect(pageTargets).toEqual(["page-1"]);
  expect(stages).toEqual([
    "search_provider_ready",
    "tabs_restored",
    "page_targets_ready",
    "windows_distinct",
    "window_minimized",
    "profile_card_observed",
    "background_page_observed",
    "session_capture_observed",
    "first_window_raised",
    "second_window_raised",
  ]);
});

test("Windows window acceptance rejects a missing initial page before native polling", async () => {
  const events: string[] = [];
  await expect(exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open(profileId) { events.push(`open:${profileId}`); },
    async close(profileId) { events.push(`close:${profileId}`); },
    async nativeWindows() {
      events.push("native-windows");
      return { foregroundHwnd: 0, windows: {} };
    },
    async minimize() {},
    async pageTargetIds(profileId) {
      events.push(`targets:${profileId}`);
      return profileId === "first" ? ["page-1"] : [];
    },
    async runProfileCardObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved() {
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront() {},
  })).rejects.toThrow("managed CloakBrowser did not expose initial page targets");
  expect(events).toEqual([
    "open:first",
    "open:second",
    "targets:first",
    "targets:second",
    "close:second",
    "close:first",
  ]);
});

test("Windows window acceptance rejects a profile-card page target and still closes both browsers", async () => {
  const closed: string[] = [];
  let pageTargets = ["page-1"];
  await expect(exerciseWindowsWindowAcceptance({
    profileIds: ["first", "second"],
    async open() {},
    async close(profileId) { closed.push(profileId); },
    async nativeWindows() {
      return {
        foregroundHwnd: 202,
        windows: {
          first: { hwnd: 101, minimized: true, visible: true },
          second: { hwnd: 202, minimized: false, visible: true },
        },
      };
    },
    async minimize() {},
    async pageTargetIds() { return [...pageTargets]; },
    async runProfileCardObserved() {
      pageTargets = ["page-2"];
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async runBackgroundPageObserved() {
      return {
        createdPageTargetIds: ["temporary-page"],
        destroyedPageTargetIds: ["temporary-page"],
        nativeWindowStayedMinimized: true,
      };
    },
    async runSessionCaptureObserved() {
      return { createdPageTargetIds: [], nativeWindowStayedMinimized: true };
    },
    async bringToFront() {},
  })).rejects.toThrow("profile-card operation changed the page targets");
  expect(closed).toEqual(["second", "first"]);
});

for (const scenario of [
  {
    name: "transient page target",
    observation: { createdPageTargetIds: ["transient-page"], nativeWindowStayedMinimized: true },
    failure: "profile-card operation created a page target",
  },
  {
    name: "transient native restore",
    observation: { createdPageTargetIds: [], nativeWindowStayedMinimized: false },
    failure: "profile-card operation transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return scenario.observation; },
      async runBackgroundPageObserved() {
        return {
          createdPageTargetIds: ["temporary-page"],
          destroyedPageTargetIds: ["temporary-page"],
          nativeWindowStayedMinimized: true,
        };
      },
      async runSessionCaptureObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

for (const scenario of [
  {
    name: "missing created background page target",
    observation: {
      createdPageTargetIds: [],
      destroyedPageTargetIds: [],
      nativeWindowStayedMinimized: true,
    },
    failure: "background page operation did not observe exactly one created page target",
  },
  {
    name: "missing destroyed background page target",
    observation: {
      createdPageTargetIds: ["temporary-page"],
      destroyedPageTargetIds: [],
      nativeWindowStayedMinimized: true,
    },
    failure: "background page operation did not observe its page target being destroyed",
  },
  {
    name: "background page native restore",
    observation: {
      createdPageTargetIds: ["temporary-page"],
      destroyedPageTargetIds: ["temporary-page"],
      nativeWindowStayedMinimized: false,
    },
    failure: "background page operation transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async runBackgroundPageObserved() { return scenario.observation; },
      async runSessionCaptureObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

for (const scenario of [
  {
    name: "session-capture page target",
    observation: { createdPageTargetIds: ["transient-page"], nativeWindowStayedMinimized: true },
    failure: "session capture created a page target",
  },
  {
    name: "session-capture native restore",
    observation: { createdPageTargetIds: [], nativeWindowStayedMinimized: false },
    failure: "session capture transiently restored the minimized native window",
  },
]) {
  test(`Windows window acceptance rejects a ${scenario.name} and still closes both browsers`, async () => {
    const closed: string[] = [];
    await expect(exerciseWindowsWindowAcceptance({
      profileIds: ["first", "second"],
      async open() {},
      async close(profileId) { closed.push(profileId); },
      async nativeWindows() {
        return {
          foregroundHwnd: 202,
          windows: {
            first: { hwnd: 101, minimized: true, visible: true },
            second: { hwnd: 202, minimized: false, visible: true },
          },
        };
      },
      async minimize() {},
      async pageTargetIds() { return ["page-1"]; },
      async runProfileCardObserved() { return { createdPageTargetIds: [], nativeWindowStayedMinimized: true }; },
      async runBackgroundPageObserved() {
        return {
          createdPageTargetIds: ["temporary-page"],
          destroyedPageTargetIds: ["temporary-page"],
          nativeWindowStayedMinimized: true,
        };
      },
      async runSessionCaptureObserved() { return scenario.observation; },
      async bringToFront() {},
    })).rejects.toThrow(scenario.failure);
    expect(closed).toEqual(["second", "first"]);
  });
}

test("CLI dispatches the session worker before normal command parsing", async () => {
  const events: string[] = [];
  expect(await dispatchReadSessionWorker(["list"], {
    async readSession() { throw new Error("must not run"); },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(false);
  expect(events).toEqual([]);

  expect(await dispatchReadSessionWorker(["--read-session-worker", "ws://capture"], {
    async readSession(ws) {
      expect(ws).toBe("ws://capture");
      return "captured bundle";
    },
    async write(value) { events.push(value); },
    exit(code) { events.push(`exit:${code}`); },
  })).toBe(true);
  expect(events).toEqual([
    JSON.stringify({ ok: true, bundle: "captured bundle" }),
    "exit:0",
  ]);
});

test("desktop first run opens the local workspace without sign-in", () => {
  expect(desktopFirstRunMode(true, {})).toBe("local");
  expect(desktopFirstRunMode(true, { ALIASMODE_BACKGROUND: "1" })).toBe("local");
  expect(desktopFirstRunMode(false, {})).toBeNull();
});

test("Local mode does not initialize or validate Cloud configuration", () => {
  const invalidEnv = {
    ALIASMODE_CLOUD_URL: "not a URL",
    ALIASMODE_SUPABASE_URL: "not a URL",
    ALIASMODE_SUPABASE_ANON_KEY: "",
  };
  expect(cloudRuntimeConfiguration(localMode, invalidEnv)).toBeNull();
});

test("lifecycle admission env config is optional and parses positive integers", () => {
  expect(lifecycleAdmissionOptionsFromEnv({})).toEqual({});
  expect(lifecycleAdmissionOptionsFromEnv({
    ALIASMODE_LIFECYCLE_CAP: "6",
    ALIASMODE_LIFECYCLE_WAIT_MS: "180000",
  })).toEqual({ limit: 6, queueWaitMs: 180_000 });
});

test("invalid lifecycle admission env config fails startup validation", () => {
  for (const [name, value] of [
    ["ALIASMODE_LIFECYCLE_CAP", "0"],
    ["ALIASMODE_LIFECYCLE_CAP", "4.5"],
    ["ALIASMODE_LIFECYCLE_CAP", "NaN"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", "Infinity"],
    ["ALIASMODE_LIFECYCLE_WAIT_MS", ""],
  ] as const) {
    expect(() => lifecycleAdmissionOptionsFromEnv({ [name]: value })).toThrow(`${name} must be a positive integer`);
  }
});

test("remote shutdown retries unconfirmed cleanup until it is safe to exit", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const logs: string[] = [];

  await drainRemoteShutdown(
    async () => ++attempts >= 3,
    {
      retryMs: 7,
      attemptLogMs: 100,
      sleep: async (ms) => { waits.push(ms); },
      log: (message) => logs.push(message),
    },
  );

  expect(attempts).toBe(3);
  expect(waits).toEqual([7, 7]);
  expect(logs.filter((message) => message.includes("remains unconfirmed")).length).toBe(2);
  expect(logs.at(-1)).toContain("confirmed on attempt 3");
});

test("remote shutdown logs a hung cleanup in bounded windows without overlapping it", async () => {
  let attempts = 0;
  let finish!: (confirmed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  const logs: string[] = [];

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return pending;
    },
    {
      attemptLogMs: 2,
      retryMs: 1,
      sleep: async () => {},
      log: (message) => logs.push(message),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  expect(attempts).toBe(1);
  expect(logs.some((message) => message.includes("continuing to wait without overlapping"))).toBe(true);

  finish(true);
  await draining;
  expect(attempts).toBe(1);
});

test("remote shutdown has a total deadline even when cleanup never settles", async () => {
  let attempts = 0;
  const never = new Promise<boolean>(() => {});

  const draining = drainRemoteShutdown(
    () => {
      attempts++;
      return never;
    },
    {
      maxDrainMs: 12,
      attemptLogMs: 3,
      retryMs: 1,
      log: () => {},
    },
  );

  await expect(draining).rejects.toBeInstanceOf(RemoteShutdownTimeoutError);
  expect(attempts).toBe(1);
});

test("remote shutdown deadline retains failed cleanup instead of retrying forever", async () => {
  let attempts = 0;
  let now = 0;

  await expect(drainRemoteShutdown(
    async () => {
      attempts++;
      return false;
    },
    {
      maxDrainMs: 10,
      retryMs: 7,
      attemptLogMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      log: () => {},
    },
  )).rejects.toThrow("launch records and any unconfirmed hub locks were intentionally retained");

  expect(attempts).toBe(2);
});

 test("legacy environment variables cannot enable account runtimes", () => {
    for (const mode of [cloudMode, localMode, { ...localMode, mode: "unconfigured" as const }]) {
      expect(cloudRuntimeConfiguration(mode, { ALIASMODE_CLOUD_URL: "not a URL", ALIASMODE_SUPABASE_URL: "http://127.0.0.1:1", ALIASMODE_SUPABASE_ANON_KEY: "legacy" })).toBeNull();
    }
  });
  test("removed Cloud CLI commands fail before creating state or contacting a service", async () => {
    const root = mkdtempSync(join(tmpdir(), "vela-retired-cli-"));
    const stateRoot = join(root, "must-not-be-created");
    try {
      for (const command of ["__cloud-restore-fixture", "__cloud-launcher-smoke", "__cloud-cross-device-acceptance"]) {
        const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), command, "--state-root", stateRoot], { stdout: "pipe", stderr: "pipe" });
        const output = new Response(child.stderr).text();
        expect(await child.exited).not.toBe(0);
        expect(await output).toContain("Accounts and Cloud mode have been removed");
        expect(existsSync(stateRoot)).toBe(false);
      }
    } finally { await removeTemporaryRoot(root); }
  });

test("browser lifecycle smoke accepts only locally supported engines", () => {
  expect(browserLifecycleSmokeEngine([])).toBe("chromium");
  expect(browserLifecycleSmokeEngine(["--engine", "firefox"])).toBe("firefox");
  for (const engine of ["", "edge", "unknown"]) expect(() => browserLifecycleSmokeEngine(["--engine", engine])).toThrow("chromium or firefox");
});

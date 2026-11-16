import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "./app-config.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { PLAYWRIGHT_PROTOCOL_VERSION } from "./playwright-runtime.ts";
import {
  serveAutomationApi,
  serveDashboard,
  serveDesktopAutomationApi,
} from "./web.ts";

const webSource = readFileSync(join(import.meta.dir, "web.ts"), "utf8");

test("profile identity cards do not fetch egress IP automatically", () => {
  expect(webSource).not.toContain("ip-api.com/json");
  expect(webSource).not.toContain("checking egress IP");
  expect(webSource).toContain("Vela Firefox");
  expect(webSource).toContain("no CDP, PDF, or Chrome extensions");
});

test("identity cards load stored Chromium and Firefox metadata without egress lookup", async () => {
  const store = new ProfileStore(":memory:");
  const chromium = buildNewProfile({ chromiumRuntime: "cloakbrowser", name: "Chromium card" }, () => false);
  const firefox = buildNewProfile({ engine: "firefox", name: "Firefox card" }, (id) => id === chromium.id);
  const chromium155 = buildNewProfile({ chromiumRuntime: "aliasmode", name: "Chromium 155 card" }, (id) => id === chromium.id || id === firefox.id);
  store.upsertProfiles([chromium, firefox, chromium155]);
  const server = serveDashboard({ port: 0, launcher: {} as any, store, log: () => {} });

  try {
    for (const [profile, browser] of [
      [chromium, "CloakBrowser"],
      [firefox, "Vela Firefox"],
      [chromium155, "Vela Chromium"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}/card?id=${profile.id}`);
      expect(response.status).toBe(200);
      const card = await response.text();
      expect(card).toContain(browser);
      expect(card).toContain(profile.timezone || "—");
      expect(card).not.toContain("ip-api.com");
    }
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("dashboard serves in production mode so it never watches the app folder", async () => {
  const server = serveDashboard({ port: 0, launcher: {} as any, store: {} as any, log: () => {} });
  try {
    expect(server.development).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("dashboard health route blocks browser cross-origin submissions on loopback", async () => {
  let publishes = 0;
  const server = serveDashboard({
    port: 0,
    launcher: {} as any,
    store: {} as any,
    remote: {
      publishAutomationHealthSnapshot: async () => {
        publishes++;
        return { profiles: 1, alive: 0, suspended: 1 };
      },
    } as any,
    log: () => {},
  });

  try {
    const endpoint = `http://127.0.0.1:${server.port}/api/xactions/health-snapshot`;
    const body = JSON.stringify({ profiles: [{ profileId: "p1", suspended: true }] });

    const automation = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(automation.status).toBe(200);
    expect(publishes).toBe(1);

    const browser = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body,
    });
    expect(browser.status).toBe(403);

    const simplePost = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body,
    });
    expect(simplePost.status).toBe(415);
    expect(publishes).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("automation API serves compatibility routes without desktop UI", async () => {
  const store = new ProfileStore(":memory:");
  let publishes = 0;
  const server = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    remote: {
      listProfiles: async () => [],
      publishAutomationHealthSnapshot: async () => {
        publishes++;
        return { profiles: 1, alive: 1, suspended: 0 };
      },
    } as any,
    log: () => {},
  });

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const status = await fetch(`${origin}/api/v1/status`).then((response) => response.json());
    expect(status.code).toBe(0);

    const profiles = await fetch(`${origin}/api/v1/user/list?page=1&page_size=10`).then((response) => response.json());
    expect(profiles).toMatchObject({ code: 0, data: { list: [] } });

    const health = await fetch(`${origin}/api/xactions/health-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles: [{ profileId: "p1", suspended: false }] }),
    });
    expect(health.status).toBe(200);
    expect(publishes).toBe(1);

    for (const path of ["/", "/ui/api/health", "/card?id=p1", "/api/agent/v1/connect"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.headers.get("content-type")).not.toContain("text/html");
      expect(await response.text()).not.toContain("<!doctype html>");
    }
  } finally {
    await server.stop(true);
    store.close();
  }
});

test.each([serveAutomationApi, serveDashboard])("compatibility API keeps default access and respects an explicit scope (%p)", async (serve) => {
  const root = mkdtempSync(join(tmpdir(), "vela-automation-scope-"));
  const appConfig = new AppConfigStore(join(root, "app-config.json"));
  const store = new ProfileStore(":memory:");
  const allowed = buildNewProfile({ engine: "firefox", name: "Allowed", group: "Work" }, () => false);
  const excluded = buildNewProfile({ engine: "firefox", name: "Excluded", group: "Personal" }, (id) => id === allowed.id);
  store.upsertProfiles([allowed, excluded]);
  const cookie = { name: "session", value: "fixture-only", domain: "example.test", path: "/" };
  let reads = 0;
  const owner = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as { operation: string };
      expect(body.operation).toBe("cookie-harvest");
      reads++;
      return Response.json({ version: PLAYWRIGHT_PROTOCOL_VERSION, ok: true, result: [cookie] });
    },
  });
  for (const profile of [allowed, excluded]) {
    store.recordLaunch({
      profileId: profile.id, pid: 1, debugPort: owner.port!, ws: `firefox://127.0.0.1:${owner.port}/${profile.id}`,
      startedAt: 1, userDataDir: join(root, profile.id), engine: "firefox",
      firefoxOwner: { endpoint: owner.url.href, token: "fixture-token", pid: 1, browserPid: 1, generation: profile.id },
    });
  }
  const launchCalls: string[] = [];
  const cacheCalls: string[] = [];
  const launcher = {
    certifiedActive: async () => true,
    start: async (id: string) => { launchCalls.push(id); return { ws: store.getLaunch(id)!.ws, port: owner.port }; },
    clearCache: async (id: string) => { cacheCalls.push(id); },
  } as any;
  const api = serve({ port: 0, launcher, appConfig, store, log: () => {} });
  const call = (path: string, body?: object) => fetch(`http://127.0.0.1:${api.port}${path}`, body && {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((response) => response.json());
  const browser = (action: string, id: string) => call(`/api/v1/browser/${action}?user_id=${id}`);

  try {
    expect(await browser("start", excluded.id)).toMatchObject({ code: 0, data: { engine: "firefox" } });
    expect(await browser("cookies", excluded.id)).toMatchObject({ code: 0, data: { cookies: [cookie] } });

    appConfig.write({ ...appConfig.read(), aiAccess: { default: ["Work"], agents: {} } });
    expect(await browser("cookies", allowed.id)).toMatchObject({ code: 0, data: { cookies: [cookie] } });
    for (const action of ["start", "stop", "active", "cookies"]) {
      expect(await browser(action, excluded.id)).toMatchObject({ code: -1, msg: "Outside the default AI access scope" });
    }
    expect(launchCalls).toEqual([excluded.id]);
    expect(reads).toBe(2);
    expect(await call("/api/v1/user/list")).toMatchObject({ code: 0, data: { list: [{ user_id: allowed.id }] } });
    expect(await call("/api/v1/group/list")).toMatchObject({ code: 0, data: { list: [{ group_id: "Work" }] } });
    expect(await call("/api/v2/browser-profile/delete-cache", { profile_id: [allowed.id, excluded.id] })).toMatchObject({ code: -1 });
    expect(cacheCalls).toEqual([]);
    expect(await call("/api/v2/browser-profile/delete-cache", { profile_id: [allowed.id] })).toMatchObject({ code: 0 });
    expect(cacheCalls).toEqual([allowed.id]);

    appConfig.write({ ...appConfig.read(), aiAccess: { default: "none", agents: {} } });
    expect(await browser("start", allowed.id)).toMatchObject({ code: -1 });
    expect(await browser("cookies", allowed.id)).toMatchObject({ code: -1 });
    expect(await call("/api/v1/status")).toMatchObject({ code: 0 });
  } finally {
    await api.stop(true);
    owner.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard and automation API share lifecycle admission", async () => {
  const store = new ProfileStore(":memory:");
  const admission = new LifecycleAdmissionController({ limit: 1 });
  let release = () => {};
  const blocker = admission.run(
    { kind: "start", profileIds: ["held"] },
    () => new Promise<void>((resolve) => { release = resolve; }),
  );
  const dashboard = serveDashboard({
    port: 0,
    launcher: {} as any,
    store,
    lifecycleAdmission: admission,
    log: () => {},
  });
  const automation = serveAutomationApi({
    port: 0,
    launcher: {} as any,
    store,
    lifecycleAdmission: admission,
    log: () => {},
  });

  try {
    const dashboardStatus = await fetch(`http://127.0.0.1:${dashboard.port}/status`).then((response) => response.json());
    const automationStatus = await fetch(`http://127.0.0.1:${automation.port}/status`).then((response) => response.json());
    expect(dashboardStatus.data.admission.inFlight).toBe(1);
    expect(automationStatus.data.admission.inFlight).toBe(1);
  } finally {
    release();
    await blocker;
    await Promise.all([dashboard.stop(true), automation.stop(true)]);
    store.close();
  }
});

test("desktop automation API owns 127.0.0.1:50400 and desktop startup survives conflicts", async () => {
  const store = new ProfileStore(":memory:");
  const logs: string[] = [];
  const options = {
    launcher: {} as any,
    store,
    log: (message: string) => logs.push(message),
  };
  const server = serveDesktopAutomationApi(options);
  const dashboard = serveDashboard({ ...options, port: 0, log: () => {} });
  try {
    expect(dashboard.port).not.toBe(50_400);
    if (server) {
      expect(server.port).toBe(50_400);
      const response = await fetch("http://127.0.0.1:50400/status");
      expect(await response.json()).toMatchObject({ code: 0 });
      expect(serveDesktopAutomationApi(options)).toBeUndefined();
    }

    expect(logs.some((message) =>
      message.includes("automation API could not bind to http://127.0.0.1:50400")
    )).toBeTrue();
    expect(logs.filter((message) => message.includes("automation API on")).length)
      .toBe(server ? 1 : 0);

    const health = await fetch(`http://127.0.0.1:${dashboard.port}/ui/api/health`);
    expect(health.status).toBe(200);
  } finally {
    await Promise.all([server?.stop(true), dashboard.stop(true)]);
    store.close();
  }
});

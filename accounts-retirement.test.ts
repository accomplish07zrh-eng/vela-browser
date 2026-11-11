import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "./app-config.ts";
import { buildNewProfile } from "./create.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

test("retired account routes never access credentials, runtime dependencies or the network", async () => {
  const unreachable = new Proxy({}, { get() { throw new Error("retired account dependency accessed"); } });
  const paths = [
    "cloud-auth", "cloud-auth/sign-in", "cloud-auth/sign-up", "cloud-auth/restore", "cloud-auth/sign-out",
    "cloud-auth/legal", "cloud-workspace", "cloud-workspace/invite", "cloud-events", "cloud-connectors",
    "cloud-store", "cloud/auth", "cloud/team", "scripts/example/publication", "profiles/example/restore-session",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/${path}`, { method }), unreachable as any, unreachable as any, null, unreachable);
      expect(response?.status).toBe(410);
      expect(response?.headers.get("cache-control")).toBe("no-store");
      expect(await response?.json()).toMatchObject({ ok: false, code: "accounts_removed" });
    }
  }
});

test("local environment routes ignore legacy account runtime hooks", async () => {
  const store = new ProfileStore(":memory:");
  const unreachable = new Proxy({}, { get() { throw new Error("retired account runtime accessed"); } });
  const raised: string[] = [];
  const launcher = { reconcileOrphans: async () => {}, bringToFront: async (id: string) => { raised.push(id); } };
  try {
    const profile = buildNewProfile({ engine: "chromium", name: "Local environment" }, () => false);
    store.upsertProfile(profile);
    const before = store.getProfile(profile.id);
    const options = { cloudAuth: unreachable, cloudBrowser: unreachable, cloudConnection: unreachable } as any;
    const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/profiles"), launcher as any, store, null, options);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ profiles: [{ id: profile.id, name: "Local environment" }] });
    const trash = await handleUiRequest(new Request("http://127.0.0.1/ui/api/trash"), launcher as any, store, null, options);
    expect(trash?.status).toBe(200);
    const raisedResponse = await handleUiRequest(new Request(`http://127.0.0.1/ui/api/profiles/${profile.id}/raise`, { method: "POST" }), launcher as any, store, null, options);
    expect(await raisedResponse?.json()).toEqual({ ok: true });
    expect(raised).toEqual([profile.id]);
    expect(store.getProfile(profile.id)).toEqual(before);
  } finally {
    store.close();
  }
});

test("configuration can be read locally but no API call can switch account modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "vela-mode-retirement-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const unreachable = new Proxy({}, { get() { throw new Error("browser dependency accessed"); } });
  try {
    appConfig.setMode("local");
    const before = readFileSync(appConfig.path, "utf8");
    for (const mode of ["cloud", "local", "unconfigured"]) {
      const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/app-mode", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
      }), unreachable as any, unreachable as any, null, { appConfig });
      expect(response?.status).toBe(410);
      expect(await response?.json()).toMatchObject({ code: "accounts_removed" });
      expect(readFileSync(appConfig.path, "utf8")).toBe(before);
    }
    const response = await handleUiRequest(new Request("http://127.0.0.1/ui/api/app-mode"), unreachable as any, unreachable as any, null, { appConfig });
    expect(response?.status).toBe(200);
    const config = await response?.json();
    expect(config.mode).toBe("local");
    expect(config).not.toHaveProperty("cloudUrl");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retiring product accounts preserves website credentials, cookies and profile identity", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-data-retirement-"));
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  try {
    const profile = buildNewProfile({ engine: "chromium", name: "Preserved environment", username: "website-user", password: "website-password" }, () => false);
    profile.cookies = [{ name: "session", value: "website-session", domain: ".example.test", path: "/", expires: 4070908800 }];
    store.upsertProfile(profile);
    const before = store.getProfile(profile.id);
    writeFileSync(appConfig.path, JSON.stringify({ version: 1, mode: "cloud", cloudUrl: "https://old.example.test", localAnalytics: false }));
    appConfig.write(appConfig.read());
    expect(appConfig.read().mode).toBe("local");
    expect(store.getProfile(profile.id)).toEqual(before);
    expect(store.getProfile(profile.id)?.username).toBe("website-user");
    expect(store.getProfile(profile.id)?.cookies).toEqual(profile.cookies);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

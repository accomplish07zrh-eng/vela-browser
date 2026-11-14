import { test, expect } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";
import { BrowserLaunchError, Launcher, launchPersona } from "./launcher.ts";
import { parseExport } from "./parse.ts";
import { deriveFingerprintFlags, editedProfileHardware } from "./fingerprint.ts";
import { listUiProfiles, handleUiRequest, LOW_DISK_SPACE_BYTES } from "./ui.ts";
import { supportsChromium155Host } from "./aliasmode-chromium.ts";
import { webkitSupported } from "./webkit-config.ts";
import { trackRuntimeDownload } from "./runtime-download.ts";
import { readXlsx, writeXlsx } from "./xlsx.ts";
import { AppConfigStore } from "./app-config.ts";
import { CloudAuthRuntime } from "./cloud-auth.ts";
import { CloudConnectionRuntime } from "./cloud-connection.ts";
import { CloudBrowserCoordinator } from "./cloud-browser.ts";
import { PendingSyncRuntime } from "./pending-sync.ts";
import { EmailVerificationRequiredError, SupabaseAuthRequestError, type SupabaseAuthClient } from "./supabase-auth.ts";
import { CloudApiError, CloudRequestError } from "./cloud-client.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import type { ProxyCheckResult } from "./proxy-check.ts";
import type { Profile, ProxySpec } from "./types.ts";

const SAMPLE = `id=k1d0cd11
name=sophia
group=va1
username=account-user
password=SECRETpw
email=mailbox@example.com
emailpassword=MAILSECRETpw
fakey=TOTPSEED
cookie=[{"name":"auth_token","value":"COOKIEVAL","domain":".x.com","path":"/","expires":4070908800}]
proxytype=http
proxy=1.2.3.4:8080:proxyuser:PROXYPASS
ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36
resolution=1680*1050
******************`;

function store(): ProfileStore {
  const s = new ProfileStore(":memory:");
  for (const p of parseExport(SAMPLE).profiles) s.upsertProfile(p);
  return s;
}

function firefoxProfile(s: ProfileStore, id: string): Profile {
  const base = s.getProfile("k1d0cd11")!;
  return {
    ...base,
    id,
    engine: "firefox",
    firefox: {
      version: 1,
      runtimeVersion: "test-firefox",
      config: { timezone: "UTC" },
    },
  };
}

/** One exit lookup asks GeoJS (MaxMind's data) and ip-api.com at once. */
const EXIT_LOOKUP_CALLS = [["https://get.geojs.io/v1/ip/geo.json"], ["http://ip-api.com/json/?fields=status,timezone,countryCode,query"]];

function timezoneFetch(timezones: Record<string, string>, calls?: string[][]) {
  return async (url: string, _init: RequestInit) => {
    calls?.push([url]);
    const timezone = Object.values(timezones)[0];
    return { json: async () => timezone ? { status: "success", timezone } : { status: "fail" } };
  };
}

const EXTENSION_ZIP = Buffer.from(
  "UEsDBBQAAAAAAFtxHl1SmQ+hOwAAADsAAAANAAAAbWFuaWZlc3QuanNvbnsibWFuaWZlc3RfdmVyc2lvbiI6MywibmFtZSI6IlJvdXRlIEZpeHR1cmUiLCJ2ZXJzaW9uIjoiMSJ9UEsBAhQDFAAAAAAAW3EeXVKZD6E7AAAAOwAAAA0AAAAAAAAAAAAAAIABAAAAAG1hbmlmZXN0Lmpzb25QSwUGAAAAAAEAAQA7AAAAZgAAAAAA",
  "base64",
);

function extensionId(publicKey: Uint8Array): string {
  const digest = createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

const extensionKeys = generateKeyPairSync("rsa", { modulusLength: 1024 });
const extensionPublicKey = new Uint8Array(
  extensionKeys.publicKey.export({ format: "der", type: "spki" }),
);

function extensionCrx(): Uint8Array {
  const signature = new Uint8Array(sign("sha1", EXTENSION_ZIP, extensionKeys.privateKey));
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("Cr24"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, true);
  view.setUint32(8, extensionPublicKey.length, true);
  view.setUint32(12, signature.length, true);
  const out = new Uint8Array(header.length + extensionPublicKey.length + signature.length + EXTENSION_ZIP.length);
  out.set(header);
  out.set(extensionPublicKey, header.length);
  out.set(signature, header.length + extensionPublicKey.length);
  out.set(EXTENSION_ZIP, header.length + extensionPublicKey.length + signature.length);
  return out;
}

function extensionResponse(): Response {
  const bytes = extensionCrx();
  return new Response(bytes.buffer as ArrayBuffer);
}

test("listUiProfiles exposes metadata but redacts every secret", () => {
  const s = store();
  const list = listUiProfiles(s);
  const p = list[0]!;
  expect(p.proxy).toBe("1.2.3.4:8080"); // host:port only
  expect(p.cookieCount).toBe(1);
  expect(p.screen).toBe("1680x1050");
  expect(p.running).toBe(false);

  const json = JSON.stringify(list);
  for (const secret of ["account-user", "SECRETpw", "MAILSECRETpw", "mailbox@example.com", "TOTPSEED", "COOKIEVAL", "PROXYPASS", "proxyuser"]) {
    expect(json.includes(secret)).toBe(false);
  }
  s.close();
});

test("a quarantined legacy proxy stays visible and repairable without exposing credentials", async () => {
  const s = store();
  const raw = JSON.stringify({ type: "socks4", host: "legacy.example", port: "1080", user: "legacy-user", pass: "legacy-pass" });
  (s as any)["db"].query("UPDATE profiles SET proxy_json = ? WHERE id = ?").run(raw, "k1d0cd11");

  const roster = listUiProfiles(s);
  expect(roster).toHaveLength(1);
  expect(roster[0]!.proxy).toBeNull();
  expect(roster[0]!.proxyError).toContain("unsupported proxy type");
  expect(JSON.stringify(roster)).not.toContain("legacy-pass");

  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await response!.json()).profile;
  expect(edit.proxy).toBe("");
  expect(edit.proxyError).toContain("unsupported proxy type");
  s.close();
});

test("proxy check route rejects untrusted or invalid input without echoing credentials", async () => {
  const s = store();
  let checks = 0;
  const options = {
    proxyCheck: async () => {
      checks++;
      throw new Error("checker exposed private-password");
    },
  } as any;
  const request = (body: unknown, headers: HeadersInit = { "content-type": "application/json" }) =>
    handleUiRequest(new Request("http://x/ui/api/proxy/check", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }), {} as any, s, null, options);

  const untrusted = await request({}, { "content-type": "text/plain" });
  expect(untrusted!.status).toBe(415);
  expect(untrusted!.headers.get("cache-control")).toBe("no-store");

  const crossOrigin = await request({}, {
    "content-type": "application/json",
    origin: "https://outside.invalid",
  });
  expect(crossOrigin!.status).toBe(403);

  for (const body of [
    { proxy: { host: "", port: "" } },
    { proxy: { host: "proxy.example", port: "not-a-port" } },
    { proxy: { type: "private-password", host: "proxy.example", port: "8080" } },
    "not-json",
  ]) {
    const response = await request(body);
    const text = await response!.text();
    expect(response!.status).toBe(400);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("private-password");
    expect(text).not.toContain("proxy.example");
  }
  expect(checks).toBe(0);

  const failed = await request({
    proxy: {
      type: "http",
      host: "proxy.example",
      port: "8080",
      user: "proxy-user",
      pass: "private-password",
    },
  });
  const failureText = await failed!.text();
  expect(failed!.status).toBe(500);
  expect(failed!.headers.get("cache-control")).toBe("no-store");
  expect(failureText).toContain("Proxy check failed");
  expect(failureText).not.toContain("private-password");
  expect(failureText).not.toContain("checker exposed");
  expect(checks).toBe(1);
  // HTTPS proxies are checked too: the relay reaches them over TLS, as a launched browser's does.
  await request({ proxy: { type: "https", host: "proxy.example", port: "8443" } });
  expect(checks).toBe(2);
  s.close();
});

test("full profile edit keeps account and mailbox credentials in separate fields", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await response!.json()).profile;
  expect(edit).toMatchObject({
    username: "account-user",
    password: "SECRETpw",
    email: "mailbox@example.com",
    emailPassword: "MAILSECRETpw",
    twofa: "TOTPSEED",
  });
  const updated = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: {
        username: "account-user", password: "linkedin-pass",
        email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
      } }),
    }),
    {} as any,
    s,
  );
  expect(updated!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    username: "account-user", password: "linkedin-pass",
    email: "new-mail@example.com", emailPassword: "new-mail-pass", twofa: "NEWSEED",
  });
  s.close();
});

test("listUiProfiles reflects running status from the launches table", () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 123 });
  const p = listUiProfiles(s)[0]!;
  expect(p.running).toBe(true);
  expect(p.debugPort).toBe(9412);
  s.close();
});

test("open/close routes call the launcher", async () => {
  const s = store();
  const calls: string[] = [];
  const launcher: any = {
    start: async (id: string) => { calls.push(`start:${id}`); return { ws: "ws://x", port: 9333 }; },
    stop: async (id: string) => { calls.push(`stop:${id}`); return true; },
    captureLocalSession: async (id: string) => { calls.push(`capture:${id}`); return false; },
  };
  const open = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }), launcher, s);
  expect((await open!.json()).ok).toBe(true);
  const close = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/close", { method: "POST" }), launcher, s);
  expect((await close!.json()).ok).toBe(true);
  expect(calls).toEqual(["start:k1d0cd11", "capture:k1d0cd11", "stop:k1d0cd11"]);
  s.close();
});

test("Firefox open responses do not expose the internal port", async () => {
  const s = store();
  s.upsertProfile(firefoxProfile(s, "firefox-open"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/firefox-open/open", { method: "POST" }),
    { start: async () => ({ port: 9333 }) } as any,
    s,
  );
  expect(await response!.json()).toEqual({
    ok: true,
    engine: "firefox",
    capabilities: { cdp: false, pdf: false, chromeExtensions: false },
  });
  s.close();
});

test("cookie route rejects untrusted and malformed requests, and keeps cookies for a closed profile", async () => {
  const s = store();
  let certifications = 0;
  let writes = 0;
  const launcher = { certifiedActive: async () => { certifications++; return false; } } as any;
  const options = { setCookies: async () => { writes++; } } as any;

  const untrusted = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://outside.invalid" },
    body: "{}",
  }), launcher, s, null, options);
  expect(untrusted!.status).toBe(415);

  const crossOrigin = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://outside.invalid" },
    body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
  }), launcher, s, null, options);
  expect(crossOrigin!.status).toBe(403);

  for (const body of [
    { name: "", value: "value", domain: "example.com", path: "/" },
    { name: "bad name", value: "value", domain: "example.com", path: "/" },
    { name: "bad=name", value: "value", domain: "example.com", path: "/" },
    { name: "name", value: "bad;value", domain: "example.com", path: "/" },
    { name: "name", value: "value", domain: "", path: "/" },
    { name: "name", value: "value", domain: "example.com", path: "account" },
    { text: "not cookies" },
    { text: "[]" },
  ]) {
    const malformed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), launcher, s, null, options);
    expect(malformed!.status).toBe(400);
  }
  expect(s.getPendingCookies("k1d0cd11")).toEqual([]);

  const closed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "session", value: "value", domain: "example.com", path: "/" }),
  }), launcher, s, null, options);
  expect(closed!.status).toBe(200);
  expect(await closed!.json()).toEqual({ ok: true, applied: "next-start", count: 1 });
  expect(s.getPendingCookies("k1d0cd11")).toMatchObject([{ name: "session", value: "value", domain: "example.com", path: "/" }]);
  expect(listUiProfiles(s).find((profile) => profile.id === "k1d0cd11")!.pendingCookieCount).toBe(1);
  // The pending list shows domain and name only, and can be removed.
  const listed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/pending-cookies"), launcher, s, null, options);
  expect(await listed!.json()).toEqual({ ok: true, cookies: [{ domain: "example.com", name: "session" }] });
  const removed = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/pending-cookies/clear", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), launcher, s, null, options);
  expect(await removed!.json()).toEqual({ ok: true, removed: 1 });
  expect(s.getPendingCookies("k1d0cd11")).toEqual([]);
  expect(listUiProfiles(s).find((profile) => profile.id === "k1d0cd11")!.pendingCookieCount).toBeUndefined();

  // A recorded browser that is not certified yet (still starting) gets nothing.
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
  const starting = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "other", value: "value", domain: "example.com", path: "/" }),
  }), launcher, s, null, options);
  expect(starting!.status).toBe(409);
  expect(await starting!.json()).toEqual({ ok: false, error: "profile browser is not open" });
  expect(certifications).toBe(1);
  expect(writes).toBe(0);
  expect(s.getPendingCookies("k1d0cd11")).toHaveLength(0);
  s.close();
});

test("bulk cookie route sets open browsers now and keeps cookies for closed profiles", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1closed", name: "closed" });
  s.upsertProfile(firefoxProfile(s, "k1firefox"));
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://chromium", startedAt: 1 });
  s.recordLaunch({ profileId: "k1firefox", engine: "firefox", pid: 2, debugPort: 9413, ws: "firefox://live", startedAt: 1 });
  const calls: Array<{ ws: string; cookies: any[] }> = [];
  const post = (body: unknown) => handleUiRequest(new Request("http://x/ui/api/profiles/cookies", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { certifiedActive: async () => true } as any, s, null, {
    setCookies: async (ws: string, cookies: any[]) => { calls.push({ ws, cookies }); },
  } as any);

  const json = JSON.stringify([
    { name: "auth_token", value: "a1", domain: ".x.com", path: "/", secure: true, httpOnly: true, expirationDate: 1_800_000_000, sameSite: "no_restriction", partitionKey: "https://x.com" },
    { name: "ct0", value: "c1", domain: ".x.com", path: "/", session: true },
  ]);
  const response = await post({ ids: ["k1d0cd11", "k1closed", "k1firefox"], text: json });
  expect(await response!.json()).toEqual({ ok: true, count: 2, live: 2, nextStart: 1, errors: [] });
  expect(calls.map((call) => call.ws)).toEqual(["ws://chromium", "firefox://live"]);
  expect(calls[0]!.cookies[0]).toMatchObject({ name: "auth_token", sameSite: "None", secure: true, partitionKey: "https://x.com", expires: 1_800_000_000 });
  // Firefox has no Chromium cookie partitions.
  expect(calls[1]!.cookies[0].partitionKey).toBeUndefined();
  expect(s.getPendingCookies("k1closed").map((cookie) => cookie.name)).toEqual(["auth_token", "ct0"]);

  // cookies.txt replaces a pending cookie with the same name, domain and path.
  const netscape = "# Netscape HTTP Cookie File\n#HttpOnly_.x.com\tTRUE\t/\tTRUE\t1800000000\tct0\tc2\n";
  expect(await (await post({ ids: ["k1closed"], text: netscape }))!.json()).toMatchObject({ ok: true, count: 1, nextStart: 1 });
  expect(s.getPendingCookies("k1closed")).toEqual([
    expect.objectContaining({ name: "auth_token", value: "a1" }),
    { name: "ct0", value: "c2", domain: ".x.com", path: "/", httpOnly: true, secure: true, expires: 1_800_000_000 },
  ]);

  const unknown = await post({ ids: ["k1closed", "missing"], name: "a", value: "b", domain: "x.com" });
  expect(await unknown!.json()).toMatchObject({ ok: false, nextStart: 1, errors: [{ id: "missing", error: "no such profile" }] });
  s.close();
});

test("cookie route never returns the cookie value or a raw worker error", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
  const secret = "private-cookie-value";
  const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/cookies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "session", value: secret, domain: "example.com", path: "/" }),
  }), { certifiedActive: async () => true } as any, s, null, {
    setCookies: async () => { throw new Error(`worker rejected ${secret}`); },
  } as any);
  const body = await response!.text();

  expect(response!.status).toBe(500);
  expect(body).toContain("cookie could not be added");
  expect(body).not.toContain(secret);
  expect(body).not.toContain("worker rejected");
  s.close();
});

test("remote open returns an advisory warning as a success", async () => {
  const s = store();
  const remote: any = {
    open: async () => ({
      ok: true,
      port: 9333,
      warning: "Possible concurrent use; session sync is disabled for this browser.",
    }),
  };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toEqual({
    ok: true,
    port: 9333,
    warning: "Possible concurrent use; session sync is disabled for this browser.",
  });
  s.close();
});

test("a refused Local open shows what happened instead of its bare launch code", async () => {
  const s = store();
  const launcher: any = { start: async () => { throw new BrowserLaunchError("preflight", "cookie_key_unreadable"); } };
  const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/open", { method: "POST" }), launcher, s);
  expect(res!.status).toBe(500);
  expect((await res!.json()).error).toBe(new BrowserLaunchError("preflight", "cookie_key_unreadable").guidance);
  s.close();
});

test("the disk space check warns only below the threshold and when the drive can be read", async () => {
  const s = store();
  for (const [freeBytes, low] of [[LOW_DISK_SPACE_BYTES - 1, true], [LOW_DISK_SPACE_BYTES, false], [null, false]] as const) {
    const launcher: any = { dataDriveFreeBytes: () => freeBytes };
    const res = await handleUiRequest(new Request("http://x/ui/api/disk-space"), launcher, s);
    expect(await res!.json()).toEqual({ ok: true, freeBytes, low });
  }
  s.close();
});

test("open on an unknown profile 404s without touching the launcher", async () => {
  const s = store();
  const launcher: any = { start: async () => { throw new Error("must not be called"); } };
  const res = await handleUiRequest(new Request("http://x/ui/api/profiles/nope/open", { method: "POST" }), launcher, s);
  expect(res!.status).toBe(404);
  s.close();
});

test("GET /ui/api/health is independent of launcher and hub state", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/health"),
    new Proxy({}, { get: () => { throw new Error("launcher must not be touched"); } }) as any,
    s,
    new Proxy({}, { get: () => { throw new Error("hub must not be touched"); } }) as any,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, version: expect.any(String), root: import.meta.dir });
  s.close();
});

test("GET /ui/api/health uses desktop parent metadata when supplied", async () => {
  const s = store();
  const health = { version: "0.1.0-beta.1", root: "C:\\Vela Browser", instance: "ab".repeat(32) };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/health"),
    {} as any,
    s,
    null,
    { health },
  );
  expect(await res!.json()).toEqual({ ok: true, ...health });
  s.close();
});

test("GET /ui/api/profiles clears a stale launch row before reporting status", async () => {
  const s = store();
  // A launch row whose browser is gone (crash / external teardown).
  s.recordLaunch({
    profileId: "k1d0cd11",
    pid: 99999,
    debugPort: 9999,
    ws: "ws://x",
    startedAt: 1,
    binaryPath: "/fake",
    userDataDir: "/tmp/ui-recon/k1d0cd11",
    processGroupId: 99999,
    rootStartTime: "1",
  });
  const launcher = new Launcher({
    store: s,
    binaryPath: "/fake",
    unsafeDisableIdentityGates: true,
    dataRoot: "/tmp/ui-recon",
    spawn: () => ({ pid: 1, kill() {} }),
    fetch: async () => ({ ok: false, json: async () => ({}) }), // CDP port is dead
    ensureCookies: async () => ({ injected: false }),
    killPid: async () => {},
    isPidAlive: () => false,
    findOwnedBrowserPids: async () => [],
    cdpReadyTimeoutMs: 100,
  });

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
  const body = await res!.json();
  expect(body.profiles[0].running).toBe(false); // not shown as running
  expect(body.healthSources).toEqual([]);
  expect(s.getLaunch("k1d0cd11")).toBeNull(); // stale row reconciled away
  s.close();
});

test("GET /ui/api/profiles carries remote health and node freshness through local launch overlays", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => {} };
  const remote: any = {
    listRoster: async () => ({
      profiles: [{
        id: "k1d0cd11",
        name: "sophia",
        group: "va1",
        healthStatus: "suspended",
        healthObservedAt: 1_000,
      }],
      healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
    }),
  };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s, remote);
  expect(await res!.json()).toEqual({
    profiles: [{
      id: "k1d0cd11",
      name: "sophia",
      group: "va1",
      healthStatus: "suspended",
      healthObservedAt: 1_000,
      engine: "chromium",
      running: false,
    }],
    healthSources: [{ sourceId: "node-a", lastSnapshotAt: 1_000, stale: false }],
  });
  s.close();
});

test("GET /ui/api/profiles returns a JSON error when remote roster loading fails", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => {} };
  const remote: any = { listRoster: async () => { throw new Error("hub roster unavailable"); } };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s, remote);
  expect(res!.status).toBe(502);
  expect(res!.headers.get("content-type")).toContain("application/json");
  const body = await res!.json();
  expect(body.error).toBe("profile roster failed: hub roster unavailable");
  s.close();
});

test("GET /ui/api/profiles returns a JSON error when local reconciliation fails", async () => {
  const s = store();
  const launcher: any = { reconcileOrphans: async () => { throw new Error("process scan unavailable"); } };

  const res = await handleUiRequest(new Request("http://x/ui/api/profiles"), launcher, s);
  expect(res!.status).toBe(500);
  expect(res!.headers.get("content-type")).toContain("application/json");
  expect((await res!.json()).error).toBe("profile roster failed: process scan unavailable");
  s.close();
});

test("Local group creation keeps an empty group in the profile roster", async () => {
  const s = store();
  const created = await handleUiRequest(
    new Request("http://x/ui/api/groups/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty group" }),
    }),
    {} as any,
    s,
  );
  expect(created!.status).toBe(200);
  expect(await created!.json()).toEqual({ ok: true, name: "Empty group", folder: { name: "Empty group", parentName: null, label: "Empty group" } });

  const reserved = await handleUiRequest(
    new Request("http://x/ui/api/groups/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "all" }),
    }),
    {} as any,
    s,
  );
  expect(reserved!.status).toBe(400);

  const roster = await handleUiRequest(
    new Request("http://x/ui/api/profiles"),
    { reconcileOrphans: async () => {} } as any,
    s,
  );
  expect((await roster!.json()).groups).toContain("Empty group");
  s.close();
});

test("Local folder routes preserve explicit parents through create, rename and move", async () => {
  const s = store();
  const request = (path: string, body: unknown) => handleUiRequest(new Request(`http://x/ui/api/groups/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), {} as any, s);
  try {
    await request("create", { name: "Facebook" });
    const created = await request("create", { name: "Fitness", parentName: "Facebook" });
    expect((await created!.json()).folder).toEqual({ name: "Facebook/Fitness", parentName: "Facebook", label: "Fitness" });
    const renamed = await request("rename", { from: "Facebook/Fitness", to: "Health" });
    expect((await renamed!.json()).folder.name).toBe("Facebook/Health");
    expect((await request("move", { name: "Facebook", parentName: "Facebook/Health" }))!.status).toBe(400);
    const moved = await request("move", { name: "Facebook/Health", parentName: null });
    expect((await moved!.json()).folder).toEqual({ name: "Health", parentName: null, label: "Health" });
  } finally { s.close(); }
});

test("move route reassigns selected profiles' group", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/move", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"], group: "newgrp" }) }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.moved).toBe(1);
  expect(listUiProfiles(s)[0]!.group).toBe("newgrp");
  s.close();
});

test("group extension route replaces members and lists defaults", async () => {
  const s = store();
  const saved = await handleUiRequest(
    new Request("http://x/ui/api/groups/extensions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "va1", extensions: ["e2", "e1", "e2"] }),
    }),
    {} as any,
    s,
  );
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toMatchObject({ ok: true, updatedCount: 1 });
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["e2", "e1"]);

  const listed = await handleUiRequest(
    new Request("http://x/ui/api/groups/extensions"),
    {} as any,
    s,
  );
  expect(await listed!.json()).toEqual({
    ok: true,
    groups: [{ name: "va1", extensions: ["e2", "e1"], permission: "edit" }],
  });
  s.close();
});

test("new profiles and moves inherit Local group extension defaults", async () => {
  const s = store();
  s.registerGroup("With defaults");
  s.setGroupExtensionDefaults("With defaults", ["e1"]);

  const created = await handleUiRequest(
    new Request("http://x/ui/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new", group: "With defaults", engine: "chromium" }),
    }),
    {} as any,
    s,
  );
  const createdId = (await created!.json()).id;
  expect(s.getProfile(createdId)!.extensions).toEqual(["e1"]);

  const moved = await handleUiRequest(
    new Request("http://x/ui/api/profiles/move", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11"], group: "With defaults" }),
    }),
    {} as any,
    s,
  );
  expect(moved!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["e1"]);
  s.close();
});

test("single and file group edits inherit unless extensions are explicit", async () => {
  const s = store();
  s.registerGroup("Defaulted");
  s.setGroupExtensionDefaults("Defaulted", ["group-extension"]);

  const inherited = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { group: "Defaulted" } }),
    }),
    {} as any,
    s,
  );
  expect(inherited!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["group-extension"]);

  const explicit = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { group: "va1", extensions: ["chosen"] } }),
    }),
    {} as any,
    s,
  );
  expect(explicit!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["chosen"]);

  const form = new FormData();
  form.append("files", new File(["id,group\nk1d0cd11,Defaulted\n"], "updates.csv"));
  const fromFile = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(fromFile!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["group-extension"]);
  s.close();
});

test("move route with no ids is a 400", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/move", { method: "POST", body: JSON.stringify({ ids: [], group: "x" }) }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(400);
  s.close();
});

test("upload route imports profiles from posted files", async () => {
  const s = new ProfileStore(":memory:");
  // No proxy line → geoip is skipped (no network in the test).
  const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.profiles).toBe(1);
  expect(s.getProfile("k1up0001")!.group).toBe("ug");
  s.close();
});

test("upload route atomically imports two AdsPower profiles from one pasted file", async () => {
  const s = new ProfileStore(":memory:");
  const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, files: 1, profiles: 2 });
  expect(s.count()).toBe(2);
  expect(s.getProfile("k1up0002")).not.toBeNull();
  expect(s.getProfile("k1up0003")).not.toBeNull();
  s.close();
});

test("upload route rejects a malformed AdsPower record without partial writes", async () => {
  const s = store();
  const beforeCount = s.count();
  const ADSPOWER = `id=k1up0002\nname=first\ngroup=ug\ncookie=[]\nresolution=1280*720\n******************\nid=k1up0003\nname=second\ngroup=ug\ncookie=[]\nresolution=0x0\n******************`;
  const form = new FormData();
  form.append("files", new File([ADSPOWER], "pasted-adspower.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(400);
  expect((await res!.json()).error).toContain("invalid resolution");
  expect(s.count()).toBe(beforeCount);
  expect(s.getProfile("k1up0002")).toBeNull();
  expect(s.getProfile("k1up0003")).toBeNull();
  s.close();
});

test("upload route applies group override in local mode", async () => {
  const s = new ProfileStore(":memory:");
  const NOPROXY = `id=k1up0001\nname=uploaded\ngroup=fromfile\ncookie=[]\nresolution=1280*720\n******************`;
  const form = new FormData();
  form.append("group", "selected");
  form.append("files", new File([NOPROXY], "export.txt", { type: "text/plain" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect((await res!.json()).ok).toBe(true);
  expect(s.getProfile("k1up0001")!.group).toBe("selected");
  s.close();
});

test("upload route imports JSON and XLSX provider files in Local mode", async () => {
  const s = new ProfileStore(":memory:");
  const form = new FormData();
  form.append("files", new File([JSON.stringify({ profiles: [{
    _id: "localjson1",
    name: "GoLogin JSON",
    navigator: { resolution: "1600x900", platform: "Win32" },
  }] })], "gologin.json", { type: "application/json" }));
  const workbook = await writeXlsx(
    ["Profile ID", "Profile Name", "Operating System"],
    [["localxlsx1", "HideMyAcc sheet", "mac"]],
  );
  form.append("files", new File([workbook as unknown as BlobPart], "hidemyacc.xlsx"));

  const response = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );

  expect(response!.status).toBe(200);
  expect(await response!.json()).toMatchObject({ ok: true, files: 2, profiles: 2 });
  expect(s.getProfile("localjson1")).toMatchObject({ name: "GoLogin JSON", platformOs: "windows" });
  expect(s.getProfile("localxlsx1")).toMatchObject({ name: "HideMyAcc sheet", platformOs: "macos" });
  s.close();
});

test("upload route forwards raw files and overrides in remote mode", async () => {
  const s = new ProfileStore(":memory:");
  const form = new FormData();
  form.append("group", "hubgrp");
  form.append("platform", "telegram.org");
  const rawFile = "raw,unchanged\ncontent";
  form.append("files", new File([rawFile], "export.json", { type: "application/json" }));
  let gotOverride: any = null;
  let gotUploads: any[] = [];
  const remote = {
    importToHub: async (uploads: any[], override: any) => {
      gotUploads = uploads.map((upload) => ({ name: upload.name, bytes: new Uint8Array(upload.bytes) }));
      gotOverride = override;
      return { files: 1, profiles: 1 };
    },
  } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
    remote,
  );
  expect((await res!.json()).ok).toBe(true);
  expect(gotOverride).toEqual({ group: "hubgrp", platform: "telegram.org" });
  expect(gotUploads).toEqual([{ name: "export.json", bytes: new TextEncoder().encode(rawFile) }]);
  s.close();
});

test("upload route rejects a zero-profile hub result", async () => {
  const s = new ProfileStore(":memory:");
  const form = new FormData();
  form.append("files", new File(["unrecognized"], "export.txt", { type: "text/plain" }));
  const remote = {
    importToHub: async () => ({ files: 1, profiles: 0 }),
  } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(400);
  expect(await res!.json()).toMatchObject({ ok: false, error: expect.stringContaining("no profiles") });
  s.close();
});

test("upload route with no files is a 400", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: new FormData() }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(400);
  s.close();
});

test("upload route reports unsupported archives as bad input", async () => {
  const s = new ProfileStore(":memory:");
  const form = new FormData();
  form.append("files", new File(["PKencrypted-profile"], "multilogin.zip", { type: "application/zip" }));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(response!.status).toBe(400);
  expect((await response!.json()).error).toContain("encrypted or proprietary");
  expect(s.count()).toBe(0);
  s.close();
});

test("upload route reports an open-profile import conflict as 409", async () => {
  const s = store();
  s.recordLaunch({
    profileId: "k1d0cd11",
    pid: 123,
    debugPort: 9333,
    ws: "ws://127.0.0.1:9333/devtools/browser/live",
    startedAt: Date.now(),
  });
  const form = new FormData();
  form.append("files", new File(["id=k1d0cd11\nname=changed\n******************"], "profile.txt"));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/import/upload", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(response!.status).toBe(409);
  expect((await response!.json()).error).toContain("currently open");
  s.close();
});

function cloudFileHarness() {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-ui-cloud-update-file-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  appConfig.setMode("cloud", "https://cloud.aliasmode.test");
  const profiles = new Map(Array.from({ length: 4 }, (_, index) => {
    const id = `cloud000${index + 1}`;
    return [id, {
      profile: { id, version: 3, activeOpens: [] as unknown[] },
      payload: encodePortableProfile({ ...s.getProfile("k1d0cd11")!, id }),
    }] as const;
  }));
  const updates: Array<{ id: string; request: any }> = [];
  const client = {
    async getProfile(id: string) {
      const value = profiles.get(id);
      if (!value) throw new CloudApiError("Cloud profile was not found", "profile_not_found", 404);
      return value;
    },
    async updateProfile(id: string, request: any) { updates.push({ id, request }); },
  };
  return {
    s, profiles, updates, client,
    async upload(files: File[]) {
      const form = new FormData();
      for (const file of files) form.append("files", file);
      return (await handleUiRequest(
        new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
        {} as any, s, null,
        { appConfig, cloudBrowser: {} as any, cloudConnection: { client } as any },
      ))!;
    },
    close() { s.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("bulk update validates every row before atomically writing any profile", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
  const csv = [
    "id,name,proxy,proxytype",
    "k1d0cd11,renamed,proxy.example:8080:u:p,http",
    "k1d0cd22,also-renamed,malformed,http",
  ].join("\n");
  const form = new FormData();
  form.append("files", new File([csv], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(res!.status).toBe(400);
  expect(body.updated).toBe(0);
  expect(body.errors).toEqual([{ id: "k1d0cd22", error: expect.stringContaining("proxy must be") }]);
  expect(s.getProfile("k1d0cd11")!.name).toBe("sophia");
  expect(s.getProfile("k1d0cd22")!.name).toBe("second");
  s.close();
});

test("a short CSV update row preserves omitted trailing identity fields", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const form = new FormData();
  form.append("files", new File([
    "id,name,proxy,proxytype,resolution\n" +
    "k1d0cd11,renamed",
  ], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(200);
  const after = s.getProfile("k1d0cd11")!;
  expect(after.name).toBe("renamed");
  expect(after.proxy).toEqual(before.proxy);
  expect(after.timezone).toBe("America/Los_Angeles");
  expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
  s.close();
});

test("bulk proxy edits resolve changed timezones", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  first.timezone = "America/Los_Angeles";
  s.upsertProfile(first);
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second" });
  const form = new FormData();
  form.append("files", new File([
    "id,proxy,proxytype\n" +
    "k1d0cd11,first-proxy.example:8080:u:p,http\n" +
    "k1d0cd22,second-proxy.example:1080:u:p,socks5",
  ], "updates.csv", { type: "text/csv" }));
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "first-proxy.example": "Europe/London" }, calls) },
  );

  expect(res!.status).toBe(200);
  expect(calls).toEqual([...EXIT_LOOKUP_CALLS, ...EXIT_LOOKUP_CALLS]);
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
  expect(s.getProfile("k1d0cd22")!.timezone).toBe("Europe/London");
  s.close();
});

test("single edits reject malformed resolutions without changing stored identity", async () => {
  for (const resolution of ["", "0x0", "319x1080", "99999x1080", "1920xnope"]) {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    const res = await handleUiRequest(
      new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST",
        body: JSON.stringify({ set: { resolution } }),
      }),
      {} as any,
      s,
    );
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toContain("invalid resolution");
    const after = s.getProfile("k1d0cd11")!;
    expect([after.screenWidth, after.screenHeight]).toEqual([before.screenWidth, before.screenHeight]);
    s.close();
  }
});

test("Firefox profiles reject Chrome extension changes", async () => {
  const s = store();
  s.upsertProfile(firefoxProfile(s, "firefox-ext"));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/firefox-ext/update", {
      method: "POST",
      body: JSON.stringify({ set: { extensions: ["chrome-extension"] } }),
    }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(500);
  expect((await res!.json()).error).toMatch(/Firefox profiles/);
  s.close();
});

test("a Firefox screen edit saves the screen with its usable area and a window inside it, also while open", async () => {
  const s = store();
  const profile = firefoxProfile(s, "firefox-screen");
  profile.screenWidth = 2560;
  profile.screenHeight = 1440;
  profile.firefox!.config = {
    ...profile.firefox!.config, "navigator.platform": "Win32", "screen.width": 2560, "screen.height": 1440,
    "window.outerWidth": 1664, "window.outerHeight": 1296, "window.innerWidth": 1648, "window.innerHeight": 1190,
  };
  s.upsertProfile(profile);
  const edit = () => handleUiRequest(
    new Request("http://x/ui/api/profiles/firefox-screen/update", { method: "POST", body: JSON.stringify({ set: { resolution: "1366x768" } }) }),
    {} as any,
    s,
  );
  s.recordLaunch({
    profileId: "firefox-screen", pid: 1, debugPort: 9412, ws: "firefox://live", startedAt: 123,
    persona: launchPersona(s.getProfile("firefox-screen")!),
  });
  const open = await edit();
  expect(open!.status).toBe(200);
  // Saved now; the open browser keeps its launch screen until it restarts.
  expect(await open!.json()).toEqual({ ok: true, restartRequired: true });
  expect(s.getLaunch("firefox-screen")!.persona).toMatchObject({ screenWidth: 2560, screenHeight: 1440 });
  s.clearLaunch("firefox-screen");
  const saved = s.getProfile("firefox-screen")!;
  expect([saved.screenWidth, saved.screenHeight]).toEqual([1366, 768]);
  expect(saved.firefox!.config).toMatchObject({
    "screen.width": 1366, "screen.height": 768, "screen.availWidth": 1366, "screen.availHeight": 720,
    "window.outerWidth": 888, "window.outerHeight": 691, "window.innerWidth": 872, "window.innerHeight": 585, timezone: "UTC",
  });
  s.close();
});

test("a malformed nonblank proxy edit is rejected without removing the existing proxy", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: "proxy.example:not-a-port" } }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(500);
  expect((await res!.json()).error).toContain("invalid proxy port");
  const after = s.getProfile("k1d0cd11")!;
  expect(after.proxy).toEqual(before.proxy);
  expect(after.timezone).toBe("America/Los_Angeles");
  s.close();
});

test("a changed proxy gets its exit timezone", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxyType: "socks5", proxy: "new-proxy.example:1080:user:pass" } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) },
  );

  expect(res!.status).toBe(200);
  expect(calls).toEqual(EXIT_LOOKUP_CALLS);
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    proxy: { type: "socks5", host: "new-proxy.example", port: "1080", user: "user", pass: "pass" },
    timezone: "Europe/Paris",
  });
  s.close();
});

test("a typed timezone stays when the proxy changes, and a blank one follows the proxy again", async () => {
  const s = store();
  const update = (set: Record<string, unknown>) => handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", { method: "POST", body: JSON.stringify({ set }) }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, []) },
  );

  expect((await update({ timezone: "America/Chicago" }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "America/Chicago", timezoneManual: true });
  expect((await update({ proxyType: "http", proxy: "new-proxy.example:8080" }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "America/Chicago", timezoneManual: true });

  expect((await update({ timezone: "" }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.timezoneManual).toBeUndefined();
  expect((await update({ proxyType: "http", proxy: "other-proxy.example:8080" }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({ timezone: "Europe/Paris" });
  s.close();
});

test("CPU cores and the seed can be typed, and a blank count goes back to automatic", async () => {
  const s = store();
  const update = (set: Record<string, unknown>) => handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", { method: "POST", body: JSON.stringify({ set }) }),
    {} as any,
    s,
  );
  const seed = s.getProfile("k1d0cd11")!.fingerprintSeed;
  expect((await update({ cores: "6", fingerprintSeed: String(seed + 1) }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({ hardware: { cores: 6 }, fingerprintSeed: seed + 1 });
  expect((await update({ cores: "" }))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.hardware).toEqual(editedProfileHardware(s.getProfile("k1d0cd11")!, undefined));
  expect((await update({ cores: "0" }))!.status).toBe(500);
  expect((await update({ fingerprintSeed: "abc" }))!.status).toBe(500);
  s.close();
});

test("a proxy edit keeps changes saved during its timezone lookup", async () => {
  for (const launch of [false, true]) {
    const s = store();
    const before = s.getProfile("k1d0cd11")!;
    before.timezone = "America/Los_Angeles";
    s.upsertProfile(before);
    const res = await handleUiRequest(
      new Request("http://x/ui/api/profiles/k1d0cd11/update", {
        method: "POST",
        body: JSON.stringify({ set: { proxyType: "http", proxy: "new-proxy.example:8080" } }),
      }),
      {} as any,
      s,
      null,
      { timezoneFetch: async () => {
        const updated = s.getProfile("k1d0cd11")!;
        updated.name = "renamed during lookup";
        s.upsertProfile(updated);
        if (launch) s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
        return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
      } },
    );
    expect(res!.status).toBe(200);
    expect(s.getProfile("k1d0cd11")).toMatchObject({
      name: "renamed during lookup",
      proxy: { host: "new-proxy.example" },
      // Saved for the next start also when a browser opened during the lookup.
      timezone: "Europe/Paris",
    });
    s.close();
  }
});

test("bulk proxy edits keep changes saved during the timezone lookups", async () => {
  const s = store();
  const form = new FormData();
  form.append("files", new File(["id,proxy,proxytype\nk1d0cd11,new-proxy.example:8080,http"], "updates.csv", { type: "text/csv" }));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { timezoneFetch: async () => {
      const updated = s.getProfile("k1d0cd11")!;
      updated.name = "renamed during lookup";
      s.upsertProfile(updated);
      return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
    } },
  );
  expect(res!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    name: "renamed during lookup",
    proxy: { host: "new-proxy.example" },
    timezone: "Europe/Paris",
  });
  s.close();
});

test("bulk proxy edits save an open profile for its next start", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });
  const form = new FormData();
  form.append("files", new File(["id,proxy,proxytype\nk1d0cd11,new-proxy.example:8080,http"], "updates.csv", { type: "text/csv" }));
  const calls: string[][] = [];
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) },
  );
  expect(res!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")).toMatchObject({ proxy: { host: "new-proxy.example" }, timezone: "Europe/Paris" });
  expect(s.getLaunch("k1d0cd11")).not.toBeNull();
  s.close();
});

test("an explicit timezone action updates a Local proxy timezone", async () => {
  const s = store();
  const calls: string[][] = [];
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) },
  );
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, timezone: "Europe/London", locale: "en-GB" });
  expect(calls).toEqual(EXIT_LOOKUP_CALLS);
  expect(s.getProfile("k1d0cd11")!.locale).toBe("en-GB");
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("Europe/London");
  s.close();
});

test("an explicit timezone action updates Firefox configuration", async () => {
  const s = store();
  s.upsertProfile(firefoxProfile(s, "firefox-timezone"));
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/firefox-timezone/timezone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }) },
  );
  expect(res!.status).toBe(200);
  expect(s.getProfile("firefox-timezone")!).toMatchObject({
    timezone: "Europe/London",
    locale: "en-GB",
    firefox: { config: { timezone: "Europe/London", "navigator.language": "en-GB", "locale:all": "en-GB, en" } },
  });
  s.close();
});

test("explicit connection timezone lookup supports system VPNs in both engines", async () => {
  for (const engine of ["chromium", "firefox"] as const) {
    const s = store();
    const profile = engine === "firefox" ? firefoxProfile(s, "vpn-profile") : { ...s.getProfile("k1d0cd11")!, id: "vpn-profile" };
    profile.proxy = null;
    profile.timezone = "UTC";
    s.upsertProfile(profile);
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/vpn-profile/timezone", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {} as any, s, null, { timezoneFetch: async (_url, init) => {
      expect(init).not.toHaveProperty("proxy");
      return { json: async () => ({ status: "success", timezone: "America/Toronto" }) };
    } });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, timezone: "America/Toronto" });
    const saved = s.getProfile(profile.id)!;
    expect(saved.timezone).toBe("America/Toronto");
    expect(saved.fingerprintSeed).toBe(profile.fingerprintSeed);
    expect(saved.cookies).toEqual(profile.cookies);
    if (engine === "firefox") expect(saved.firefox!.config.timezone).toBe(saved.timezone);
    s.close();
  }
});

test("timezone lookup does not treat a quarantined proxy as a direct connection", async () => {
  const s = store();
  const profile = s.getProfile("k1d0cd11")!;
  profile.proxy = null;
  profile.proxyError = "Invalid proxy port";
  s.upsertProfile(profile);
  let calls = 0;
  const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), {} as any, s, null, { timezoneFetch: async () => {
    calls++;
    return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
  } });
  expect(response!.status).toBe(400);
  expect(calls).toBe(0);
  expect(s.getProfile(profile.id)).toEqual(profile);
  s.close();
});

test("failed timezone lookups report failure without changing the saved identity", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "Europe/Paris";
  s.upsertProfile(before);
  const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), {} as any, s, null, { timezoneFetch: async () => { throw new Error("offline"); } });
  expect(response!.status).toBe(502);
  expect(await response!.json()).toMatchObject({ ok: false, error: expect.any(String) });
  expect(s.getProfile(before.id)).toEqual(before);
  s.close();
});

test("timezone lookup cannot overwrite a changed connection or unrelated edits", async () => {
  for (const changeProxy of [false, true]) {
    const s = store();
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), {} as any, s, null, { timezoneFetch: async () => {
      const updated = s.getProfile("k1d0cd11")!;
      updated.name = "edited while lookup was pending";
      if (changeProxy) updated.proxy = null;
      s.upsertProfile(updated);
      return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
    } });
    expect(response!.status).toBe(changeProxy ? 409 : 200);
    expect(s.getProfile("k1d0cd11")!.name).toBe("edited while lookup was pending");
    expect(s.getProfile("k1d0cd11")!.timezone).toBe(changeProxy ? "" : "Europe/Paris");
    s.close();
  }
});

test("legacy remote proxy edits preserve stored timezone without a lookup", async () => {
  const s = store();
  const local = s.getProfile("k1d0cd11")!;
  local.timezone = "America/Los_Angeles";
  s.upsertProfile(local);
  const remoteProfile = structuredClone(local);
  let saved: typeof remoteProfile | null = null;
  const remote = {
    async getProfile() { return structuredClone(remoteProfile); },
    async saveProfile(profile: typeof remoteProfile) { saved = structuredClone(profile); },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxyType: "http", proxy: "remote-proxy.example:8080:user:pass" } }),
    }),
    {} as any,
    s,
    remote,
    { timezoneFetch: timezoneFetch({ "remote-proxy.example": "Asia/Singapore" }) },
  );

  expect(res!.status).toBe(200);
  expect(saved).toMatchObject({
    proxy: { type: "http", host: "remote-proxy.example", port: "8080", user: "user", pass: "pass" },
    timezone: "America/Los_Angeles",
  });
  expect(s.getProfile("k1d0cd11")).toMatchObject({
    proxy: local.proxy,
    timezone: "America/Los_Angeles",
  });
  s.close();
});

test("an explicit blank proxy edit preserves the stored timezone", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.timezone = "America/Los_Angeles";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: "" } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({}, calls) },
  );
  expect(res!.status).toBe(200);
  expect(calls).toEqual([]);
  expect(s.getProfile("k1d0cd11")!.proxy).toBeNull();
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("America/Los_Angeles");
  s.close();
});

test("an IPv6 proxy round-trips through the edit view without losing its identity", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.proxy = { type: "socks5", host: "2001:db8::1", port: "1080", user: "user", pass: "p:ss" };
  before.timezone = "America/New_York";
  s.upsertProfile(before);
  const calls: string[][] = [];

  const detail = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11"),
    {} as any,
    s,
  );
  const edit = (await detail!.json()).profile;
  expect(edit.proxy).toBe("[2001:db8::1]:1080:user:p:ss");

  const saved = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { proxy: edit.proxy, proxyType: edit.proxyType } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: timezoneFetch({}, calls) },
  );
  expect(saved!.status).toBe(200);
  expect(calls).toEqual([]);
  expect(s.getProfile("k1d0cd11")!.proxy).toEqual(before.proxy);
  expect(s.getProfile("k1d0cd11")!.timezone).toBe("America/New_York");
  s.close();
});

test("Chrome Web Store endpoint installs once and reuses the registered extension", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
  const id = extensionId(extensionPublicKey);
  const assignmentsBefore = s.listProfiles().map((profile) => profile.extensions ?? []);
  let fetches = 0;
  const request = () => new Request("http://x/ui/api/extensions/web-store", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: `https://chromewebstore.google.com/detail/fixture/${id}` }),
  });

  const first = await handleUiRequest(request(), {} as any, s, null, {
    paths: { extensions: root } as any,
    extensionFetch: async () => { fetches++; return extensionResponse(); },
  });
  expect(first!.status).toBe(200);
  expect(await first!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: false });
  expect(s.getExtension(id)?.loadDir).toBe(join(root, id));
  expect(existsSync(join(root, id, "manifest.json"))).toBe(true);

  const second = await handleUiRequest(request(), {} as any, s, null, {
    paths: { extensions: root } as any,
    extensionFetch: async () => { fetches++; throw new Error("must not fetch again"); },
  });
  expect(second!.status).toBe(200);
  expect(await second!.json()).toMatchObject({ ok: true, installed: { id, name: "Route Fixture" }, alreadyInstalled: true });
  expect(fetches).toBe(1);
  expect(s.listProfiles().map((profile) => profile.extensions ?? [])).toEqual(assignmentsBefore);
  s.close();
});

test("Chrome Web Store endpoint leaves no registry or files after identity failure", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "aliasmode-web-store-"));
  const requestedId = "a".repeat(32);
  expect(requestedId).not.toBe(extensionId(extensionPublicKey));
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: requestedId }),
    }),
    {} as any,
    s,
    null,
    {
      paths: { extensions: root } as any,
      extensionFetch: async () => extensionResponse(),
    },
  );

  expect(response!.status).toBe(500);
  expect(s.getExtension(requestedId)).toBeNull();
  expect(existsSync(join(root, requestedId))).toBe(false);
  s.close();
});

test("Chrome Web Store endpoint rejects cross-origin simple requests", async () => {
  const s = store();
  let fetches = 0;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ source: extensionId(extensionPublicKey) }),
    }),
    {} as any,
    s,
    null,
    {
      extensionFetch: async () => {
        fetches++;
        return extensionResponse();
      },
    },
  );

  expect(response!.status).toBe(415);
  expect(fetches).toBe(0);
  expect(s.listExtensions()).toEqual([]);
  s.close();
});

test("Chrome Web Store endpoint keeps the existing remote-mode restriction", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/extensions/web-store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "aapbdbdomjkkjkaonfhkkikfgjllcleb" }),
    }),
    {} as any,
    s,
    {} as any,
  );
  expect(response!.status).toBe(400);
  s.close();
});

test("extension assignment also saves open profiles for their next start", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1d0cd22", name: "second", extensions: [] });
  s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/extensions", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11", "k1d0cd22"], extensionId: "ext-one", op: "add" }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["ext-one"]);
  expect(s.getProfile("k1d0cd22")!.extensions).toEqual(["ext-one"]);
  s.close();
});

test("extension deletion cannot mutate the persona of an open profile", async () => {
  const s = store();
  s.addExtension({ id: "ext-one", name: "Extension One", loadDir: "/tmp/ext-one" });
  expect(s.assignExtension(["k1d0cd11"], "ext-one", true)).toBe(1);
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1 });

  const res = await handleUiRequest(
    new Request("http://x/ui/api/extensions/delete", {
      method: "POST",
      body: JSON.stringify({ id: "ext-one" }),
    }),
    {} as any,
    s,
  );

  expect(res!.status).toBe(409);
  expect(s.getExtension("ext-one")).not.toBeNull();
  expect(s.getProfile("k1d0cd11")!.extensions).toEqual(["ext-one"]);
  s.close();
});

test("closed fingerprint edits persist and preserve the rest of the identity", async () => {
  for (const engine of ["chromium", "firefox"] as const) {
    const s = store();
    const id = engine === "firefox" ? "firefox-edit" : "k1d0cd11";
    if (engine === "firefox") s.upsertProfile(firefoxProfile(s, id));
    const before = s.getProfile(id)!;
    const calls: string[][] = [];
    for (const timezone of ["Europe/Paris", ""]) {
      const set = { timezone, proxy: "next-proxy.example:8080", ...(engine === "chromium" ? { platformOs: "macos", resolution: "1920x1080" } : {}) };
      const res = await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}/update`, {
        method: "POST", body: JSON.stringify({ set }),
      }), {} as any, s, null, { timezoneFetch: timezoneFetch({}, calls) });
      expect(res!.status).toBe(200);
      const saved = s.getProfile(id)!;
      expect(saved.timezone).toBe(timezone);
      expect(saved.locale).toBe(before.locale);
      expect(saved.cookies).toEqual(before.cookies);
      expect(saved.fingerprintSeed).toBe(before.fingerprintSeed);
      expect(saved.ua).toBe(before.ua);
      if (engine === "firefox") {
        const { timezone: _timezone, ...config } = before.firefox!.config;
        expect(saved.firefox!.config).toEqual({ ...config, ...(timezone ? { timezone } : {}) });
      } else {
        expect(saved).toMatchObject({ platformOs: "macos", screenWidth: 1920, screenHeight: 1080 });
        const flags = deriveFingerprintFlags(saved);
        expect(flags).toContain("--fingerprint-platform=macos");
        expect(flags).toContain("--fingerprint-screen-width=1920");
        expect(flags.filter((flag) => flag.startsWith("--fingerprint-timezone="))).toEqual(timezone ? [`--fingerprint-timezone=${timezone}`] : []);
      }
      const detail = await handleUiRequest(new Request(`http://x/ui/api/profiles/${id}`), {} as any, s);
      expect((await detail!.json()).profile.timezone).toBe(timezone);
    }
    expect(calls).toEqual([]);
    s.close();
  }
});

test("Firefox rejects OS edits and invalid timezone edits leave the profile unchanged", async () => {
  const s = store();
  s.upsertProfile(firefoxProfile(s, "firefox-edit"));
  const before = s.getProfile("firefox-edit");
  for (const set of [{ platformOs: "macos" }, { timezone: "Europe/Not_A_Zone" }]) {
    const res = await handleUiRequest(new Request("http://x/ui/api/profiles/firefox-edit/update", {
      method: "POST", body: JSON.stringify({ set }),
    }), {} as any, s);
    expect((await res!.json()).ok).toBe(false);
    expect(s.getProfile("firefox-edit")).toEqual(before);
  }
  s.close();
});

test("timezone lookup of an open profile saves the timezone for its next start", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 123, debugPort: 9333, ws: "ws://x", startedAt: 1, persona: launchPersona(s.getProfile("k1d0cd11")!) });
  const calls: string[][] = [];
  const res = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/timezone", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }), {} as any, s, null, { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) });
  expect(res!.status).toBe(200);
  expect(await res!.json()).toMatchObject({ ok: true, timezone: "Europe/London", restartRequired: true });
  s.close();
});

test("mobile persona conversion preserves the account and replaces only incoherent device fields", async () => {
  const s = store();
  const before = s.getProfile("k1d0cd11")!;
  before.ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/146.0.0.0 Mobile Safari/537.36";
  before.screenWidth = 412;
  before.screenHeight = 915;
  before.timezone = "America/New_York";
  before.tags = ["priority"];
  before.extensions = ["ext-one"];
  s.upsertProfile(before);

  const detail = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
  const edit = (await detail!.json()).profile;
  expect(edit.mobilePersona).toBe(true);
  expect(edit.desktopConversion.platform).toBe("windows");
  expect(edit.desktopConversion.screenChanged).toBe(true);

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body).toMatchObject({ ok: true, changed: true, platform: "windows", screenChanged: true });

  const after = s.getProfile("k1d0cd11")!;
  expect(after.ua).toContain("Windows NT 10.0");
  expect(after.ua.toLowerCase()).not.toContain("mobile");
  expect(after.screenWidth).toBeGreaterThanOrEqual(1024);
  for (const key of ["id", "accId", "username", "password", "email", "emailPassword", "twofa", "proxy", "timezone", "fingerprintSeed", "cookies", "seeded", "tags", "extensions"] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  s.close();
});

test("mobile persona conversion is idempotent and refuses local mutation while open", async () => {
  const s = store();
  const p = s.getProfile("k1d0cd11")!;
  p.ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148";
  s.upsertProfile(p);
  s.recordLaunch({ profileId: p.id, pid: 123, debugPort: 9333, ws: "ws://live", startedAt: 1 });

  const blocked = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(blocked!.status).toBe(409);
  expect(s.getProfile(p.id)!.ua).toContain("iPhone");

  s.clearLaunch(p.id);
  const converted = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect((await converted!.json()).platform).toBe("macos");
  const repeated = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
  );
  expect(await repeated!.json()).toEqual({ ok: true, changed: false });
  s.close();
});

test("remote mobile persona conversion saves a fresh hub profile without touching the local cache", async () => {
  const s = store();
  const hubProfile = s.getProfile("k1d0cd11")!;
  hubProfile.ua = "Mozilla/5.0 (Linux; Android 13; Mobile) Chrome/145.0.0.0 Safari/537.36";
  let saved: typeof hubProfile | null = null;
  const remote = {
    getProfile: async () => structuredClone(hubProfile),
    saveProfile: async (profile: typeof hubProfile) => { saved = structuredClone(profile); },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/convert-mobile", { method: "POST" }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(saved!.ua).toContain("Windows NT 10.0");
  expect(saved!.fingerprintSeed).toBe(hubProfile.fingerprintSeed);
  expect(saved!.cookies).toEqual(hubProfile.cookies);
  expect(s.getProfile("k1d0cd11")!.ua).not.toContain("Android");
  s.close();
});

test("bulk updates also change open profiles", async () => {
  const s = store();
  const first = s.getProfile("k1d0cd11")!;
  s.upsertProfile({ ...first, id: "k1bulk02", name: "second-before" });
  s.recordLaunch({ profileId: "k1bulk02", pid: 123, debugPort: 9334, ws: "ws://live", startedAt: 1 });
  const form = new FormData();
  form.append("file", new File([
    [
      "id,name",
      "k1d0cd11,first-after",
      "k1bulk02,second-after",
    ].join("\n"),
  ], "updates.csv", { type: "text/csv" }));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
  );
  expect(res!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.name).toBe("first-after");
  expect(s.getProfile("k1bulk02")!.name).toBe("second-after");
  expect(s.getLaunch("k1bulk02")).not.toBeNull();
  s.close();
});

test("export route fails explicitly in remote mode", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/export", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    {} as any,
    s,
    {} as any,
  );
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.ok).toBe(false);
  expect(body.error).toContain("remote mode");
  s.close();
});

test("create (local mode) sets the timezone from the proxy", async () => {
  for (const engine of ["chromium", "firefox"] as const) {
    const s = new ProfileStore(":memory:");
    const calls: string[][] = [];
    const res = await handleUiRequest(
      new Request("http://x/ui/api/profiles", {
        method: "POST",
        body: JSON.stringify({ engine, name: "fresh", proxy: { type: "http", host: "new-proxy.example", port: "8080" } }),
      }),
      {} as any,
      s,
      null,
      { timezoneFetch: timezoneFetch({ "new-proxy.example": "Europe/Paris" }, calls) },
    );
    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(calls).toEqual(EXIT_LOOKUP_CALLS);
    const saved = s.getProfile(body.id)!;
    expect(saved).toMatchObject({ timezone: "Europe/Paris", locale: "fr-FR" });
    if (engine === "firefox") expect(saved.firefox!.config.timezone).toBe("Europe/Paris");
    s.close();
  }
});

test("create (local mode) keeps the host timezone when the proxy lookup fails", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name: "fresh", proxy: { type: "http", host: "new-proxy.example", port: "8080" } }),
    }),
    {} as any,
    s,
    null,
    { timezoneFetch: async () => { throw new Error("offline"); } },
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(s.getProfile(body.id)!.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  s.close();
});

test("blank Local creation and edit do not request timezones for either browser", async () => {
  for (const engine of ["chromium", "firefox"] as const) {
    const s = new ProfileStore(":memory:");
    const calls: string[][] = [];
    const created = await handleUiRequest(
      new Request("http://x/ui/api/profiles", {
        method: "POST",
        body: JSON.stringify({ engine }),
      }),
      {} as any,
      s,
      null,
      { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) },
    );
    const body = await created!.json();
    expect(body.ok).toBe(true);
    expect(calls).toEqual([]);

    const edited = await handleUiRequest(
      new Request(`http://x/ui/api/profiles/${body.id}/update`, {
        method: "POST",
        body: JSON.stringify({ set: { name: `${engine}-edited` } }),
      }),
      {} as any,
      s,
      null,
      { timezoneFetch: timezoneFetch({ "1.2.3.4": "Europe/London" }, calls) },
    );
    expect((await edited!.json()).ok).toBe(true);
    expect(calls).toEqual([]);
    expect(s.getProfile(body.id)).toMatchObject({ engine, name: `${engine}-edited` });
    s.close();
  }
});

test("create (local mode) adds a new profile", async () => {
  const s = new ProfileStore(":memory:");
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "fresh", group: "g" }) }),
    {} as any,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(s.getProfile(body.id)!.name).toBe("fresh");
  s.close();
});

test("creating a Firefox profile starts the background download of its font pack", async () => {
  const s = new ProfileStore(":memory:");
  const prefetched: Profile[][] = [];
  const launcher = { prefetchFirefoxFontPacks: (profiles: Profile[]) => { prefetched.push(profiles); } } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "mac", engine: "firefox", platformOs: "macos" }) }),
    launcher,
    s,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(prefetched.map((profiles) => profiles.map((profile) => [profile.id, profile.engine, profile.platformOs])))
    .toEqual([[[body.id, "firefox", "macos"]]]);
  s.close();
});

test("creation validation is retryable and a post-save prefetch error cannot create duplicates", async () => {
  const s = new ProfileStore(":memory:");
  try {
    const invalid = await handleUiRequest(new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ engine: "unknown" }) }), {} as any, s);
    expect(await invalid!.json()).toMatchObject({ ok: false, uncertain: false });
    expect(s.listProfiles()).toHaveLength(0);
    const saved = await handleUiRequest(new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "Saved exactly once", engine: "chromium" }) }), { prefetchFirefoxFontPacks() { throw new Error("download unavailable"); } } as any, s);
    const response = await saved!.json();
    expect(response).toMatchObject({ ok: true });
    expect(s.listProfiles()).toHaveLength(1);
    expect(s.getProfile(response.id)!.name).toBe("Saved exactly once");
  } finally { s.close(); }
});

test("a remote creation timeout reports an unknown outcome instead of inviting a duplicate", async () => {
  const s = new ProfileStore(":memory:");
  try {
    const response = await handleUiRequest(new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "Remote" }) }), {} as any, s, { createProfile: async () => { throw new Error("response lost"); } } as any);
    expect(await response!.json()).toMatchObject({ ok: false, uncertain: true });
    expect(s.listProfiles()).toHaveLength(0);
  } finally { s.close(); }
});

test("create in remote mode delegates to the hub (not the local store)", async () => {
  const s = new ProfileStore(":memory:");
  const remote = { createProfile: async (input: any) => ({ id: "remote-" + (input.name || "x") }) } as any;
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles", { method: "POST", body: JSON.stringify({ name: "rp" }) }),
    {} as any,
    s,
    remote,
  );
  const body = await res!.json();
  expect(body.ok).toBe(true);
  expect(body.id).toBe("remote-rp");
  expect(s.getProfile("remote-rp")).toBeNull(); // went to the hub, not created locally
  s.close();
});

test("export in remote mode pulls every selected profile from the hub, not the local launch cache", async () => {
  const s = store(); // local launch cache holds only k1d0cd11
  // Two accounts that live on the hub roster but were never opened on this
  // machine — exactly what the launch cache can't serve. Selecting these and
  // exporting used to silently produce a file missing both rows.
  const base = parseExport(SAMPLE).profiles[0]!;
  const hubProfiles: Record<string, any> = {
    hub0001: { ...base, id: "hub0001", name: "alpha" },
    hub0002: { ...base, id: "hub0002", name: "bravo" },
  };
  const fetched: string[] = [];
  const remote = {
    async getProfiles(ids: string[]) {
      fetched.push(...ids);
      return ids.map((id) => hubProfiles[id]).filter(Boolean);
    },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["hub0001", "hub0002"], format: "csv" }),
    }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  expect(res!.headers.get("content-disposition")).toContain("vela-export.csv");
  const text = await res!.text();
  expect(fetched).toEqual(["hub0001", "hub0002"]); // resolved against the hub, not the local store
  const rows = text.trim().split("\n");
  expect(rows.length).toBe(3); // header + both selected accounts (not just the locally-cached one)
  expect(text).toContain("hub0001");
  expect(text).toContain("hub0002");
  expect(text).not.toContain("k1d0cd11"); // the local-cache fallback is gone
  s.close();
});

test("remote-mode streamed export reports progress between hub batches", async () => {
  const s = store();
  const base = parseExport(SAMPLE).profiles[0]!;
  const ids = Array.from({ length: 20 }, (_, i) => `hub${String(i).padStart(4, "0")}`);
  const remote = {
    async getProfiles(selected: string[], _full: boolean, onProgress?: (completed: number, total: number) => void) {
      const out: Profile[] = [];
      for (let i = 0; i < selected.length; i += 8) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        out.push(...selected.slice(i, i + 8).map((id) => ({ ...base, id })));
        onProgress?.(out.length, selected.length);
      }
      return out;
    },
  } as any;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids, format: "csv", stream: true }),
    }),
    {} as any,
    s,
    remote,
  );
  const records = (await response!.text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((record) => record.type === "progress").map((record) => record.completed)).toEqual([0, 8, 16, 20]);
  const file = records.at(-1)!;
  expect(file.type).toBe("file");
  expect(file.mime).toContain("text/csv");
  expect(Buffer.from(file.data, "base64").toString("utf8")).toContain("hub0000");
  s.close();
});

test("local-mode streamed export reports progress after each profile", async () => {
  const s = store();
  s.upsertProfile({ ...s.getProfile("k1d0cd11")!, id: "local0002", name: "second" });
  const captured: string[] = [];
  const launcher = { async captureLocalSession(id: string) { captured.push(id); return false; } } as any;
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11", "local0002"], format: "txt", stream: true }),
    }),
    launcher,
    s,
  );
  const records = (await response!.text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((record) => record.type === "progress").map((record) => record.completed)).toEqual([0, 1, 2]);
  const file = records.at(-1)!;
  expect(file.type).toBe("file");
  const text = Buffer.from(file.data, "base64").toString("utf8");
  expect(parseExport(text).profiles.map((profile) => profile.id)).toEqual(["k1d0cd11", "local0002"]);
  expect(captured).toEqual(["k1d0cd11", "local0002"]);
  s.close();
});

test("export as xlsx returns a workbook carrying the full identity", async () => {
  const s = store();
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["k1d0cd11"], format: "xlsx" }),
    }),
    new Launcher({ store: s }),
    s,
    null as any,
  );
  expect(res!.status).toBe(200);
  expect(res!.headers.get("content-disposition")).toContain("vela-export.xlsx");
  expect(res!.headers.get("content-type")).toContain("spreadsheetml.sheet");

  const rows = await readXlsx(new Uint8Array(await res!.arrayBuffer()));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe("k1d0cd11");
  expect(rows[0]!.proxy).toBe("1.2.3.4:8080:proxyuser:PROXYPASS");
  expect(rows[0]!.resolution).toBe("1680*1050");
  // The identity the export exists to move: cookies and the user-agent.
  expect(JSON.parse(rows[0]!.cookie!)[0].name).toBe("auth_token");
  expect(rows[0]!.ua).toContain("Chrome/143.0.0.0");
  s.close();
});

test("export as xlsx pulls from the hub in remote mode, with secrets", async () => {
  const s = store();
  const asked: Array<[string[], boolean | undefined]> = [];
  const base = parseExport(SAMPLE).profiles[0]!;
  const remote = {
    async getProfiles(ids: string[], full?: boolean) {
      asked.push([ids, full]);
      return ids.map((id) => ({ ...base, id }));
    },
  } as any;

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/export", {
      method: "POST",
      body: JSON.stringify({ ids: ["hub0001"], format: "xlsx" }),
    }),
    {} as any,
    s,
    remote,
  );
  expect(res!.status).toBe(200);
  // A full-fidelity sheet without cookies would be a silent downgrade, so the
  // hub fetch must ask for secrets exactly as the .txt export does.
  expect(asked).toEqual([[["hub0001"], true]]);
  expect((await readXlsx(new Uint8Array(await res!.arrayBuffer())))[0]!.id).toBe("hub0001");
  s.close();
});

test("update-file accepts an edited .xlsx and applies only editable columns", async () => {
  const s = store();
  const book = await writeXlsx(
    ["id", "name", "group", "cookie"],
    [["k1d0cd11", "renamed", "NewGroup", "[]"]],
  );
  const form = new FormData();
  form.append("files", new File([book as unknown as BlobPart], "edited.xlsx"));

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/update-file", { method: "POST", body: form }),
    {} as any,
    s,
    null as any,
  );
  const body = (await res!.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.updated).toBe(1);

  const p = s.getProfile("k1d0cd11")!;
  expect(p.name).toBe("renamed");
  expect(p.group).toBe("NewGroup");
  // Identity columns stay inert on re-upload, exactly as for .txt and .csv.
  expect(p.cookies).toHaveLength(1);
  s.close();
});

test("delete (standalone) blocks an open profile without stopping it or removing its data", async () => {
  const s = store();
  const dataRoot = join("/tmp", `ui-del-${process.pid}-${s.count()}`);
  const launcher: any = {
    cacheCleanupSettled: async () => {},
    profileDeletionBlocked: () => true,
    stop: async () => { throw new Error("must not stop an open profile during delete"); },
    removeUserDataDir: () => { throw new Error("must not remove an open profile"); },
  };
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
  const dir = join(dataRoot, "k1d0cd11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Cookies"), "logged-in");

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    launcher,
    s,
  );
  const body = await res!.json();
  expect(res!.status).toBe(409);
  expect(body).toMatchObject({ ok: false, deleted: 0, locked: ["k1d0cd11"] });
  expect(existsSync(dir)).toBe(true);
  expect(s.getProfile("k1d0cd11")).not.toBeNull();

  rmSync(dataRoot, { recursive: true, force: true });
  s.close();
});

test("delete (standalone) keeps a mixed open and closed selection atomic", async () => {
  const s = store();
  const closedId = "closed001";
  s.upsertProfile({ ...s.getProfile("k1d0cd11")!, id: closedId, name: "closed" });
  const dataRoot = join("/tmp", `ui-del-mixed-${process.pid}-${s.count()}`);
  const openDir = join(dataRoot, "k1d0cd11");
  const closedDir = join(dataRoot, closedId);
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  writeFileSync(join(openDir, "Cookies"), "open");
  writeFileSync(join(closedDir, "Cookies"), "closed");
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://x", startedAt: 1 });
  const launcher: any = {
    cacheCleanupSettled: async () => {},
    profileDeletionBlocked: (id: string) => id === "k1d0cd11",
    stop: async () => { throw new Error("must not stop profiles during delete"); },
    removeUserDataDir: () => { throw new Error("must not mutate a blocked batch"); },
  };

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", {
      method: "POST", body: JSON.stringify({ ids: [closedId, "k1d0cd11"] }),
    }),
    launcher,
    s,
  );
  expect(res!.status).toBe(409);
  expect(await res!.json()).toMatchObject({ deleted: 0, locked: ["k1d0cd11"] });
  expect(s.getProfile(closedId)).not.toBeNull();
  expect(s.getProfile("k1d0cd11")).not.toBeNull();
  expect(existsSync(closedDir)).toBe(true);
  expect(existsSync(openDir)).toBe(true);
  rmSync(dataRoot, { recursive: true, force: true });
  s.close();
});

test("delete (standalone) trashes a closed profile without calling stop or removing data", async () => {
  const s = store();
  const calls: string[] = [];
  const launcher: any = {
    cacheCleanupSettled: async () => {},
    profileDeletionBlocked: () => false,
    stop: async () => { throw new Error("delete must not stop a profile"); },
    removeUserDataDir: (id: string) => { calls.push(id); return true; },
  };

  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }) }),
    launcher,
    s,
  );

  expect(await res!.json()).toMatchObject({ ok: true, deleted: 1, locked: [] });
  expect(calls).toEqual([]);
  expect(s.getProfile("k1d0cd11")).toBeNull();
  expect(s.listTrashed().map((p) => p.id)).toEqual(["k1d0cd11"]);
  s.close();
});

test("delete (standalone) keeps recoverable data without cleanup and is idempotent", async () => {
  const s = store();
  const launcher: any = {
    cacheCleanupSettled: async () => {},
    profileDeletionBlocked: () => false,
    removeUserDataDir: () => { throw new Error("Trash must not clean up saved data"); },
  };
  const request = () => new Request("http://x/ui/api/profiles/delete", {
    method: "POST", body: JSON.stringify({ ids: ["k1d0cd11"] }),
  });

  const first = await handleUiRequest(request(), launcher, s);
  expect(first!.status).toBe(200);
  expect(await first!.json()).toMatchObject({ ok: true, deleted: 1 });
  const retried = await handleUiRequest(request(), launcher, s);
  expect(retried!.status).toBe(200);
  expect(await retried!.json()).toMatchObject({ ok: true, deleted: 0 });
  expect(s.listTrashed()).toHaveLength(1);
  expect(s.restoreProfile("k1d0cd11")).toBe(true);
  expect(s.getProfile("k1d0cd11")).not.toBeNull();
  s.close();
});

test("delete with an unknown id never touches the launcher (no rmSync on a crafted path)", async () => {
  const s = store();
  const launcher: any = {
    stop: async () => { throw new Error("must not be called"); },
    userDataDir: () => { throw new Error("must not be called"); },
  };
  const res = await handleUiRequest(
    new Request("http://x/ui/api/profiles/delete", { method: "POST", body: JSON.stringify({ ids: ["../../etc"] }) }),
    launcher,
    s,
  );
  expect((await res!.json()).deleted).toBe(0);
  s.close();
});

test("handleUiRequest returns null for non-ui paths (falls through to the AdsPower API)", async () => {
  const s = store();
  const res = await handleUiRequest(new Request("http://x/api/v1/status"), {} as any, s);
  expect(res).toBeNull();
  s.close();
});

test("runtime downloads route lists each download in progress with the bytes of its part", async () => {
  const s = store();
  const read = async () => {
    const response = await handleUiRequest(new Request("http://x/ui/api/runtime-downloads"), {} as any, s);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    return response!.json();
  };
  expect(await read()).toEqual({ downloads: [] });

  const dir = mkdtempSync(join(tmpdir(), "aliasmode-runtime-download-"));
  const partial = join(dir, "runtime.part");
  writeFileSync(partial, "x".repeat(42));
  let finish!: () => void;
  const download = trackRuntimeDownload("aliasmode", partial, 100, () => new Promise<void>((resolve) => { finish = resolve; }));
  expect(await read()).toEqual({ downloads: [{ runtime: "aliasmode", receivedBytes: 42, totalBytes: 100 }] });

  finish();
  await download;
  expect(await read()).toEqual({ downloads: [] });
  rmSync(dir, { recursive: true, force: true });
  s.close();
});

test("the roster carries each profile's serial and custom NO.", () => {
  const s = store();
  const [before] = listUiProfiles(s);
  expect(before!.serial).toBe(s.getSerial("k1d0cd11")!);
  expect(before!.customNo).toBe(""); // unset -> the UI falls back to the serial

  s.upsertProfile({ ...s.getProfile("k1d0cd11")!, customNo: "907341" });
  expect(listUiProfiles(s)[0]!.customNo).toBe("907341");
  s.close();
});

test("editing a custom NO. validates digits and survives a reopen of the editor", async () => {
  const s = store();
  const save = (customNo: string) => handleUiRequest(
    new Request("http://x/ui/api/profiles/k1d0cd11/update", {
      method: "POST",
      body: JSON.stringify({ set: { customNo } }),
    }),
    {} as any,
    s,
  );

  expect((await save("4421"))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421");

  const view = await handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11"), {} as any, s);
  expect((await view!.json()).profile.customNo).toBe("4421");

  const rejected = await save("44-21");
  expect(rejected!.status).toBe(500);
  expect((await rejected!.json()).error).toContain("digits only");
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("4421"); // rejected edit changed nothing

  expect((await save(""))!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.customNo).toBe("");
  s.close();
});

test("creating a profile stores the credentials supplied with it", async () => {
  const s = store();
  const response = await handleUiRequest(
    new Request("http://x/ui/api/profiles", {
      method: "POST",
      body: JSON.stringify({
        name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
        username: "fresh_user", password: "fresh-pass",
        email: "fresh@example.com", emailPassword: "mailbox-pass",
        twofa: "JBSWY3DPEHPK3PXP",
      }),
    }),
    {} as any,
    s,
  );
  const { ok, id } = await response!.json();
  expect(ok).toBe(true);

  // The create endpoint has always accepted these; this pins that the dialog is
  // not the only thing that can set them and that none are silently dropped.
  expect(s.getProfile(id)).toMatchObject({
    name: "fresh", group: "Warmup", platform: "x.com", customNo: "5150",
    username: "fresh_user", password: "fresh-pass",
    email: "fresh@example.com", emailPassword: "mailbox-pass",
    twofa: "JBSWY3DPEHPK3PXP",
  });
  s.close();
});

test("the dashboard profile payload carries the fingerprint verdict", () => {
  const s = store();
  s.saveObservedFingerprint(
    "k1d0cd11",
    { canvas: "deadbeef", capturedAt: "2026-08-29T11:04:22Z" },
    { verdict: "mismatch", differences: [{ field: "canvas", expected: "a3f19c8e", observed: "deadbeef" }] },
  );
  const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
  expect(row.fpVerdict!.verdict).toBe("mismatch");
  expect(row.fpVerdict!.differences[0]!.field).toBe("canvas");
  expect(row.fpCapturedAt).toBe("2026-08-29T11:04:22Z");
  s.close();
});

test("a profile that has never been probed carries no verdict", () => {
  const s = store();
  const row = listUiProfiles(s).find((p) => p.id === "k1d0cd11")!;
  expect(row.fpVerdict).toBeNull();
  expect(row.fpCapturedAt).toBe("");
  s.close();
});

test("shell-language round-trips through the server and rejects invalid tags", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "shell-lang-"));
  const paths = { root } as any;
  const call = (req: Request) => handleUiRequest(req, {} as any, s, null, { paths });

  // Nothing stored yet: null, so the UI follows the system language.
  let res = await call(new Request("http://x/ui/api/shell-language"));
  expect(res!.status).toBe(200);
  expect(await res!.json()).toEqual({ language: null });

  // Store Chinese, read it back.
  res = await call(new Request("http://x/ui/api/shell-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "zh-CN" }),
  }));
  expect(await res!.json()).toMatchObject({ ok: true, language: "zh-CN" });
  res = await call(new Request("http://x/ui/api/shell-language"));
  expect(await res!.json()).toEqual({ language: "zh-CN" });
  expect(existsSync(join(root, "shell.json"))).toBe(true);

  // Invalid tags fall back to English instead of being stored.
  res = await call(new Request("http://x/ui/api/shell-language", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language: "../../etc/passwd" }),
  }));
  expect(await res!.json()).toMatchObject({ ok: true, language: "en-US" });
  res = await call(new Request("http://x/ui/api/shell-language"));
  expect(await res!.json()).toEqual({ language: "en-US" });

  s.close();
  rmSync(root, { recursive: true, force: true });
});

test("fingerprint check route opens only the Vela Browser test page in a running profile", async () => {
  const s = store();
  s.recordLaunch({ profileId: "k1d0cd11", pid: 1, debugPort: 9412, ws: "ws://live-browser", startedAt: 123 });
  const opened: Array<{ ws: string; urls: string[]; replace: boolean }> = [];
  let active = true;
  const launcher = {
    certifiedActive: async () => active,
    navigate: async (ws: string, urls: string[], replace: boolean) => { opened.push({ ws, urls, replace }); },
  } as any;
  const request = (page: unknown) => handleUiRequest(new Request("http://x/ui/api/profiles/k1d0cd11/check-fingerprint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page }),
  }), launcher, s, null, {} as any);

  expect((await request("ru"))!.status).toBe(200);
  expect((await request("https://evil.invalid/"))!.status).toBe(200);
  expect(opened).toEqual([
    { ws: "ws://live-browser", urls: ["https://github.com/accomplish07zrh-eng/vela-browser/ru/fingerprint-test/"], replace: false },
    { ws: "ws://live-browser", urls: ["https://github.com/accomplish07zrh-eng/vela-browser/check/"], replace: false },
  ]);

  active = false;
  const closed = await request("en");
  expect(closed!.status).toBe(409);
  expect(opened).toHaveLength(2);
  s.close();
});

test("app-mode exposes kernelDns and /ui/api/proxy-kernel/dns persists preset and invalidates selector cache", async () => {
  const s = store();
  const root = mkdtempSync(join(tmpdir(), "vela-ui-kernel-dns-"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  const invalidated: string[] = [];
  const launcher = {
    invalidateKernelDns: (env?: string) => { invalidated.push(env ?? "all"); },
  } as any;
  const call = (path: string, body?: unknown, origin?: string) => handleUiRequest(
    new Request(`http://127.0.0.1:50400${path}`, body === undefined ? { method: "GET" } : {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    }),
    launcher,
    s,
    null,
    { appConfig },
  );

  const mode0 = await (await call("/ui/api/app-mode"))!.json();
  expect(mode0).toMatchObject({ kernelDnsSupported: true, kernelDns: "auto" });

  // Untrusted origin blocked.
  expect((await call("/ui/api/proxy-kernel/dns", { kernelDns: "cn" }, "https://evil.example"))!.status).toBe(403);
  // Invalid value rejected.
  expect((await call("/ui/api/proxy-kernel/dns", { kernelDns: "1.1.1.1" }))!.status).toBe(400);

  const saved = await call("/ui/api/proxy-kernel/dns", { kernelDns: "cn" });
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toEqual({ ok: true, kernelDns: "cn" });
  expect(appConfig.read().kernelDns).toBe("cn");
  expect(invalidated).toEqual(["all"]);

  const mode1 = await (await call("/ui/api/app-mode"))!.json();
  expect(mode1.kernelDns).toBe("cn");
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test("mutations enforce cross-origin/content-type guards, concurrent edit conflict, and pool edit round-trip", async () => {
  const s = store();
  const launcher = { start: async () => ({ ws: "ws://127.0.0.1:1/x", port: 1 }) } as any;
  const sub = s.proxyPool.addSubscription({ url: "https://sub.example/ui-pool" });
  const { parseSubscription } = await import("./subscription.ts");
  const parsed = parseSubscription("vless://11111111-2222-3333-4444-555555555555@jp.example:443?security=tls#JP");
  s.proxyPool.syncSubscription(sub.id, parsed.nodes, parsed);
  const node = s.proxyPool.list().find((n) => n.subscriptionId === sub.id)!;

  // Cross-origin Sec-Fetch-Site / Origin blocked across mutating routes, while local PowerShell bodyless POSTs succeed.
  const crossOpen = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/open", {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
    body: "{}",
  }), launcher, s);
  expect(crossOpen!.status).toBe(403);

  const pwshOpen = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/open", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }), launcher, s);
  expect(pwshOpen!.status).toBe(200);

  const formTaskbar = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/desktop/taskbar", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  }), launcher, s, null, { appConfig: new AppConfigStore(join(mkdtempSync(join(tmpdir(), "vela-tb-")), "c.json")) });
  expect(formTaskbar!.status).toBe(415);

  // Pool proxy edits round-trip cleanly via /ui/api/profiles/:id/update.
  const roundTrip = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set: { name: "sophia-2", proxyType: "pool", proxy: node.id } }),
  }), launcher, s);
  expect(roundTrip!.status).toBe(200);
  expect(s.getProfile("k1d0cd11")!.name).toBe("sophia-2");
  expect(s.getProfile("k1d0cd11")!.proxy).toEqual(node.proxy);

  // Concurrent proxy modification during non-pool exit timezone lookup returns 409 conflict.
  const conflict = await handleUiRequest(new Request("http://127.0.0.1:50400/ui/api/profiles/k1d0cd11/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ set: { proxyType: "http", proxy: "proxy.example:8080" } }),
  }), launcher, s, null, {
    timezoneFetch: (async () => {
      s.upsertProfile({ ...s.getProfile("k1d0cd11")!, proxy: null });
      return new Response(JSON.stringify({ status: "success", timezone: "Asia/Tokyo", countryCode: "JP" }));
    }) as any,
  });
  expect(conflict!.status).toBe(409);
  expect(s.getProfile("k1d0cd11")!.proxy).toBeNull();
  s.close();
});

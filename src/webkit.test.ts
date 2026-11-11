import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile } from "./create.ts";
import { normalizeProfileEngine } from "./firefox-config.ts";
import { assertValidProfile } from "./profile-validation.ts";
import { parseExport, recordToProfile, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";
import { createWebKitProfileConfig, normalizeWebKitProfileConfig, WEBKIT_DEFAULT_UA, webkitSupported } from "./webkit-config.ts";
import { ensureWebKit, WEBKIT_ARCHIVE } from "./webkit-install.ts";
import { readWebKitSessionCookies, WEBKIT_SESSION_FILE } from "./webkit-session.ts";
import type { AliasmodeChromiumDeps } from "./aliasmode-chromium.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "vela-webkit-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const profile = (): Profile => ({
  id: "webkit-one", engine: "webkit", webkit: createWebKitProfileConfig(1920, 1080),
  accId: "", name: "WebKit · Studio", group: "Studio", username: "", password: "", twofa: "",
  proxy: null, ua: WEBKIT_DEFAULT_UA, timezone: "Asia/Taipei", locale: "zh-TW", platformOs: "windows",
  screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 123, cookies: [], seeded: false,
});

test("WebKit preserves native settings and rejects cross-engine fingerprint configs", () => {
  const config = createWebKitProfileConfig(1920, 1080);
  expect(config.viewport).toEqual({ width: 1280, height: 800 });
  expect(normalizeProfileEngine("webkit", undefined, config)).toEqual({ engine: "webkit", webkit: config });
  for (const value of [
    { ...config, config: { "navigator.platform": "MacIntel" } },
    { ...config, deviceScaleFactor: 0 }, { ...config, viewport: { width: 100, height: 800 } },
    { ...config, viewport: { width: 1280, height: NaN } },
  ]) expect(() => normalizeWebKitProfileConfig(value)).toThrow();
  for (const [engine, firefox, webkit] of [
    ["webkit", undefined, undefined], ["webkit", {}, config], ["firefox", {}, config], ["chromium", undefined, config], [undefined, undefined, config],
  ]) expect(() => normalizeProfileEngine(engine, firefox, webkit)).toThrow();
  for (const edit of [{ hardware: { cores: 4 } }, { extensions: ["chrome-extension"] }, { chromiumRuntime: "aliasmode" }, { displayScale: 1.25 }]) {
    expect(() => assertValidProfile({ ...profile(), ...edit })).toThrow();
  }
});

test("WebKit creation is explicit and respects the verified host matrix", () => {
  expect(webkitSupported("win32", "x64")).toBe(true);
  for (const [platform, arch] of [["win32", "arm64"], ["darwin", "arm64"], ["linux", "x64"]] as const) expect(webkitSupported(platform, arch)).toBe(false);
  if (webkitSupported()) {
    const created = buildNewProfile({ engine: "webkit", screen: "1920x1080" }, () => false);
    expect(created).toMatchObject({ engine: "webkit", ua: WEBKIT_DEFAULT_UA, webkit: createWebKitProfileConfig(1920, 1080) });
    expect(created.hardware).toBeUndefined(); expect(created.firefox).toBeUndefined(); expect(created.chromiumRuntime).toBeUndefined();
    expect(() => buildNewProfile({ engine: "webkit", platformOs: "macos" }, () => false)).toThrow("OS fingerprint overrides");
  } else expect(() => buildNewProfile({ engine: "webkit" }, () => false)).toThrow("Windows x64");
});

test("WebKit config and private owner survive SQLite reopen without an in-place engine switch", () => {
  const path = join(temporary(), "profiles.sqlite"); let store = new ProfileStore(path);
  cleanup.push(() => store.close());
  store.upsertProfile(profile());
  const owner = { endpoint: "http://127.0.0.1:41001/", generation: "generation", token: "private", pid: 101, browserPid: 102 };
  store.recordLaunch({ profileId: "webkit-one", engine: "webkit", pid: 102, debugPort: 41001, ws: "webkit://127.0.0.1:41001/generation", startedAt: 1, webkitOwner: owner });
  store.close(); store = new ProfileStore(path);
  expect(store.getProfile("webkit-one")).toMatchObject({ engine: "webkit", webkit: profile().webkit });
  expect(store.getLaunch("webkit-one")).toMatchObject({ engine: "webkit", webkitOwner: owner });
  expect(store.getLaunch("webkit-one")!.firefoxOwner).toBeUndefined();
  const { webkit: _webkit, ...rest } = profile();
  expect(() => store.upsertProfile({ ...rest, engine: "chromium" })).toThrow();
  expect(() => store.setHardware("webkit-one", { cores: 4 })).toThrow();
});

test("WebKit TXT, XLSX and portable V5 preserve the complete saved identity", () => {
  const original = profile();
  const text = parseExport(serializeAdsTxt([original]));
  expect(text.errors).toEqual([]);
  expect(text.profiles[0]).toMatchObject({ engine: "webkit", webkit: original.webkit, locale: "zh-TW", ua: original.ua });
  const xlsx = serializeXlsxRows([original]);
  const row = Object.fromEntries(xlsx.headers.map((key, index) => [key, xlsx.rows[0]![index]!])) as Record<string, string>;
  expect(recordToProfile(row)!.profile).toMatchObject({ engine: "webkit", webkit: original.webkit });
  const portable = encodePortableProfile(original, JSON.stringify({ cookies: [], origins: [], tabs: ["https://example.com/"] }));
  expect(portable.schemaVersion).toBe(5);
  expect(decodePortableProfile(portable).profile).toMatchObject({ engine: "webkit", webkit: original.webkit, locale: "zh-TW" });
  for (const schemaVersion of [1, 2, 3, 4]) expect(() => decodePortableProfile({ ...portable, schemaVersion } as any)).toThrow();
  for (const edit of [{ engine: "chromium" }, { firefox: {} }, { hardware: { cores: 8 } }, { extensionAssignments: ["extension"] }, { chromiumRuntime: "aliasmode" }]) {
    expect(() => decodePortableProfile({ ...portable, profile: { ...portable.profile, ...edit } } as any)).toThrow();
  }
});

test("a graceful WebKit session restores only session cookies of its exact profile", () => {
  const root = temporary(), file = join(root, WEBKIT_SESSION_FILE);
  const session = { version: 1, profileId: "webkit-one", generation: "41001:1234", cookies: [
    { name: "account", value: "a", domain: "example.com", path: "/", expires: -1 },
    { name: "persistent", value: "disk-owned", domain: "example.com", path: "/", expires: 4_000_000_000 },
  ] };
  writeFileSync(file, JSON.stringify(session));
  expect(readWebKitSessionCookies(root, "webkit-one")).toEqual([session.cookies[0]!]);
  expect(readWebKitSessionCookies(root, "webkit-two")).toBeNull();
  for (const edit of [{ generation: "old" }, { version: 2 }, { cookies: [{ ...session.cookies[0], value: 42 }] }]) {
    writeFileSync(file, JSON.stringify({ ...session, ...edit })); expect(readWebKitSessionCookies(root, "webkit-one")).toBeNull();
  }
});

test("WebKit installer verifies both pins, deduplicates installs and rejects unsupported hosts", async () => {
  const root = temporary(); let downloads = 0;
  const release = (archive = WEBKIT_ARCHIVE.archiveSha256, executable = WEBKIT_ARCHIVE.executableSha256): AliasmodeChromiumDeps => ({
    download: async (_url, output) => { downloads++; writeFileSync(output, archive); },
    extract: async (_archive, output) => { mkdirSync(output, { recursive: true }); writeFileSync(join(output, "Playwright.exe"), executable); },
    hashFile: async (path) => readFileSync(path, "utf8"), run: async () => {},
  });
  const installed = await Promise.all([ensureWebKit(root, release(), "win32", "x64"), ensureWebKit(root, release(), "win32", "x64")]);
  expect(installed[0]).toBe(installed[1]); expect(downloads).toBe(1);
  expect(await ensureWebKit(root, release(), "win32", "x64")).toBe(installed[0]); expect(downloads).toBe(1);
  await expect(ensureWebKit(temporary(), release("bad"), "win32", "x64")).rejects.toThrow();
  await expect(ensureWebKit(temporary(), release(undefined, "bad"), "win32", "x64")).rejects.toThrow();
  await expect(ensureWebKit(temporary(), release(), "linux", "x64")).rejects.toThrow("Windows x64");
});

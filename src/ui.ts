/**
 * Dashboard API — the `/ui/api/*` namespace consumed by the web UI.
 *
 * Kept entirely separate from the AdsPower-compatible API (server.ts /
 * handleRequest) so the `/api/v1|v2/*` compatibility contract is never touched.
 *
 * SECURITY: responses are redacted. They expose profile metadata (proxy
 * host:port, cookie COUNT, group, etc.) but NEVER secrets — no password, 2FA,
 * cookie values, or proxy credentials. Same rule the `inspect` command follows.
 */

import { BrowserLaunchError, defaultSetCookies, launchIdentityChanged, type Launcher } from "./launcher.ts";
import { taskbarModeSupported } from "./taskbar.ts";
import type { ProfileStore } from "./store.ts";
import type { AutomationHealthStatus } from "./remote-types.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import { CloudApiError, CloudRequestError } from "./cloud-client.ts";
import type { StatePaths } from "./paths.ts";
import type { ChromiumRuntime, FingerprintVerdict, Profile, CookieRecord, ProxySpec } from "./types.ts";
import { checkProxy as runProxyCheck, type ProxyCheckResult } from "./proxy-check.ts";
import { handleProxyToolsRequest } from "./proxy-tools.ts";
import { handleTrashRequest } from "./trash.ts";
import {
  importInbox,
  importBuffers,
  ProfileImportError,
  type ImportOverrides,
} from "./inbox.ts";
import { hostChromiumRuntime, supportsChromium155Host } from "./aliasmode-chromium.ts";
import { buildNewProfile, defaultProfileEngine, type NewProfileInput } from "./create.ts";
import { webkitSupported } from "./webkit-config.ts";
import { firefoxGraphicsRenderer } from "./firefox-config.ts";
import { attachTimezones, lookupExitLocation, type FetchLike } from "./geoip.ts";
import { localeForCountry, localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { parseUpdateFile, rowsToUpdates, serializeCsv, serializeAdsTxt, serializeXlsxRows, parseStrictProxy, parseStrictResolution, parseStrictPlatformOs, parseStrictTimezone, parseStrictCustomNo, parseStrictCores, parseStrictSeed, decodeText, parseCookieText, cookiesForEngine } from "./parse.ts";
import type { ProfileExport } from "./parse.ts";
import { writeXlsx, readXlsx } from "./xlsx.ts";
import { generateTotp } from "./totp.ts";
import {
  installExtension,
  installWebStoreExtension,
  parseWebStoreExtensionId,
  removeExtensionFiles,
  type ExtensionFetch,
} from "./extensions.ts";
import { isSafeProfileId, PROFILE_ID_ERROR } from "./profile-id.ts";
import { normalizeProxySpec, proxyHostPort, proxyLegacyString, type ProxyInput } from "./proxy.ts";
import { convertMobilePersonaToDesktop, editedProfileHardware, isMobileUserAgent } from "./fingerprint.ts";
import { fingerprintAudit } from "./fingerprint-audit.ts";
import { setFirefoxScreen, syncFirefoxTimezone } from "./firefox-config.ts";
import { join, resolve, dirname } from "node:path";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { validAgentAuthorization } from "./agent-control.ts";
import { ScriptError, prefetchPythonFor, type ScriptLibrary, type ScriptSupervisor } from "./scripts.ts";
import type { PythonRuntime } from "./python-runtime.ts";
import { runtimeDownloads } from "./runtime-download.ts";

/** Readiness metadata supplied by the desktop parent process. */
export interface UiHealthMetadata {
  version: string;
  root: string;
  instance: string;
}

/** Redacted, dashboard-safe view of a profile + its live status. */
export interface UiProfile {
  id: string;
  name: string;
  /** Browser family. Legacy profiles without a value are Chromium. */
  engine: "chromium" | "firefox" | "webkit";
  /** Present only for the opt-in Chromium 155 beta. */
  chromiumRuntime?: ChromiumRuntime;
  group: string;
  /** Account platform: "x.com", "telegram.org", or "" (none). */
  platform: string;
  /** "host:port" only — never user/pass. Null when the profile has no proxy. */
  proxy: string | null;
  /** Safe validation message for a quarantined legacy proxy. */
  proxyError?: string;
  timezone: string;
  cookieCount: number;
  seeded: boolean;
  screen: string;
  mobilePersona?: boolean;
  /** Whether a 2FA secret is stored (drives the row's authenticator button). */
  has2fa: boolean;
  /** Store serial (SQLite rowid) — the roster's default "No." for this profile. */
  serial: number | null;
  /** Creation time, ms. 0 for rows imported before the column existed. */
  createdAt: number;
  /** Most recent launch, ms. 0 when this profile has never been opened here. */
  lastOpenAt: number;
  /** Operator-chosen "custom NO.", or "" when the serial is used instead. */
  customNo: string;
  running: boolean;
  /** The open browser runs with an older proxy or fingerprint than the saved one. */
  restartPending?: boolean;
  /** Cookies added while the profile was closed; the next start sets them. */
  pendingCookieCount?: number;
  debugPort?: number;
  startedAt?: number;
  healthStatus?: AutomationHealthStatus;
  healthObservedAt?: number | null;
  /**
   * Whether the last launch's measured fingerprint still matches the one an
   * import claimed. Null when nothing was imported to check against — that is
   * "unknown", not "verified", and the dashboard must render it as neither.
   */
  fpVerdict: FingerprintVerdict | null;
  /** ISO-8601 instant of the last measurement; "" if never launched. */
  fpCapturedAt: string;
}

function profileEngine(profile: unknown): "chromium" | "firefox" | "webkit" {
  return typeof profile === "object" && profile !== null && "engine" in profile && (profile.engine === "firefox" || profile.engine === "webkit")
    ? profile.engine
    : "chromium";
}

function openResponse(
  profile: unknown,
  result: { port?: number; warning?: string },
): Response {
  const engine = profileEngine(profile);
  return Response.json({
    ok: true,
    ...(engine === "firefox" || engine === "webkit"
      ? { engine, capabilities: { cdp: false, pdf: false, chromeExtensions: false } }
      : { port: result.port }),
    ...(result.warning === undefined ? {} : { warning: result.warning }),
  });
}

/**
 * Map the store into redacted UiProfiles joined with running state. Status comes
 * from the launches table, which is authoritative for every browser THIS manager
 * started — campaign-launched or dashboard-launched alike (one manager per box).
 */
export function listUiProfiles(store: ProfileStore): UiProfile[] {
  const launches = new Map(store.listLaunches().map((l) => [l.profileId, l]));
  const meta = store.listProfileMeta();
  const pendingCookies = store.pendingCookieCounts();
  return store.listProfiles().map((p) => {
    const l = launches.get(p.id);
    return {
      id: p.id,
      name: p.name,
      engine: profileEngine(p),
      ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
      group: p.group,
      platform: p.platform ?? "",
      tags: p.tags ?? [],
      proxy: p.proxy ? proxyHostPort(p.proxy) : null,
      ...(p.proxyError ? { proxyError: p.proxyError } : {}),
      timezone: p.timezone,
      cookieCount: p.cookies.length,
      seeded: p.seeded,
      screen: `${p.screenWidth}x${p.screenHeight}`,
      has2fa: !!(p.twofa && p.twofa.trim()),
      serial: meta.get(p.id)?.serial ?? null,
      createdAt: meta.get(p.id)?.createdAt ?? 0,
      lastOpenAt: meta.get(p.id)?.lastOpenAt ?? 0,
      customNo: p.customNo ?? "",
      mobilePersona: isMobileUserAgent(p.ua),
      running: !!l,
      ...(l && launchIdentityChanged(p, l) ? { restartPending: true } : {}),
      ...(pendingCookies.get(p.id) ? { pendingCookieCount: pendingCookies.get(p.id) } : {}),
      ...(profileEngine(p) === "chromium" ? { debugPort: l?.debugPort } : {}),
      startedAt: l?.startedAt,
      // null when nothing was imported to check this profile against.
      fpVerdict: p.fpVerdict ?? null,
      fpCapturedAt: p.fpObserved?.capturedAt ?? "",
    };
  });
}

async function readLatestDiagnose(reportsRoot = "reports"): Promise<unknown | null> {
  try {
    const f = Bun.file(join(reportsRoot, "diagnose-latest.json"));
    if (!(await f.exists())) return null;
    return await f.json();
  } catch {
    return null;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Below 2 GB free Chromium gives sites no new storage and below 1 GB it evicts their data;
 * Firefox evicts the least recently used sites when the disk runs low. 5 GB warns before that.
 */
export const LOW_DISK_SPACE_BYTES = 5 * 1024 ** 3;

function rejectUntrustedJsonMutation(req: Request): Response | null {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return Response.json({ ok: false, error: "application/json is required" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    return Response.json({ ok: false, error: "cross-origin requests are forbidden" }, { status: 403 });
  }
  return null;
}

function normalizeCookieDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  if (!input || /[\x00-\x20\x7f]/.test(input)) return null;
  const includeSubdomains = input.startsWith(".");
  const candidate = includeSubdomains ? input.slice(1) : input;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return null;
    return includeSubdomains ? `.${hostname}` : hostname;
  } catch {
    return null;
  }
}

/** One cookie from the Add cookie form, or the reason it is invalid. */
function singleCookie(body: Record<string, unknown>): CookieRecord | string {
  const name = body.name;
  const value = body.value;
  const domain = normalizeCookieDomain(body.domain);
  const path = body.path === undefined ? "/" : body.path;
  if (typeof name !== "string" || !name || /[\s\x00-\x1f\x7f;=]/.test(name)) return "cookie name is invalid";
  if (typeof value !== "string" || /[\x00-\x1f\x7f;]/.test(value)) return "cookie value is invalid";
  if (!domain) return "cookie domain is invalid";
  if (typeof path !== "string" || !path.startsWith("/")) return "cookie path must start with /";
  return {
    name,
    value,
    domain,
    path,
    expires: Math.floor(Date.now() / 1_000) + 31_536_000,
    secure: true,
    sameSite: "Lax",
  };
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

// Shell UI language preference. localStorage cannot persist it: the desktop
// shell serves the UI from a random loopback port each launch, and localStorage
// is origin-scoped (http://127.0.0.1:PORT), so it is wiped on every restart.
// Persist to <state-root>/shell.json instead. The value is a BCP47 language
// tag validated by pattern only, so adding a locale never needs backend changes.
const SHELL_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z]{2,8})?$/;

function shellLanguagePath(paths?: StatePaths): string | null {
  if (!paths?.root) return null;
  return join(paths.root, "shell.json");
}

/** The saved shell language, or null when the user never chose one (the UI then follows the system language). */
export function readShellLanguage(paths?: StatePaths): string | null {
  try {
    const file = shellLanguagePath(paths);
    if (!file) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { language?: unknown };
    if (typeof raw.language === "string" && SHELL_LANGUAGE_PATTERN.test(raw.language)) return raw.language;
  } catch {
    // Missing or corrupt file: nothing chosen yet.
  }
  return null;
}

export function writeShellLanguage(paths: StatePaths | undefined, language: string): void {
  if (!SHELL_LANGUAGE_PATTERN.test(language)) throw new Error(`Invalid language tag: ${language}`);
  const file = shellLanguagePath(paths);
  if (!file) throw new Error("Shell language storage is unavailable");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ language })}\n`, "utf8");
}

function proxyCheckView(result: ProxyCheckResult): ProxyCheckResult {
  return {
    status: result.status,
    attempts: result.attempts,
    successes: result.successes,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.ip ? { ip: result.ip } : {}),
    ...(result.country ? { country: result.country } : {}),
    ...(result.region ? { region: result.region } : {}),
    ...(result.city ? { city: result.city } : {}),
    ...(result.rotating !== undefined ? { rotating: result.rotating } : {}),
  };
}
const APPLICATION_ROOT = resolve(import.meta.dir);

let appVersionPromise: Promise<string> | null = null;
function appVersion(): Promise<string> {
  if (!appVersionPromise) {
    appVersionPromise = (async () => {
      try {
        const file = Bun.file(join(APPLICATION_ROOT, "VERSION.txt"));
        if (!(await file.exists())) return "dev";
        return (await file.text()).trim() || "dev";
      } catch {
        return "dev";
      }
    })();
  }
  return appVersionPromise;
}

/**
 * Full editable detail for the Edit modal — UNLIKE the redacted list view, this
 * DOES include the account secrets and full proxy creds, because you can't edit
 * what you can't see. Safe only because the dashboard is loopback-only (same
 * trust boundary as the `inspect` command).
 */
/** The hardware a profile is set to report, for display. Engines choose what is absent. */
function storedHardware(p: Profile): { gpu?: string; cores?: number } | undefined {
  // The card the browser shows, which is Apple's for a macOS profile saved with another.
  const gpu = p.firefox ? firefoxGraphicsRenderer(p) : undefined;
  const cores = p.hardware?.cores ?? p.firefox?.config["navigator.hardwareConcurrency"];
  const hardware = {
    ...(typeof gpu === "string" && gpu ? { gpu } : {}),
    ...(typeof cores === "number" ? { cores } : {}),
  };
  return Object.keys(hardware).length ? hardware : undefined;
}

function profileEditView(p: Profile) {
  const px = p.proxy;
  const proxy = px ? proxyLegacyString(px) : "";
  const conversion = isMobileUserAgent(p.ua) ? convertMobilePersonaToDesktop(p) : null;
  return {
    id: p.id, name: p.name, engine: profileEngine(p), ...(p.chromiumRuntime ? { chromiumRuntime: p.chromiumRuntime } : {}),
    ...(storedHardware(p) ? { hardware: storedHardware(p) } : {}),
    group: p.group, platform: p.platform ?? "",
    proxyType: px?.type ?? "http", proxy,
    ...(p.proxyError ? { proxyError: p.proxyError } : {}),
    username: p.username, password: p.password,
    email: p.email ?? "", emailPassword: p.emailPassword ?? "", twofa: p.twofa,
    resolution: `${p.screenWidth}*${p.screenHeight}`,
    extensions: p.extensions ?? [],
    tags: (p.tags ?? []).join(", "),
    customNo: p.customNo ?? "",
    platformOs: p.platformOs ?? "",
    timezone: p.timezone,
    ...(p.timezoneManual ? { timezoneManual: true } : {}),
    locale: p.locale ?? "",
    cores: p.hardware ? String(p.hardware.cores) : "",
    fingerprintSeed: String(p.fingerprintSeed),
    cookieCount: p.cookies.length, seeded: p.seeded,
    mobilePersona: !!conversion,
    ...(conversion ? {
      desktopConversion: {
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}*${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      },
    } : {}),
  };
}

/** `{ restartRequired: true }` when the open browser runs with an older proxy or fingerprint than the saved one. */
function restartRequired(store: ProfileStore, id: string): { restartRequired?: true } {
  const launch = store.getLaunch(id);
  const profile = launch ? store.getProfile(id) : null;
  return profile && launchIdentityChanged(profile, launch) ? { restartRequired: true } : {};
}

/**
 * Apply a partial field set onto a profile in place. Only keys present in `set`
 * change — everything else (cookies, fingerprint seed, seeded) is preserved.
 * This is what makes single-edit and file bulk-update safe. Shared by both.
 */
function applyEdits(p: Profile, set: Record<string, unknown>): boolean {
  let proxyChanged = false;
  if ("name" in set) p.name = String(set.name ?? "");
  if ("group" in set) p.group = String(set.group ?? "");
  if ("platform" in set) p.platform = String(set.platform ?? "");
  if ("username" in set) p.username = String(set.username ?? "");
  if ("password" in set) p.password = String(set.password ?? "");
  if ("email" in set) p.email = String(set.email ?? "");
  if ("emailPassword" in set) p.emailPassword = String(set.emailPassword ?? "");
  if ("twofa" in set) p.twofa = String(set.twofa ?? "");
  if ("resolution" in set) {
    const r = parseStrictResolution(set.resolution);
    if (profileEngine(p) === "firefox" && (p.screenWidth !== r.width || p.screenHeight !== r.height)) {
      setFirefoxScreen(p, r.width, r.height);
    }
    p.screenWidth = r.width;
    p.screenHeight = r.height;
    if (p.webkit) p.webkit = { ...p.webkit, viewport: { width: Math.min(p.webkit.viewport.width, r.width), height: Math.min(p.webkit.viewport.height, r.height) } };
  }
  if (p.engine === "webkit" && ("cores" in set || "fingerprintSeed" in set)) throw new Error("WebKit does not support hardware or seed fingerprint overrides");
  if ("platformOs" in set) {
    const platformOs = parseStrictPlatformOs(set.platformOs);
    if (profileEngine(p) !== "chromium" && platformOs !== (p.platformOs ?? "")) {
      throw new Error("Firefox operating system cannot be changed");
    }
    p.platformOs = platformOs;
  }
  if ("locale" in set) p.locale = normalizeProfileLocale(set.locale) ?? p.locale;
  if ("timezone" in set) {
    p.timezone = parseStrictTimezone(set.timezone);
    // A typed timezone stays when the proxy changes and on every launch. A blank one follows the proxy.
    if (p.timezone) p.timezoneManual = true;
    else delete p.timezoneManual;
    syncFirefoxTimezone(p);
  }
  if ("fingerprintSeed" in set) p.fingerprintSeed = parseStrictSeed(set.fingerprintSeed);
  if ("cores" in set) {
    const hardware = editedProfileHardware(p, parseStrictCores(set.cores));
    if (hardware) p.hardware = hardware;
    else delete p.hardware;
  }
  if ("proxy" in set) {
    const nextProxy = parseStrictProxy(set.proxyType ?? p.proxy?.type ?? "http", set.proxy);
    const previousProxy = p.proxy;
    proxyChanged = !!p.proxyError ||
      previousProxy?.type !== nextProxy?.type ||
      previousProxy?.host !== nextProxy?.host ||
      previousProxy?.port !== nextProxy?.port ||
      previousProxy?.user !== nextProxy?.user ||
      previousProxy?.pass !== nextProxy?.pass;
    p.proxy = nextProxy;
    delete p.proxyError;
  }
  if ("extensions" in set) {
    const extensions = Array.isArray(set.extensions) ? set.extensions.map(String) : [];
    if (profileEngine(p) !== "chromium" && extensions.length > 0) {
      throw new Error("Chrome extensions are unavailable for Firefox profiles");
    }
    p.extensions = extensions;
  }
  if ("tags" in set) {
    p.tags = Array.isArray(set.tags)
      ? set.tags.map(String)
      : String(set.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  }
  if ("customNo" in set) p.customNo = parseStrictCustomNo(set.customNo);
  return proxyChanged;
}

export interface UiRuntimeOptions {
  /** @deprecated Account runtimes are retired; production entry points ignore these fields. */
  cloudAuth?: import("./cloud-auth.ts").CloudAuthRuntime;
  cloudConnection?: import("./cloud-connection.ts").CloudConnectionRuntime;
  cloudBrowser?: import("./cloud-browser.ts").CloudBrowserLifecycle;
  pendingSync?: import("./pending-sync.ts").PendingSyncRuntime;
  mcpTunnel?: import("./mcp-tunnel.ts").McpTunnelLifecycle;
  defaultCloudUrl?: string;

  scripts?: { library: ScriptLibrary; runner: ScriptSupervisor; nonce: string; python?: PythonRuntime };
  appConfig?: AppConfigStore;
  /** Re-applies taskbar-hidden mode right after the setting changes. */
  taskbarMode?: import("./taskbar.ts").TaskbarMode;
  paths?: StatePaths;


  health?: UiHealthMetadata | null;
  timezoneFetch?: FetchLike;
  proxyCheck?: (proxy: ProxySpec) => Promise<ProxyCheckResult>;
  extensionFetch?: ExtensionFetch;
  /** Sets cookies in an open browser. Defaults to Playwright's addCookies. */
  setCookies?: (ws: string, cookies: CookieRecord[]) => Promise<void>;
  /** Mode whose runtimes were wired when this process started. */
  runtimeMode?: "local";
}

/**
 * Handle a `/ui/api/*` request. Returns null for any other path so the caller
 * can fall through to the AdsPower API handler.
 */
export async function handleUiRequest(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  remote?: RemoteCoordinator | null,
  options: UiRuntimeOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith("/ui/api/")) return null;

  // Retired account endpoints cannot restore a session or contact a Cloud service.
  if (/^\/ui\/api\/cloud(?:[-/]|$)/.test(pathname) || (pathname === "/ui/api/app-mode" && req.method !== "GET") || /^\/ui\/api\/scripts\/[^/]+\/publication$/.test(pathname) || /^\/ui\/api\/profiles\/[^/]+\/restore-session$/.test(pathname)) {
    return noStoreJson({ ok: false, code: "accounts_removed", error: "Accounts and Cloud mode have been removed from Vela Browser" }, 410);
  }

  if (pathname === "/ui/api/scripts" || pathname.startsWith("/ui/api/scripts/")) {
    const scripts = options.scripts;
    if (!scripts) return noStoreJson({ ok: false, error: "Scripts require the desktop app" }, 503);
    if (!validAgentAuthorization(req.headers.get("authorization"), scripts.nonce)) {
      return noStoreJson({ ok: false, error: "Script authorization failed" }, 401);
    }
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) return noStoreJson({ ok: false, error: "Cross-origin requests are forbidden" }, 403);
    if (req.method !== "GET") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    try {
      if (pathname === "/ui/api/scripts/run") {
        if (req.method === "GET") return noStoreJson({ ok: true, run: scripts.runner.status() });
        if (req.method === "POST") return noStoreJson({ ok: true, run: scripts.runner.start(await req.json()) });
      }
      if (pathname === "/ui/api/scripts/stop" && req.method === "POST") {
        return noStoreJson({ ok: true, run: await scripts.runner.stop() });
      }
      if (pathname === "/ui/api/scripts/python-runtime") {
        // null: a source checkout runs Python scripts on python3 and downloads nothing.
        if (req.method === "POST") scripts.python?.ensure().catch(() => {});
        if (req.method === "GET" || req.method === "POST") return noStoreJson({ ok: true, python: scripts.python?.status() ?? null });
      }
      if (pathname === "/ui/api/scripts/log" && req.method === "GET") {
        const params = new URL(req.url).searchParams;
        return noStoreJson({ ok: true, ...scripts.runner.log(params.get("runId") ?? "", Number(params.get("offset") ?? 0)) });
      }
      if (pathname === "/ui/api/scripts/library" && req.method === "GET") {
        const params = new URL(req.url).searchParams;
        const language = params.get("language") || undefined;
        if (language !== undefined && language !== "javascript" && language !== "python") throw new ScriptError("Unsupported script language");
        return noStoreJson(await scripts.library.browse({
          q: params.get("q") ?? undefined,
          language: language || undefined,
          offset: params.has("offset") ? Number(params.get("offset")) : undefined,
        }));
      }
      const publicMatch = pathname.match(/^\/ui\/api\/scripts\/library\/([^/]+)(\/import)?$/);
      if (publicMatch) {
        const id = decodeURIComponent(publicMatch[1]!);
        if (!publicMatch[2] && req.method === "GET") return noStoreJson({ ok: true, script: await scripts.library.viewPublished(id) });
        if (publicMatch[2] && req.method === "POST") {
          const script = await scripts.library.importPublished(id);
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
      }
      const publicationMatch = pathname.match(/^\/ui\/api\/scripts\/([^/]+)\/publication$/);
      if (publicationMatch) {
        const id = decodeURIComponent(publicationMatch[1]!);
        if (req.method === "PUT") return noStoreJson({ ok: true, script: await scripts.library.publish(id, await req.json()) });
        if (req.method === "DELETE") {
          await scripts.library.unpublish(id);
          return noStoreJson({ ok: true, unpublished: true });
        }
      }
      // Having or adding a Python script starts the Python runtime download in the background.
      if (pathname === "/ui/api/scripts") {
        if (req.method === "GET") {
          const info = await scripts.library.info();
          prefetchPythonFor(scripts.python, info.scripts);
          return noStoreJson({ ok: true, ...info });
        }
        if (req.method === "POST") {
          const script = await scripts.library.save(await req.json());
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
      }
      const match = pathname.match(/^\/ui\/api\/scripts\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (req.method === "GET") return noStoreJson({ ok: true, script: await scripts.library.get(id) });
        if (req.method === "PATCH") {
          const body = await req.json();
          const script = await scripts.library.save(body, id, body?.expectedRevision);
          prefetchPythonFor(scripts.python, [script]);
          return noStoreJson({ ok: true, script });
        }
        if (req.method === "DELETE") {
          const body = await req.json();
          await scripts.library.delete(id, body?.expectedRevision);
          return noStoreJson({ ok: true });
        }
      }
      return noStoreJson({ ok: false, error: "Unknown script operation" }, 404);
    } catch (error) {
      const status = error instanceof ScriptError || error instanceof CloudApiError ? error.status
        : error instanceof CloudRequestError ? 502 : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      return noStoreJson({ ok: false, error: error instanceof SyntaxError ? "Invalid JSON request" : msg(error) }, status);
    }
  }

  // Dependency-free readiness probe for the Windows updater. Unlike the
  // profile roster it does not touch CDP, the process scanner, SQLite rows, or
  // the remote hub, so an upstream outage cannot masquerade as a failed update.
  if (pathname === "/ui/api/health" && req.method === "GET") {
    const logDir = options.paths ? join(options.paths.root, "logs") : undefined;
    return Response.json(options.health
      ? { ok: true, ...options.health, ...(logDir ? { logDir } : {}) }
      : { ok: true, version: await appVersion(), root: APPLICATION_ROOT, ...(logDir ? { logDir } : {}) });
  }

  // Warning only: under storage pressure both engines evict saved site data.
  if (pathname === "/ui/api/disk-space" && req.method === "GET") {
    const freeBytes = launcher.dataDriveFreeBytes();
    return noStoreJson({ ok: true, freeBytes, low: freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES });
  }

  if (pathname === "/ui/api/logs" && req.method === "GET") {
    if (!options.paths) return Response.json({ ok: false, error: "logs are unavailable" }, { status: 503 });
    try {
      const dir = join(options.paths.root, "logs");
      const name = readdirSync(dir).filter((f) => /^aliasmode-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().pop();
      if (!name) return Response.json({ ok: false, error: "no log file yet" });
      const content = readFileSync(join(dir, name), "utf8");
      return Response.json({ ok: true, file: name, content: content.slice(-64 * 1024) });
    } catch {
      return Response.json({ ok: false, error: "log file could not be read" });
    }
  }

  if (pathname === "/ui/api/app-mode" && req.method === "GET") {
    const config = options.appConfig?.read() ?? { version: 1 as const, mode: "local" as const, localAnalytics: false };
    return Response.json({
      ...config,
      ...(remote ? { legacyRemote: true } : {}),
      ...(options.runtimeMode ? { restartRequired: config.mode !== options.runtimeMode } : {}),
      ...(hostChromiumRuntime() ? { chromiumRuntime: hostChromiumRuntime() } : {}),
      ...(!remote && supportsChromium155Host(process.platform, process.arch) ? { defaultChromiumRuntime: "aliasmode" } : {}),
      ...(!remote ? { defaultEngine: defaultProfileEngine(), webkitAvailable: webkitSupported() } : {}),
      ...(taskbarModeSupported() ? { taskbarModeSupported: true } : {}),
    });
  }

  if (pathname === "/ui/api/desktop/taskbar" && req.method === "POST") {
    if (!options.appConfig || !taskbarModeSupported()) return noStoreJson({ ok: false, error: "Not available on this computer" }, 404);
    const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
    if (typeof body.hidden !== "boolean") return noStoreJson({ ok: false, error: "hidden must be true or false" }, 400);
    const current = options.appConfig.read();
    const { hideFromTaskbar: _previous, ...rest } = current;
    const saved = options.appConfig.write(body.hidden ? { ...rest, hideFromTaskbar: true } : rest);
    await options.taskbarMode?.sweep();
    return noStoreJson({ ok: true, hidden: saved.hideFromTaskbar === true });
  }

  if (pathname === "/ui/api/shell-language" && req.method === "GET") {
    return noStoreJson({ language: readShellLanguage(options.paths) });
  }

  if (pathname === "/ui/api/shell-language" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { language?: unknown };
    const language = typeof body.language === "string" && SHELL_LANGUAGE_PATTERN.test(body.language)
      ? body.language
      : "en-US";
    try {
      writeShellLanguage(options.paths, language);
    } catch {
      return noStoreJson({ ok: false, error: "Could not save language preference" }, 500);
    }
    return noStoreJson({ ok: true, language });
  }

  // Browser runtimes downloading now, so the dashboard can show their progress.
  if (pathname === "/ui/api/runtime-downloads" && req.method === "GET") {
    return noStoreJson({ downloads: runtimeDownloads() });
  }

  if (pathname === "/ui/api/proxy/check" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) {
      rejected.headers.set("Cache-Control", "no-store");
      return rejected;
    }
    let proxy: ProxySpec;
    try {
      const body = await req.json() as { proxy?: unknown };
      if (!body || typeof body !== "object" || !body.proxy || typeof body.proxy !== "object" || Array.isArray(body.proxy)) {
        throw new Error("invalid proxy input");
      }
      const normalized = normalizeProxySpec(body.proxy as ProxyInput);
      if (!normalized || (normalized.type !== "http" && normalized.type !== "socks5")) {
        throw new Error("unsupported proxy input");
      }
      proxy = normalized;
    } catch {
      return noStoreJson({ ok: false, error: "Invalid proxy settings" }, 400);
    }
    try {
      const result = await (options.proxyCheck ?? runProxyCheck)(proxy);
      return noStoreJson({ ok: true, ...proxyCheckView(result) });
    } catch {
      return noStoreJson({ ok: false, error: "Proxy check failed" }, 500);
    }
  }

  if (pathname.startsWith("/ui/api/proxies/")) {
    if (remote) return noStoreJson({ ok: false, error: "Bulk proxy tools are unavailable in legacy remote mode" }, 400);
    if (req.method !== "POST") return noStoreJson({ ok: false, error: "POST is required" }, 405);
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;

    return handleProxyToolsRequest(req, store, launcher, options);
  }

  if (pathname === "/ui/api/trash" || pathname.startsWith("/ui/api/trash/")) {
    if (remote) return noStoreJson({ ok: false, error: "Trash is unavailable in legacy remote mode" }, 400);
    if (req.method !== "GET") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }

    return handleTrashRequest(req, store, launcher, options);
  }

  if (pathname === "/ui/api/profiles" && req.method === "GET") {
    try {

      if (remote) {
        // Remote mode: the roster is the hub's (with lock + session status); layer
        // on this machine's local running state. Probe live CDP ports first and drop
        // launch rows for browsers the user closed manually (or that crashed) — else
        // the row lingers and the profile shows "running" with a stale Close button.
        // remote.listRoster() then releases the now-orphaned hub lock for those.
        await launcher.reconcileOrphans();
        const roster = await remote.listRoster();
        const profiles = roster.profiles.map((p) => {
          const { debugPort: _debugPort, ...profile } = p as typeof p & { debugPort?: number };
          const l = store.getLaunch(p.id);
          const engine = profileEngine(p);
          return { ...profile, engine, running: !!l, ...(engine === "chromium" ? { debugPort: l?.debugPort } : {}) };
        });
        return Response.json({ profiles, healthSources: roster.healthSources });
      }
      // Probe live CDP ports and clear stale launch rows first: a crash or an
      // external debug-port teardown leaves the row in SQLite, which would
      // otherwise show "running" forever and hide the Open action. reconcileOrphans
      // probes active() per launch and drops dead rows (it never kills processes).
      await launcher.reconcileOrphans();
      return Response.json({ profiles: listUiProfiles(store), healthSources: [], groups: store.listGroups(), folders: store.listFolders() });
    } catch (error) {
      // Bun renders an uncaught route exception as an HTML 500 page. The React
      // client then cannot expose the actual hub/reconciliation error and only
      // sees "Unexpected token '<'". Keep this API JSON-shaped even on failure.
      return Response.json(
        { ok: false, error: `profile roster failed: ${msg(error)}` },
        { status: remote || undefined ? 502 : 500 },
      );
    }
  }

  if (pathname === "/ui/api/profiles" && req.method === "POST") {
    // Create a new profile: unique id → unique seed → unique fingerprint/UA.
    let uncertain = false;
    try {
      const input = (await req.json()) as NewProfileInput;
      if (remote && input.chromiumRuntime) throw new Error("Vela Chromium is unavailable in legacy Remote mode");
      if (remote) {
        uncertain = true;
        const { id } = await remote.createProfile(input);
        return Response.json({ ok: true, id });
      }
      const profile = buildNewProfile(input, (id) => !!store.getProfile(id));
      store.applyGroupExtensionDefaults(profile, null, false);
      // Best-effort: match the browser clock to the proxy's exit location. A
      // failed lookup keeps the host timezone.
      if (profile.proxy) {
        await attachTimezones([profile], options.timezoneFetch, true).catch(() => {});
        syncFirefoxTimezone(profile);
      }
      uncertain = true;
      const created = undefined;
      if (!created) store.upsertProfile(profile);
      // A download hint cannot turn a persisted creation into an apparent failure.
      try { launcher.prefetchFirefoxFontPacks?.([profile]); } catch {}
      return Response.json({ ok: true, ...(created ?? { id: profile.id }) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e), uncertain }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/profiles/move" && req.method === "POST") {
    try {
      const body = (await req.json()) as { ids?: unknown; group?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const group = typeof body.group === "string" ? body.group.trim() : "";
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });

      const moved = remote ? await remote.move(ids, group) : store.setGroup(ids, group);
      return Response.json({ ok: true, moved, group });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/profiles/delete" && req.method === "POST") {
    try {
      const body = (await req.json()) as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (ids.length === 0) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });

      if (remote) {
        const r = await remote.deleteProfiles(ids);
        return Response.json({ ok: true, ...r });
      }
      // Standalone deletion never closes a browser implicitly. Preflight the
      // full selection before mutation so a mixed open/closed batch is atomic.
      const existing = ids.filter((id) => store.getProfile(id));
      await Promise.all(existing.map((id) => launcher.cacheCleanupSettled(id)));
      const locked = existing.filter((id) => launcher.profileDeletionBlocked(id));
      if (locked.length > 0) {
        return Response.json({
          ok: false,
          error: "close open profiles before deleting them",
          deleted: 0,
          locked,
        }, { status: 409 });
      }
      let deleted = 0;
      for (const id of existing) {
        if (store.trashProfile(id)) deleted++;
      }
      return Response.json({ ok: true, deleted, locked: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import" && req.method === "POST") {
    // In remote mode the local inbox isn't the source of truth — importing there
    // would write to the local launch-cache, never reaching the hub roster.
    if (remote) return Response.json({ ok: false, error: "remote mode: import via the hub (upload in the dashboard)" }, { status: 400 });
    try {
      const r = await importInbox(store, options.paths?.inbox);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...r });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/import/upload" && req.method === "POST") {
    try {
      const form = await req.formData();
      const uploads: { name: string; bytes: Uint8Array }[] = [];
      const override = importOverridesFromForm(form);

      for (const [, value] of form) {
        if (value instanceof File) uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
      }
      if (uploads.length === 0) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });

      if (remote) {
        const result = await remote.importToHub(uploads, override);
        if (result.profiles === 0) {
          return Response.json(
            { ok: false, error: "the hub found no profiles in the uploaded export" },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, ...result });
      }
      const imported = await importBuffers(store, uploads, console.log, override, undefined, options.timezoneFetch);
      launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
      return Response.json({ ok: true, ...imported });
    } catch (error) {
      const status = error instanceof ProfileImportError
        ? error.status
        : error instanceof CloudApiError ? error.status
        : error instanceof CloudRequestError ? 502
        : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/export" && req.method === "POST") {
    if (remote) {
      return Response.json({ ok: false, error: "remote mode: export from the hub, not this launch cache" }, { status: 400 });
    }
    return Response.json({ ok: false, error: "export is not available" }, { status: 404 });
  }

  if (pathname === "/ui/api/diagnose/latest" && req.method === "GET") {
    return Response.json({ report: await readLatestDiagnose(options.paths?.reports) });
  }

  // Cloud exports fan out this many concurrent profile fetches. Big enough to
  // keep a 1,600-profile export moving, small enough not to open hundreds of
  // Cloud connections at once.
  const CLOUD_EXPORT_BATCH = 16;

  if (pathname === "/ui/api/profiles/export" && req.method === "POST") {
    // Export selected profiles for offline editing. Replies with the finished
    // file directly (not JSON) so the browser saves it; the dashboard opts into
    // `stream: true` for newline-delimited progress + file records instead.
    // Both formats carry `id` so the file can be re-uploaded through
    // /ui/api/profiles/update-file.
    let body: { ids?: unknown; format?: unknown; stream?: unknown };
    try {
      body = (await req.json()) as { ids?: unknown; format?: unknown; stream?: unknown };
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (ids.length === 0) {
      return Response.json({ ok: false, error: "select at least one profile to export" }, { status: 400 });
    }
    if (ids.some((id) => !isSafeProfileId(id))) {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (body.format !== "txt" && body.format !== "xlsx" && body.format !== "csv") {
      return Response.json({ ok: false, error: "format must be csv, txt, or xlsx" }, { status: 400 });
    }
    const format = body.format;
    // .txt and .xlsx are the full-fidelity forms: they carry cookies and the
    // user-agent, so they need the profile's secrets. .csv is the trimmed
    // credential view.
    const full = format !== "csv";

    try {
      // Collect the export rows from whichever store owns the profile. The
      // optional hooks exist for the streaming response below: `onProgress`
      // reports how many selected profiles are fully processed, and `aborted`
      // (a disconnected client) stops further batches instead of fetching a
      // file nobody is left to receive.
      const collectProfiles = async (
        onProgress: (completed: number) => void,
        aborted: () => boolean,
      ): Promise<ProfileExport[]> => {
        if (remote) {
          // The local store is only a launch cache in remote mode; the hub
          // reader keeps its own bounded fan-out and reports between batches.
          return remote.getProfiles(ids, full, (completed) => onProgress(completed));
        }

        const profiles: ProfileExport[] = [];
        let processed = 0;
        for (const id of ids) {
          if (aborted()) return profiles;
          const fresh = full && await launcher.captureLocalSession(id);
          const profile = store.getProfile(id);
          if (profile) {
            const sessionBundle = full ? store.getSessionBundle(id) ?? undefined : undefined;
            profiles.push({ ...profile, sessionBundle, sessionSource: fresh ? "live" : sessionBundle ? "saved" : "stored-cookies" });
          }
          onProgress(++processed);
        }
        return profiles;
      };

      const buildExportFile = async (profiles: ProfileExport[]): Promise<{ mime: string; bytes: Uint8Array }> => {
        if (format === "xlsx") {
          const { headers, rows } = serializeXlsxRows(profiles);
          return {
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            bytes: await writeXlsx(headers, rows),
          };
        }
        const text = format === "txt" ? serializeAdsTxt(profiles) : serializeCsv(profiles);
        return { mime: `${format === "txt" ? "text/plain" : "text/csv"}; charset=utf-8`, bytes: new TextEncoder().encode(text) };
      };

      if (body.stream !== true) {
        // Legacy single-response export: build everything, then reply with the
        // finished file in one piece.
        const { mime, bytes } = await buildExportFile(await collectProfiles(() => {}, () => false));
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "content-type": mime,
            "content-disposition": `attachment; filename=vela-export.${format}`,
            "cache-control": "no-store",
          },
        });
      }

      // Streaming export (dashboard): newline-delimited JSON records keep the
      // HTTP response alive while profiles are fetched — a 1,600-profile Cloud
      // export can run for minutes — then one file record delivers the bytes.
      // The connection staying active also sidesteps idle-timeout failure of a
      // single long-silent response.
      let clientGone = false;
      req.signal.addEventListener("abort", () => { clientGone = true; });
      const encoder = new TextEncoder();
      const records = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (record: unknown) => {
            if (clientGone) return;
            try {
              controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
            } catch {
              clientGone = true; // the client aborted between batches
            }
          };
          try {
            send({ type: "progress", completed: 0, total: ids.length });
            const profiles = await collectProfiles(
              (completed) => send({ type: "progress", completed, total: ids.length }),
              () => clientGone,
            );
            if (clientGone) return;
            const { mime, bytes } = await buildExportFile(profiles);
            send({ type: "file", mime, data: Buffer.from(bytes).toString("base64") });
          } catch (error) {
            send({ type: "error", error: msg(error) });
          } finally {
            try { controller.close(); } catch { /* already closed by cancel() */ }
          }
        },
        cancel() { clientGone = true; },
      });
      return new Response(records, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError || undefined ? 502 : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  if (pathname === "/ui/api/profiles/update-file" && req.method === "POST") {
    // File-based bulk update (AdsPower "Update profile"): re-upload an edited
    // export. Rows matched to existing profiles by `id`; only columns present in
    // the file change. Unknown ids reported, never created.
    if (remote) return Response.json({ ok: false, error: "remote mode: update via the hub" }, { status: 400 });
    try {
      const form = await req.formData();
      let updated = 0, skipped = 0;
      const notFound: string[] = [];
      const errors: Array<{ id: string; error: string }> = [];
      const pending = new Map<string, Profile>();
      const cloudPending = new Map<string, Record<string, string>>();
      const proxyChanged = new Set<string>();
      const applied: Array<{ id: string; set: Record<string, string> }> = [];
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const bytes = new Uint8Array(await value.arrayBuffer());
        // An .xlsx is a ZIP, so it is binary and starts "PK" — decoding it as
        // text would turn a spreadsheet into mojibake with no usable `id`
        // column and report the whole upload as zero rows changed.
        const isWorkbook = bytes[0] === 0x50 && bytes[1] === 0x4b;
        const summary = isWorkbook
          ? rowsToUpdates(await readXlsx(bytes))
          : parseUpdateFile(decodeText(bytes));
        skipped += summary.skipped;
        for (const u of summary.updates) {
          if (!isSafeProfileId(u.id)) {
            errors.push({ id: u.id, error: PROFILE_ID_ERROR });
            continue;
          }

          const p = pending.get(u.id) ?? store.getProfile(u.id);
          if (!p) { notFound.push(u.id); continue; }
          try {
            const previousGroup = p.group;
            if (applyEdits(p, u.set)) proxyChanged.add(u.id);
            store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in u.set);
            pending.set(u.id, p);
            applied.push(u);
          } catch (error) {
            errors.push({ id: u.id, error: msg(error) });
          }
        }
      }
      // Validate the entire upload before opening a transaction. A bad row
      // reports its id and leaves every otherwise-valid row untouched.
      if (errors.length) {
        return Response.json({ ok: false, updated: 0, skipped, notFound, errors }, { status: 400 });
      }

      // Open profiles change too. Their browsers keep the identity they launched with until the next start.
      // A new proxy gets its exit timezone. A failed lookup keeps the saved one.
      const located = [...proxyChanged]
        .map((id) => pending.get(id))
        .filter((profile): profile is Profile => !!profile?.proxy && !profile.timezoneManual)
        .map((profile) => ({ ...profile, timezone: "" }));
      if (located.length > 0) {
        await attachTimezones(located, options.timezoneFetch).catch(() => {});
        // Apply the rows again to current copies, so changes saved during the lookups are kept.
        pending.clear();
        for (const { id, set } of applied) {
          const p = pending.get(id) ?? store.getProfile(id);
          if (!p) continue;
          const previousGroup = p.group;
          applyEdits(p, set);
          store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
          pending.set(id, p);
        }
        for (const { id, timezone } of located) {
          const p = pending.get(id);
          if (p && timezone) {
            p.timezone = timezone;
            syncFirefoxTimezone(p);
          }
        }
      }
      store.upsertProfiles([...pending.values()]);
      updated = pending.size;
      return Response.json({ ok: true, updated, skipped, notFound, errors: [] });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/create" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { name?: unknown; parentName?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      if (name === "all") return Response.json({ ok: false, error: "group name is reserved" }, { status: 400 });
      const folder = store.createGroup(name, typeof body.parentName === "string" ? body.parentName : null);
      return Response.json({ ok: true, name: folder.name, folder });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/rename" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { from?: unknown; to?: unknown };
      const from = String(body.from ?? "").trim(), to = String(body.to ?? "").trim();
      if (!from || !to) return Response.json({ ok: false, error: "from and to group names required" }, { status: 400 });

      const source = store.listFolders().find((folder) => folder.name === from);
      const moved = store.renameGroup(from, to);
      const name = source?.parentName ? `${source.parentName}/${to}` : to;
      return Response.json({ ok: true, moved, folder: store.listFolders().find((folder) => folder.name === name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/move" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    try {
      const body = await req.json() as { name?: unknown; parentName?: unknown };
      if (typeof body.name !== "string" || (body.parentName !== null && typeof body.parentName !== "string")) {
        return Response.json({ ok: false, error: "name and parentName are required" }, { status: 400 });
      }
      return Response.json({ ok: true, folder: store.moveGroup(body.name, body.parentName) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
  }

  if (pathname === "/ui/api/groups/delete" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { name?: unknown };
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "group name required" }, { status: 400 });
      return Response.json({ ok: true, ungrouped: store.deleteGroup(name) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/groups/extensions" && (req.method === "GET" || req.method === "POST")) {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      if (req.method === "GET") {

        return Response.json({
          ok: true,
          groups: store.listGroupExtensionDefaults().map((group) => ({ ...group, permission: "edit" as const })),
        });
      }

      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
      const body = (await req.json()) as { group?: unknown; extensions?: unknown };
      const group = String(body.group ?? "").trim();
      const extensions = Array.isArray(body.extensions) ? body.extensions.map(String) : null;
      if (!group || !extensions) {
        return Response.json({ ok: false, error: "group and extensions are required" }, { status: 400 });
      }

      return Response.json({ ok: true, updatedCount: store.setGroupExtensionDefaults(group, extensions) });
    } catch (error) {
      const status = error instanceof CloudApiError
        ? error.status
        : error instanceof CloudRequestError ? 502 : 500;
      return Response.json({ ok: false, error: msg(error) }, { status });
    }
  }

  // --- Extensions registry (upload / list / delete) ---
  if (pathname === "/ui/api/extensions" && req.method === "GET") {
    return Response.json({ ok: true, extensions: store.listExtensions().map((e) => ({ id: e.id, name: e.name })) });
  }

  if (pathname === "/ui/api/extensions/web-store" && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    let source: string;
    let id: string;
    try {
      const body = (await req.json()) as { source?: unknown };
      source = String(body.source ?? "").trim();
      id = parseWebStoreExtensionId(source);
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 400 });
    }
    const existing = store.getExtension(id);
    if (existing) {
      return Response.json({
        ok: true,
        installed: { id: existing.id, name: existing.name },
        alreadyInstalled: true,
      });
    }
    try {
      const installed = await installWebStoreExtension(
        source,
        options.paths?.extensions,
        options.extensionFetch,
      );
      try {
        store.addExtension({ id, name: installed.name, loadDir: installed.loadDir });
      } catch (error) {
        removeExtensionFiles(id, options.paths?.extensions);
        throw error;
      }
      return Response.json({
        ok: true,
        installed: { id, name: installed.name },
        alreadyInstalled: false,
      });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/extensions/upload" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const form = await req.formData();
      const installed: Array<{ id: string; name: string }> = [];
      for (const [, value] of form) {
        if (!(value instanceof File)) continue;
        const id = "ext" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const bytes = new Uint8Array(await value.arrayBuffer());
        const fallback = value.name.replace(/\.(zip|crx)$/i, "");
        const { loadDir, name } = await installExtension(bytes, id, fallback, options.paths?.extensions);
        store.addExtension({ id, name, loadDir });
        installed.push({ id, name });
      }
      if (!installed.length) return Response.json({ ok: false, error: "no files uploaded" }, { status: 400 });
      return Response.json({ ok: true, installed });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  if (pathname === "/ui/api/extensions/delete" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { id?: unknown };
      const id = String(body.id ?? "").trim();
      if (!id) return Response.json({ ok: false, error: "extension id required" }, { status: 400 });
      const liveIds = store.listProfiles()
        .filter((profile) => profile.extensions?.includes(id) && store.getLaunch(profile.id))
        .map((profile) => profile.id);
      if (liveIds.length > 0) {
        return Response.json(
          { ok: false, error: `extension is assigned to open profile(s) ${liveIds.join(", ")}; close them before deleting it` },
          { status: 409 },
        );
      }
      store.unassignExtension(id); // drop it from any profile that had it
      store.deleteExtension(id);
      removeExtensionFiles(id, options.paths?.extensions);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Bulk assign / unassign one extension across many selected profiles.
  if (pathname === "/ui/api/profiles/extensions" && req.method === "POST") {
    if (remote) return Response.json({ ok: false, error: "remote mode: not supported" }, { status: 400 });
    try {
      const body = (await req.json()) as { ids?: unknown; extensionId?: unknown; op?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const extId = String(body.extensionId ?? "").trim();
      const add = body.op !== "remove";
      if (!ids.length || !extId) return Response.json({ ok: false, error: "ids and extensionId required" }, { status: 400 });
      const firefoxIds = ids.filter((id) => profileEngine(store.getProfile(id)) !== "chromium");
      if (firefoxIds.length > 0) {
        return Response.json({ ok: false, error: "Chrome extensions are unavailable for Firefox profiles" }, { status: 400 });
      }
      if (add && !store.getExtension(extId)) return Response.json({ ok: false, error: "unknown extension" }, { status: 404 });
      // An open browser loads the change at its next start.
      return Response.json({ ok: true, updated: store.assignExtension(ids, extId, add) });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  const timezoneRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/timezone$/);
  if (timezoneRoute && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (remote || undefined) {
      return Response.json({ ok: false, error: "timezone lookup is available for Local profiles only" }, { status: 400 });
    }
    try {
      const id = decodeURIComponent(timezoneRoute[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      const profile = store.getProfile(id);
      if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (profile.proxyError) return Response.json({ ok: false, error: "Fix or remove the invalid proxy before setting the timezone." }, { status: 400 });
      const location = await lookupExitLocation(profile.proxy, options.timezoneFetch);
      if (!location) return Response.json({ ok: false, error: "Could not determine the connection timezone. The saved timezone is unchanged." }, { status: 502 });
      const current = store.getProfile(id);
      if (!current || current.proxyError || JSON.stringify(current.proxy) !== JSON.stringify(profile.proxy)) {
        return Response.json({ ok: false, error: "Profile connection changed. Reopen Edit and try again." }, { status: 409 });
      }
      current.timezone = location.timezone;
      delete current.timezoneManual;
      current.locale = localeForCountry(location.country) ?? localeForTimezone(location.timezone);
      syncFirefoxTimezone(current);
      store.upsertProfile(current);
      return Response.json({ ok: true, timezone: current.timezone, locale: current.locale, ...restartRequired(store, id) });
    } catch (error) {
      return Response.json({ ok: false, error: msg(error) }, { status: 500 });
    }
  }

  // Add cookies to one profile (/profiles/<id>/cookies) or to the selected ones (/profiles/cookies).
  // An open browser gets them now. A closed profile keeps them and its next start sets them before
  // the first page opens: a Local profile in its pending list, a Cloud profile in its Cloud session.
  const cookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/cookies$/);
  if ((cookieRoute || pathname === "/ui/api/profiles/cookies") && req.method === "POST") {
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;

    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ ok: false, error: "invalid cookie request" }, { status: 400 });
    }
    let ids: string[];
    try {
      ids = cookieRoute ? [decodeURIComponent(cookieRoute[1]!)] : Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    } catch {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (!ids.length) return Response.json({ ok: false, error: "no profiles selected" }, { status: 400 });
    if (!ids.every(isSafeProfileId)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });

    let cookies: CookieRecord[];
    if (typeof body.text === "string") {
      try {
        cookies = parseCookieText(body.text);
      } catch (error) {
        return Response.json({ ok: false, error: msg(error) }, { status: 400 });
      }
    } else {
      const cookie = singleCookie(body);
      if (typeof cookie === "string") return Response.json({ ok: false, error: cookie }, { status: 400 });
      cookies = [cookie];
    }

    const setCookies = options.setCookies ?? defaultSetCookies;
    let live = 0;
    let nextStart = 0;
    const errors: Array<{ id: string; error: string; status: number }> = [];
    for (const id of ids) {
      try {
        const launch = store.getLaunch(id);
        if (launch) {
          if (!await launcher.certifiedActive(id).catch(() => false) || !store.getLaunch(id)?.ws) {
            errors.push({ id, error: "profile browser is not open", status: 409 });
            continue;
          }
          const engine = launch.engine ?? profileEngine(store.getProfile(id));
          try {
            await setCookies(store.getLaunch(id)!.ws, cookiesForEngine(cookies, engine));
          } catch {
            // The worker error can quote the cookie value.
            errors.push({ id, error: "cookie could not be added", status: 500 });
            continue;
          }
          live++;
        } else if (remote) {
          errors.push({ id, error: "profile browser is not open", status: 409 });
        } else {
          if (!store.getProfile(id)) {
            errors.push({ id, error: "no such profile", status: 404 });
            continue;
          }
          store.addPendingCookies(id, cookies);
          nextStart++;
        }
      } catch (error) {
        errors.push({ id, error: msg(error), status: 500 });
      }
    }
    if (cookieRoute) {
      const error = errors[0];
      if (error) return Response.json({ ok: false, error: error.error }, { status: error.status });
      return Response.json(live ? { ok: true, applied: "now", count: cookies.length } : { ok: true, applied: "next-start", count: cookies.length });
    }
    return Response.json({
      ok: errors.length === 0, count: cookies.length, live, nextStart,
      errors: errors.map(({ id, error }) => ({ id, error })),
    });
  }

  // Cookies a closed Local profile sets at its next start: list them (domain and name only) or remove them.
  const pendingCookieRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/pending-cookies(\/clear)?$/);
  if (pendingCookieRoute && (pendingCookieRoute[2] ? req.method === "POST" : req.method === "GET")) {
    if (req.method === "POST") {
      const rejected = rejectUntrustedJsonMutation(req);
      if (rejected) return rejected;
    }
    let id: string;
    try {
      id = decodeURIComponent(pendingCookieRoute[1]!);
    } catch {
      return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    }
    if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
    if (!store.getProfile(id)) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    const pending = store.getPendingCookies(id);
    if (pendingCookieRoute[2]) {
      store.clearPendingCookies(id, pending);
      return Response.json({ ok: true, removed: pending.length });
    }
    return noStoreJson({ ok: true, cookies: pending.map(({ domain, name }) => ({ domain, name })) });
  }

  const auditRoute = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/fingerprint-audit$/);
  if (auditRoute && (req.method === "GET" || req.method === "POST")) {
    if (remote) return noStoreJson({ ok: false, error: "Fingerprint measurement requires a browser on this device" }, 400);
    let id: string;
    try { id = decodeURIComponent(auditRoute[1]!); } catch { return noStoreJson({ ok: false, error: PROFILE_ID_ERROR }, 400); }
    if (!isSafeProfileId(id)) return noStoreJson({ ok: false, error: PROFILE_ID_ERROR }, 400);
    const profile = store.getProfile(id);
    if (!profile) return noStoreJson({ ok: false, error: "no such profile" }, 404);
    if (req.method === "GET") return noStoreJson({ ok: true, audit: fingerprintAudit(profile) });
    const rejected = rejectUntrustedJsonMutation(req);
    if (rejected) return rejected;
    if (!await launcher.certifiedActive(id).catch(() => false)) return noStoreJson({ ok: false, error: "profile browser is not open" }, 409);
    try { return noStoreJson({ ok: true, audit: await launcher.refreshFingerprint(id) }); }
    catch { return noStoreJson({ ok: false, error: "Fingerprint measurement could not complete. Reopen this browser and try again." }, 409); }
  }

  // Open the Vela Browser fingerprint test in a new tab of a running profile. Only these pages can be opened.
  const fingerprintCheck = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/check-fingerprint$/);
  if (fingerprintCheck && req.method === "POST") {
    const id = decodeURIComponent(fingerprintCheck[1]!);
    const body = await req.json().catch(() => ({})) as { page?: unknown };
    const pages: Record<string, string> = {
      en: "https://github.com/accomplish07zrh-eng/vela-browser/check/",
      ru: "https://github.com/accomplish07zrh-eng/vela-browser/ru/fingerprint-test/",
      "zh-cn": "https://github.com/accomplish07zrh-eng/vela-browser/zh-cn/fingerprint-test/",
    };
    const url = pages[typeof body.page === "string" ? body.page : "en"] ?? pages.en!;
    if (!await launcher.certifiedActive(id).catch(() => false)) {
      return Response.json({ ok: false, error: "profile browser is not open" }, { status: 409 });
    }
    const launch = store.getLaunch(id);
    if (!launch?.ws) {
      return Response.json({ ok: false, error: "profile browser is not open" }, { status: 409 });
    }
    try {
      await launcher.navigate(launch.ws, [url], false);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Bring a running profile's browser window to the foreground.
  const raise = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/raise$/);
  if (raise && req.method === "POST") {
    // Raising the window is a purely LOCAL operation (the browser runs on this operator in both
    // modes; bringToFront uses the local launch record + CDP), so it works in remote mode too.
    try {
      const id = decodeURIComponent(raise[1]!);
      if (profileEngine(store.getProfile(id)) === "firefox") {
        return Response.json({ ok: false, error: "bringing a Firefox profile to the front is unavailable" }, { status: 400 });
      }
      await launcher.bringToFront(id);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: msg(e) }, { status: 500 });
    }
  }

  // Live 2FA code (TOTP) for a profile — the authenticator. Returns only the
  // current code (never the secret), so the redacted list can offer quick-copy.
  const totp = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/totp$/);
  if (totp && req.method === "GET") {
    const p = store.getProfile(decodeURIComponent(totp[1]!));
    if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    const r = generateTotp(p.twofa ?? "");
    if (!r) return Response.json({ ok: true, code: null });
    return Response.json({ ok: true, code: r.code, secondsRemaining: r.secondsRemaining, period: r.period });
  }

  // Single-profile edit detail (WITH secrets) for the Edit modal.
  const single = pathname.match(/^\/ui\/api\/profiles\/([^/]+)$/);
  if (single && req.method === "GET") {
    const id = decodeURIComponent(single[1]!);

    const p = remote
      ? await remote.getProfile(id).catch(() => null)
      : store.getProfile(id);
    if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    return Response.json({ ok: true, profile: profileEditView(p) });
  }

  // Apply edits to one profile (Edit modal save).
  const upd = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/update$/);
  if (upd && req.method === "POST") {
    try {
      const id = decodeURIComponent(upd[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });

      const body = (await req.json()) as { set?: unknown };
      const set = body.set && typeof body.set === "object" ? (body.set as Record<string, unknown>) : {};
      // Every field saves now, also while the browser is open. That browser keeps the identity it
      // launched with; a changed proxy or fingerprint applies at its next start.
      let p = remote ? await remote.getProfile(id).catch(() => null) : store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      let previousGroup = p.group;
      const proxyChanged = applyEdits(p, set);
      // A new proxy gets its exit timezone, like a Cloud edit. A failed lookup keeps the saved one.
      if (!remote && proxyChanged && p.proxy && !("timezone" in set) && !p.timezoneManual) {
        const location = await lookupExitLocation(p.proxy, options.timezoneFetch);
        // Apply the edit to the current copy, so changes saved during the lookup are kept.
        p = store.getProfile(id);
        if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
        previousGroup = p.group;
        applyEdits(p, set);
        if (location) {
          p.timezone = location.timezone;
          syncFirefoxTimezone(p);
        }
      }
      if (!remote) store.applyGroupExtensionDefaults(p, previousGroup, "extensions" in set);
      if (remote) await remote.saveProfile(p);
      else {
        store.upsertProfile(p);
        if ("timezone" in set) store.setTimezone(id, p.timezone);
        if ("cores" in set) store.setHardware(id, p.hardware);
      }
      return Response.json({ ok: true, ...(remote ? {} : restartRequired(store, id)) });
    } catch (e) {
      return Response.json(
        { ok: false, error: msg(e) },
        { status: 500 },
      );
    }
  }

  // Explicit one-time migration for imported mobile personas. Vela Browser cannot
  // reproduce a phone/tablet coherently with its desktop kernel, but the
  // account/session data remains useful. Preserve it while replacing only the
  // impossible device claim with the closest stable desktop persona.
  const convertMobile = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/convert-mobile$/);
  if (convertMobile && req.method === "POST") {
    try {
      const id = decodeURIComponent(convertMobile[1]!);
      if (!isSafeProfileId(id)) return Response.json({ ok: false, error: PROFILE_ID_ERROR }, { status: 400 });
      const p = remote ? await remote.getProfile(id).catch(() => null) : store.getProfile(id);
      if (!p) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
      if (!isMobileUserAgent(p.ua)) {
        return Response.json({ ok: true, changed: false });
      }
      if (!remote && store.getLaunch(id)) {
        return Response.json(
          { ok: false, error: "profile is currently open; close it before converting its device persona" },
          { status: 409 },
        );
      }
      const conversion = convertMobilePersonaToDesktop(p);
      if (remote) await remote.saveProfile(conversion.profile);
      else store.upsertProfile(conversion.profile);
      return Response.json({
        ok: true,
        changed: true,
        platform: conversion.platform,
        resolution: `${conversion.profile.screenWidth}x${conversion.profile.screenHeight}`,
        screenChanged: conversion.screenChanged,
      });
    } catch (e) {
      const error = msg(e);
      const status = /currently open|in use/i.test(error) ? 409 : 500;
      return Response.json({ ok: false, error }, { status });
    }
  }

  const action = pathname.match(/^\/ui\/api\/profiles\/([^/]+)\/(open|close|clear-cache)$/);
  if (action && req.method === "POST") {
    const id = decodeURIComponent(action[1]!);

    if (remote) {
      try {
        if (action[2] === "open") {
          const force = new URL(req.url).searchParams.get("force") === "1";
          const profile = remote.getProfile
            ? await remote.getProfile(id).catch(() => null)
            : null;
          const r = await remote.open(id, [], force);
          if (r.ok) return openResponse(profile, r);
          return Response.json(
            { ok: false, error: r.lockedBy ? `in use by ${r.lockedBy}` : (r.error ?? "open failed"), lockedBy: r.lockedBy },
            { status: r.lockedBy ? 409 : 500 },
          );
        }
        if (action[2] === "close") {
          return (await remote.close(id))
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
        }
        return Response.json({ ok: true }); // clear-cache: not applicable in remote mode
      } catch (e) {
        return Response.json({ ok: false, error: msg(e) }, { status: 500 });
      }
    }
    const profile = store.getProfile(id);
    if (!profile) return Response.json({ ok: false, error: "no such profile" }, { status: 404 });
    try {
      if (action[2] === "open") {
        const r = await launcher.start(id);
        return openResponse(profile, r);
      }
      if (action[2] === "close") {
        const launch = store.getLaunch(id);
        await launcher.captureLocalSession(id);
        return (await launcher.stop(id, launch ?? undefined))
          ? Response.json({ ok: true })
          : Response.json({ ok: false, error: "browser teardown unconfirmed" }, { status: 500 });
      }
      const r = await launcher.clearCache(id);
      return Response.json({ ok: true, cleared: r.cleared });
    } catch (e) {
      // A preflight refusal says what happened and what to do instead of its bare code.
      return Response.json({ ok: false, error: e instanceof BrowserLaunchError && e.guidance ? e.guidance : msg(e) }, { status: 500 });
    }
  }

  return Response.json({ error: `unknown ui route: ${pathname}` }, { status: 404 });
}

function importOverridesFromForm(form: FormData): ImportOverrides {
  const override: ImportOverrides = {};
  const group = form.get("group");
  if (typeof group === "string" && group.trim()) override.group = group.trim();
  const platform = form.get("platform");
  if (typeof platform === "string" && platform.trim()) override.platform = platform.trim();
  return override;
}

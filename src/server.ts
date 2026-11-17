/**
 * AdsPower-shaped HTTP facade over the CloakBrowser Launcher.
 *
 * Automation clients can use this exactly as they use AdsPower's local API — same
 * routes, same JSON envelope — so `startAdsPowerProfile(profileId, baseUrl)`
 * works unchanged when `baseUrl` points here. The shapes below are dictated by
 * what src/browser.ts parses:
 *   start  -> data.data.ws.puppeteer, data.data.debug_port
 *   active -> data.data.status === "Inactive"
 *   status -> data.code === 0 (health)
 */

import { webkitPublicFields } from "./browser-capabilities.ts";
import { AUTOMATION_SCOPE_DENIED, type LocalAutomationScope } from "./ai-access.ts";
import type { Launcher } from "./launcher.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import type { CloudBrowserLifecycle } from "./cloud-browser.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import {
  LifecycleAdmissionError,
  normalizeProfileIds,
  type LifecycleAdmissionController,
  type LifecycleState,
} from "./lifecycle-admission.ts";
import { harvestCookies, keepUnreadableOrigins, parseCapturedSessionBundle, sessionCaptureSeed, workerCaptureSeed } from "./session.ts";
import { isSafeProfileId } from "./profile-id.ts";
import type { AutomationHealthEntry } from "./remote-types.ts";

function ok(data?: unknown) {
  return Response.json({ code: 0, msg: "success", data: data ?? {} });
}
function fail(msg: string) {
  return Response.json({ code: -1, msg, data: {} });
}

const FIREFOX_CAPABILITIES = ["firefox-native", "cookies", "navigation", "sessions", "mcp", "scripts"] as const;

type FirefoxLaunch = { engine?: "chromium" | "firefox"; firefoxOwner?: FirefoxOwner };

function isFirefoxEngine(launch: unknown): launch is FirefoxLaunch & { engine: "firefox" } {
  return (launch as FirefoxLaunch | null)?.engine === "firefox";
}

function isFirefoxLaunch(launch: unknown): launch is FirefoxLaunch & { engine: "firefox"; firefoxOwner: FirefoxOwner } {
  return isFirefoxEngine(launch) && !!launch.firefoxOwner;
}

function firefoxPublicFields() {
  return { engine: "firefox" as const, capabilities: FIREFOX_CAPABILITIES };
}

async function captureFirefoxSession(store: ProfileStore, profileId: string, owner: FirefoxOwner): Promise<void> {
  try {
    const captureSeed = sessionCaptureSeed(store.getSessionBundle(profileId) ?? "");
    const bundle = keepUnreadableOrigins(await callFirefoxOwner<string>(owner, "session-capture", {
      captureSeed: workerCaptureSeed(captureSeed),
    }), captureSeed.saved);
    parseCapturedSessionBundle(bundle);
    const current = store.getLaunch(profileId);
    if (isFirefoxLaunch(current) && current.firefoxOwner.generation === owner.generation) {
      store.saveSessionBundle(profileId, bundle);
    }
  } catch {
    // Preserve the last saved session when capture cannot be confirmed.
  }
}

export interface BrowserLifecycleContext {
  admission?: LifecycleAdmissionController;
  remote?: Pick<RemoteCoordinator, "lifecycleState" | "publishAutomationHealthSnapshot">;
  automationScope?: LocalAutomationScope;
}

function currentLifecycle(profileId: string, lifecycle?: BrowserLifecycleContext): LifecycleState | null {
  const states = [
    lifecycle?.admission?.lifecycleState(profileId),
    lifecycle?.remote?.lifecycleState(profileId),
  ];
  if (states.includes("stopping")) return "stopping";
  if (states.includes("uncertain")) return "uncertain";
  return states.includes("starting") ? "starting" : null;
}

async function activeResponse(
  profileId: string,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
  v2 = false,
): Promise<Response> {
  const beforeState = currentLifecycle(profileId, lifecycle);
  if (beforeState) return ok({ status: "Active", lifecycle: beforeState });

  // Durable ownership is intentionally checked before certification. In the
  // confirmed-absence case there is nothing to probe or wait behind.
  if (!store.getLaunch(profileId)) return ok({ status: "Inactive" });

  const alive = await launcher.certifiedActive(profileId).catch(() => false);
  const afterState = currentLifecycle(profileId, lifecycle);
  if (afterState) return ok({ status: "Active", lifecycle: afterState });

  const launch = store.getLaunch(profileId);
  if (alive && launch?.engine === "webkit") return ok({ status: "Active", lifecycle: "running", ...webkitPublicFields() });
  if (alive && isFirefoxEngine(launch)) {
    return ok({ status: "Active", lifecycle: "running", ...firefoxPublicFields() });
  }
  if (alive && launch?.ws) {
    const connection = v2 ? await v2ChromiumConnection(profileId, launch.ws, launch.debugPort, launcher, false)
      : { ws: { puppeteer: launch.ws, selenium: "" } };
    const pending = currentLifecycle(profileId, lifecycle);
    if (pending) return ok({ status: "Active", lifecycle: pending });
    if (store.getLaunch(profileId)?.ws === launch.ws) return ok({ status: "Active", lifecycle: "running", ...connection });
    return store.getLaunch(profileId) ? ok({ status: "Active", lifecycle: "uncertain" }) : ok({ status: "Inactive" });
  }
  // Certification can fail while ownership-safe teardown remains unconfirmed.
  // Keep that durable generation visible without exposing an uncertified CDP URL.
  if (launch) return ok({ status: "Active", lifecycle: "uncertain" });
  return ok({ status: "Inactive" });
}

function parseLaunchArgs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

type V2BrowserAction = "start" | "stop" | "active";
interface V2BrowserOptions { launchArgs: string[]; headless?: boolean }

function v2BrowserAction(pathname: string): V2BrowserAction | undefined {
  if (pathname === "/api/v2/browser-profile/start") return "start";
  if (pathname === "/api/v2/browser-profile/stop") return "stop";
  if (pathname === "/api/v2/browser-profile/active") return "active";
}

async function handleV2BrowserControl(
  req: Request,
  action: V2BrowserAction,
  resolveProfileNo: (number: string) => string[] | Promise<string[]>,
  lifecycle: BrowserLifecycleContext | undefined,
  run: (profileId: string, options: V2BrowserOptions) => Promise<Response>,
): Promise<Response> {
  const requiredMethod = action === "active" ? "GET" : "POST";
  if (req.method !== requiredMethod) return fail("expected " + requiredMethod);
  const body: unknown = action === "active"
    ? Object.fromEntries(new URL(req.url).searchParams)
    : await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid JSON body");
  const params = body as Record<string, unknown>;
  const { profile_id, profile_no } = params;
  let profileId = typeof profile_id === "string" ? profile_id.trim() : "";
  if (profile_id != null && typeof profile_id !== "string") return fail("profile_id must be a string");
  if (!profileId) {
    const number = typeof profile_no === "string" ? profile_no.trim()
      : Number.isSafeInteger(profile_no) ? String(profile_no) : "";
    if (!number) return fail("provide profile_id or profile_no");
    let matches: string[];
    try { matches = await resolveProfileNo(number); }
    catch { return fail("Could not resolve profile_no"); }
    if (matches.length !== 1) return fail("profile_no is unavailable or ambiguous. Use profile_id");
    profileId = matches[0]!;
  }
  if (!isSafeProfileId(profileId)) return fail("invalid profile_id");
  const options: V2BrowserOptions = { launchArgs: [] };
  if (action === "start") {
    if (params.headless === "1" || params.headless === 1) options.headless = true;
    else if (params.headless === "0" || params.headless === 0) options.headless = false;
    else if (params.headless !== undefined) return fail("headless must be 0 or 1");
    if (params.launch_args !== undefined) {
      if (!Array.isArray(params.launch_args) || !params.launch_args.every(arg => typeof arg === "string")) {
        return fail("launch_args must be a list of strings");
      }
      options.launchArgs = params.launch_args;
    }
  }
  const allowed = () => lifecycle?.automationScope?.allowsProfile(profileId) ?? true;
  if (!allowed()) return fail(AUTOMATION_SCOPE_DENIED);
  const dispatch = () => allowed() ? run(profileId, options) : Promise.resolve(fail(AUTOMATION_SCOPE_DENIED));
  try {
    if (action === "active" || !lifecycle?.admission) return await dispatch();
    // Use the resolved profile ID so v1, v2 and dashboard requests share the same lifecycle lane.
    return await lifecycle.admission.run({ kind: action, profileIds: [profileId], signal: req.signal }, dispatch);
  } catch (error) {
    if (error instanceof LifecycleAdmissionError) return fail(error.message + ". Request was not dispatched");
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function v2ChromiumConnection(profileId: string, ws: string, port: number, launcher: Launcher, download: boolean) {
  const webdriver = await launcher.chromeDriverPath?.(profileId, download);
  return {
    ws: { puppeteer: ws, selenium: Number.isInteger(port) && port >= 1 && port <= 65535 ? "127.0.0.1:" + port : "" },
    debug_port: String(port), webdriver: webdriver ?? "",
  };
}

async function startLocalBrowser(profileId: string, launcher: Launcher, store: ProfileStore, launchArgs: string[], headless?: boolean, v2 = false) {
  if (!store.getProfile(profileId)) return fail("no such profile: " + profileId);
  try {
    const { ws, port } = headless === undefined ? await launcher.start(profileId, launchArgs)
      : await launcher.start(profileId, launchArgs, { headless });
    const launch = store.getLaunch(profileId);
    if (launch?.engine === "webkit" || ws.startsWith("webkit://")) return ok(webkitPublicFields());
    if (isFirefoxEngine(launch) || ws.startsWith("firefox://")) return ok(firefoxPublicFields());
    if (v2) return ok(await v2ChromiumConnection(profileId, ws, port, launcher, true));
    return ok({ ws: { puppeteer: ws, selenium: "" }, debug_port: String(port), webdriver: "" });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function stopLocalBrowser(profileId: string, launcher: Launcher, store: ProfileStore): Promise<Response> {
  const launch = store.getLaunch(profileId);
  if (isFirefoxEngine(launch)) {
    if (isFirefoxLaunch(launch)) await captureFirefoxSession(store, profileId, launch.firefoxOwner);
  } else await launcher.captureLocalSession(profileId);
  return await launcher.stop(profileId, launch ?? undefined) ? ok() : fail("browser teardown unconfirmed: " + profileId);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function healthSnapshotEntries(value: unknown): AutomationHealthEntry[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["profiles"]) || !Array.isArray(body.profiles)) return null;
  const profiles: AutomationHealthEntry[] = [];
  for (const value of body.profiles) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const profile = value as Record<string, unknown>;
    if (!exactKeys(profile, ["profileId", "suspended"])) return null;
    if (typeof profile.profileId !== "string" || !isSafeProfileId(profile.profileId)) return null;
    if (typeof profile.suspended !== "boolean") return null;
    profiles.push({ profileId: profile.profileId, suspended: profile.suspended });
  }
  return profiles;
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  return !!address && (address.startsWith("127.") || address === "::1" || address.startsWith("::ffff:127."));
}

export function isAllowedHealthOrigin(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export async function handleAutomationHealthSnapshot(
  req: Request,
  remote: Pick<RemoteCoordinator, "publishAutomationHealthSnapshot">,
): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }
  const contentType = (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ ok: false, error: "content-type must be application/json" }, { status: 415 });
  }
  if (!isAllowedHealthOrigin(req.headers.get("origin"))) {
    return Response.json({ ok: false, error: "non-local origin forbidden" }, { status: 403 });
  }
  const profiles = healthSnapshotEntries(await req.json().catch(() => null));
  if (!profiles) {
    return Response.json(
      { ok: false, error: "body must be exactly { profiles: [{ profileId, suspended }] }" },
      { status: 400 },
    );
  }
  try {
    const counts = await remote.publishAutomationHealthSnapshot(profiles);
    return Response.json({ ok: true, ...counts });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

/** Handle one request. Exposed so the dashboard server (web.ts) and tests can call it directly. */
export async function handleRequest(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;
  const v2Action = v2BrowserAction(pathname);
  if (v2Action) {
    return handleV2BrowserControl(req, v2Action, number => store.profileIdsByDisplayNo(number), lifecycle, (profileId, options) => {
      if (v2Action === "start") return startLocalBrowser(profileId, launcher, store, options.launchArgs, options.headless, true);
      if (v2Action === "stop") return stopLocalBrowser(profileId, launcher, store);
      return activeResponse(profileId, launcher, store, lifecycle, true);
    });
  }
  const userId = searchParams.get("user_id") ?? "";
  const scope = lifecycle?.automationScope;
  if (scope && userId && (isAdsPowerBrowserControl(pathname) || pathname === "/api/v1/browser/cookies") && !scope.allowsProfile(userId)) {
    return fail(AUTOMATION_SCOPE_DENIED);
  }

  if (pathname === "/api/xactions/health-snapshot") {
    if (!lifecycle?.remote) {
      return Response.json({ ok: false, error: "remote hub is not configured" }, { status: 503 });
    }
    return handleAutomationHealthSnapshot(req, lifecycle.remote);
  }

  // `/status` is the path AdsPower's own local API serves; `/api/v1/status`
  // is accepted for compatibility, so any AdsPower REST client is a base-URL flip.
  if (pathname === "/api/v1/status" || pathname === "/status") {
    return lifecycle?.admission
      ? ok({ admission: lifecycle.admission.stats() })
      : ok();
  }

  if (pathname === "/api/v1/browser/start") {
    if (!userId) return fail("missing user_id");
    return startLocalBrowser(userId, launcher, store, parseLaunchArgs(searchParams.get("launch_args")));
  }

  if (pathname === "/api/v1/browser/stop") {
    if (!userId) return fail("missing user_id");
    return stopLocalBrowser(userId, launcher, store);
  }

  // Cookie harvest is an Vela Browser extension to the AdsPower API. The browser
  // can reject raw CDP cookie reads, so this route uses Playwright's
  // context.cookies() and returns the result as JSON.
  //   GET /api/v1/browser/cookies?user_id=<id>&urls=https://x.com,https://twitter.com
  //   -> { code:0, data:{ cookies:[{name,value,domain,path,httpOnly,secure,expires,sameSite}, ...] } }
  if (pathname === "/api/v1/browser/cookies") {
    if (!userId) return fail("missing user_id");
    if (!(await launcher.certifiedActive(userId))) return fail(`profile not safely running: ${userId}`);
    const launch = store.getLaunch(userId);
    if (!launch) return fail(`profile not running: ${userId}`);
    const urlsParam = searchParams.get("urls");
    const urls = urlsParam
      ? urlsParam.split(",").map((u) => u.trim()).filter(Boolean)
      : ["https://x.com", "https://twitter.com"];
    try {
      const cookies = isFirefoxEngine(launch)
        ? isFirefoxLaunch(launch)
          ? await callFirefoxOwner(launch.firefoxOwner, "cookie-harvest", { urls })
          : (() => { throw new Error("Firefox owner is unavailable"); })()
        : launch.ws ? await harvestCookies(launch.ws, urls) : (() => { throw new Error("profile not running"); })();
      return ok({ cookies });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  if (pathname === "/api/v1/browser/active") {
    if (!userId) return fail("missing user_id");
    return activeResponse(userId, launcher, store, lifecycle);
  }

  if (pathname === "/api/v2/browser-profile/delete-cache") {
    // Compatibility clients may fire-and-forget this after each session:
    //   POST { profile_id: [id], type: ["image_file"] }
    // Trim the profile's disk caches so user-data dirs don't grow unbounded.
    let ids: string[] = [];
    try {
      const body = (await req.json()) as { profile_id?: unknown };
      ids = normalizeProfileIds(body?.profile_id);
    } catch {
      /* missing/invalid body → nothing to clear */
    }
    if (scope && ids.some((id) => !scope.allowsProfile(id))) return fail(AUTOMATION_SCOPE_DENIED);
    for (const id of ids) await launcher.clearCache(id);
    return ok();
  }

  return fail(`unknown route: ${pathname}`);
}

/**
 * True for the AdsPower browser-control routes that remote mode must NOT serve
 * locally — doing so would bypass hub session roaming and writer coordination.
 * `status` and `delete-cache` are intentionally excluded (safe to pass through).
 */
export function isAdsPowerBrowserControl(pathname: string): boolean {
  return !!v2BrowserAction(pathname) || /^\/api\/v1\/browser\/(start|stop|active)$/.test(pathname);
}

/**
 * Remote-mode AdsPower control: serve compatible start/stop/active calls through
 * the coordinator so launches restore the roamed session. A competing writer
 * produces a successful launch with a warning; only the lease owner checkpoints
 * the session. Same wire shapes as handleRequest, so clients work unchanged.
 */
export async function handleRemoteBrowserControl(
  req: Request,
  coord: RemoteCoordinator,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const v2Action = v2BrowserAction(pathname);
  if (v2Action) {
    const resolveProfileNo = async (number: string) => (await coord.listProfiles())
      .filter((_, index) => String(index + 1) === number).map(profile => profile.id);
    return handleV2BrowserControl(req, v2Action, resolveProfileNo, lifecycle, async (profileId, { launchArgs, headless }) => {
      if (v2Action === "start") {
        const opened = await coord.open(profileId, launchArgs, false, headless === undefined ? {} : { headless });
        if (!opened.ok || !opened.ws || opened.port === undefined) {
          return fail(opened.lockedBy ? "in use by " + opened.lockedBy : opened.error ?? "open failed");
        }
        if (opened.ws.startsWith("firefox://")) return ok({ ...firefoxPublicFields(), ...(opened.warning ? { warning: opened.warning } : {}) });
        if (opened.ws.startsWith("webkit://")) return ok({ ...webkitPublicFields(), ...(opened.warning ? { warning: opened.warning } : {}) });
        return ok({ ...await v2ChromiumConnection(profileId, opened.ws, opened.port, launcher, true),
          ...(opened.warning ? { warning: opened.warning } : {}) });
      }
      if (v2Action === "stop") return await coord.close(profileId) ? ok() : fail("browser teardown unconfirmed: " + profileId);
      return activeResponse(profileId, launcher, store, { ...lifecycle, remote: coord }, true);
    });
  }
  const userId = searchParams.get("user_id") ?? "";
  if (!userId) return fail("missing user_id");

  // A thrown error here (hub unreachable, token revoked, unknown profile —
  // coord.open() throws on a failed hub call before it can return {ok:false})
  // must NOT bubble as a 500/non-JSON: startAdsPowerProfile() parses the body
  // and code unconditionally, so it has to be a clean AdsPower {code:-1}.
  try {
    if (pathname === "/api/v1/browser/start") {
      const r = await coord.open(userId, parseLaunchArgs(searchParams.get("launch_args")));
      if (r.ok) {
        return ok({
          ws: { puppeteer: r.ws, selenium: "" },
          debug_port: String(r.port),
          webdriver: "",
          ...(r.warning ? { warning: r.warning } : {}),
        });
      }
      return fail(r.lockedBy ? `in use by ${r.lockedBy}` : (r.error ?? "open failed"));
    }
    if (pathname === "/api/v1/browser/stop") {
      return (await coord.close(userId))
        ? ok()
        : fail(`browser teardown unconfirmed: ${userId}`);
    }
    return activeResponse(userId, launcher, store, {
      ...lifecycle,
      remote: coord,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Cloud-mode AdsPower control backed by the same lifecycle used by the dashboard. */
export async function handleCloudBrowserControl(
  req: Request,
  cloudBrowser: CloudBrowserLifecycle,
  launcher: Launcher,
  store: ProfileStore,
  lifecycle?: BrowserLifecycleContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id") ?? "";
  if (!userId) return fail("missing user_id");

  try {
    if (pathname === "/api/v1/browser/start") {
      const result = await cloudBrowser.open(userId, parseLaunchArgs(searchParams.get("launch_args")));
      if (!result.ok) return fail(result.error ?? "open failed");
      if (!result.ws || result.port === undefined) return fail("open returned no browser connection");
      return ok({
        ws: { puppeteer: result.ws, selenium: "" },
        debug_port: String(result.port),
        webdriver: "",
        ...(result.warning ? { warning: result.warning } : {}),
      });
    }
    if (pathname === "/api/v1/browser/stop") {
      return (await cloudBrowser.close(userId)).closed
        ? ok()
        : fail(`browser teardown unconfirmed: ${userId}`);
    }
    return activeResponse(userId, launcher, store, lifecycle);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

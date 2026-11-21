/**
 * AdsPower-compatible PROFILE MANAGEMENT facade (`/api/v1/group/list`,
 * `/api/v1/group/create`, `/api/v1/user/{list,create,delete,update}`).
 *
 * server.ts covers AdsPower's browser-control routes (the only ones automation
 * needs). This module covers the lifecycle routes a full AdsPower REST client
 * uses — e.g. the Python profile-create-login tool — so that tool migrates to
 * aliasmode by repointing its base URL alone, no client rewrite.
 *
 * Served in BOTH modes. Standalone: against the local store. Remote (HUB_URL set):
 * create/list/delete/group route through the hub coordinator — the same central
 * roster the dashboard and automation use — so a hub-connected box stays the single
 * source of truth (creating against the local launch cache would silently diverge).
 *
 * Shapes are dictated by what the Python client (adspower_api.py) parses:
 *   group/list  -> data.list[].{group_id, group_name}
 *   user/list   -> data.list[].{user_id, name, created_time, last_open_time, serial_number}
 *   user/create -> data.id
 *   user/delete -> code === 0
 *   user/update -> code === 0 (name, credentials and user_proxy_config are each optional)
 */

import { profileDisplayNo, type Launcher } from "./launcher.ts";
import { AUTOMATION_SCOPE_DENIED, type LocalAutomationScope } from "./ai-access.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { CookieRecord, Profile, ProxySpec } from "./types.ts";
import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { attachTimezones, lookupExitLocation } from "./geoip.ts";
import { normalizeProxySpec, proxyIdentityKey } from "./proxy.ts";
import { setFirefoxScreen, syncFirefoxTimezone } from "./firefox-config.ts";
import { isSafeProfileId } from "./profile-id.ts";
import { isValidProfileName } from "./profile-validation.ts";
import { localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { mergeCookies, parseCookieText, parseStartupUrls, parseStrictResolution, parseStrictTimezone } from "./parse.ts";
import { createWebKitProfileConfig } from "./webkit-config.ts";

/** Best-effort geoip fetch, injectable for tests; defaults to real ip-api.com. */
type GeoipFetch = (url: string, init: RequestInit) => Promise<{ json(): Promise<any> }>;

function ok(data?: unknown) {
  return Response.json({ code: 0, msg: "success", data: data ?? {} });
}
function fail(msg: string) {
  return Response.json({ code: -1, msg, data: {} });
}

/**
 * AdsPower's default/un-grouped bucket is id "0"; aliasmode stores ungrouped
 * profiles with an empty label. Map both "0" and "" to "" on the way in/out so
 * create→list round-trips and group filtering stay symmetric.
 */
/** Authoritative roster, with optional Cloud folder and profile creation operations. */
export interface ProfileRoster {
  listProfiles(): Promise<Array<{ id: string; name: string; group: string }>>;
  listGroups?(): Promise<string[]>;
  createGroup?(name: string): Promise<void>;
  createProfile?(profile: Profile): Promise<{ id: string }>;
  updateProfile?(id: string, edits: ProfileEdits): Promise<void>;
}

/** Fields the compatibility API can apply to a saved profile. */
export type ProfileEdits = Partial<Pick<Profile, "name" | "username" | "password" | "email" | "emailPassword" | "twofa" | "proxy"
  | "group" | "platform" | "remark" | "startupUrls" | "locale" | "timezone" | "timezoneManual" | "screenWidth" | "screenHeight">>;

function normalizeGroup(g: unknown): string {
  const s = String(g ?? "").trim();
  return s === "0" ? "" : s;
}

function intParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function userRecords(store: ProfileStore, roster: ProfileRoster | null, scope?: LocalAutomationScope) {
  // A remote roster has no local measurement or timestamps.
  const rows = roster
    ? (await roster.listProfiles()).map((p, i) => ({ ...p, createdAt: 0, lastOpenAt: 0, serial: i + 1,
        customNo: "", fpVerdict: "", fpCapturedAt: "" }))
    : store.listUserRecords();
  return scope ? rows.filter(row => scope.allowsGroup(row.group)) : rows;
}

/** AdsPower account/proxy/fingerprint fields → aliasmode NewProfileInput. */
function inputFromCreateBody(body: any): NewProfileInput {
  const px = body?.user_proxy_config;
  const hasProxy = px && px.proxy_host && String(px.proxy_host).trim();
  // AdsPower screen_resolution is "1920_1080"; aliasmode's create wants "1920x1080".
  const screenRaw = body?.fingerprint_config?.screen_resolution;
  return {
    name: typeof body?.name === "string" ? body.name : "",
    group: normalizeGroup(body?.group_id),
    platform: typeof body?.domain_name === "string" ? body.domain_name : "",
    username: typeof body?.username === "string" ? body.username : "",
    password: typeof body?.password === "string" ? body.password : "",
    email: typeof body?.email === "string" ? body.email : "",
    emailPassword: typeof body?.email_password === "string"
      ? body.email_password
      : (typeof body?.emailPassword === "string" ? body.emailPassword : ""),
    twofa: typeof body?.fakey === "string"
      ? body.fakey
      : (typeof body?.twofa === "string" ? body.twofa : ""),
    proxy: hasProxy
      ? {
          type: String(px.proxy_type || "http"),
          host: String(px.proxy_host).trim(),
          port: String(px.proxy_port ?? ""),
          user: String(px.proxy_user ?? ""),
          pass: String(px.proxy_password ?? ""),
        }
      : null,
    screen: typeof screenRaw === "string" ? screenRaw.replace(/_/g, "x") : "",
    // Vela Browser fields. This API's contract is a CDP WebSocket, so a request that names no
    // engine gets Chromium on every computer.
    engine: body?.engine || "chromium",
    ...(body?.chromium_runtime ? { chromiumRuntime: body.chromium_runtime } : {}),
  };
}

function hasCredentialUpdate(body: any): boolean {
  return ["username", "password", "email", "email_password", "emailPassword", "fakey", "twofa"]
    .some((field) => typeof body?.[field] === "string");
}

/** AdsPower `user_proxy_config` on update. `proxy_soft: "no_proxy"` removes the proxy. */
function proxyFromUpdateConfig(px: any): ProxySpec | null {
  if (px.proxy_soft === "no_proxy") return null;
  const proxy = normalizeProxySpec({
    type: String(px.proxy_type || "http"),
    host: String(px.proxy_host ?? ""),
    port: String(px.proxy_port ?? ""),
    user: String(px.proxy_user ?? ""),
    pass: String(px.proxy_password ?? ""),
  });
  if (!proxy) throw new Error('user_proxy_config needs proxy_host and proxy_port, or proxy_soft "no_proxy" to remove the proxy');
  return proxy;
}

function editsFromUpdateBody(body: any, includeProxy = true): ProfileEdits {
  const edits: ProfileEdits = {};
  if (typeof body?.name === "string") edits.name = body.name;
  if (typeof body?.username === "string") edits.username = body.username;
  if (typeof body?.password === "string") edits.password = body.password;
  if (typeof body?.email === "string") edits.email = body.email;
  if (typeof body?.email_password === "string") edits.emailPassword = body.email_password;
  else if (typeof body?.emailPassword === "string") edits.emailPassword = body.emailPassword;
  if (typeof body?.fakey === "string") edits.twofa = body.fakey;
  else if (typeof body?.twofa === "string") edits.twofa = body.twofa;
  if (includeProxy && body?.user_proxy_config && typeof body.user_proxy_config === "object") {
    edits.proxy = proxyFromUpdateConfig(body.user_proxy_config);
  }
  return edits;
}

function isBodyObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function v2Settings(body: Record<string, unknown>, store: ProfileStore): ProfileEdits {
  const edits: ProfileEdits = {};
  for (const [field, key] of [["group_id", "group"], ["platform", "platform"], ["remark", "remark"]] as const) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") throw new Error(field + " must be a string");
    edits[key] = field === "group_id" ? normalizeGroup(raw) : raw.trim();
  }
  if (body.tabs !== undefined) edits.startupUrls = parseStartupUrls(body.tabs);
  if (body.user_proxy_config !== undefined) {
    if (body.proxyid !== undefined) throw new Error("Choose user_proxy_config or proxyid");
    const config = body.user_proxy_config;
    if (!isBodyObject(config)) throw new Error("user_proxy_config must be an object");
    if (String(config.global_config) === "1" || config.proxy_url) {
      throw new Error("Use a saved proxyid or supply a complete static user_proxy_config");
    }
    edits.proxy = proxyFromUpdateConfig(config);
  } else if (body.proxyid !== undefined) {
    if (typeof body.proxyid !== "string" || !body.proxyid.trim()) throw new Error("proxyid must be a pool node ID or random");
    const id = body.proxyid.trim();
    const candidates = id === "random" ? store.proxyPool.list().filter(node => !node.disabled && !node.removedFromSource) : [];
    const node = id === "random" ? candidates[Math.floor(Math.random() * candidates.length)] : store.proxyPool.get(id);
    if (!node || node.disabled) throw new Error("proxyid is unavailable in the local proxy pool");
    edits.proxy = node.proxy;
  }
  if (body.fingerprint_config !== undefined) {
    const fp = body.fingerprint_config;
    if (!isBodyObject(fp)) throw new Error("fingerprint_config must be an object");
    const resolution = fp.screen_resolution;
    if (resolution !== undefined && resolution !== "random" && resolution !== "none") {
      const { width, height } = parseStrictResolution(String(resolution).replaceAll("_", "x"));
      edits.screenWidth = width;
      edits.screenHeight = height;
    }
    if (String(fp.language_switch) === "1") {
      edits.locale = undefined;
    } else if (fp.language !== undefined) {
      const language = Array.isArray(fp.language) ? fp.language[0] : fp.language;
      const locale = normalizeProfileLocale(language);
      if (!locale) throw new Error("fingerprint_config.language must start with a valid locale");
      edits.locale = locale;
    }
    if (String(fp.automatic_timezone) === "1") {
      edits.timezone = "";
      edits.timezoneManual = false;
    } else if (fp.timezone !== undefined || String(fp.automatic_timezone) === "0") {
      edits.timezone = parseStrictTimezone(fp.timezone ?? "");
      edits.timezoneManual = true;
    }
  }
  return edits;
}

function v2Cookies(body: Record<string, unknown>): CookieRecord[] {
  if (body.cookie === undefined || body.cookie === "" || Array.isArray(body.cookie) && body.cookie.length === 0) return [];
  if (typeof body.cookie !== "string" && !Array.isArray(body.cookie)) throw new Error("cookie must be JSON or Netscape cookie text");
  const text = typeof body.cookie === "string" ? body.cookie : JSON.stringify(body.cookie);
  if (!text.trim() || text.trim() === "[]") return [];
  if (String(body.ignore_cookie_error) === "1" && !/^[\s]*[\[{]/.test(text)) {
    return text.split(/\r?\n/).flatMap(line => { try { return parseCookieText(line); } catch { return []; } });
  }
  return parseCookieText(text);
}

function checkRepeatConfig(body: Record<string, unknown>, profile: Profile, store: ProfileStore, scope?: LocalAutomationScope): void {
  if (body.repeat_config === undefined) return;
  if (!Array.isArray(body.repeat_config) || !body.repeat_config.every(value => ["0", "2", "3", "4", 0, 2, 3, 4].includes(value))) {
    throw new Error("repeat_config must contain supported deduplication modes");
  }
  const modes = new Set(body.repeat_config.map(Number));
  if (modes.has(0) || !modes.size) return;
  const cookieKey = (item: CookieRecord) => JSON.stringify([item.domain, item.path, item.name, item.value, item.partitionKey ?? ""]);
  const jar = new Set(mergeCookies([], profile.cookies).map(cookieKey));
  const cUser = (cookies: CookieRecord[]) => cookies.find(cookie => cookie.name === "c_user"
    && /(^|\.)facebook\.com$/i.test(cookie.domain))?.value;
  const facebookUser = modes.has(4) ? cUser(profile.cookies) : undefined;
  for (const candidate of store.listProfiles()) {
    if (scope && !scope.allowsGroup(candidate.group)) continue;
    const candidateCookies = modes.has(3) || facebookUser
      ? mergeCookies(candidate.cookies, store.getPendingCookies(candidate.id)) : [];
    const sameAccount = modes.has(2) && profile.username && profile.platform === candidate.platform
      && profile.username === candidate.username && profile.password === candidate.password;
    const sameJar = modes.has(3) && jar.size && candidateCookies.length === jar.size
      && candidateCookies.every(cookie => jar.has(cookieKey(cookie)));
    if (sameAccount || sameJar || facebookUser && facebookUser === cUser(candidateCookies)) {
      throw new Error("A matching profile already exists");
    }
  }
}

/** A new proxy's exit timezone, as the Edit dialog looks it up. Null when the proxy stays or the user typed a timezone. */
export async function exitTimezoneForEdit(profile: Profile, edits: ProfileEdits, geoipFetch?: GeoipFetch): Promise<string | null> {
  const proxy = edits.proxy === undefined ? profile.proxy : edits.proxy;
  if (!proxy || (edits.timezoneManual ?? profile.timezoneManual)
    || (edits.timezoneManual !== false && proxyIdentityKey(proxy) === proxyIdentityKey(profile.proxy))) return null;
  return (await lookupExitLocation(proxy, geoipFetch))?.timezone ?? null;
}

export function profileWithEdits(profile: Profile, edits: ProfileEdits, timezone: string | null = null): Profile {
  const next = { ...profile, ...edits };
  if ("proxy" in edits) delete next.proxyError;
  if (edits.timezoneManual === false) delete next.timezoneManual;
  if (timezone && !next.timezoneManual) next.timezone = timezone;
  if ("locale" in edits && !edits.locale) next.locale = localeForTimezone(next.timezone);
  if (timezone || edits.timezone !== undefined) syncFirefoxTimezone(next);
  if (edits.screenWidth !== undefined && edits.screenHeight !== undefined) {
    if (next.engine === "firefox") setFirefoxScreen(next, edits.screenWidth, edits.screenHeight);
    if (next.webkit) {
      next.webkit = { ...next.webkit, viewport: createWebKitProfileConfig(edits.screenWidth, edits.screenHeight).viewport };
    }
  }
  return next;
}

/**
 * Handle an AdsPower profile-management request. Returns null for any path this
 * module doesn't own, so web.ts falls through to the browser-control handler.
 * When `remote` is set, central edits route through the hub coordinator.
 */
export async function handleUserApi(
  req: Request,
  launcher: Launcher,
  store: ProfileStore,
  remote?: RemoteCoordinator | null,
  geoipFetch?: GeoipFetch,
  roster: ProfileRoster | null = remote ?? null,
  scope?: LocalAutomationScope,
): Promise<Response | null> {
  const { pathname, searchParams } = new URL(req.url);

  // --- groups: id == name (aliasmode has no group ids) ---
  if (pathname === "/api/v1/group/list" && req.method === "GET") {
    const page = intParam(searchParams.get("page"), 1);
    const pageSize = intParam(searchParams.get("page_size"), 100);
    // Cloud: authoritative folders, including empty ones. Remote: profile labels.
    // Standalone: registry ∪ profile labels.
    const names = roster?.listGroups
      ? (await roster.listGroups()).sort()
      : roster
        ? [...new Set((await roster.listProfiles()).map((p) => normalizeGroup(p.group)).filter((g) => g))].sort()
        : store.listGroups();
    const permitted = scope ? names.filter((group) => scope.allowsGroup(group)) : names;
    const list = permitted.slice((page - 1) * pageSize, page * pageSize).map((g) => ({ group_id: g, group_name: g }));
    return ok({ list, page, page_size: pageSize });
  }

  // --- create a folder up front (AdsPower group/create); idempotent, id == name ---
  if (pathname === "/api/v1/group/create" && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    const name = String(body?.group_name ?? "").trim();
    if (!name) return fail("missing group_name");
    if (scope && !scope.allowsGroup(name)) return fail(AUTOMATION_SCOPE_DENIED);
    // Remote: the hub has no empty-group registry; the folder materializes when a
    // profile is created/moved into it (id == name, so this is enough for the
    // create flow). Standalone: persist it so empty folders list immediately.
    if (!remote) {
      if (roster?.createGroup) await roster.createGroup(name);
      else store.registerGroup(name);
    }
    return ok({ group_id: name });
  }

  if (pathname === "/api/v2/browser-profile/list" && req.method === "POST") {
    const value: unknown = await req.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid JSON body");
    const body = value as Record<string, unknown>;
    const ids = body.profile_id ?? [];
    const numbers = body.profile_no ?? [];
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && id.trim())) return fail("profile_id must be a list of IDs");
    if (!Array.isArray(numbers) || !numbers.every(no => (typeof no === "string" && no.trim()) || Number.isSafeInteger(no))) {
      return fail("profile_no must be a list of profile numbers");
    }
    const page = Number(body.page ?? 1);
    const limit = Number(body.limit ?? 1);
    if (!Number.isSafeInteger(page) || page < 1) return fail("page must be a positive integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("limit must be between 1 and 100");
    const sort = body.sort_type ?? "profile_no";
    const order = body.sort_order ?? "desc";
    if (sort !== "profile_no" && sort !== "created_time" && sort !== "last_open_time") return fail("invalid sort_type");
    if (order !== "asc" && order !== "desc") return fail("invalid sort_order");
    const byNumber = new Intl.Collator("en", { numeric: true });
    const selectedIds = new Set(ids.map(id => id.trim()));
    const selectedNumbers = new Set(numbers.map(no => String(no).trim()));
    const group = typeof body.group_id === "string" && body.group_id.trim() ? normalizeGroup(body.group_id) : null;
    const rows = (await userRecords(store, roster, scope))
      .map(row => ({ ...row, number: profileDisplayNo(row.customNo, row.serial)! }))
      .filter(row => (group === null || normalizeGroup(row.group) === group)
        && (!selectedIds.size || selectedIds.has(row.id)) && (!selectedNumbers.size || selectedNumbers.has(row.number)));
    rows.sort((a, b) => {
      const comparison = sort === "profile_no" ? byNumber.compare(a.number, b.number)
        : sort === "created_time" ? a.createdAt - b.createdAt : a.lastOpenAt - b.lastOpenAt;
      return (order === "asc" ? 1 : -1) * (comparison || a.serial - b.serial);
    });
    const list = rows.slice((page - 1) * limit, page * limit).map(row => ({
      profile_id: row.id, profile_no: row.number, name: row.name,
      group_id: normalizeGroup(row.group) || "0", group_name: normalizeGroup(row.group),
      created_time: String(Math.floor(row.createdAt / 1000)), last_open_time: String(Math.floor(row.lastOpenAt / 1000)),
    }));
    return ok({ list, page, limit });
  }

  // --- list profiles (optionally by group), AdsPower envelope ---
  if (pathname === "/api/v1/user/list" && req.method === "GET") {
    const page = intParam(searchParams.get("page"), 1);
    const pageSize = intParam(searchParams.get("page_size"), 100);
    let rows = await userRecords(store, roster, scope);

    const groupId = searchParams.get("group_id");
    if (groupId != null) {
      const want = normalizeGroup(groupId);
      rows = rows.filter((r) => normalizeGroup(r.group) === want);
    }
    // AdsPower's user_id filter: clients look a single profile up by id and read list[0].
    const userId = searchParams.get("user_id");
    if (userId) rows = rows.filter((r) => r.id === userId);

    // Honor AdsPower's user_sort={"created_time"|"last_open_time":"asc"|"desc"}.
    // (No-op on the remote roster, which carries no timestamps.)
    const sortRaw = searchParams.get("user_sort");
    if (sortRaw) {
      try {
        const s = JSON.parse(sortRaw) as Record<string, string>;
        if (s.created_time) {
          rows.sort((a, b) => (s.created_time === "asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
        } else if (s.last_open_time) {
          rows.sort((a, b) => (s.last_open_time === "asc" ? a.lastOpenAt - b.lastOpenAt : b.lastOpenAt - a.lastOpenAt));
        }
      } catch {
        /* malformed sort → keep insertion order */
      }
    }

    const list = rows.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      user_id: r.id,
      name: r.name,
      group_id: normalizeGroup(r.group),
      serial_number: String(r.serial),
      // AdsPower reports Unix SECONDS; our bookkeeping is ms. 0 stays 0 (unknown).
      created_time: r.createdAt ? Math.floor(r.createdAt / 1000) : 0,
      last_open_time: r.lastOpenAt ? Math.floor(r.lastOpenAt / 1000) : 0,
      // Additive: existing AdsPower clients ignore unknown fields. "" means
      // there was no imported attestation to check this profile against.
      fp_verdict: r.fpVerdict,
      fp_captured_at: r.fpCapturedAt,
    }));
    return ok({ list, page, page_size: pageSize });
  }

  // Generate a native identity for both profile creation APIs.
  const createV2 = pathname === "/api/v2/browser-profile/create";
  if ((createV2 || pathname === "/api/v1/user/create") && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    if (createV2 && !isBodyObject(body)) return fail("invalid JSON body");
    if (createV2 && roster) return fail("V2 profile creation requires the local profile store");
    try {
      const input = inputFromCreateBody(body);
      if (scope && !scope.allowsGroup(input.group ?? "")) return fail(AUTOMATION_SCOPE_DENIED);
      if (createV2 && body.name !== undefined && (typeof body.name !== "string" || body.name.length > 100)) {
        throw new Error("name must be a string of at most 100 characters");
      }
      const edits = createV2 ? v2Settings(body, store) : {};
      const cookies = createV2 ? v2Cookies(body) : [];
      if (createV2) {
        input.proxy = edits.proxy ?? null;
        input.platform = edits.platform ?? input.platform;
        input.screen = edits.screenWidth !== undefined ? edits.screenWidth + "x" + edits.screenHeight : "";
      }
      if (remote && input.chromiumRuntime) throw new Error("Vela Chromium is unavailable in legacy Remote mode");
      if (remote) {
        // Hub owns id generation, fingerprint seed, and geoip timezone.
        const { id } = await remote.createProfile(input);
        return ok({ id });
      }
      let profile = buildNewProfile(input, id => !!store.getProfile(id) || createV2 && store.isTrashed(id));
      if (createV2) profile = profileWithEdits({ ...profile, cookies }, edits);
      // Match the browser clock to the proxy's geo, exactly as /ui/api create and
      // AdsPower's automatic_timezone do. Best-effort: never fail create on geoip.
      if (profile.proxy && !profile.timezoneManual) {
        await attachTimezones([profile], geoipFetch, !createV2 || !edits.locale).catch(() => {});
        syncFirefoxTimezone(profile);
      }
      if (roster?.createProfile) return ok(await roster.createProfile(profile));
      if (createV2) {
        return store.runTransaction(() => {
          checkRepeatConfig(body, profile, store, scope);
          if (store.getProfile(profile.id) || store.isTrashed(profile.id)) throw new Error("Could not allocate a profile ID. Retry creation.");
          store.upsertProfile(profile);
          return ok({ profile_id: profile.id, profile_no: profileDisplayNo(profile.customNo, store.getSerial(profile.id)) });
        });
      }
      store.upsertProfile(profile);
      return ok({ id: profile.id });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // --- delete ---
  const deleteV2 = pathname === "/api/v2/browser-profile/delete";
  if ((pathname === "/api/v1/user/delete" || deleteV2) && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    if (deleteV2 && (!Array.isArray(body?.profile_id) || body.profile_id.length < 1 || body.profile_id.length > 100
      || !body.profile_id.every(isSafeProfileId))) return fail("profile_id must contain 1 to 100 valid profile IDs");
    const ids: string[] = deleteV2 ? [...new Set<string>(body.profile_id)] : Array.isArray(body?.user_ids) ? body.user_ids.map(String) : [];
    if (scope && ids.some((id: string) => !scope.allowsProfile(id))) return fail(AUTOMATION_SCOPE_DENIED);
    if (remote) {
      const r = await remote.deleteProfiles(ids); // hub deletes centrally (respects locks)
      return ok({ deleted: r.deleted, locked: r.locked });
    }
    // Standalone: stop, remove the persistent user-data dir, drop the row.
    let deleted = 0;
    const locked: string[] = [];
    const protectedIds: string[] = [];
    for (const id of ids) {
      if (!store.getProfile(id)) continue;
      if (store.isDeletionProtected(id)) {
        protectedIds.push(id);
        continue;
      }
      // stop() also waits for an in-flight start that has not recorded its
      // launch row yet, so deletion cannot race a late browser spawn.
      if ((await launcher.stop(id)) !== true) {
        locked.push(id);
        continue;
      }
      // The cache delete after stop() runs on; let it end before the folder is removed.
      await launcher.cacheCleanupSettled(id);
      if (store.isDeletionProtected(id)) {
        protectedIds.push(id);
        continue;
      }
      // removeUserDataDir refuses any path outside the data root (a crafted or
      // legacy "../" id), so rmSync can't escape; the row is dropped regardless.
      launcher.removeUserDataDir(id);
      store.deleteProfile(id);
      deleted++;
    }
    return ok({ deleted, locked, ...(protectedIds.length ? { protected: protectedIds } : {}) });
  }

  const updateV2 = pathname === "/api/v2/browser-profile/update";
  if ((updateV2 || pathname === "/api/v1/user/update") && req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return fail("invalid JSON body");
    }
    if (updateV2 && !isBodyObject(body)) return fail("invalid JSON body");
    if (updateV2 && roster) return fail("V2 profile updates require the local profile store");
    const field = updateV2 ? "profile_id" : "user_id";
    const id = typeof body?.[field] === "string" ? body[field] : "";
    if (!id) return fail("missing " + field);
    if (updateV2 && !isSafeProfileId(id)) return fail("invalid profile_id");
    if (scope && !scope.allowsProfile(id)) return fail(AUTOMATION_SCOPE_DENIED);
    if (body.name !== undefined && !isValidProfileName(body.name)) return fail("name must be a non-empty string");
    if (updateV2 && body.name?.length > 100) return fail("name must be at most 100 characters");
    let edits: ProfileEdits;
    let cookies: CookieRecord[] = [];
    try {
      edits = editsFromUpdateBody(body, !updateV2);
      if (updateV2) {
        if (scope && body.group_id !== undefined && !scope.allowsGroup(normalizeGroup(body.group_id))) {
          return fail(AUTOMATION_SCOPE_DENIED);
        }
        Object.assign(edits, v2Settings(body, store));
        cookies = v2Cookies(body);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (!Object.keys(edits).length && (!updateV2 || body.cookie === undefined)) {
      return fail(updateV2 ? "nothing to update" : "nothing to update: send name, account fields or user_proxy_config");
    }
    if (roster?.updateProfile) {
      try {
        await roster.updateProfile(id, edits);
        return ok({});
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
    if (remote) {
      if ("proxy" in edits) return fail("proxy updates are unavailable in legacy Remote mode");
      try {
        if (!hasCredentialUpdate(body)) {
          await remote.renameProfile(id, body.name);
        } else {
          const profile = await remote.getProfile(id);
          await remote.saveProfile(profileWithEdits(profile, edits));
        }
        return ok({});
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
    try {
      const profile = store.getProfile(id);
      if (!profile) return fail(`no such profile: ${id}`);
      // An open browser keeps the timezone it launched with; its next launch looks the new proxy up.
      const timezone = store.getLaunch(id) ? null : await exitTimezoneForEdit(profile, edits, geoipFetch);
      // Apply to the current copy, so changes saved during the lookup are kept.
      const current = store.getProfile(id);
      if (!current) return fail(`no such profile: ${id}`);
      if (scope && !scope.allowsGroup(current.group)) return fail(AUTOMATION_SCOPE_DENIED);
      store.runTransaction(() => {
        if (Object.keys(edits).length) {
          const timezoneStillApplies = edits.proxy !== undefined || proxyIdentityKey(current.proxy) === proxyIdentityKey(profile.proxy);
          store.upsertProfile(profileWithEdits(current, edits, store.getLaunch(id) || !timezoneStillApplies ? null : timezone));
        }
        if (cookies.length) store.addPendingCookies(id, cookies);
      });
      return ok({});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return fail(`failed to persist profile update: ${message}`);
    }
  }

  return null;
}

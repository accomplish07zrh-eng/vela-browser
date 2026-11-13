/**
 * Changing a profile's proxy, also while its browser is open (design §5).
 *
 * The timezone and WebRTC address a page sees are fixed when the browser starts, from the exit it
 * starts on. Changing them in a running browser needs the engines' own runtime interface, which
 * the Vela kernels do not have yet; emulating it from outside (CDP overrides) would leave windows
 * where a page sees the old timezone beside the new exit. So an open browser changes exits by
 * reopening: its session is saved, it closes, it starts on the new exit (timezone and WebRTC set
 * from that exit), and its tabs come back. The relay's hot switch (phase 0) is ready for the day
 * the kernels can update a running page; until then nothing switches under a live page.
 *
 * Every step can stop the switch; none can leave the profile on a direct route:
 *  - the new exit is checked first, through the same kind of route a launch uses; a failed check
 *    changes nothing;
 *  - a browser whose teardown cannot be confirmed keeps its old proxy;
 *  - after reopening, the exit is checked again through the profile's own relay; an exit that is
 *    this computer's own address closes the browser.
 */

import type { EgressInfo } from "./egress.ts";
import { fetchDirectEgress } from "./egress.ts";
import type { KernelSupervisor } from "./kernel.ts";
import type { LaunchStartOptions, LaunchStartResult } from "./launcher.ts";
import type { ProxyCheckResult } from "./proxy-check.ts";
import { checkProxy } from "./proxy-check.ts";
import { poolUsage, type PoolNode } from "./proxy-pool.ts";
import { proxyHostPort, proxyIdentityKey } from "./proxy.ts";
import { lookupExitLocation, type FetchLike } from "./geoip.ts";
import { syncFirefoxTimezone } from "./firefox-config.ts";
import type { ProfileStore } from "./store.ts";
import type { LaunchInfo, Profile, ProxySpec } from "./types.ts";

/**
 * Save `proxy` as a profile's proxy, as the profile form saves one: the timezone follows the new
 * exit unless the user typed one (a pool node's exit is looked up at its launch, through its
 * kernel), and an open browser keeps the proxy it runs with until its next start. False when
 * there is no such profile.
 */
export async function saveProfileProxy(store: ProfileStore, id: string, proxy: ProxySpec, timezoneFetch?: FetchLike): Promise<boolean> {
  const apply = (profile: Profile) => {
    const changed = !!profile.proxyError || proxyIdentityKey(profile.proxy) !== proxyIdentityKey(proxy);
    profile.proxy = { ...proxy };
    delete profile.proxyError;
    return changed;
  };
  let p = store.getProfile(id);
  if (!p) return false;
  if (apply(p) && !p.timezoneManual) {
    const location = await lookupExitLocation(proxy, timezoneFetch);
    // Apply to the current copy, so changes saved during the lookup are kept.
    p = store.getProfile(id);
    if (!p) return false;
    apply(p);
    if (location) {
      p.timezone = location.timezone;
      syncFirefoxTimezone(p);
    }
  }
  store.upsertProfile(p);
  return true;
}

export type SwitchErrorCode =
  | "no_such_profile" | "node_unavailable" | "pool_exhausted" | "rate_limited" | "profile_busy"
  | "switch_check_failed" | "teardown_unconfirmed" | "reopen_failed" | "exit_is_direct";

export class ProxySwitchError extends Error {
  constructor(readonly code: SwitchErrorCode, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface SwitchHistoryEntry {
  profileId: string;
  at: number;
  by: string;
  from: string;
  to: string;
  outcome: "saved" | "reopened" | "failed";
  code?: SwitchErrorCode;
  exitCountry?: string;
}

export interface SwitchResult {
  applied: "saved" | "reopened";
  previous: string;
  next: string;
  exit?: { ip?: string; country?: string };
  /** Profiles already on the new exit. */
  sharedWith: Array<{ id: string; name: string; group: string }>;
}

export interface SwitchLauncher {
  start(profileId: string, launchArgs?: string[], opts?: LaunchStartOptions): Promise<LaunchStartResult>;
  stop(profileId: string, expected?: LaunchInfo): Promise<boolean>;
  captureLocalSession(profileId: string): Promise<unknown>;
  kernels?: Pick<KernelSupervisor, "startTemporary">;
}

export interface SwitchDeps {
  store: ProfileStore;
  launcher: SwitchLauncher;
  /** Saves `proxy` as the profile's proxy the way the profile form does. */
  assign(profileId: string, proxy: ProxySpec): Promise<unknown>;
  /** Checks an exit; defaults to the shared proxy check. */
  check?: (proxy: ProxySpec, direct: EgressInfo | null) => Promise<ProxyCheckResult>;
  direct?: () => Promise<EgressInfo | null>;
  now?: () => number;
  /** Seconds a profile waits between two switches. */
  minIntervalMs?: number;
  log?: (msg: string) => void;
}

const MIN_INTERVAL_MS = 30_000;
const inFlight = new WeakMap<ProfileStore, Set<string>>();

/** A short label for a proxy or a pool node, without credentials. */
export function proxyLabel(store: ProfileStore, proxy: ProxySpec | null): string {
  if (!proxy) return "direct";
  if (proxy.type === "pool") {
    const node = store.proxyPool.get(proxy.host);
    return node ? `${node.protocol} · ${node.name}` : "pool node (removed)";
  }
  return `${proxy.type}://${proxyHostPort(proxy)}`;
}

/** Give a profile a pool node, reopening its browser on the new exit if it is open. */
export async function switchProfileProxy(
  deps: SwitchDeps,
  request: { profileId: string; nodeId: string; by: string },
): Promise<SwitchResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const busy = inFlight.get(store) ?? new Set<string>();
  inFlight.set(store, busy);
  if (busy.has(request.profileId)) throw new ProxySwitchError("profile_busy", "This profile is already changing its proxy");
  busy.add(request.profileId);
  const profile = store.getProfile(request.profileId);
  const previous = proxyLabel(store, profile?.proxy ?? null);
  let next = request.nodeId;
  const record = (entry: Omit<SwitchHistoryEntry, "profileId" | "at" | "by" | "from" | "to">) =>
    store.proxyPool.recordSwitch({ profileId: request.profileId, at: now(), by: request.by, from: previous, to: next, ...entry });
  try {
    if (!profile) throw new ProxySwitchError("no_such_profile", "no such profile");
    const last = store.proxyPool.switchHistory(request.profileId, 1)[0];
    if (last && last.outcome !== "failed" && now() - last.at < (deps.minIntervalMs ?? MIN_INTERVAL_MS)) {
      throw new ProxySwitchError("rate_limited", "This profile changed its proxy moments ago; wait before changing it again", {
        retryAfterMs: (deps.minIntervalMs ?? MIN_INTERVAL_MS) - (now() - last.at),
      });
    }
    const node = store.proxyPool.get(request.nodeId);
    if (!node || node.disabled) throw new ProxySwitchError("node_unavailable", "This proxy is not available in the pool");
    next = `${node.protocol} · ${node.name}`;
    const users = (poolUsage([node], store.listProfiles()).get(node.id) ?? []).filter((p) => p.id !== profile.id);
    if (node.maxProfiles !== null && users.length >= node.maxProfiles) {
      throw new ProxySwitchError("pool_exhausted", "This proxy is already used by as many profiles as its sharing limit allows", {
        profiles: users.map(({ id, name, group }) => ({ id, name, group })),
      });
    }
    const sharedWith = users.map(({ id, name, group }) => ({ id, name, group }));

    // 1. The new exit must work before anything changes.
    const direct = await (deps.direct ?? (() => fetchDirectEgress()))().catch(() => null);
    const checked = await checkNode(deps, node, direct);
    if (checked.status !== "working" && checked.status !== "unstable") {
      throw new ProxySwitchError("switch_check_failed", "The new proxy did not pass its check; nothing was changed", {
        status: checked.status, ...(checked.reason ? { reason: checked.reason } : {}),
      });
    }
    const launch = store.getLaunch(profile.id);
    // 2. A closed profile just takes the new proxy; its next start uses it.
    if (!launch) {
      await deps.assign(profile.id, node.proxy);
      record({ outcome: "saved", ...(checked.country ? { exitCountry: checked.country } : {}) });
      return { applied: "saved", previous, next, exit: { ip: checked.ip, country: checked.country }, sharedWith };
    }
    // 3. An open browser: save its session, close it for certain, then reopen on the new exit.
    await deps.launcher.captureLocalSession(profile.id).catch(() => {});
    const stopped = await deps.launcher.stop(profile.id, launch);
    if (!stopped || store.getLaunch(profile.id)) {
      throw new ProxySwitchError("teardown_unconfirmed", "The browser could not be closed for certain; it keeps its proxy");
    }
    await deps.assign(profile.id, node.proxy);
    try {
      await deps.launcher.start(profile.id, [], { ...(launch.headless !== undefined ? { headless: launch.headless } : {}) });
    } catch (error) {
      throw new ProxySwitchError("reopen_failed", "The new proxy is saved, but the browser did not reopen", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    // 4. Check the exit again through the profile's own relay. This computer's address is the one
    //    answer that must never come back: it closes the browser.
    const relayPort = store.getLaunch(profile.id)?.relayPort;
    let exit: ProxyCheckResult | null = null;
    if (relayPort) {
      exit = await (deps.check ?? ((proxy, d) => checkProxy(proxy, { direct: d })))(
        { type: "http", host: "127.0.0.1", port: String(relayPort), user: "", pass: "" }, direct,
      ).catch(() => null);
      if (exit?.reason === "proxy_bypassed" || (direct && exit?.ip === direct.ip)) {
        const current = store.getLaunch(profile.id);
        await deps.launcher.stop(profile.id, current ?? undefined).catch(() => false);
        throw new ProxySwitchError("exit_is_direct", "After reopening, the browser's traffic left from this computer's own address; it was closed");
      }
    }
    record({ outcome: "reopened", ...(exit?.country ?? checked.country ? { exitCountry: exit?.country ?? checked.country } : {}) });
    return { applied: "reopened", previous, next, exit: { ip: exit?.ip ?? checked.ip, country: exit?.country ?? checked.country }, sharedWith };
  } catch (error) {
    if (error instanceof ProxySwitchError) {
      if (error.code !== "profile_busy" && error.code !== "rate_limited" && profile) record({ outcome: "failed", code: error.code });
      deps.log?.(`proxy switch for ${request.profileId} stopped: ${error.code}`);
    }
    throw error;
  } finally {
    busy.delete(request.profileId);
  }
}

/** Check a node the way a launch would reach it: a kernel node through a temporary kernel. */
async function checkNode(deps: SwitchDeps, node: PoolNode, direct: EgressInfo | null): Promise<ProxyCheckResult> {
  const check = deps.check ?? ((proxy, d) => checkProxy(proxy, { direct: d }));
  if (!node.outbound) return check(node.proxy, direct).catch(() => ({ status: "unavailable", attempts: 0, successes: 0 } as ProxyCheckResult));
  if (!deps.launcher.kernels) return { status: "unavailable", attempts: 0, successes: 0, reason: "check_unavailable" };
  let temporary: Awaited<ReturnType<KernelSupervisor["startTemporary"]>> | undefined;
  try {
    temporary = await deps.launcher.kernels.startTemporary([{ tag: "check", outbound: node.outbound }]);
    return await check(temporary.specs.get("check")!, direct);
  } catch {
    return { status: "unavailable", attempts: 0, successes: 0, reason: "check_unavailable" };
  } finally {
    temporary?.process.stop();
  }
}

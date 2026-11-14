import { CloudApiError } from "./cloud-client.ts";
import { syncFirefoxTimezone } from "./firefox-config.ts";
import { attachTimezones } from "./geoip.ts";
import { canonicalIp } from "./ip.ts";
import { buildProxyPreview, checkProfileProxies, replacementState, selectProxyProfiles, ProxyToolsError, type PlannedProxyReplacement, type ProxyInventoryProfile } from "./proxy-bulk.ts";
import { parsePoolSelection } from "./proxy-pool.ts";
import { poolNodeTimezone } from "./proxy-switch.ts";
import {
  proxyHostPort,
  proxyIdentityKey,
} from "./proxy.ts";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { ProxySpec } from "./types.ts";
import type { UiRuntimeOptions } from "./ui.ts";
import type { ProxyPreview, ProxyPreviewInput, ProxyProgressEvent, ProxyScope } from "./proxy-tools-types.ts";

type Preview = { id: string; owner: string; scope: ProxyScope; rows: PlannedProxyReplacement[]; unusedProxies: number; distinctExitIp?: boolean };
const states = new WeakMap<ProfileStore, { preview?: Preview; applying: boolean }>();

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function previewView(preview: Preview): ProxyPreview {
  return { ok: true, previewId: preview.id, rows: preview.rows.map((r) => r.view), unusedProxies: preview.unusedProxies };
}

/** Why a pool node can no longer take this profile, or null when it can. */
function poolNodeUnavailable(
  store: ProfileStore,
  nodeId: string,
  profileId: string,
  proxy: ProxySpec,
  distinctExitIp = false,
): string | null {
  const node = store.proxyPool.get(nodeId);
  if (!node || node.disabled || node.removedFromSource || proxyIdentityKey(node.proxy) !== proxyIdentityKey(proxy)) return "pool_node_unavailable";
  const profiles = store.listProfiles();
  if (node.maxProfiles !== null) {
    const key = proxyIdentityKey(node.proxy);
    const users = profiles.filter((p) => p.id !== profileId && p.proxy && proxyIdentityKey(p.proxy) === key).length;
    if (users >= node.maxProfiles) return "pool_exhausted";
  }
  if (distinctExitIp && node.check?.ip) {
    const exitIp = canonicalIp(node.check.ip) || node.check.ip.trim();
    const nodesByKey = new Map(store.proxyPool.list().map((n) => [proxyIdentityKey(n.proxy), n]));
    for (const other of profiles) {
      if (other.id === profileId || !other.proxy) continue;
      const otherNode = nodesByKey.get(proxyIdentityKey(other.proxy));
      const usedIp = otherNode?.check?.ip ? (canonicalIp(otherNode.check.ip) || otherNode.check.ip.trim()) : "";
      if (usedIp && usedIp === exitIp) return "pool_exhausted";
    }
  }
  return null;
}

function safeError(error: unknown): string {
  if (error instanceof ProxyToolsError) return error.message;
  if (error instanceof CloudApiError && error.status === 404) return "Cloud bulk proxy tools are not available on this server yet";
  return "Proxy operation failed. Refresh and try again.";
}

export async function handleProxyToolsRequest(
  req: Request, store: ProfileStore, launcher: Launcher, options: UiRuntimeOptions,
): Promise<Response> {
  const state = states.get(store) ?? { applying: false };
  states.set(store, state);
  let streaming = false;
  try {
    const owner = "local";
    const current = () => !req.signal.aborted;
    const assertCurrent = () => { if (!current()) throw new ProxyToolsError("Operation cancelled or account changed", 409); };
    assertCurrent();
    if (state.preview?.owner !== owner) state.preview = undefined;
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProxyToolsError("Invalid request");
    const action = new URL(req.url).pathname.split("/").pop();
    const inventory = async (): Promise<ProxyInventoryProfile[]> => {
      assertCurrent();

      const profiles = store.listProfiles();
      await Promise.all(profiles.map((p) => launcher.cacheCleanupSettled(p.id)));
      return profiles.map((p) => ({
        id: p.id, name: p.name, group: p.group, proxy: p.proxy, proxyError: p.proxyError,
        permission: "edit", running: launcher.profileDeletionBlocked(p.id),
      }));
    };
    const getPreview = (): Preview => {
      const preview = state.preview;
      if (!preview || preview.owner !== owner || preview.id !== body.previewId) throw new ProxyToolsError("Preview expired. Preview the replacements again.", 409);
      return preview;
    };
    if (state.applying && action !== "check") throw new ProxyToolsError("Replacement is still running", 409);
    if (action === "preview") {
      const profiles = await inventory();
      if (state.applying) throw new ProxyToolsError("Replacement is still running", 409);
      const previewInput = body as ProxyPreviewInput;
      const built = buildProxyPreview(profiles, previewInput, previewInput.mode === "pool"
        ? { nodes: store.proxyPool.list(), allProfiles: profiles.map(({ id, name, group, proxy }) => ({ id, name, group, proxy })) }
        : undefined);
      const distinctExitIp = previewInput.mode === "pool" ? parsePoolSelection(previewInput.input).distinctExitIp : undefined;
      assertCurrent();
      state.preview = { id: crypto.randomUUID(), owner, scope: structuredClone(body.scope), ...built, ...(distinctExitIp ? { distinctExitIp: true } : {}) };
      return response(previewView(state.preview));
    }
    if (action === "retry-preview") {
      const previous = getPreview();
      if (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== "string")) throw new ProxyToolsError("Select failed profiles to retry");
      const ids = new Set<string>(body.ids);
      const fresh = new Map(selectProxyProfiles(await inventory(), previous.scope).map((p) => [p.id, p]));
      if (state.applying) throw new ProxyToolsError("Replacement is still running", 409);
      const rows = previous.rows.filter((row) => row.view.profileId && ids.has(row.view.profileId) && ["skipped", "failed"].includes(row.view.status)).map((row) => {
        const profile = fresh.get(row.view.profileId!);
        if (!row.next || row.view.code === "duplicate_target") return { ...row, view: { ...row.view } };
        let nextState = replacementState(profile, row.next);
        if (nextState.status === "ready" && row.poolNodeId && profile) {
          const poolCode = poolNodeUnavailable(store, row.poolNodeId, profile.id, row.next, previous.distinctExitIp);
          if (poolCode) nextState = { status: "skipped", code: poolCode };
        }
        return { ...row, originalKey: proxyIdentityKey(profile?.proxy ?? null), expectedVersion: profile?.version,
          view: { ...row.view, name: profile?.name ?? row.view.name, group: profile?.group ?? row.view.group,
            previousProxy: profile?.proxy ? `${profile.proxy.type}://${proxyHostPort(profile.proxy)}` : null,
            code: undefined, ...nextState } };
      });
      assertCurrent();
      state.preview = { ...previous, id: crypto.randomUUID(), rows };
      return response(previewView(state.preview));
    }
    if (action !== "check" && action !== "apply") throw new ProxyToolsError("Unknown proxy operation", 404);
    const preview = action === "apply" ? getPreview() : undefined;
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id: unknown) => typeof id !== "string"))) throw new ProxyToolsError("Invalid profile selection");
    if (preview) state.applying = true;
    let clientGone = false;
    const cancelled = () => clientGone || !current();
    streaming = true;
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: ProxyProgressEvent) => {
          if (clientGone || !current()) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { clientGone = true; }
        };
        try {
          send({ type: "progress", phase: "loading", completed: 0, total: 1 });
          const profiles = await inventory();
          send({ type: "progress", phase: "loading", completed: 1, total: 1 });
          if (action === "check") {
            await checkProfileProxies(selectProxyProfiles(profiles, body.scope), send, cancelled,
              options.proxyCheck ? { check: options.proxyCheck, direct: async () => null } : undefined);
          } else if (preview) {
            const selectedIds = body.ids ? new Set<string>(body.ids) : null;
            for (const row of preview.rows) {
              if (row.view.status !== "ready" && (!selectedIds || selectedIds.has(row.view.profileId!))) send({ type: "replacement", row: row.view });
            }
            const rows = preview.rows.filter((r) => r.view.status === "ready" && r.next && (!selectedIds || selectedIds.has(r.view.profileId!)));
            const byId = new Map(selectProxyProfiles(profiles, preview.scope).map((p) => [p.id, p]));
            let completed = 0;
            send({ type: "progress", phase: "applying", completed, total: rows.length });
            // Match the existing export batch size; this is not a profile limit.
            for (let offset = 0; offset < rows.length && !cancelled(); offset += 16) {
              const batch = rows.slice(offset, offset + 16);
              const ready: PlannedProxyReplacement[] = [];
              for (const row of batch) {
                const profile = byId.get(row.view.profileId!);
                const status = replacementState(profile, row.next!);
                if (!profile || profile.group !== row.view.group || profile.permission !== "edit") {
                  Object.assign(row.view, { status: "skipped", code: "no_editable_match" });
                } else if (profile.version !== row.expectedVersion || proxyIdentityKey(profile.proxy) !== row.originalKey) {
                  Object.assign(row.view, { status: "skipped", code: "version_conflict" });
                } else if (status.status !== "ready") Object.assign(row.view, { code: undefined, ...status });
                else ready.push(row);
              }
              {
                for (const row of ready) {
                  if (cancelled()) break;
                  const id = row.view.profileId!;
                  try {
                    let profile = store.getProfile(id);
                    if (!profile || proxyIdentityKey(profile.proxy) !== row.originalKey || profile.group !== row.view.group) {
                      Object.assign(row.view, { status: "skipped", code: "version_conflict" }); continue;
                    }
                    const initialTimezone = profile.timezone;
                    const initialTimezoneManual = !!profile.timezoneManual;
                    await launcher.cacheCleanupSettled(id);
                    if (cancelled()) break;
                    if (launcher.profileDeletionBlocked(id)) { Object.assign(row.view, { status: "skipped", code: "profile_open" }); continue; }
                    const changed = { ...profile, proxy: row.next!, timezone: "" };
                    await attachTimezones([changed], options.timezoneFetch).catch(() => {});
                    if (cancelled()) break;
                    if (!changed.timezone && row.next!.type === "pool" && !profile.timezoneManual) {
                      changed.timezone = poolNodeTimezone(store, row.next!) ?? "";
                    }
                    assertCurrent();
                    profile = store.getProfile(id);
                    if (
                      !profile
                      || proxyIdentityKey(profile.proxy) !== row.originalKey
                      || profile.group !== row.view.group
                      || profile.timezone !== initialTimezone
                      || !!profile.timezoneManual !== initialTimezoneManual
                    ) {
                      Object.assign(row.view, { status: "skipped", code: "version_conflict" }); continue;
                    }
                    if (launcher.profileDeletionBlocked(id)) { Object.assign(row.view, { status: "skipped", code: "profile_open" }); continue; }
                    // A pool node may have filled up, changed exit IP, or left the pool since the preview.
                    if (row.poolNodeId) {
                      const code = poolNodeUnavailable(store, row.poolNodeId, id, row.next!, preview.distinctExitIp);
                      if (code) { Object.assign(row.view, { status: "skipped", code }); continue; }
                    }
                    profile.proxy = row.next!; delete profile.proxyError;
                    // A failed lookup keeps the saved timezone; never overwrite a user-set timezone.
                    if (changed.timezone && !profile.timezoneManual) {
                      profile.timezone = changed.timezone;
                      syncFirefoxTimezone(profile);
                    }
                    store.upsertProfile(profile);
                    Object.assign(row.view, { status: "updated", code: undefined });
                  } catch {
                    if (cancelled()) break;
                    Object.assign(row.view, { status: "failed", code: "update_failed" });
                  }
                }
              }
              for (const row of batch) {
                if (row.view.status === "ready") continue;
                send({ type: "replacement", row: row.view });
                send({ type: "progress", phase: "applying", completed: ++completed, total: rows.length });
              }
            }
          }
          if (!cancelled()) send({ type: "done" });
        } catch (error) { send({ type: "error", error: safeError(error) }); }
        finally {
          if (preview) state.applying = false;
          try { controller.close(); } catch {}
        }
      },
      cancel() { clientGone = true; },
    }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  } catch (error) {
    return response({ ok: false, error: safeError(error) }, error instanceof ProxyToolsError ? error.status : error instanceof SyntaxError ? 400 : error instanceof CloudApiError ? error.status : 500);
  }
}

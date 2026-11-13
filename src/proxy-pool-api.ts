/**
 * Proxy pool routes for the dashboard (/ui/api/proxy-pool...). Responses never carry a node's
 * credentials. Giving one profile a node goes through the same save as the profile form, so the
 * timezone follows the new exit and an open browser keeps its proxy until its next start.
 */

import { fetchDirectEgress } from "./egress.ts";
import { checkProxy } from "./proxy-check.ts";
import { checkPoolNodes, poolNodeViews, poolUsage, ProxyPoolError, type PoolNode } from "./proxy-pool.ts";
import { normalizeProxyType } from "./proxy.ts";
import type { ProfileStore } from "./store.ts";
import type { ProxySpec } from "./types.ts";
import type { UiRuntimeOptions } from "./ui.ts";

export interface ProxyPoolRouteDeps {
  /** Save `proxy` as the profile's proxy, as the profile form does. */
  assign(profileId: string, proxy: ProxySpec): Promise<{ restartRequired?: true } | null>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function views(store: ProfileStore, nodes = store.proxyPool.list()) {
  const profiles = store.listProfiles().map(({ id, name, group, proxy }) => ({ id, name, group, proxy }));
  return poolNodeViews(nodes, profiles);
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ProxyPoolError(`${what} must be a list`);
  return value as string[];
}

export async function handleProxyPoolRequest(
  req: Request,
  store: ProfileStore,
  options: UiRuntimeOptions,
  deps: ProxyPoolRouteDeps,
): Promise<Response> {
  const action = new URL(req.url).pathname.replace(/^\/ui\/api\/proxy-pool\/?/, "");
  const pool = store.proxyPool;
  try {
    if (action === "" && req.method === "GET") return json({ ok: true, nodes: views(store) });
    if (req.method !== "POST") return json({ ok: false, error: "POST is required" }, 405);
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
      body = parsed as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "Invalid request" }, 400);
    }

    if (action === "import") {
      const type = body.type === undefined ? "http" : normalizeProxyType(body.type);
      const result = pool.importText(String(body.text ?? ""), { type, tags: body.tags });
      return json({
        ok: true,
        added: result.added.length,
        addedIds: result.added.map((node) => node.id),
        duplicates: result.duplicates,
        invalid: result.invalid,
      });
    }

    if (action === "update") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a proxy");
      const { id, ...patch } = body;
      const node = pool.update(id, patch);
      return json({ ok: true, node: views(store).find((view) => view.id === node.id) });
    }

    if (action === "delete") {
      const removed = pool.remove(stringList(body.ids, "ids"));
      return json({ ok: true, removed });
    }

    if (action === "assign") {
      if (typeof body.profileId !== "string" || typeof body.nodeId !== "string") throw new ProxyPoolError("Choose a profile and a proxy");
      const node = pool.get(body.nodeId);
      if (!node || node.disabled) return json({ ok: false, error: "This proxy is not available in the pool", code: "pool_node_unavailable" }, 409);
      const others = (poolUsage([node], store.listProfiles()).get(node.id) ?? []).filter((profile) => profile.id !== body.profileId);
      if (node.maxProfiles !== null && others.length >= node.maxProfiles) {
        return json({
          ok: false,
          error: "This proxy is already used by as many profiles as its sharing limit allows",
          code: "pool_exhausted",
          profiles: others.map(({ id, name, group }) => ({ id, name, group })),
        }, 409);
      }
      const saved = await deps.assign(body.profileId, node.proxy);
      if (!saved) return json({ ok: false, error: "no such profile" }, 404);
      // Profiles already on this exit, so the caller can show who shares it.
      return json({ ok: true, ...saved, sharedWith: others.map(({ id, name, group }) => ({ id, name, group })) });
    }

    if (action === "check") {
      const ids = body.ids === undefined ? null : new Set(stringList(body.ids, "ids"));
      const nodes = pool.list().filter((node) => !ids || ids.has(node.id));
      return streamChecks(store, nodes, options, req.signal);
    }

    return json({ ok: false, error: "Unknown proxy pool operation" }, 404);
  } catch (error) {
    if (error instanceof ProxyPoolError) return json({ ok: false, error: error.message }, error.status);
    if (error instanceof Error && /unsupported proxy type/.test(error.message)) return json({ ok: false, error: "Unsupported proxy type" }, 400);
    return json({ ok: false, error: "Proxy pool operation failed" }, 500);
  }
}

/** NDJSON: {type:"progress"}, {type:"node", node} for each result, then {type:"done"}. */
function streamChecks(store: ProfileStore, nodes: PoolNode[], options: UiRuntimeOptions, signal: AbortSignal): Response {
  let gone = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => {
        if (gone) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { gone = true; }
      };
      let completed = 0;
      send({ type: "progress", completed, total: nodes.length });
      try {
        await checkPoolNodes(store.proxyPool, nodes, {
          check: options.proxyCheck ? (proxy) => options.proxyCheck!(proxy) : (proxy, opts) => checkProxy(proxy, { direct: opts.direct }),
          direct: options.proxyCheck ? async () => null : () => fetchDirectEgress(),
          cancelled: () => gone || signal.aborted,
          onResult: (node) => {
            send({ type: "node", node: views(store, [store.proxyPool.get(node.id) ?? node])[0] });
            send({ type: "progress", completed: ++completed, total: nodes.length });
          },
        });
        send({ type: "done" });
      } catch {
        send({ type: "error", error: "Proxy check failed" });
      } finally {
        try { controller.close(); } catch {}
      }
    },
    cancel() { gone = true; },
  }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

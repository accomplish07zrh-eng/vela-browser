/**
 * Proxy pool routes for the dashboard (/ui/api/proxy-pool...). Responses never carry a node's
 * credentials. Giving one profile a node goes through the same save as the profile form, so the
 * timezone follows the new exit and an open browser keeps its proxy until its next start.
 */

import { fetchDirectEgress } from "./egress.ts";
import { checkProxy } from "./proxy-check.ts";
import { checkPoolNodes, poolNodeViews, poolUsage, ProxyPoolError, subscriptionView, type PoolNode } from "./proxy-pool.ts";
import { fetchSubscription, SubscriptionError } from "./subscription.ts";
import type { KernelSupervisor } from "./kernel.ts";
import { normalizeProxyType } from "./proxy.ts";
import type { ProfileStore } from "./store.ts";
import type { ProxySpec } from "./types.ts";
import type { UiRuntimeOptions } from "./ui.ts";

export interface ProxyPoolRouteDeps {
  /** Save `proxy` as the profile's proxy, as the profile form does. */
  assign(profileId: string, proxy: ProxySpec): Promise<{ restartRequired?: true } | null>;
  /** Runs kernel-protocol nodes for checks. Without it those nodes cannot be checked. */
  kernels?: Pick<KernelSupervisor, "startTemporary">;
  /** Injectable for tests. */
  fetchSubscription?: typeof fetchSubscription;
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
    if (action === "" && req.method === "GET") {
      return json({ ok: true, nodes: views(store), subscriptions: pool.listSubscriptions().map(subscriptionView) });
    }
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
      return streamChecks(store, nodes, options, req.signal, deps);
    }

    if (action === "subscriptions/add") {
      if (typeof body.url !== "string") throw new ProxyPoolError("Paste a subscription link");
      const sub = pool.addSubscription({
        url: body.url,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.userAgent === "string" ? { userAgent: body.userAgent } : {}),
      });
      return json(await refreshSubscription(store, sub.id, deps));
    }

    if (action === "subscriptions/refresh") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a subscription");
      return json(await refreshSubscription(store, body.id, deps));
    }

    if (action === "subscriptions/rename") {
      if (typeof body.id !== "string" || typeof body.name !== "string") throw new ProxyPoolError("Choose a subscription");
      pool.renameSubscription(body.id, body.name);
      return json({ ok: true });
    }

    if (action === "subscriptions/delete") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a subscription");
      const used = poolUsage(pool.list(), store.listProfiles());
      return json({ ok: true, ...pool.removeSubscription(body.id, (node) => (used.get(node.id) ?? []).length > 0) });
    }

    return json({ ok: false, error: "Unknown proxy pool operation" }, 404);
  } catch (error) {
    if (error instanceof ProxyPoolError) return json({ ok: false, error: error.message }, error.status);
    if (error instanceof Error && /unsupported proxy type/.test(error.message)) return json({ ok: false, error: "Unsupported proxy type" }, 400);
    return json({ ok: false, error: "Proxy pool operation failed" }, 500);
  }
}

/** Fetch a subscription and bring its nodes in line. The link never appears in the answer. */
async function refreshSubscription(store: ProfileStore, id: string, deps: ProxyPoolRouteDeps) {
  const pool = store.proxyPool;
  const sub = pool.getSubscription(id);
  if (!sub) throw new ProxyPoolError("This subscription is no longer here", 404);
  try {
    const fetched = await (deps.fetchSubscription ?? fetchSubscription)(sub.url, sub.userAgent ? { userAgent: sub.userAgent } : {});
    const result = pool.syncSubscription(id, fetched.parsed.nodes, { ...fetched.parsed, ...(fetched.usage ? { usage: fetched.usage } : {}) });
    return {
      ok: true,
      subscription: subscriptionView(pool.getSubscription(id)!),
      ...result,
      format: fetched.parsed.format,
      nonNodes: fetched.parsed.nonNodes,
      infoEntries: fetched.parsed.infoEntries.length,
      unsupported: fetched.parsed.unsupported,
    };
  } catch (error) {
    const message = error instanceof SubscriptionError ? error.message : "The subscription could not be read";
    pool.recordSubscriptionFailure(id, message);
    throw new ProxyPoolError(message, 502);
  }
}

/** NDJSON: {type:"progress"}, {type:"node", node} for each result, then {type:"done"}. */
function streamChecks(store: ProfileStore, nodes: PoolNode[], options: UiRuntimeOptions, signal: AbortSignal, deps: ProxyPoolRouteDeps): Response {
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
      // Kernel-protocol nodes are checked through one temporary kernel, one inbound each, which
      // carries no profile's traffic and stops when the checks end.
      const kernelNodes = nodes.filter((node) => node.outbound);
      let temporary: Awaited<ReturnType<KernelSupervisor["startTemporary"]>> | undefined;
      try {
        if (kernelNodes.length && deps.kernels) {
          temporary = await deps.kernels.startTemporary(kernelNodes.map((node) => ({ tag: node.id, outbound: node.outbound! })));
        }
      } catch { /* each kernel node below reports "unavailable" */ }
      const route = (node: PoolNode): ProxySpec | null => node.outbound ? temporary?.specs.get(node.id) ?? null : node.proxy;
      try {
        await checkPoolNodes(store.proxyPool, nodes, {
          check: async (_proxy, opts, node) => {
            const via = route(node!);
            if (!via) throw new Error("no kernel");
            return options.proxyCheck ? options.proxyCheck(via) : checkProxy(via, { direct: opts.direct });
          },
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
        temporary?.process.stop();
        try { controller.close(); } catch {}
      }
    },
    cancel() { gone = true; },
  }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

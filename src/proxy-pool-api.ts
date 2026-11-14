/**
 * Proxy pool routes for the dashboard (/ui/api/proxy-pool...). Responses never carry a node's
 * credentials. Giving one profile a node goes through the same save as the profile form, so the
 * timezone follows the new exit and an open browser keeps its proxy until its next start.
 */

import { fetchDirectEgress } from "./egress.ts";
import { checkProxy } from "./proxy-check.ts";
import { checkPoolNodes, poolNodeViews, poolUsage, ProxyPoolError, subscriptionView, UNREADABLE_SUBSCRIPTION, type PoolCheck, type PoolNode } from "./proxy-pool.ts";
import { SecretUnavailableError } from "./secret-box.ts";
import { fetchSubscription, SubscriptionError } from "./subscription.ts";
import { KernelBinaryError, type KernelSupervisor } from "./kernel.ts";
import { ProxySwitchError, type SwitchResult } from "./proxy-switch.ts";
import { normalizeProxyType } from "./proxy.ts";
import type { ProfileStore } from "./store.ts";
import type { ProxySpec } from "./types.ts";
import type { UiRuntimeOptions } from "./ui.ts";

export interface ProxyPoolRouteDeps {
  /** Save `proxy` as the profile's proxy, as the profile form does. */
  assign(profileId: string, proxy: ProxySpec, opts?: { poolTimezone?: string; poolCountry?: string }): Promise<{ restartRequired?: true } | null>;
  /** Runs kernel-protocol nodes for checks. Without it those nodes cannot be checked. */
  kernels?: Pick<KernelSupervisor, "startTemporary">;
  /** Injectable for tests. */
  fetchSubscription?: typeof fetchSubscription;
  /** Change a profile's proxy to a pool node, reopening its browser if open (proxy-switch.ts). */
  switchProxy?: (profileId: string, nodeId: string, by: string) => Promise<SwitchResult>;
}

/** HTTP status for each reason a switch stops. */
export const SWITCH_STATUS: Record<string, number> = {
  no_such_profile: 404, node_unavailable: 409, pool_exhausted: 409, rate_limited: 429, profile_busy: 409,
  switch_check_failed: 422, teardown_unconfirmed: 500, reopen_failed: 500, exit_is_direct: 500,
};

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
    if (action === "history" && req.method === "GET") {
      const profileId = new URL(req.url).searchParams.get("profileId");
      if (!profileId) return json({ ok: false, error: "Choose a profile" }, 400);
      return json({ ok: true, history: pool.switchHistory(profileId, 20) });
    }

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

    if (action === "switch") {
      if (typeof body.profileId !== "string" || typeof body.nodeId !== "string") throw new ProxyPoolError("Choose a profile and a proxy");
      if (!deps.switchProxy) return json({ ok: false, error: "Proxy pool operation failed" }, 500);
      try {
        return json({ ok: true, ...(await deps.switchProxy(body.profileId, body.nodeId, "dashboard")) });
      } catch (error) {
        if (!(error instanceof ProxySwitchError)) throw error;
        return json({ ok: false, code: error.code, error: error.message, ...error.detail }, SWITCH_STATUS[error.code] ?? 500);
      }
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
        ...(body.refreshHours !== undefined ? { refreshHours: body.refreshHours } : {}),
      });
      return json(await refreshPoolSubscription(store, sub.id, { ...deps, ...(options.shutdownSignal ? { signal: options.shutdownSignal } : {}) }));
    }

    if (action === "subscriptions/refresh") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a subscription");
      return json(await refreshPoolSubscription(store, body.id, { ...deps, ...(options.shutdownSignal ? { signal: options.shutdownSignal } : {}) }));
    }

    if (action === "subscriptions/rename") {
      if (typeof body.id !== "string" || typeof body.name !== "string") throw new ProxyPoolError("Choose a subscription");
      const subscription = pool.updateSubscription(body.id, { name: body.name });
      return json({ ok: true, subscription: subscriptionView(subscription) });
    }

    if (action === "subscriptions/update") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a subscription");
      if (body.name === undefined && body.refreshHours === undefined) throw new ProxyPoolError("Choose a subscription");
      const subscription = pool.updateSubscription(body.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.refreshHours !== undefined ? { refreshHours: body.refreshHours } : {}),
      });
      return json({ ok: true, subscription: subscriptionView(subscription) });
    }

    if (action === "subscriptions/delete") {
      if (typeof body.id !== "string") throw new ProxyPoolError("Choose a subscription");
      const used = poolUsage(pool.list(), store.listProfiles());
      return json({ ok: true, ...pool.removeSubscription(body.id, (node) => (used.get(node.id) ?? []).length > 0) });
    }

    return json({ ok: false, error: "Unknown proxy pool operation" }, 404);
  } catch (error) {
    if (error instanceof ProxyPoolError) return json({ ok: false, error: error.message }, error.status);
    if (error instanceof SecretUnavailableError) return json({ ok: false, error: "Encrypted storage is unavailable right now" }, 503);
    if (error instanceof Error && /unsupported proxy type/.test(error.message)) return json({ ok: false, error: "Unsupported proxy type" }, 400);
    return json({ ok: false, error: "Proxy pool operation failed" }, 500);
  }
}

/**
 * Check pool nodes and record the results. Kernel-protocol nodes start together in one temporary
 * kernel when all configs are valid; if kernel startup fails for a batch, recursively bisect to
 * isolate broken node configs so healthy nodes in the batch still get checked. KernelBinaryError
 * stops bisection immediately because the kernel executable itself cannot start.
 */
export async function runPoolChecks(
  store: ProfileStore,
  nodes: PoolNode[],
  opts: {
    kernels?: Pick<KernelSupervisor, "startTemporary">;
    check?: (proxy: ProxySpec, direct: import("./egress.ts").EgressInfo | null) => Promise<import("./proxy-check.ts").ProxyCheckResult>;
    direct?: () => Promise<import("./egress.ts").EgressInfo | null>;
    cancelled?: () => boolean;
    signal?: AbortSignal;
    onResult?: (node: PoolNode) => void;
    now?: () => number;
  } = {},
): Promise<void> {
  const isCancelled = () => Boolean(opts.cancelled?.() || opts.signal?.aborted);
  if (!nodes.length || isCancelled()) return;
  const now = opts.now ?? Date.now;
  const directInfo = await (opts.direct ?? (() => fetchDirectEgress()))().catch(() => null);
  if (isCancelled()) return;
  const directFn = async () => directInfo;
  const checkOne = (via: ProxySpec, direct: import("./egress.ts").EgressInfo | null) =>
    opts.check ? opts.check(via, direct) : checkProxy(via, { direct });

  const plainNodes = nodes.filter((node) => !node.outbound);
  const kernelNodes = nodes.filter((node) => !!node.outbound);

  const recordStatic = (batch: PoolNode[], status: PoolCheck["status"], reason: string) => {
    for (const node of batch) {
      if (isCancelled()) return;
      const check: PoolCheck = { status, reason, checkedAt: now() };
      store.proxyPool.recordCheck(node.id, check);
      opts.onResult?.(node);
    }
  };

  const checkKernelBatch = async (batch: PoolNode[]): Promise<void> => {
    if (!batch.length || isCancelled()) return;
    if (!opts.kernels) {
      recordStatic(batch, "unavailable", "check_unavailable");
      return;
    }
    let temporary: Awaited<ReturnType<KernelSupervisor["startTemporary"]>> | undefined;
    try {
      const entries = batch.map((node) => ({ tag: node.id, outbound: node.outbound! }));
      temporary = opts.signal
        ? await opts.kernels.startTemporary(entries, { signal: opts.signal })
        : await opts.kernels.startTemporary(entries);
    } catch (error) {
      if (isCancelled()) return;
      if (error instanceof KernelBinaryError) {
        recordStatic(batch, "unavailable", "check_unavailable");
        return;
      }
      if (batch.length === 1) {
        const reason = error instanceof Error && /timed out/i.test(error.message) ? "timeout" : "connection_failed";
        recordStatic(batch, "failed", reason);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await checkKernelBatch(batch.slice(0, mid));
      if (!isCancelled()) await checkKernelBatch(batch.slice(mid));
      return;
    }
    if (isCancelled()) {
      temporary.process.stop();
      return;
    }
    try {
      await checkPoolNodes(store.proxyPool, batch, {
        check: async (_proxy, checkOpts, node) => {
          const via = temporary!.specs.get(node!.id);
          if (!via) throw new Error("no kernel");
          return checkOne(via, checkOpts.direct);
        },
        direct: directFn,
        now,
        cancelled: isCancelled,
        ...(opts.onResult ? { onResult: opts.onResult } : {}),
      });
    } finally {
      temporary.process.stop();
    }
  };

  const plainPromise = plainNodes.length
    ? checkPoolNodes(store.proxyPool, plainNodes, {
        check: (proxy, checkOpts) => checkOne(proxy, checkOpts.direct),
        direct: directFn,
        now,
        cancelled: isCancelled,
        ...(opts.onResult ? { onResult: opts.onResult } : {}),
      })
    : Promise.resolve();

  await Promise.all([plainPromise, checkKernelBatch(kernelNodes)]);
}

const inFlightRefreshes = new WeakMap<ProfileStore, Map<string, Promise<SubscriptionRefreshResponse>>>();
const activePoolWork = new WeakMap<ProfileStore, { tasks: Set<Promise<unknown>>; controllers: Set<AbortController> }>();

function trackPoolWork<T>(store: ProfileStore, promise: Promise<T>, controller: AbortController): Promise<T> {
  if (!store || typeof store !== "object") return promise;
  let bucket = activePoolWork.get(store);
  if (!bucket) {
    bucket = { tasks: new Set(), controllers: new Set() };
    activePoolWork.set(store, bucket);
  }
  bucket.tasks.add(promise);
  bucket.controllers.add(controller);
  return promise.finally(() => {
    bucket!.tasks.delete(promise);
    bucket!.controllers.delete(controller);
  });
}

/** Abort and wait for active subscription refreshes and pool check streams on `store` before closing DB. */
export async function drainPoolTasks(store: ProfileStore): Promise<void> {
  if (!store || typeof store !== "object") return;
  const bucket = activePoolWork.get(store);
  if (!bucket) return;
  for (const controller of [...bucket.controllers]) controller.abort();
  await Promise.allSettled([...bucket.tasks]);
}

export interface SubscriptionRefreshResponse {
  ok: true;
  subscription: ReturnType<typeof subscriptionView>;
  added: number;
  kept: number;
  removed: number;
  format: string;
  nonNodes: number;
  infoEntries: number;
  unsupported: Array<{ name: string; reason: string }>;
}

/** Fetch a subscription and bring its nodes in line. The link never appears in the answer. */
export async function refreshPoolSubscription(
  store: ProfileStore,
  id: string,
  deps: { fetchSubscription?: typeof fetchSubscription; signal?: AbortSignal } = {},
): Promise<SubscriptionRefreshResponse> {
  if (deps.signal?.aborted) throw new ProxyPoolError("Subscription refresh interrupted", 499);
  let bySub = inFlightRefreshes.get(store);
  if (!bySub) {
    bySub = new Map();
    inFlightRefreshes.set(store, bySub);
  }
  const existing = bySub.get(id);
  if (existing) return existing;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onAbort, { once: true });

  const task = (async (): Promise<SubscriptionRefreshResponse> => {
    const pool = store.proxyPool;
    const sub = pool.getSubscription(id);
    if (!sub) throw new ProxyPoolError("This subscription is no longer here", 404);
    if (sub.unreadable) throw new ProxyPoolError(UNREADABLE_SUBSCRIPTION, 409);
    try {
      const fetchOpts: { userAgent?: string; signal?: AbortSignal } = {
        ...(sub.userAgent ? { userAgent: sub.userAgent } : {}),
        signal: controller.signal,
      };
      const fetched = await (deps.fetchSubscription ?? fetchSubscription)(sub.url, fetchOpts);
      if (controller.signal.aborted) throw new ProxyPoolError("Subscription refresh interrupted", 499);
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
      if (error instanceof ProxyPoolError) throw error;
      if (controller.signal.aborted) throw new ProxyPoolError("Subscription refresh interrupted", 499);
      const message = error instanceof SubscriptionError ? error.message : "The subscription could not be read";
      if (pool.getSubscription(id)) pool.recordSubscriptionFailure(id, message);
      throw new ProxyPoolError(message, 502);
    }
  })().finally(() => {
    deps.signal?.removeEventListener("abort", onAbort);
    if (bySub.get(id) === task) bySub.delete(id);
  });

  bySub.set(id, task);
  return trackPoolWork(store, task, controller);
}

/** NDJSON: {type:"progress"}, {type:"node", node} for each result, then {type:"done"}. */
function streamChecks(store: ProfileStore, nodes: PoolNode[], options: UiRuntimeOptions, signal: AbortSignal, deps: ProxyPoolRouteDeps): Response {
  let gone = false;
  const taskController = new AbortController();
  let resolveWork!: () => void;
  const workDone = new Promise<void>((resolve) => { resolveWork = resolve; });
  void trackPoolWork(store, workDone, taskController);
  const abortAll = () => {
    gone = true;
    taskController.abort();
  };
  if (signal.aborted || options.shutdownSignal?.aborted) abortAll();
  signal.addEventListener("abort", abortAll, { once: true });
  options.shutdownSignal?.addEventListener("abort", abortAll, { once: true });

  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => {
        if (gone || taskController.signal.aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { abortAll(); }
      };
      let completed = 0;
      send({ type: "progress", completed, total: nodes.length });
      try {
        await runPoolChecks(store, nodes, {
          ...(deps.kernels ? { kernels: deps.kernels } : {}),
          ...(options.proxyCheck ? { check: (proxy) => options.proxyCheck!(proxy), direct: async () => null } : {}),
          cancelled: () => gone || taskController.signal.aborted,
          signal: taskController.signal,
          onResult: (node) => {
            if (gone || taskController.signal.aborted) return;
            const latest = store.proxyPool.get(node.id);
            if (!latest) return;
            send({ type: "node", node: views(store, [latest])[0] });
            send({ type: "progress", completed: ++completed, total: nodes.length });
          },
        });
        if (!gone && !taskController.signal.aborted) send({ type: "done" });
      } catch {
        if (!gone && !taskController.signal.aborted) send({ type: "error", error: "Proxy check failed" });
      } finally {
        signal.removeEventListener("abort", abortAll);
        options.shutdownSignal?.removeEventListener("abort", abortAll);
        try { controller.close(); } catch {}
        resolveWork();
      }
    },
    cancel() { abortAll(); },
  }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

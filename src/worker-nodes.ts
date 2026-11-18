import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { BrowserTaskActor, BrowserTaskSupervisor } from "./browser-tasks.ts";
import { agentKey } from "./ai-access.ts";
import { MAX_PORTABLE_BYTES, type PortableProfiles } from "./portable-profiles.ts";
import type { ProfileStore } from "./store.ts";

export const WORKER_PATH = "/api/worker/v1";
type NodeConfig = { url: string; token: string; agents?: string[]; caFile?: string };
type ClientConfig = { name: string; token: string; groups: string[]; agents?: string[] };
const AGENT_HEADER = "x-vela-worker-agent";
const HEALTH_TIMEOUT = 3000;

function token(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}
function match(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function field(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("Provide " + name);
  return value;
}

function agentList(value: unknown): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 100 || value.some(name => typeof name !== "string" ||
    !name.trim() || name.length > 64 || agentKey(name) === "unknown")) throw new Error("Invalid Worker Agent list");
  return [...new Set(value.map(agentKey))];
}

function workerActor(client: ClientConfig, agent?: string): BrowserTaskActor {
  return agent === undefined ? { scope: "worker-legacy:" + client.name, name: "worker:" + client.name }
    : { scope: "worker:" + client.name, name: agentKey(agent) };
}

function listed(agents: string[] | undefined, name: string): boolean {
  return agents?.includes(agentKey(name)) ?? true;
}

async function body(request: Request, limit: number): Promise<Buffer> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new Error("Worker request exceeded its size limit");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Worker request has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error("Worker request exceeded its size limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
}

function workerUrl(value: unknown): URL {
  const url = new URL(field(value, "worker URL"));
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password
    || url.search || url.hash || url.pathname !== "/") throw new Error("Worker nodes use an HTTPS origin or a loopback test origin");
  return url;
}

export class WorkerNodes {
  private readonly probes = new Map<string, { signature: string; at: number; result: Promise<{ id: string; checkedAt: string; reachable: boolean; status?: unknown }> }>();

  constructor(private readonly options: { config: string; store: ProfileStore; tasks: BrowserTaskSupervisor; portable: PortableProfiles;
    capacity?(): { size: number; host?: { paused: boolean; available: number; inUse: number } } }) {}

  private config(): { clients: ClientConfig[]; nodes: Record<string, NodeConfig> } {
    if (!existsSync(this.options.config)) return { clients: [], nodes: {} };
    const file = object(JSON.parse(readFileSync(this.options.config, "utf8")));
    const clients = Array.isArray(file.clients) ? file.clients.map(value => {
      const item = object(value);
      if (!token(item.token) || !Array.isArray(item.groups) || !item.groups.every(group => typeof group === "string")) throw new Error("Invalid worker client settings");
      const name = field(item.name, "worker client name").trim();
      if (name.length > 48 || /[\u0000-\u001f]/.test(name)) throw new Error("Invalid Worker client name");
      return { name, token: item.token, groups: item.groups, agents: agentList(item.agents) };
    }) : [];
    if (new Set(clients.map(client => client.name)).size !== clients.length ||
      new Set(clients.map(client => client.token)).size !== clients.length) throw new Error("Worker clients need unique names and credentials");
    const nodes = Object.fromEntries(Object.entries(object(file.nodes ?? {})).map(([id, value]) => {
      const node = object(value);
      if (!token(node.token)) throw new Error("Invalid worker credential for " + id);
      const agents = agentList(node.agents);
      const url = workerUrl(node.url);
      const caFile = node.caFile === undefined ? undefined : field(node.caFile, "Worker TLS CA file");
      if (caFile && url.protocol !== "https:") throw new Error("A Worker CA requires HTTPS");
      return [id, { url: url.origin, token: node.token, agents, caFile }];
    }));
    return { clients, nodes };
  }

  allows(actor: BrowserTaskActor, group: string): boolean {
    try {
      const clients = this.config().clients;
      const client = clients.find(client => actor.scope === workerActor(client).scope || actor.scope === "worker:" + client.name);
      if (!client || !client.groups.includes(group)) return false;
      return actor.scope === "worker:" + client.name ? listed(client.agents, actor.name) : client.agents === undefined;
    } catch { return false; }
  }

  async serve(request: Request, pathname: string): Promise<Response> {
    try {
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const client = token(supplied) ? this.config().clients.find(item => match(supplied, item.token)) : undefined;
      if (!client) return Response.json({ ok: false, error: "Worker access denied" }, { status: 401 });
      if (request.method !== "POST") return Response.json({ ok: false, error: "Use POST" }, { status: 405 });
      const { tasks, portable, store } = this.options;
      const header = request.headers.get(AGENT_HEADER);
      let agent: string | undefined;
      if (header !== null) {
        try {
          const name = decodeURIComponent(header);
          if (name.length > 64 || agentKey(name) === "unknown" || !listed(client.agents, name)) throw new Error();
          agent = name;
        } catch { return Response.json({ ok: false, error: "Worker Agent access denied" }, { status: 403 }); }
      } else if (client.agents !== undefined) return Response.json({ ok: false, error: "Worker Agent identity is required" }, { status: 403 });
      const actor = workerActor(client, agent);
      const permitted = (group: string) => this.allows(actor, group);
      const authorize = (profileId: string) => {
        const profile = store.getProfile(profileId);
        if (!profile || !permitted(profile.group)) throw new Error("Worker access denied for this profile");
      };
      if (pathname === WORKER_PATH + "/handoff") {
        const packet = await body(request, MAX_PORTABLE_BYTES);
        const result = await portable.restore(packet, client.token, profile => {
          if (!permitted(profile.group)) throw new Error("Worker access denied for this profile group");
        });
        return Response.json({ ok: true, result });
      }
      const input = object(JSON.parse((await body(request, 1024 * 1024)).toString("utf8")));
      const operation = input.operation;
      if (operation === "health") {
        const capacity = this.options.capacity?.(), queue = tasks.queueStatus();
        return Response.json({ ok: true, result: { ready: true, platform: process.platform, arch: process.arch,
          running: queue.running, waiting: queue.waiting, limit: capacity?.size ?? null,
          memoryPaused: capacity?.host?.paused ?? false,
          availableMiB: capacity?.host ? Math.floor(capacity.host.available / 1048576) : null } });
      }
      if (operation === "prepare-handoff") {
        if (typeof input.group !== "string" || !permitted(input.group)) throw new Error("Worker access denied for this profile group");
        if (input.engine !== "webkit" && (input.platform !== process.platform || input.arch !== process.arch)) {
          throw new Error("Send native data to a worker with the same operating system and architecture");
        }
        portable.checkDestination(field(input.profileId, "profileId"),
          input.revision === undefined ? undefined : field(input.revision, "revision"), true);
        return Response.json({ ok: true, result: { ready: true } });
      }
      if (operation === "start") {
        const profileId = field(input.profileId, "profileId");
        authorize(profileId);
        const key = field(input.idempotencyKey, "idempotencyKey");
        if (key.length > 256) throw new Error("idempotencyKey must be 1 to 256 characters");
        const previousKey = createHash("sha256").update(JSON.stringify([workerActor(client).name, key])).digest("hex");
        const idempotencyKey = agent === undefined ? previousKey : key;
        const task = tasks.start(profileId, actor, { ...input, idempotencyKey, unattended: true }, agent === undefined ? undefined : previousKey);
        return Response.json({ ok: true, result: { task } });
      }
      const runId = field(input.runId, "runId"), task = tasks.status(runId, actor);
      authorize(task.profileId);
      if (operation === "status") return Response.json({ ok: true, result: { task } });
      if (operation === "pause" || operation === "cancel") return Response.json({
        ok: true, result: tasks.stop(runId, operation === "pause" ? "paused" : "cancelled", actor),
      });
      if (operation === "resume") return Response.json({ ok: true, result: { task: tasks.resume(runId, actor, input.verify, input.expectedAttempt) } });
      if (operation === "delegate") {
        const delegates = agentList(input.delegates);
        if (!delegates || delegates.some(name => !listed(client.agents, name)) || agent === undefined) throw new Error("Delegates need access to this Worker");
        return Response.json({ ok: true, result: { task: tasks.setDelegates(runId, delegates, actor) } });
      }
      if (operation === "evidence") {
        const { sequence, part = "summary", offset = 0, bytes = 65536 } = input;
        if (typeof sequence !== "number" || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
          typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1048576 || typeof part !== "string") {
          throw new Error("Invalid evidence range");
        }
        return Response.json({ ok: true, result: { evidence: tasks.evidence(runId, sequence, part, offset, bytes, actor) } });
      }
      throw new Error("Unknown worker operation");
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Worker request failed" }, { status: 400 });
    }
  }

  private async request(node: NodeConfig, client: string, path: string, payload: BodyInit, contentType: string, signal?: AbortSignal, wait = 180_000) {
    const timeout = AbortSignal.timeout(wait);
    const tls = node.caFile ? { ca: readFileSync(node.caFile, "utf8") } : undefined;
    const reply = await fetch(node.url + path, {
      method: "POST", body: payload, headers: { authorization: "Bearer " + node.token, "content-type": contentType,
        ...(agentKey(client) !== "unknown" ? { [AGENT_HEADER]: encodeURIComponent(agentKey(client)) } : {}) },
      ...(tls ? { tls } : {}),
      redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const result = await reply.json() as { ok: boolean; result?: unknown; error?: string };
    if (!reply.ok || !result.ok) throw new Error(result.error ?? "Worker request failed");
    return result.result;
  }

  private health(id: string, node: NodeConfig, client: string) {
    const key = JSON.stringify([id, agentKey(client)]);
    const now = Date.now();
    const signature = createHash("sha256").update(JSON.stringify([node.url, node.token, node.caFile])).digest("hex");
    const previous = this.probes.get(key);
    if (previous && previous.signature === signature && now - previous.at < 2000) return previous.result;
    for (const [key, entry] of this.probes) if (now - entry.at >= 2000) this.probes.delete(key);
    const result = this.request(node, client, WORKER_PATH + "/tasks", '{"operation":"health"}', "application/json", undefined, HEALTH_TIMEOUT)
      .then(status => ({ id, checkedAt: new Date().toISOString(), reachable: true, status }),
        () => ({ id, checkedAt: new Date().toISOString(), reachable: false }));
    this.probes.set(key, { signature, at: now, result });
    return result;
  }

  async call(params: Record<string, unknown>, client: string, authorize: (profileId: string) => void, signal?: AbortSignal) {
    const { nodes } = this.config();
    const allowed = (node: NodeConfig) => listed(node.agents, client);
    if (params.operation === "list") return { nodes: Object.entries(nodes).filter(([, node]) => allowed(node)).map(([id, node]) => ({ id, url: node.url })) };
    const id = field(params.node, "worker node");
    const node = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (!node || !allowed(node)) throw new Error("Worker node is unavailable to this Agent");
    if (params.operation === "health") {
      const status = await this.health(id, node, client);
      signal?.throwIfAborted();
      return status;
    }
    const call = (path: string, payload: BodyInit, contentType: string) => this.request(node, client, path, payload, contentType, signal);
    if (params.operation === "handoff") {
      const profileId = field(params.profileId, "profileId");
      authorize(profileId);
      const key = field(params.idempotencyKey, "idempotencyKey");
      const name = createHash("sha256").update(JSON.stringify([id, profileId, key])).digest("hex") + ".vela-profile";
      const portable = this.options.portable, store = this.options.store;
      if (!store.profileHandoff(profileId)) {
        const profile = store.getProfile(profileId);
        if (!profile) throw new Error("Profile was not found");
        await call(WORKER_PATH + "/tasks", JSON.stringify({
          operation: "prepare-handoff", profileId, group: profile.group, engine: profile.engine,
          platform: process.platform, arch: process.arch, revision: profile.kernelRevision,
        }), "application/json");
        await portable.export(profileId, name, node.token, true, signal);
      }
      const packet = portable.read(name, store.profileHandoff(profileId));
      return call(WORKER_PATH + "/handoff", packet as unknown as BodyInit, "application/octet-stream");
    }
    if (params.operation !== "task") throw new Error("Unknown worker operation");
    const request = object(params.request);
    // A controller can also dispatch to a profile that exists only on the Worker.
    // Profiles it manages locally must pass the calling Agent's local group scope.
    if (request.operation === "start" && typeof request.profileId === "string" && this.options.store.getProfile(request.profileId)) {
      authorize(request.profileId);
    }
    return call(WORKER_PATH + "/tasks", JSON.stringify(request), "application/json");
  }
}

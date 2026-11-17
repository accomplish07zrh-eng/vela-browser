import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { BrowserTaskSupervisor } from "./browser-tasks.ts";
import { MAX_PORTABLE_BYTES, type PortableProfiles } from "./portable-profiles.ts";
import type { ProfileStore } from "./store.ts";

export const WORKER_PATH = "/api/worker/v1";
type NodeConfig = { url: string; token: string; agents?: string[] };
type ClientConfig = { name: string; token: string; groups: string[] };

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
  constructor(private readonly options: { config: string; store: ProfileStore; tasks: BrowserTaskSupervisor; portable: PortableProfiles }) {}

  private config(): { clients: ClientConfig[]; nodes: Record<string, NodeConfig> } {
    if (!existsSync(this.options.config)) return { clients: [], nodes: {} };
    const file = object(JSON.parse(readFileSync(this.options.config, "utf8")));
    const clients = Array.isArray(file.clients) ? file.clients.map(value => {
      const item = object(value);
      if (!token(item.token) || !Array.isArray(item.groups) || !item.groups.every(group => typeof group === "string")) throw new Error("Invalid worker client settings");
      return { name: field(item.name, "worker client name").slice(0, 48), token: item.token, groups: item.groups };
    }) : [];
    const nodes = Object.fromEntries(Object.entries(object(file.nodes ?? {})).map(([id, value]) => {
      const node = object(value);
      if (!token(node.token)) throw new Error("Invalid worker credential for " + id);
      const agents = node.agents;
      if (agents !== undefined && (!Array.isArray(agents) || !agents.every(agent => typeof agent === "string"))) {
        throw new Error("Invalid Agent list for worker " + id);
      }
      return [id, { url: workerUrl(node.url).origin, token: node.token, agents }];
    }));
    return { clients, nodes };
  }

  async serve(request: Request, pathname: string): Promise<Response> {
    try {
      const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const client = token(supplied) ? this.config().clients.find(item => match(supplied, item.token)) : undefined;
      if (!client) return Response.json({ ok: false, error: "Worker access denied" }, { status: 401 });
      if (request.method !== "POST") return Response.json({ ok: false, error: "Use POST" }, { status: 405 });
      const { tasks, portable, store } = this.options;
      const principal = "worker:" + client.name;
      const permitted = (group: string) => client.groups.includes(group);
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
        const idempotencyKey = createHash("sha256").update(JSON.stringify([principal, key])).digest("hex");
        const task = tasks.start(profileId, principal, { ...input, idempotencyKey, unattended: true });
        return Response.json({ ok: true, result: { task } });
      }
      const runId = field(input.runId, "runId"), task = tasks.status(runId);
      authorize(task.profileId);
      if (task.client !== principal) throw new Error("This task belongs to a different worker client");
      if (operation === "status") return Response.json({ ok: true, result: { task } });
      if (operation === "cancel") return Response.json({ ok: true, result: tasks.stop(runId, "cancelled") });
      if (operation === "resume") return Response.json({ ok: true, result: { task: tasks.resume(runId, principal, input.verify) } });
      throw new Error("Unknown worker operation");
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "Worker request failed" }, { status: 400 });
    }
  }

  async call(params: Record<string, unknown>, client: string, authorize: (profileId: string) => void, signal?: AbortSignal) {
    const { nodes } = this.config();
    const allowed = (node: NodeConfig) => !node.agents || node.agents.includes(client);
    if (params.operation === "list") return { nodes: Object.entries(nodes).filter(([, node]) => allowed(node)).map(([id, node]) => ({ id, url: node.url })) };
    const id = field(params.node, "worker node");
    const node = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (!node || !allowed(node)) throw new Error("Worker node is unavailable to this Agent");
    const call = async (path: string, payload: BodyInit, contentType: string) => {
      const timeout = AbortSignal.timeout(180_000);
      const reply = await fetch(node.url + path, {
        method: "POST", body: payload, headers: { authorization: "Bearer " + node.token, "content-type": contentType },
        redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const result = await reply.json() as { ok: boolean; result?: unknown; error?: string };
      if (!reply.ok || !result.ok) throw new Error(result.error ?? "Worker request failed");
      return result.result;
    };
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
    return call(WORKER_PATH + "/tasks", JSON.stringify(request), "application/json");
  }
}

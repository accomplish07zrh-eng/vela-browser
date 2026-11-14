import { webkitPublicFields } from "./browser-capabilities.ts";
import { createLocalProfile, type NewProfileInput } from "./create.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import { callWebKitOwner, type WebKitOwner } from "./webkit-runtime.ts";
import { pointerAgent, validWorkbenchPointer } from "./workbench.ts";
import {
  BrowserLaunchError,
  type BrowserOpenOptions,
  type Launcher,
} from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import type { RemoteCoordinator } from "./remote.ts";
import {
  ProxyReplacementInputError,
} from "./proxy-replacements.ts";
import type { ProfileStore } from "./store.ts";
import { poolNodeViews, type PoolNode, type PoolNodeView } from "./proxy-pool.ts";
import type { ProxySpec } from "./types.ts";
import { runPoolChecks } from "./proxy-pool-api.ts";
import { ProxySwitchError, proxyLabel, saveProfileProxy, switchProfileProxy } from "./proxy-switch.ts";
import type { AiProxyPolicy, ProxyApprovalQueue } from "./proxy-approvals.ts";
import type { AiCodePolicy, CodeApprovalQueue, CodeApprovalRequest } from "./code-approvals.ts";
import { preparePlugin, scanPlugins, writePlugin } from "./plugins.ts";
import type { ScriptLibrary, ScriptSupervisor } from "./scripts.ts";
import { existsSync as pathExists } from "node:fs";
import { allowsGroup, ruleFor, type AiAccessSettings } from "./ai-access.ts";
import type { AuditLog } from "./audit.ts";
import { join as joinPath } from "node:path";

export const AGENT_CONTROL_PROTOCOL = "aliasmode-agent-v1";
export const AGENT_CONTROL_PATH = "/api/agent/v1/connect";
export const AGENT_CONTROL_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface AgentControlRequest {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentControlResponse {
  protocol: typeof AGENT_CONTROL_PROTOCOL;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AgentControlDeps {
  /** @deprecated Retained as an offline recovery type; no account runtime is used. */
  cloudConnection?: import("./cloud-connection.ts").CloudConnectionRuntime;
  cloudBrowser?: import("./cloud-browser.ts").CloudBrowserLifecycle;

  launcher: Launcher;
  store: ProfileStore;
  admission: LifecycleAdmissionController;
  firefoxCall?: (owner: FirefoxOwner, operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  webkitCall?: (owner: WebKitOwner, operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  remote?: RemoteCoordinator | null;
  /** AI actions count as work in that browser, so cooling leaves it alone. */
  activity?: import("./cooling.ts").ActivityLog;
  /** The enabled plugins, read from the plugins folder each time an AI lists or calls tools. */
  plugins?: () => import("./plugins.ts").PluginSpec[];
  /** People approve proxy changes an AI asks for here. Without it, such changes are refused unless allowed. */
  proxyApprovals?: ProxyApprovalQueue;
  /** The user's choice for AI proxy changes. Defaults to asking each time. */
  aiProxyPolicy?: () => AiProxyPolicy;
  /** Injectable exit check for proxy changes (tests). */
  proxySwitchCheck?: import("./proxy-switch.ts").SwitchDeps["check"];
  proxySwitchDirect?: import("./proxy-switch.ts").SwitchDeps["direct"];
  /** Injectable exit-timezone lookup for proxy changes (tests). */
  proxyTimezoneFetch?: import("./geoip.ts").FetchLike;
  /** The AI's human-like pointer, drawn over the browser's card on the workbench. */
  pointer?: (profileId: string, pointer: import("./workbench.ts").WorkbenchPointer) => void;
  /** Saved scripts and their runner: an AI lists, writes (with approval) and runs them. */
  scripts?: { library: ScriptLibrary; runner: ScriptSupervisor };
  /** The plugins folder, where a plugin an AI wrote lands once approved. */
  pluginsRoot?: string;
  /** People approve the scripts and plugins an AI asks to save here. */
  codeApprovals?: CodeApprovalQueue;
  /** The user's choice for code an AI saves. Defaults to asking each time. */
  aiCodePolicy?: () => AiCodePolicy;

  /** Which groups each AI may use. */
  aiAccess?: () => AiAccessSettings | undefined;
  /** Where what AIs did is recorded. */
  audit?: AuditLog;

  log?: (message: string) => void;
}

/** Calls that only read: kept out of the record so it stays readable. */
const UNAUDITED = new Set(["profiles.list", "browser.status", "plugins.list", "scripts.list", "scripts.get", "scripts.status", "scripts.log", "proxyPool.list", "workbench.pointer", "firefox.tools.list", "webkit.tools.list", "session.identify", "session.audit"]);

function humanizeParam(value: unknown): { enabled: boolean; speed: number; pasteOver: number | null; agent?: string } {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const speed = typeof input.speed === "number" && Number.isFinite(input.speed) ? Math.min(2.5, Math.max(0.4, input.speed)) : 1;
  const pasteOver = typeof input.pasteOver === "number" && Number.isInteger(input.pasteOver) && input.pasteOver >= 0 ? Math.min(input.pasteOver, 100_000) : null;
  const agent = pointerAgent(input.agent);
  return { enabled: input.enabled !== false, speed, pasteOver, ...(agent ? { agent } : {}) };
}

const FIREFOX_CAPABILITIES = ["firefox-native", "cookies", "navigation", "sessions", "mcp", "scripts"] as const;

type FirefoxLaunch = { engine?: "chromium" | "firefox" | "webkit"; firefoxOwner?: FirefoxOwner };

function isFirefoxEngine(launch: unknown): launch is FirefoxLaunch & { engine: "firefox" } {
  return (launch as FirefoxLaunch | null)?.engine === "firefox";
}

function isFirefoxLaunch(launch: unknown): launch is FirefoxLaunch & { engine: "firefox"; firefoxOwner: FirefoxOwner } {
  return isFirefoxEngine(launch) && !!launch.firefoxOwner;
}

function firefoxPublicFields(): { engine: "firefox"; capabilities: readonly string[] } {
  return { engine: "firefox", capabilities: FIREFOX_CAPABILITIES };
}

type SafeProfile = {
  id: string;
  name: string;
  group: string;
  platform: string;
  tags: string[];
  running: boolean;
  engine?: "firefox" | "webkit";
  capabilities?: readonly string[];
  debugPort?: number;
  headless?: boolean;
  expectedVersion?: number;
  permission?: "view" | "edit";
} & SafeProxyFields;

type SafeProxyFields = {
  proxyType?: Exclude<ProxySpec["type"], "pool">;
  proxyNodeId?: string;
  proxyNodeName?: string;
  proxyCountry?: string;
};

/**
 * Imported nodes can use their address, or even a secret, as their display name. Such a name is
 * left out. Only the secret parts are compared (addresses, logins, passwords, ids, the link), and
 * only when long enough to mean something, so ordinary names like "HK 100M" stay.
 */
function aiPoolName(node: PoolNode, subscriptionUrl?: string): string | undefined {
  const secrets: string[] = [];
  const add = (value: unknown) => {
    const text = typeof value === "string" || typeof value === "number" ? String(value).toLowerCase() : "";
    if (text.length >= 4) secrets.push(text);
  };
  if (node.proxy.type !== "pool") { add(node.proxy.host); add(node.proxy.user); add(node.proxy.pass); }
  const outbound = (node.outbound ?? {}) as Record<string, any>;
  for (const key of ["server", "uuid", "password", "username"]) add(outbound[key]);
  add(outbound.tls?.server_name);
  add(outbound.tls?.reality?.public_key);
  add(outbound.tls?.reality?.short_id);
  add(outbound.obfs?.password);
  add(outbound.transport?.headers?.Host);
  if (subscriptionUrl) { add(subscriptionUrl); try { add(new URL(subscriptionUrl).hostname); } catch { /* no host */ } }
  const name = node.name.toLowerCase();
  return name && !/https?:\/\//i.test(name) && !secrets.some((value) => name.includes(value)) ? node.name : undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agentError("invalid_request", "request parameters must be an object");
  }
  return value as Record<string, unknown>;
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value.trim()) {
    throw agentError("invalid_request", `${name} must be a non-empty string`);
  }
  return value.trim();
}

class AgentControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentControlError";
  }
}

function agentError(code: string, message: string): AgentControlError {
  return new AgentControlError(code, message);
}

function errorResponse(id: number, error: unknown): AgentControlResponse {
  if (error instanceof AgentControlError || error instanceof ProxyReplacementInputError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error instanceof AgentControlError ? error.code : "invalid_request",
        message: error.message,
      },
    };
  }
  if (error instanceof BrowserLaunchError) {
    return {
      protocol: AGENT_CONTROL_PROTOCOL,
      id,
      ok: false,
      error: {
        code: error.failure === "mode_conflict" ? "mode_conflict" : "browser_launch_failed",
        message: error.message,
      },
    };
  }
  return {
    protocol: AGENT_CONTROL_PROTOCOL,
    id,
    ok: false,
    error: {
      code: "operation_failed",
      message: error instanceof Error ? error.message : "Vela Browser operation failed",
    },
  };
}

export function parseAgentControlRequest(raw: string | Uint8Array): AgentControlRequest {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength;
  if (bytes === 0 || bytes > AGENT_CONTROL_MAX_MESSAGE_BYTES) {
    throw agentError("invalid_request", "agent request size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    throw agentError("invalid_request", "agent request must be valid JSON");
  }
  const request = object(value);
  if (
    request.protocol !== AGENT_CONTROL_PROTOCOL ||
    !Number.isSafeInteger(request.id) ||
    Number(request.id) < 1 ||
    typeof request.method !== "string" ||
    !request.method
  ) {
    throw agentError("invalid_request", "agent request has an invalid protocol shape");
  }
  if (request.params !== undefined) object(request.params);
  return request as unknown as AgentControlRequest;
}

export function validAgentAuthorization(header: string | null, nonce: string): boolean {
  return /^[a-f0-9]{64}$/.test(nonce) && header === `Bearer ${nonce}`;
}

export class AgentControlSession {
  private readonly openedByConnection = new Set<string>();
  private readonly openedEndpoints = new Map<string, string>();
  private readonly attachedExisting = new Set<string>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly sessionAbort = new AbortController();
  private cleanup?: Promise<void>;
  /** The AI on the other end, as its MCP client names itself. */
  private client = "unknown";

  constructor(private readonly deps: AgentControlDeps, private readonly openSignal?: AbortSignal) {}

  get agentName(): string { return this.client; }

  private profileGroup(profileId: string): { group: string; name?: string } | undefined {
    const profile = this.deps.store.getProfile(profileId);
    return profile ? { group: profile.group ?? "", name: profile.name } : undefined;
  }

  private accessRule() {
    let settings: AiAccessSettings | undefined;
    try { settings = this.deps.aiAccess?.(); } catch { settings = undefined; }
    return ruleFor(settings, this.client);
  }

  private mayUseGroup(group: string): boolean {
    const rule = this.accessRule();
    return rule === "all" || allowsGroup(rule, group, this.deps.store.listFolders());
  }

  /** Refuses a profile outside the groups this AI was given. */
  private guard(profileId: string): void {
    if (this.accessRule() === "all") return;
    const found = this.profileGroup(profileId);
    if (!found || !this.mayUseGroup(found.group)) {
      throw agentError("not_permitted", `${this.client} may not use this profile: its group is not one this AI was given in Vela Browser settings`);
    }
  }

  private audit(method: string, params: Record<string, unknown>, ok: boolean, error?: unknown): void {
    const audit = this.deps.audit;
    // Reads are left out, except when one was refused: a refusal is worth seeing.
    if (!audit || (UNAUDITED.has(method) && !(error instanceof AgentControlError && error.code === "not_permitted"))) return;
    const profileId = typeof params.profileId === "string" ? params.profileId : undefined;
    const action = method === "firefox.tools.call" || method === "webkit.tools.call" ? `page.${typeof params.name === "string" ? params.name : "tool"}` : method;
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    const detail = method === "scripts.run" ? `script ${String(params.scriptId ?? "")} on ${Array.isArray(params.profileIds) ? params.profileIds.length : 0} profiles`
      : method === "profiles.setProxy" ? "proxy change"
      : typeof args.url === "string" ? args.url : undefined;
    audit.record({
      actor: { kind: "ai", name: this.client }, action, ok,
      ...(profileId ? { profileId, profileName: this.profileGroup(profileId)?.name } : {}),
      ...(detail ? { detail } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
    return promise;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = Promise.all([this.queue, ...this.lanes.values()]).then(async () => {
      if (this.closed || this.sessionAbort.signal.aborted) throw agentError("connection_closed", "agent connection is closing");
      return await fn();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  enqueue(raw: string | Uint8Array): Promise<AgentControlResponse> {
    let request: AgentControlRequest;
    try {
      request = parseAgentControlRequest(raw);
    } catch (error) {
      return Promise.resolve(errorResponse(1, error));
    }
    const execute = async (): Promise<AgentControlResponse> => {
      if (this.closed) return errorResponse(request.id, agentError("connection_closed", "agent connection is closing"));
      try {
        return {
          protocol: AGENT_CONTROL_PROTOCOL,
          id: request.id,
          ok: true,
          result: await this.dispatch(request.method, request.params ?? {}).then(
            (result) => { this.audit(request.method, request.params ?? {}, true); return result; },
            (error) => { this.audit(request.method, request.params ?? {}, false, error); throw error; }),
        } satisfies AgentControlResponse;
      } catch (error) {
        return errorResponse(request.id, error);
      }
    };
    // Approval-capable RPCs validate, release the session queue while waiting on a human (abortable on
    // disconnect), then serialize the state mutation after approval so unrelated calls stay unblocked.
    if (["scripts.save", "plugins.save", "profiles.setProxy"].includes(request.method)) {
      return this.track(execute());
    }
    // Page actions of different browsers run side by side, so an AI can drive many windows at
    // once, each with its own pointer and keyboard. One browser still takes one action at a time,
    // and lifecycle requests wait for every action in flight.
    const lane = ["firefox.tools.call", "webkit.tools.call"].includes(request.method) && typeof request.params?.profileId === "string"
      ? request.params.profileId : undefined;
    if (lane) {
      const run = Promise.all([this.queue, this.lanes.get(lane)]).then(execute);
      const settled = run.then(() => undefined, () => undefined);
      this.lanes.set(lane, settled);
      void settled.then(() => { if (this.lanes.get(lane) === settled) this.lanes.delete(lane); });
      return this.track(run);
    }
    const run = Promise.all([this.queue, ...this.lanes.values()]).then(execute);
    this.queue = run.then(() => undefined, () => undefined);
    return this.track(run);
  }

  disconnect(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.sessionAbort.abort();
    this.cleanup = Promise.all([...this.inFlight, this.queue, ...this.lanes.values()]).then(async () => {
      for (const profileId of [...this.openedByConnection]) {
        await this.closeProfile(profileId).catch((error) => {
          this.deps.log?.(`agent cleanup for ${profileId} remains unconfirmed (${error instanceof Error ? error.message : "failed"})`);
        });
      }
    });
    return this.cleanup;
  }

  /** True while this connection opened or attached to the browser and has not let it go. */
  holds(profileId: string): boolean {
    return !this.closed && (this.openedByConnection.has(profileId) || this.attachedExisting.has(profileId));
  }

  get isClosed(): boolean { return this.closed; }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (typeof params.profileId === "string" && params.profileId) {
      this.guard(params.profileId.trim());
      this.deps.activity?.touch(params.profileId.trim());
    }
    switch (method) {
      case "session.identify": {
        // Named once, by the MCP client's own name; later calls cannot rename the connection.
        if (this.client === "unknown" && typeof params.name === "string" && params.name.trim()) this.client = params.name.trim().slice(0, 64);
        return { agent: this.client };
      }
      case "session.audit": {
        // Page actions in Chromium go straight to the browser; the MCP host reports them here.
        const profileId = typeof params.profileId === "string" ? params.profileId : undefined;
        this.deps.audit?.record({
          actor: { kind: "ai", name: this.client }, action: `page.${typeof params.tool === "string" ? params.tool.slice(0, 60) : "tool"}`,
          ok: params.ok !== false,
          ...(profileId ? { profileId, profileName: this.profileGroup(profileId)?.name } : {}),
          ...(typeof params.detail === "string" ? { detail: params.detail } : {}),
          ...(typeof params.error === "string" ? { error: params.error } : {}),
        });
        return {};
      }
      case "profiles.list":
        return { profiles: await this.listProfiles() };
      case "profiles.replaceProxies":
        throw agentError("accounts_removed", "Cloud proxy coordination has been removed");
      case "profiles.create":
        return await this.createProfile(params);
      case "profiles.update":
        return this.updateProfile(params);
      case "profiles.delete":
        return await this.deleteProfile(stringParam(params, "profileId"));
      case "browser.open":
        return await this.openProfile(params);
      case "browser.status":
        return await this.profileStatus(stringParam(params, "profileId"));
      case "plugins.list":
        return { plugins: this.pluginSpecs() };
      case "plugins.save":
        return await this.savePlugin(params);
      case "scripts.list":
        return { scripts: await this.scriptDeps().library.list() };
      case "scripts.get":
        return { script: await this.scriptDeps().library.get(stringParam(params, "scriptId")) };
      case "scripts.save":
        return await this.saveScript(params);
      case "scripts.run":
        return { run: this.runScript(params) };
      case "scripts.status":
        return { run: this.scriptDeps().runner.status() };
      case "scripts.log":
        return this.scriptLog(params);
      case "scripts.stop":
        return { run: await this.scriptDeps().runner.stop() };
      case "proxyPool.list":
        return { nodes: this.listPoolNodes(params) };
      case "proxyPool.check":
        return { nodes: await this.checkPoolNodes(params) };
      case "profiles.setProxy":
        return await this.setProfileProxy(params);
      case "workbench.pointer": {
        const agent = pointerAgent(params.agent);
        const pointer = { x: params.x, y: params.y, phase: params.phase, ...(agent ? { agent } : {}) };
        if (!validWorkbenchPointer(pointer)) throw agentError("invalid_request", "Invalid pointer");
        this.deps.pointer?.(stringParam(params, "profileId"), pointer);
        return {};
      }
      case "firefox.tools.list":
        return { tools: await this.firefoxCall(stringParam(params, "profileId"), "mcp-list", this.withPlugins({})) };
      case "firefox.tools.call":
        return await this.firefoxCall(stringParam(params, "profileId"), "mcp-call", this.withPlugins({
          name: stringParam(params, "name"),
          ...(params.arguments === undefined ? {} : { arguments: object(params.arguments) }),
          ...(params.humanize === undefined ? {} : { humanize: humanizeParam(params.humanize) }),
        }));
      case "webkit.tools.list":
        return { tools: await this.webkitCall(stringParam(params, "profileId"), "mcp-list", this.withPlugins({})) };
      case "webkit.tools.call":
        return await this.webkitCall(stringParam(params, "profileId"), "mcp-call", this.withPlugins({
          name: stringParam(params, "name"),
          ...(params.arguments === undefined ? {} : { arguments: object(params.arguments) }),
          ...(params.humanize === undefined ? {} : { humanize: humanizeParam(params.humanize) }),
        }));
      case "browser.detach":
        return this.detachProfile(stringParam(params, "profileId"));
      case "browser.close":
        return await this.closeProfile(stringParam(params, "profileId"),
          params.expectedEndpoint === undefined ? undefined : stringParam(params, "expectedEndpoint"));
      case "mcp.connectors.create":
      case "mcp.connectors.list":
      case "mcp.connectors.revoke":
        throw agentError("accounts_removed", "Cloud connectors have been removed from Vela Browser");
      default:
        throw agentError("unknown_method", `unknown agent method: ${method}`);
    }
  }

  /** The pool as an AI sees it: no credentials, no subscription links. */
  private poolViews(): PoolNodeView[] {
    const { store } = this.deps;
    const profiles = store.listProfiles().map(({ id, name, group, proxy }) => ({ id, name, group, proxy }));
    const nodes = store.proxyPool.list();
    const subscriptions = new Map(store.proxyPool.listSubscriptions().map((sub) => [sub.id, sub.url]));
    return poolNodeViews(nodes, profiles).map((view, index) => ({
      ...view,
      name: aiPoolName(nodes[index]!, subscriptions.get(nodes[index]!.subscriptionId ?? "")) ?? "",
    }));
  }

  private static aiNode(view: PoolNodeView) {
    const checkedCountry = view.check?.country?.toUpperCase();
    const country = checkedCountry && /^[A-Z]{2}$/.test(checkedCountry) ? checkedCountry : view.regionHint?.toUpperCase();
    return {
      nodeId: view.id,
      ...(view.name ? { name: view.name } : {}),
      protocol: view.protocol,
      ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
      ...(view.check?.city ? { city: view.check.city } : {}),
      status: view.check?.status ?? "unchecked",
      ...(view.check?.durationMs !== undefined ? { checkMs: view.check.durationMs } : {}),
      ...(view.check?.rotating ? { rotatingIp: true } : {}),
      ...(view.insecureTls ? { certificateNotChecked: true } : {}),
      ...(view.removedFromSource ? { noLongerInSubscription: true } : {}),
      ...(view.disabled ? { disabled: true } : {}),
      assignedProfiles: view.profiles.length,
      maxProfiles: view.maxProfiles,
      ...(view.sameExitAs.length ? { sameExitAsNodes: view.sameExitAs } : {}),
    };
  }

  private aiPoolNodes() {
    return new Map(this.poolViews().map((view) => {
      const node = AgentControlSession.aiNode(view);
      return [node.nodeId, node] as const;
    }));
  }

  private proxyFields(proxy: ProxySpec | null | undefined, nodes?: ReturnType<AgentControlSession["aiPoolNodes"]>): SafeProxyFields {
    if (!proxy) return {};
    if (proxy.type !== "pool") return { proxyType: proxy.type };
    const node = (nodes ?? this.aiPoolNodes()).get(proxy.host);
    return {
      proxyNodeId: proxy.host,
      ...(node?.name ? { proxyNodeName: node.name } : {}),
      ...(node?.country ? { proxyCountry: node.country } : {}),
    };
  }

  private aiProxyLabel(proxy: ProxySpec | null, nodes: ReturnType<AgentControlSession["aiPoolNodes"]>): string {
    if (!proxy) return "direct";
    if (proxy.type !== "pool") return proxy.type;
    const node = nodes.get(proxy.host);
    return node ? `${node.protocol}${node.name ? ` · ${node.name}` : ""}` : "pool node (removed)";
  }

  private listPoolNodes(params: Record<string, unknown>) {
    const country = typeof params.country === "string" && params.country.trim() ? params.country.trim().toUpperCase() : undefined;
    const tag = typeof params.tag === "string" && params.tag.trim() ? params.tag.trim() : undefined;
    const status = typeof params.status === "string" ? params.status : undefined;
    return this.poolViews()
      .filter((view) => (!tag || view.tags.includes(tag))
        && (params.available !== true || (!view.disabled && (view.maxProfiles === null || view.profiles.length < view.maxProfiles))))
      .map(AgentControlSession.aiNode)
      .filter((node) => (!country || node.country === country) && (!status || node.status === status));
  }

  private async checkPoolNodes(params: Record<string, unknown>) {
    const ids = params.nodeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((id) => typeof id !== "string")) {
      throw agentError("invalid_request", "nodeIds must list 1 to 50 node ids");
    }
    const wanted = new Set(ids as string[]);
    const nodes = this.deps.store.proxyPool.list().filter((node) => wanted.has(node.id));
    await runPoolChecks(this.deps.store, nodes, {
      kernels: this.deps.launcher.kernels,
      ...(this.deps.proxySwitchCheck ? { check: this.deps.proxySwitchCheck } : {}),
      ...(this.deps.proxySwitchDirect ? { direct: this.deps.proxySwitchDirect } : {}),
    });
    return this.poolViews().filter((view) => wanted.has(view.id)).map(AgentControlSession.aiNode);
  }

  /**
   * An AI asks to change a profile's exit. The user's setting decides: never, pool nodes freely,
   * or (by default) a person approves this one change on the dashboard. Then it is the same
   * switch as the dashboard's, recorded as made by this AI client.
   */
  private clientName(params: Record<string, unknown>): string {
    return (typeof params.client === "string" && params.client.trim() ? params.client.trim() : "AI").slice(0, 60);
  }

  /**
   * An AI renames a profile, moves it to another group or changes its tags. Nothing about its
   * identity, proxy or sign-ins can change this way; those stay with the person and the editor.
   */
  private updateProfile(params: Record<string, unknown>) {
    const profileId = stringParam(params, "profileId");
    const { store } = this.deps;
    const profile = store.getProfile(profileId);
    if (!profile) throw agentError("no_such_profile", "no such profile");
    const set = object(params.set);
    const unknown = Object.keys(set).filter((key) => !["name", "group", "tags"].includes(key));
    if (unknown.length) throw agentError("invalid_request", `Only name, group and tags can be changed here, not ${unknown.join(", ")}`);
    const next = { ...profile };
    if ("name" in set) {
      if (typeof set.name !== "string" || set.name.length > 120) throw agentError("invalid_request", "name must be text of at most 120 characters");
      next.name = set.name.trim();
    }
    if ("group" in set) {
      if (typeof set.group !== "string" || set.group.length > 120) throw agentError("invalid_request", "group must be text of at most 120 characters");
      next.group = set.group.trim();
    }
    if ("tags" in set) {
      if (!Array.isArray(set.tags) || set.tags.length > 50 || !set.tags.every((tag) => typeof tag === "string" && tag.length <= 60)) {
        throw agentError("invalid_request", "tags must be at most 50 strings of at most 60 characters");
      }
      next.tags = [...new Set((set.tags as string[]).map((tag) => tag.trim()).filter(Boolean))];
    }
    store.upsertProfile(next);
    return { profile: { id: next.id, name: next.name, group: next.group, tags: next.tags ?? [] } };
  }

  private scriptDeps(): { library: ScriptLibrary; runner: ScriptSupervisor } {
    if (!this.deps.scripts) throw agentError("unsupported", "Scripts need the Vela Browser desktop app");
    return this.deps.scripts;
  }

  /** The user's setting decides whether code an AI wrote is saved: never, always, or (by default) after a person reads it. */
  private async approveCode(request: CodeApprovalRequest): Promise<void> {
    const policy = this.deps.aiCodePolicy?.() ?? "ask";
    if (policy === "deny") throw agentError("approval_denied", "Saving scripts and plugins from an AI is turned off in Vela Browser");
    if (policy === "allow") return;
    if (!this.deps.codeApprovals) throw agentError("approval_denied", "No one can approve this now; nothing was saved");
    const outcome = await this.deps.codeApprovals.request(request, undefined, this.sessionAbort.signal);
    if (outcome === "aborted") throw agentError("connection_closed", "agent connection is closing");
    if (outcome === "timeout") throw agentError("approval_timeout", "No one approved it in time; nothing was saved");
    if (outcome === "denied") throw agentError("approval_denied", "It was not approved; nothing was saved");
  }

  private async saveScript(params: Record<string, unknown>) {
    const { library } = this.scriptDeps();
    if (params.scriptId !== undefined && (typeof params.scriptId !== "string" || !params.scriptId)) {
      throw agentError("invalid_request", "scriptId must be a non-empty string");
    }
    const scriptId = params.scriptId as string | undefined;
    const language = params.language === "python" || params.language === "javascript" ? params.language : null;
    if (!language) throw agentError("invalid_request", "language must be javascript or python");
    if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 120) throw agentError("invalid_request", "name must be 1 to 120 characters");
    if (params.description !== undefined && (typeof params.description !== "string" || params.description.length > 500)) throw agentError("invalid_request", "description must be at most 500 characters");
    if (typeof params.source !== "string" || !params.source.trim()) throw agentError("invalid_request", "source is empty");
    if (Buffer.byteLength(params.source, "utf8") > 1024 * 1024) throw agentError("invalid_request", "source is larger than 1 MB");
    const name = params.name.trim(), description = typeof params.description === "string" ? params.description : "", source = params.source;
    const existing = await this.serialize(async () => scriptId ? await library.get(scriptId) : null);
    await this.approveCode({
      kind: "script",
      action: existing ? "update" : "create",
      title: name,
      dedupeKey: scriptId ? `script:${scriptId}` : `script:new:${name}`,
      client: this.clientName(params),
      detail: existing ? `${language} · ${existing.id.slice(0, 8)}` : language,
      files: [{ name: `${name}.${language === "python" ? "py" : "mjs"}`, content: source }],
    });
    return await this.serialize(async () => {
      const saved = await library.save({ name, description, language, source }, scriptId, existing?.revision);
      return { script: { id: saved.id, name: saved.name, language: saved.language, revision: saved.revision } };
    });
  }

  private runScript(params: Record<string, unknown>) {
    const { runner } = this.scriptDeps();
    const scriptId = stringParam(params, "scriptId");
    const profileIds = params.profileIds;
    if (!Array.isArray(profileIds) || !profileIds.length || profileIds.length > 500 || !profileIds.every((id) => typeof id === "string" && id)) {
      throw agentError("invalid_request", "profileIds must list 1 to 500 profiles");
    }
    for (const id of profileIds as string[]) this.guard(id);
    for (const id of profileIds as string[]) if (!this.deps.store.getProfile(id)) throw agentError("no_such_profile", `no such profile: ${id}`);
    const inputs = params.inputs === undefined ? {} : object(params.inputs);
    if (params.concurrency !== undefined && (typeof params.concurrency !== "number" || !Number.isInteger(params.concurrency) || params.concurrency < 1 || params.concurrency > 50)) {
      throw agentError("invalid_request", "concurrency must be 1 to 50");
    }
    const concurrency = params.concurrency as number | undefined;
    // Saved sign-ins never go to a script an AI starts.
    return runner.start({ scriptId, profileIds: profileIds as string[], inputs, useCredentials: false, ...(concurrency ? { concurrency } : {}), startedBy: { kind: "ai", name: this.client } });
  }

  private scriptLog(params: Record<string, unknown>) {
    const { runner } = this.scriptDeps();
    const offset = typeof params.offset === "number" && Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    return runner.log(stringParam(params, "runId"), offset);
  }

  private async savePlugin(params: Record<string, unknown>) {
    const root = this.deps.pluginsRoot;
    if (!root) throw agentError("unsupported", "Plugins need the Vela Browser desktop app");
    const id = stringParam(params, "pluginId");
    let prepared: ReturnType<typeof preparePlugin>;
    try { prepared = preparePlugin({ id, manifest: object(params.manifest), module: typeof params.module === "string" ? params.module : "" }); }
    catch (error) { throw agentError("invalid_request", error instanceof Error ? error.message : String(error)); }
    const assertNoCollision = () => {
      const existing = scanPlugins(root);
      for (const spec of existing.specs) {
        if (spec.id === id) continue;
        for (const tool of spec.tools) {
          if (prepared.tools.includes(tool.toolName)) {
            throw agentError("invalid_request", `tool ${tool.toolName} is also provided by plugin ${spec.id}`);
          }
        }
      }
    };
    const action = await this.serialize(async () => {
      assertNoCollision();
      return pathExists(joinPath(root, id)) ? "update" as const : "create" as const;
    });
    await this.approveCode({
      kind: "plugin", action, title: id, dedupeKey: `plugin:${id}`, client: this.clientName(params),
      detail: prepared.tools.join(", "), files: prepared.files,
    });
    return await this.serialize(async () => {
      assertNoCollision();
      writePlugin(root, prepared);
      return { pluginId: id, tools: prepared.tools, note: "Select or open a browser again to load the plugin's tools." };
    });
  }

  private async setProfileProxy(params: Record<string, unknown>) {
    const profileId = stringParam(params, "profileId");
    const nodeId = stringParam(params, "nodeId");
    const client = (typeof params.client === "string" && params.client.trim() ? params.client.trim() : "AI").slice(0, 60);
    const { store, launcher } = this.deps;
    const approval = await this.serialize(async () => {
      const profile = store.getProfile(profileId);
      if (!profile) throw agentError("no_such_profile", "no such profile");
      const node = store.proxyPool.get(nodeId);
      if (!node || node.disabled) throw agentError("node_unavailable", "This proxy is not available in the pool");
      const policy = this.deps.aiProxyPolicy?.() ?? "ask";
      if (policy === "deny") throw agentError("approval_denied", "AI proxy changes are turned off in Vela Browser");
      if (policy !== "ask") return null;
      if (!this.deps.proxyApprovals) throw agentError("approval_denied", "No one can approve this proxy change now");
      return {
        profileId,
        profileName: profile.name || profileId,
        client,
        from: proxyLabel(store, profile.proxy),
        to: `${node.protocol} · ${node.name}`,
        reopens: !!store.getLaunch(profileId),
      };
    });
    if (approval) {
      const outcome = await this.deps.proxyApprovals!.request(approval, undefined, this.sessionAbort.signal);
      if (outcome === "aborted") throw agentError("connection_closed", "agent connection is closing");
      if (outcome === "timeout") throw agentError("approval_timeout", "No one approved this proxy change in time; nothing was changed");
      if (outcome === "denied") throw agentError("approval_denied", "The proxy change was not approved; nothing was changed");
    }
    return await this.serialize(async () => {
      const profile = store.getProfile(profileId);
      if (!profile) throw agentError("no_such_profile", "no such profile");
      const node = store.proxyPool.get(nodeId);
      if (!node || node.disabled) throw agentError("node_unavailable", "This proxy is not available in the pool");
      try {
        const nodes = this.aiPoolNodes();
        const previous = this.aiProxyLabel(profile.proxy ?? null, nodes);
        const next = this.aiProxyLabel({ type: "pool", host: node.id, port: "0", user: "", pass: "" }, nodes);
        const result = await switchProfileProxy({
          store, launcher, assign: (id, proxy, opts) => saveProfileProxy(store, id, proxy, this.deps.proxyTimezoneFetch, opts),
          ...(this.deps.proxySwitchCheck ? { check: this.deps.proxySwitchCheck } : {}),
          ...(this.deps.proxySwitchDirect ? { direct: this.deps.proxySwitchDirect } : {}),
          log: (msg) => this.deps.log?.(msg),
        }, { profileId, nodeId, by: `mcp:${client}` });
        if (result.applied === "reopened") {
          const newLaunch = store.getLaunch(profileId);
          if (this.openedByConnection.has(profileId)) {
            if (newLaunch?.ws) this.openedEndpoints.set(profileId, newLaunch.ws);
            else {
              this.openedByConnection.delete(profileId);
              this.openedEndpoints.delete(profileId);
            }
          }
        }
        return {
          profileId, applied: result.applied, previous, next,
          ...(result.exit ? { exit: { ...(result.exit.country ? { country: result.exit.country } : {}) } } : {}),
          sharedWith: result.sharedWith,
        };
      } catch (error) {
        if (error instanceof ProxySwitchError) {
          if ((error.code === "reopen_failed" || error.code === "exit_is_direct") && !store.getLaunch(profileId)) {
            this.openedByConnection.delete(profileId);
            this.openedEndpoints.delete(profileId);
            this.attachedExisting.delete(profileId);
          }
          throw agentError(error.code, error.message + ("retryAfterMs" in error.detail ? ` (retry after ${Math.ceil(Number(error.detail.retryAfterMs) / 1000)} s)` : ""));
        }
        throw error;
      }
    });
  }

  private async firefoxCall(profileId: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    if (!isFirefoxLaunch(launch)) throw agentError("browser_not_firefox", "This profile is not running in Firefox");
    if (!(await this.deps.launcher.certifiedActive(profileId).catch(() => false))) {
      throw agentError("browser_not_running", "This Firefox profile is not safely running");
    }
    return await (this.deps.firefoxCall ?? callFirefoxOwner)(launch.firefoxOwner, operation, payload);
  }

  private pluginSpecs(): import("./plugins.ts").PluginSpec[] {
    try { return this.deps.plugins?.() ?? []; } catch { return []; }
  }

  /** Firefox and WebKit run plugin tools in their own owner process, so the list travels with each call. */
  private withPlugins(payload: Record<string, unknown>): Record<string, unknown> {
    const plugins = this.pluginSpecs();
    return plugins.length ? { ...payload, plugins } : payload;
  }

  private async webkitCall(profileId: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
    const launch = this.deps.store.getLaunch(profileId);
    if (launch?.engine !== "webkit" || !launch.webkitOwner) throw agentError("browser_not_webkit", "This profile is not running in WebKit");
    if (!(await this.deps.launcher.certifiedActive(profileId).catch(() => false))) {
      throw agentError("browser_not_running", "This WebKit profile is not running");
    }
    return await (this.deps.webkitCall ?? callWebKitOwner)(launch.webkitOwner, operation, payload);
  }

  private async listProfiles(): Promise<SafeProfile[]> {
    await this.deps.launcher.reconcileOrphans();

    if (this.deps.remote) {
      const roster = await this.deps.remote.listRoster();
      // The local store is only a launch cache in remote mode; its proxy may be stale or absent.
      // Best effort: without the details, the list is shown as before, without proxy fields.
      const details = await this.deps.remote.getProfiles(roster.profiles.map(({ id }) => id)).catch(() => []);
      const proxies = new Map(details.map(({ id, proxy }) => [id, proxy]));
      const nodes = details.some(({ proxy }) => proxy?.type === "pool") ? this.aiPoolNodes() : undefined;
      return roster.profiles.filter((profile) => this.mayUseGroup(profile.group ?? "")).map((profile) => {
        const launch = this.deps.store.getLaunch(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          group: profile.group,
          platform: profile.platform ?? "",
          tags: profile.tags ?? [],
          running: !!launch,
          ...this.proxyFields(proxies.get(profile.id), nodes),
          ...(launch ? { ...(launch.engine === "webkit" ? webkitPublicFields() : isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
        };
      });
    }
    const profiles = this.deps.store.listProfiles().filter((profile) => this.mayUseGroup(profile.group ?? ""));
    const nodes = profiles.some(({ proxy }) => proxy?.type === "pool") ? this.aiPoolNodes() : undefined;
    return profiles.map((profile) => {
      const launch = this.deps.store.getLaunch(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        group: profile.group,
        platform: profile.platform ?? "",
        tags: profile.tags ?? [],
        running: !!launch,
        ...this.proxyFields(profile.proxy, nodes),
        ...(launch ? { ...(launch.engine === "webkit" ? webkitPublicFields() : isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
      };
    });
  }

  private async createProfile(params: Record<string, unknown>): Promise<{ id: string; temporary: boolean }> {
    const input = object(params.input ?? {});
    const temporary = params.temporary === true;
    if (!this.mayUseGroup(typeof input.group === "string" ? input.group : "")) {
      throw agentError("not_permitted", `${this.client} may not create profiles in this group`);
    }
    let id: string;
    if (this.deps.remote && input.chromiumRuntime) throw new Error("Vela Chromium is unavailable in legacy Remote mode");
    if (this.deps.remote) {
      id = (await this.deps.remote.createProfile(input as NewProfileInput)).id;
    } else {
      const profile = await createLocalProfile(this.deps.store, input as NewProfileInput, {
        timezoneFetch: this.deps.proxyTimezoneFetch,
        prefetchFirefoxFontPacks: (profiles) => this.deps.launcher.prefetchFirefoxFontPacks?.(profiles),
      });
      id = profile.id;
    }
    if (temporary) this.deps.store.markAgentTemporary(id);
    return { id, temporary };
  }

  private async openProfile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const profileId = stringParam(params, "profileId");
    const options: BrowserOpenOptions = {};
    if (params.headless !== undefined) {
      if (typeof params.headless !== "boolean") throw agentError("invalid_request", "headless must be boolean");
      options.headless = params.headless;
    }
    const startupUrls = params.startupUrls === undefined
      ? []
      : Array.isArray(params.startupUrls) && params.startupUrls.every((value) => typeof value === "string" && /^https?:\/\//.test(value))
        ? params.startupUrls as string[]
        : (() => { throw agentError("invalid_request", "startupUrls must contain only HTTP(S) URLs"); })();

    const opened = await this.deps.admission.run(
      { kind: "start", profileIds: [profileId], signal: this.openSignal },
      async () => {
        const alreadyOpen = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
        const existing = alreadyOpen ? this.deps.store.getLaunch(profileId) : null;
        if (existing) {
          if (options.headless !== undefined && existing.headless !== options.headless) {
            throw new BrowserLaunchError("mode_conflict");
          }
          return { ws: existing.ws, port: existing.debugPort, alreadyOpen, headless: existing.headless ?? false };
        }


        if (this.deps.remote) {
          const result = await this.deps.remote.open(profileId, startupUrls, false, options);
          if (!result.ok || !result.ws || !result.port) {
            throw agentError("open_failed", result.error ?? "remote browser open failed");
          }
          return { ws: result.ws, port: result.port, alreadyOpen: false, headless: options.headless ?? false };
        }
        const result = await this.deps.launcher.start(profileId, startupUrls, options);
        const launch = this.deps.store.getLaunch(profileId);
        return {
          ws: result.ws,
          port: result.port,
          // A browser that was running before this call (a busy one can fail the check above) is the
          // user's, unless this connection opened it; this connection must not close the user's.
          alreadyOpen: !!result.reattached && !this.openedByConnection.has(profileId),
          headless: launch?.headless ?? options.headless ?? false,
        };
      },
    );

    if (opened.alreadyOpen) this.attachedExisting.add(profileId);
    else {
      this.openedByConnection.add(profileId);
      this.openedEndpoints.set(profileId, opened.ws);
    }
    if (this.closed && !opened.alreadyOpen) await this.closeProfile(profileId);
    const launch = this.deps.store.getLaunch(profileId) as (ReturnType<ProfileStore["getLaunch"]> & FirefoxLaunch) | null;
    const firefox = isFirefoxEngine(launch) || opened.ws.startsWith("firefox://");
    return {
      profileId,
      ...(launch?.engine === "webkit" || opened.ws.startsWith("webkit://") ? webkitPublicFields() : firefox
        ? firefoxPublicFields()
        : { ws: opened.ws, port: opened.port }),
      headless: opened.headless,
      alreadyOpen: opened.alreadyOpen,
      ownedByConnection: !opened.alreadyOpen,
    };
  }

  private detachProfile(profileId: string): { profileId: string; detached: true } {
    if (!this.openedByConnection.delete(profileId)) {
      throw agentError("not_owned", "this agent connection does not own the browser");
    }
    this.openedEndpoints.delete(profileId);
    this.attachedExisting.add(profileId);
    return { profileId, detached: true };
  }

  private async profileStatus(profileId: string): Promise<unknown> {
    const running = await this.deps.launcher.certifiedActive(profileId).catch(() => false);
    const launch = this.deps.store.getLaunch(profileId);
    const profile = this.deps.remote
      ? await this.deps.remote.getProfile(profileId).catch(() => null)
      : this.deps.store.getProfile(profileId);
    return {
      profileId,
      running,
      state: running ? "running" : launch ? "uncertain" : "closed",
      ...this.proxyFields(profile?.proxy),
      ...(running && launch ? (
        launch.engine === "webkit" ? { ...webkitPublicFields(), headless: launch.headless ?? false } : isFirefoxEngine(launch)
          ? { ...firefoxPublicFields(), headless: launch.headless ?? false }
          : { ws: launch.ws, port: launch.debugPort, headless: launch.headless ?? false }
      ) : {}),
      ownedByConnection: this.openedByConnection.has(profileId),
      attachedExisting: this.attachedExisting.has(profileId),
    };
  }

  private async closeProfile(profileId: string, expectedEndpoint?: string): Promise<{
    profileId: string;
    closed: true;
    sync?: "complete" | "pending" | "conflict";
    deleted: boolean;
  }> {
    return await this.deps.admission.run(
      { kind: "stop", profileIds: [profileId] },
      async () => {
        const expected = expectedEndpoint ?? this.openedEndpoints.get(profileId);
        if (expected && this.deps.store.getLaunch(profileId)?.ws !== expected) {
          this.openedByConnection.delete(profileId);
          this.openedEndpoints.delete(profileId);
          throw agentError("browser_changed", "The browser instance changed; the current browser was left open");
        }
        let closed: boolean;
        let sync: "complete" | "pending" | "conflict" | undefined;
        if (this.deps.remote) {
          closed = await this.deps.remote.close(profileId);
        } else {
          closed = await this.deps.launcher.stop(profileId);
        }
        if (!closed) throw agentError("close_unconfirmed", `browser teardown is unconfirmed: ${profileId}`);

        this.openedByConnection.delete(profileId);
        this.openedEndpoints.delete(profileId);
        this.attachedExisting.delete(profileId);
        const temporary = this.deps.store.listAgentTemporary().includes(profileId);
        let deleted = false;
        if (temporary && (sync === undefined || sync === "complete")) {
          deleted = await this.deleteClosedProfile(profileId);
        }
        return {
          profileId,
          closed: true as const,
          ...(sync ? { sync } : {}),
          deleted,
        };
      },
    );
  }

  private async deleteProfile(profileId: string): Promise<{ profileId: string; deleted: boolean }> {
    return await this.deps.admission.run(
      { kind: "cleanup", profileIds: [profileId] },
      async () => {
        if (this.deps.store.getLaunch(profileId)) {
          throw agentError("profile_open", "close the profile before deleting it");
        }
        return { profileId, deleted: await this.deleteClosedProfile(profileId) };
      },
    );
  }

  private async deleteClosedProfile(profileId: string): Promise<boolean> {

    if (this.deps.remote) {
      const result = await this.deps.remote.deleteProfiles([profileId]);
      if (result.locked.includes(profileId)) throw agentError("profile_open", "close the profile before deleting it");
      const deleted = result.deleted > 0;
      if (deleted) this.deps.store.clearAgentTemporary(profileId);
      return deleted;
    }
    if (!this.deps.store.getProfile(profileId)) {
      this.deps.store.clearAgentTemporary(profileId);
      return false;
    }
    // The cache delete after a close runs on after stop() returns; the profile is closed, so wait for it.
    await this.deps.launcher.cacheCleanupSettled(profileId);
    if (this.deps.launcher.profileDeletionBlocked(profileId)) {
      throw agentError("profile_open", "close the profile before deleting it");
    }
    this.deps.launcher.removeUserDataDir(profileId);
    return this.deps.store.deleteProfile(profileId);
  }
}

export class AgentControlHub {
  private cleanupInFlight?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps) {}

  private readonly sessions = new Set<AgentControlSession>();

  connect(): AgentControlSession {
    const session = new AgentControlSession(this.deps);
    this.sessions.add(session);
    return session;
  }

  /** The AIs connected right now, by the name their MCP client gives. */
  connectedAgents(): string[] {
    const names = new Set<string>();
    for (const session of [...this.sessions]) {
      if (session.isClosed) this.sessions.delete(session);
      else if (session.agentName !== "unknown") names.add(session.agentName);
    }
    return [...names];
  }

  /** True while any live AI connection holds this browser. */
  holds(profileId: string): boolean {
    for (const session of [...this.sessions]) {
      if (session.isClosed) this.sessions.delete(session);
      else if (session.holds(profileId)) return true;
    }
    return false;
  }

  cleanupTemporaryProfiles(): Promise<void> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    this.cleanupInFlight = this.doCleanupTemporaryProfiles().finally(() => {
      this.cleanupInFlight = undefined;
    });
    return this.cleanupInFlight;
  }

  private async doCleanupTemporaryProfiles(): Promise<void> {
    for (const profileId of this.deps.store.listAgentTemporary()) {
      if (this.deps.store.getLaunch(profileId)) continue;
      const session = new AgentControlSession(this.deps);
      await session.enqueue(JSON.stringify({
        protocol: AGENT_CONTROL_PROTOCOL,
        id: 1,
        method: "profiles.delete",
        params: { profileId },
      })).catch(() => undefined);
    }
  }
}

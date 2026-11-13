import { webkitPublicFields } from "./browser-capabilities.ts";
import { buildNewProfile, type NewProfileInput } from "./create.ts";
import { syncFirefoxTimezone } from "./firefox-config.ts";
import { callFirefoxOwner, type FirefoxOwner } from "./firefox-runtime.ts";
import { callWebKitOwner, type WebKitOwner } from "./webkit-runtime.ts";
import { pointerAgent, validWorkbenchPointer } from "./workbench.ts";
import { attachTimezones } from "./geoip.ts";
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
  /** The AI's human-like pointer, drawn over the browser's card on the workbench. */
  pointer?: (profileId: string, pointer: import("./workbench.ts").WorkbenchPointer) => void;

  log?: (message: string) => void;
}

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
};

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
  private cleanup?: Promise<void>;

  constructor(private readonly deps: AgentControlDeps, private readonly openSignal?: AbortSignal) {}

  enqueue(raw: string | Uint8Array): Promise<AgentControlResponse> {
    let request: AgentControlRequest;
    try {
      request = parseAgentControlRequest(raw);
    } catch (error) {
      return Promise.resolve(errorResponse(1, error));
    }
    const execute = async (): Promise<AgentControlResponse> => {
      if (this.closed) throw agentError("connection_closed", "agent connection is closing");
      try {
        return {
          protocol: AGENT_CONTROL_PROTOCOL,
          id: request.id,
          ok: true,
          result: await this.dispatch(request.method, request.params ?? {}),
        } satisfies AgentControlResponse;
      } catch (error) {
        return errorResponse(request.id, error);
      }
    };
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
      return run;
    }
    const run = Promise.all([this.queue, ...this.lanes.values()]).then(execute);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  disconnect(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.cleanup = Promise.all([this.queue, ...this.lanes.values()]).then(async () => {
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
    if (typeof params.profileId === "string" && params.profileId) this.deps.activity?.touch(params.profileId.trim());
    switch (method) {
      case "profiles.list":
        return { profiles: await this.listProfiles() };
      case "profiles.replaceProxies":
        throw agentError("accounts_removed", "Cloud proxy coordination has been removed");
      case "profiles.create":
        return await this.createProfile(params);
      case "profiles.update":
        throw agentError("accounts_removed", "Cloud profile editing has been removed; use the local profile editor");
      case "profiles.delete":
        return await this.deleteProfile(stringParam(params, "profileId"));
      case "browser.open":
        return await this.openProfile(params);
      case "browser.status":
        return await this.profileStatus(stringParam(params, "profileId"));
      case "plugins.list":
        return { plugins: this.pluginSpecs() };
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
      return roster.profiles.map((profile) => {
        const launch = this.deps.store.getLaunch(profile.id);
        return {
          id: profile.id,
          name: profile.name,
          group: profile.group,
          platform: profile.platform ?? "",
          tags: profile.tags ?? [],
          running: !!launch,
          ...(launch ? { ...(launch.engine === "webkit" ? webkitPublicFields() : isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
        };
      });
    }
    return this.deps.store.listProfiles().map((profile) => {
      const launch = this.deps.store.getLaunch(profile.id);
      return {
        id: profile.id,
        name: profile.name,
        group: profile.group,
        platform: profile.platform ?? "",
        tags: profile.tags ?? [],
        running: !!launch,
        ...(launch ? { ...(launch.engine === "webkit" ? webkitPublicFields() : isFirefoxEngine(launch) ? firefoxPublicFields() : { debugPort: launch.debugPort }), headless: launch.headless } : {}),
      };
    });
  }

  private async createProfile(params: Record<string, unknown>): Promise<{ id: string; temporary: boolean }> {
    const input = object(params.input ?? {});
    const temporary = params.temporary === true;
    let id: string;
    if (this.deps.remote && input.chromiumRuntime) throw new Error("Vela Chromium is unavailable in legacy Remote mode");
    if (this.deps.remote) {
      id = (await this.deps.remote.createProfile(input as NewProfileInput)).id;
    } else {
      const profile = buildNewProfile(input as NewProfileInput, (candidate) => !!this.deps.store.getProfile(candidate));
      if (profile.proxy) {
        await attachTimezones([profile], undefined, true).catch(() => {});
        syncFirefoxTimezone(profile);
      }
      {
        this.deps.store.upsertProfile(profile);
        id = profile.id;
      }
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
    return {
      profileId,
      running,
      state: running ? "running" : launch ? "uncertain" : "closed",
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

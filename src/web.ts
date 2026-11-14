/**
 * Dashboard + API server. Serves the Phase A web UI at "/" and routes
 * `/ui/api/*` to the dashboard API, with the AdsPower-compatible API
 * (handleRequest) as the fallback — so automation `/api/v1|v2/*` calls are
 * unaffected. The HTML import lives only here so unit tests (which import
 * server.ts / ui.ts) never trigger React bundling.
 */

import { join } from "node:path";
import { TaskbarMode, taskbarModeSupported } from "./taskbar.ts";
import { ActivityLog, COOLING_DEFAULTS, CoolingMonitor } from "./cooling.ts";
import { drainPoolTasks } from "./proxy-pool-api.ts";
import { SubscriptionScheduler } from "./subscription-scheduler.ts";
import index from "../web/index.html";
import { profileDisplayNo, type Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import type { StatePaths } from "./paths.ts";
import {
  handleRequest,
  handleRemoteBrowserControl,
  handleAutomationHealthSnapshot,
  isAdsPowerBrowserControl,
  isLoopbackAddress,
  type BrowserLifecycleContext,
} from "./server.ts";
import { handleUiRequest, type UiHealthMetadata } from "./ui.ts";
import { ScriptLibrary, ScriptSupervisor, prefetchPythonFor } from "./scripts.ts";
import { TaskRunner, TaskStore } from "./tasks.ts";
import { AuditLog } from "./audit.ts";
import { backupSessions, SnapshotStore } from "./snapshots.ts";
import { setTunBypass } from "./egress-binding.ts";
import { PythonRuntime } from "./python-runtime.ts";
import { resolvePlaywrightRuntime } from "./playwright-runtime.ts";
import { pluginsDirectory, scanPlugins } from "./plugins.ts";
import { WorkbenchHub, WORKBENCH_PATH, WORKBENCH_PROTOCOL, validWorkbenchAuthorization, type WorkbenchConnection } from "./workbench.ts";

import {
  handleUserApi,
} from "./adspower-users.ts";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
  AgentControlHub,
  type AgentControlSession,
  validAgentAuthorization,
} from "./agent-control.ts";
import { ProxyApprovalQueue, type AiProxyPolicy } from "./proxy-approvals.ts";
import { CodeApprovalQueue, type AiCodePolicy } from "./code-approvals.ts";
import {
  LifecycleAdmissionController,
  dispatchWithLifecycleAdmission,
  type LifecycleAdmissionOptions,
} from "./lifecycle-admission.ts";

export interface DashboardServerOptions {
  /** @deprecated Account runtimes are retired; production entry points ignore these fields. */
  cloudAuth?: import("./cloud-auth.ts").CloudAuthRuntime;
  cloudConnection?: import("./cloud-connection.ts").CloudConnectionRuntime;
  cloudBrowser?: import("./cloud-browser.ts").CloudBrowserLifecycle;
  pendingSync?: import("./pending-sync.ts").PendingSyncRuntime;
  mcpTunnel?: import("./mcp-tunnel.ts").McpTunnelLifecycle;
  defaultCloudUrl?: string;

  launcher: Launcher;
  store: ProfileStore;
  /** When set, the dashboard routes profiles/open/close/import/move via the hub. */
  remote?: RemoteCoordinator | null;
  appConfig?: AppConfigStore;
  paths?: StatePaths;


  port?: number;
  /**
   * Bind address. Loopback only by default — the dashboard and API are
   * unauthenticated and can start/stop browsers, so they must not be reachable
   * from other hosts. Remote access is Phase B (VPS behind Tailscale + auth).
   */
  hostname?: string;
  log?: (msg: string) => void;
  lifecycleAdmissionOptions?: LifecycleAdmissionOptions;
  lifecycleAdmission?: LifecycleAdmissionController;
  health?: UiHealthMetadata | null;
  /** Desktop-generated nonce used by the installed agent adapter. */
  agentNonce?: string;
}

type AgentSocketData = {
  session: AgentControlSession;
} | { workbench: WorkbenchConnection };

function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]!);
}

/**
 * AdsPower-style identity card for one profile: Name / Profile-No / Group / Platform /
 * Proxy and stored identity data only. This page never makes an egress lookup:
 * the operator can use the dashboard's explicit proxy check when needed.
 */
function renderProfileCard(store: ProfileStore, id: string): Response {
  const p = store.getProfile(id);
  if (!p) return new Response("unknown profile", { status: 404, headers: { "content-type": "text/plain" } });
  const engine = p.engine ?? "chromium";
  // Named as in the dashboard.
  const browser = engine === "webkit" ? "WebKit · Experimental" : engine === "firefox" ? "Vela Firefox" : p.chromiumRuntime ? "Vela Chromium" : "CloakBrowser";
  const capabilities = engine === "webkit" ? "Independent process and storage · native WebKit · limited fingerprint controls" : engine === "firefox"
    ? "Native Firefox profile · no CDP, PDF, or Chrome extensions"
    : "CDP, PDF, and Chrome extensions";
  // Same number the browser window title and identity bookmark show: the
  // operator's custom NO. first, the store serial as fallback.
  const no = profileDisplayNo(p.customNo, store.getSerial(id)) ?? "?";
  const proxy = p.proxy ? `${p.proxy.type}://${p.proxy.host}:${p.proxy.port}` : "none";
  const title = `${p.name || "profile"} · #${no}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#ffffff;--card:#ffffff;--sunken:#f5f5f7;--ink:#111114;--muted:#6b6d77;--line:rgba(0,0,0,.055);--sh:0 12px 34px -6px rgba(0,0,0,.065),0 2px 8px rgba(0,0,0,.035)}
  @media(prefers-color-scheme:dark){:root{--bg:#09090c;--card:#16161b;--sunken:#1b1b21;--ink:#f2f2f5;--muted:#9c9ea8;--line:rgba(255,255,255,.065);--sh:0 18px 44px -8px rgba(0,0,0,.62),0 4px 12px rgba(0,0,0,.38)}}
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif;margin:0;padding:48px 24px;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  .wrap{max-width:620px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
  .hero{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:28px 32px;box-shadow:var(--sh);display:flex;flex-direction:column;gap:6px}
  .brand{font-family:'Playfair Display',Didot,'Bodoni MT',Georgia,serif;font-style:italic;font-weight:700;font-size:18px;letter-spacing:.01em;color:var(--muted)}
  .browser{font-family:'Noto Serif SC','Songti SC',Georgia,serif;font-size:24px;font-weight:700;letter-spacing:.02em;margin-top:4px}
  .capabilities{color:var(--muted);font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:24px;overflow:hidden;box-shadow:var(--sh)}
  h2{padding:18px 24px 10px;margin:0;font-size:11.5px;font-weight:600;letter-spacing:.08em;color:var(--muted);text-transform:uppercase;background:var(--sunken);border-bottom:1px solid var(--line)}
  .row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 24px;border-top:1px solid var(--line);font-size:13.5px}
  .row:first-of-type{border-top:0}
  .k{color:var(--muted);font-weight:500}
  .v{font-weight:600;text-align:right;word-break:break-all;font-variant-numeric:tabular-nums}
</style></head>
<body>
  <div class="wrap">
    <div class="hero"><div class="brand">Vela</div><div class="browser">${escapeHtml(browser)}</div><div class="capabilities">${escapeHtml(capabilities)}</div></div>
    <div class="card">
      <h2>Account</h2>
      <div class="row"><span class="k">Name</span><span class="v">${escapeHtml(p.name)}</span></div>
      <div class="row"><span class="k">Profile No / ID</span><span class="v">${escapeHtml(no)} / ${escapeHtml(id)}</span></div>
      <div class="row"><span class="k">Group</span><span class="v">${escapeHtml(p.group) || "—"}</span></div>
      <div class="row"><span class="k">Platform</span><span class="v">${escapeHtml(p.platform) || "—"}</span></div>
      <div class="row"><span class="k">Browser</span><span class="v">${escapeHtml(browser)}</span></div>
      <div class="row"><span class="k">Timezone</span><span class="v">${escapeHtml(p.timezone) || "—"}</span></div>
      <div class="row"><span class="k">Proxy</span><span class="v">${escapeHtml(proxy)}</span></div>
    </div>
  </div>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function automationHealthResponse(
  req: Request,
  clientAddress: string | undefined,
  remote: RemoteCoordinator | null | undefined,
): Response | Promise<Response> | null {
  if (new URL(req.url).pathname !== "/api/xactions/health-snapshot") return null;
  if (!isLoopbackAddress(clientAddress)) {
    return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
  }
  if (!remote) {
    return Response.json({ ok: false, error: "remote hub is not configured" }, { status: 503 });
  }
  return handleAutomationHealthSnapshot(req, remote);
}

async function handleAutomationRequest(
  req: Request,
  opts: DashboardServerOptions,
  lifecycle: BrowserLifecycleContext,
): Promise<Response> {
  const { launcher, store } = opts;

  const users = await handleUserApi(req, launcher, store, opts.remote);
  if (users) return users;
  const pathname = new URL(req.url).pathname;
  if (opts.remote && isAdsPowerBrowserControl(pathname)) {
    return handleRemoteBrowserControl(req, opts.remote, launcher, store, lifecycle);
  }

  return handleRequest(req, launcher, store, lifecycle);
}

function isAllowedLoopbackHostHeader(hostHeader: string | null): boolean {
  if (!hostHeader) return true;
  const raw = hostHeader.trim().toLowerCase();
  let host = raw;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return false;
    const after = raw.slice(end + 1);
    if (after && !/^:\d+$/.test(after)) return false;
    host = raw.slice(1, end);
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon !== -1 && raw.indexOf(":") === colon && /^\d+$/.test(raw.slice(colon + 1))) {
      host = raw.slice(0, colon);
    }
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function loopbackHostGuard(req: Request, boundHostname: string): Response | null {
  if (boundHostname !== "localhost" && !isLoopbackAddress(boundHostname)) return null;
  if (isAllowedLoopbackHostHeader(req.headers.get("host"))) return null;
  return Response.json({ ok: false, error: "Forbidden host header" }, { status: 403 });
}

export function serveAutomationApi(opts: Omit<DashboardServerOptions, "hostname">) {
  const { port = 50400 } = opts;
  const hostname = "127.0.0.1";
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = opts.lifecycleAdmission ?? new LifecycleAdmissionController(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  try {
    const server = Bun.serve({
      port,
      hostname,
      idleTimeout: 240,
      fetch: async (req, server) => {
        const deniedHost = loopbackHostGuard(req, hostname);
        if (deniedHost) return deniedHost;
        const health = automationHealthResponse(req, server.requestIP(req)?.address, opts.remote);
        if (health) return health;
        return dispatchWithLifecycleAdmission(req, admission, async () => {
          return handleAutomationRequest(req, opts, lifecycle);
        });
      },
    });
    log(`automation API on http://${hostname}:${server.port}`);
    return server;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `automation API could not bind to http://${hostname}:${port}: ${detail}`;
    log(message);
    throw new Error(message);
  }
}

export function serveDesktopAutomationApi(opts: Omit<DashboardServerOptions, "hostname" | "port">) {
  try {
    return serveAutomationApi({ ...opts, port: 50400 });
  } catch {
    return undefined;
  }
}

export function serveDashboard(opts: DashboardServerOptions) {
  const { launcher, store, port = 50400, hostname = "127.0.0.1" } = opts;
  const runtimeMode = "local" as const;
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = opts.lifecycleAdmission ?? new LifecycleAdmissionController(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  const agentNonce = opts.agentNonce;
  // Desktop only: keep environment windows out of the Windows taskbar when the user asked for it.
  const taskbarMode = agentNonce && opts.appConfig && taskbarModeSupported() ? new TaskbarMode({
    store,
    enabled: () => { try { return opts.appConfig!.read().hideFromTaskbar === true; } catch { return false; } },
    log,
  }) : undefined;
  taskbarMode?.start();
  const activity = new ActivityLog();
  const workbenchHub = agentNonce ? new WorkbenchHub({
    launcher, store, activity,
    canControl: async (id) => {

      if (opts.remote) {
        const profile = (await opts.remote.listRoster()).profiles.find((item) => item.id === id);
        return !!profile && !profile.lockedBy;
      }
      return true;
    },
  }) : undefined;
  // Proxy changes an AI asks for wait here for a person on the dashboard (unless the user allowed them).
  const proxyApprovals = new ProxyApprovalQueue();
  const aiProxyPolicy = (): AiProxyPolicy => {
    try { return opts.appConfig?.read().aiProxyChanges ?? "ask"; } catch { return "ask"; }
  };
  // What AIs, scripts and tasks did, kept for six months next to the profiles.
  const audit = opts.paths && !opts.remote ? new AuditLog(join(opts.paths.root, "audit")) : undefined;
  // Snapshots before fingerprint and proxy changes, and a daily backup of sign-ins that changed.
  const snapshots = opts.paths && !opts.remote ? new SnapshotStore(join(opts.paths.root, "snapshots"), () => store.secretBox()) : undefined;
  if (snapshots) store.attachSnapshots(snapshots);
  // Connections to profiles' proxies go around a TUN proxy client on this computer when turned on.
  try { setTunBypass(!opts.remote && opts.appConfig?.read().tunBypass === true); } catch { setTunBypass(false); }
  // Sensitive fields are sealed with this data folder's key when the user turned that on; values
  // written before are sealed now. Values this computer cannot read are left as they are.
  try {
    if (!opts.remote && opts.appConfig?.read().encryptData === true) {
      store.setFieldEncryption(true);
      const { unreadable } = store.reencryptFields();
      if (unreadable) log(`${unreadable} encrypted value(s) cannot be read with this computer's key`);
    }
  } catch (error) { log(`data encryption could not start: ${error instanceof Error ? error.message : error}`); }
  const runBackups = () => {
    if (!snapshots) return;
    try { if (opts.appConfig?.read().sessionBackups === false) return; } catch { /* defaults on */ }
    try { const count = backupSessions(store, snapshots); if (count) log(`backed up the sign-ins of ${count} profile(s)`); } catch { /* next round */ }
  };
  const backupTimer = snapshots ? setInterval(runBackups, 6 * 3600_000) : undefined;
  const firstBackup = snapshots ? setTimeout(runBackups, 3 * 60_000) : undefined;
  (backupTimer as any)?.unref?.(); (firstBackup as any)?.unref?.();
  const library = agentNonce && opts.paths ? new ScriptLibrary(opts.paths.root, false) : undefined;
  // The desktop app downloads Python for Python scripts; a source checkout uses python3.
  const python = library && resolvePlaywrightRuntime().kind === "packaged"
    ? new PythonRuntime(join(opts.paths!.root, "runtimes"), { log })
    : undefined;
  const scripts = library && agentNonce ? {
    library, nonce: agentNonce, python,
    runner: new ScriptSupervisor({
      root: opts.paths!.root, library, launcher, store, admission, python,
      remote: opts.remote,   log,
      report: (entry) => audit?.record({
        actor: { kind: "script", name: entry.scriptName }, action: "script.run", ok: entry.ok,
        profileId: entry.profileId, profileName: entry.profileName,
        detail: entry.startedBy ? `${entry.status}, started by ${entry.startedBy.kind === "ai" ? "AI " : entry.startedBy.kind === "task" ? "task " : ""}${entry.startedBy.name}` : entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      }),
    }),
  } : undefined;
  // Saved scripts in order over chosen profiles, by hand or on a schedule; one run at a time.
  const tasks = scripts && opts.paths && !opts.remote ? new TaskRunner({
    store: new TaskStore(join(opts.paths.root, "tasks.json")),
    runner: scripts.runner,
    resolveProfiles: (target) => store.listProfiles().filter((profile) => target.profileIds?.includes(profile.id)
      || target.groups?.includes(profile.group || "")
      || (profile.tags ?? []).some((tag) => target.tags?.includes(tag))).map((profile) => profile.id),
    scriptName: async (id) => (await scripts.library.get(id)).name,
    log,
  }) : undefined;
  tasks?.start();
  // Scripts and plugins an AI writes wait here for a person to read them (unless the user allowed them).
  const codeApprovals = new CodeApprovalQueue();
  const aiCodePolicy = (): AiCodePolicy => {
    try { return opts.appConfig?.read().aiCodeChanges ?? "ask"; } catch { return "ask"; }
  };
  const agentHub = agentNonce
    ? new AgentControlHub({
        launcher,
        store,
        admission,
        remote: opts.remote,
        activity,
        // Plugins are code on this computer; a remotely coordinated runtime offers none.
        ...(opts.paths && !opts.remote ? { plugins: () => scanPlugins(pluginsDirectory(opts.paths!.root), opts.appConfig?.read().disabledPlugins ?? []).specs } : {}),
        // The AI's pointer in a Chromium browser, drawn over that browser's card.
        pointer: (profileId, pointer) => workbenchHub?.pointer(profileId, pointer),
        proxyApprovals,
        aiProxyPolicy,
        ...(scripts ? { scripts: { library: scripts.library, runner: scripts.runner } } : {}),
        ...(opts.paths && !opts.remote ? { pluginsRoot: pluginsDirectory(opts.paths.root) } : {}),
        codeApprovals,
        aiCodePolicy,
        aiAccess: () => opts.appConfig?.read().aiAccess,
        ...(audit ? { audit } : {}),
        log,
      })
    : undefined;
  // Desktop only: idle browsers cool down when memory runs short and come back signed in.
  const finished = new Set(["succeeded", "failed", "cancelled", "skipped"]);
  const cooling = agentNonce && opts.appConfig && !opts.remote ? new CoolingMonitor({
    settings: () => { try { return opts.appConfig!.read().cooling ?? COOLING_DEFAULTS; } catch { return COOLING_DEFAULTS; } },
    running: () => store.listLaunches().map((launch) => ({ profileId: launch.profileId, startedAt: launch.startedAt ?? 0 })),
    busy: (id) => activity.held(id) || !!agentHub?.holds(id)
      || !!scripts?.runner.status()?.profiles.some((profile) => profile.id === id && !finished.has(profile.status)),
    lastActive: (id) => activity.lastActive(id),
    cool: async (id) => {
      const launch = store.getLaunch(id);
      if (!launch) return false;
      await launcher.captureLocalSession(id);
      return await launcher.stop(id, launch);
    },
    exists: (id) => !!store.getProfile(id),
    file: opts.paths ? join(opts.paths.root, "cooled-browsers.json") : undefined,
    log,
  }) : undefined;
  cooling?.start();
  const subscriptionScheduler = !opts.remote && store && typeof (store as Partial<ProfileStore>).proxyPool === "object"
    ? new SubscriptionScheduler({ store, log })
    : undefined;
  subscriptionScheduler?.start();
  const shutdownController = new AbortController();
  if (library && python) {
    python.prune();
    // A user who already has a Python script gets the runtime before the first run.
    void library.list().then((items) => prefetchPythonFor(python, items), () => {});
  }
  const server = Bun.serve<AgentSocketData>({
    port,
    hostname,
    // Queue wait plus a complete remote restore can legitimately hold a lifecycle
    // response for several minutes while the shared transition cap does its job.
    idleTimeout: 240,
    // Development mode watches the app folder for hot reload. On Windows that
    // watcher leaks kernel memory on every database write until the host stalls.
    development: false,
    routes: { "/": index },
    websocket: {
      maxPayloadLength: AGENT_CONTROL_MAX_MESSAGE_BYTES,
      open(socket) {
        if ("workbench" in socket.data) {
          void socket.data.workbench.start((value) => {
            if ((value as { type?: string }).type === "frame" && socket.getBufferedAmount() > 2 * 1024 * 1024) return;
            socket.send(JSON.stringify(value));
          });
        }
      },
      message(socket, message) {
        if ("workbench" in socket.data) {
          if (typeof message !== "string" || message.length > 300_000) { socket.close(1009); return; }
          try { void socket.data.workbench.enqueue(JSON.parse(message)); } catch { socket.close(1007); }
          return;
        }
        const raw = typeof message === "string" ? message : new Uint8Array(message);
        void socket.data.session.enqueue(raw).then((response) => {
          socket.send(JSON.stringify(response));
        });
      },
      close(socket) {
        if ("workbench" in socket.data) { void socket.data.workbench.dispose(); return; }
        void socket.data.session.disconnect();
      },
    },
    fetch: async (req, server) => {
      const deniedHost = loopbackHostGuard(req, hostname);
      if (deniedHost) return deniedHost;
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname === WORKBENCH_PATH) {
        if (!isLoopbackAddress(server.requestIP(req)?.address) || !agentNonce || !validWorkbenchAuthorization(req, agentNonce)) {
          return Response.json({ ok: false, error: "Workbench authorization failed" }, { status: 403 });
        }
        if (!workbenchHub) return Response.json({ ok: false, error: "Workbench is unavailable" }, { status: 503 });
        try {
          const workbench = await workbenchHub.connect(reqUrl.searchParams.get("profileId") ?? "");
          if (!server.upgrade(req, { data: { workbench }, headers: { "Sec-WebSocket-Protocol": WORKBENCH_PROTOCOL } })) {
            await workbench.dispose();
            return Response.json({ ok: false, error: "Workbench connection failed" }, { status: 400 });
          }
          return undefined;
        } catch { return Response.json({ ok: false, error: "Environment is unavailable" }, { status: 409 }); }
      }
      if ((reqUrl.pathname === "/ui/api/scripts" || reqUrl.pathname.startsWith("/ui/api/scripts/"))
        && !isLoopbackAddress(server.requestIP(req)?.address)) {
        return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
      }
      if (reqUrl.pathname === AGENT_CONTROL_PATH) {
        if (!isLoopbackAddress(server.requestIP(req)?.address)) {
          return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
        }
        if (!agentHub || !agentNonce) {
          return Response.json({ ok: false, error: "agent control is unavailable" }, { status: 503 });
        }
        if (req.headers.get("sec-websocket-protocol") !== AGENT_CONTROL_PROTOCOL) {
          return Response.json({ ok: false, error: "agent protocol mismatch" }, { status: 426 });
        }
        if (!validAgentAuthorization(req.headers.get("authorization"), agentNonce)) {
          return Response.json({ ok: false, error: "agent authorization failed" }, { status: 401 });
        }
        const session = agentHub.connect();
        const upgraded = server.upgrade(req, {
          data: { session },
        });
        if (!upgraded) {
          void session.disconnect();
          return Response.json({ ok: false, error: "WebSocket upgrade failed" }, { status: 400 });
        }
        return undefined;
      }
      // The automation client publishes through this local coordinator without entering the
      // browser lifecycle admission queue. Even if the dashboard is deliberately
      // bound beyond loopback, this ingestion route remains local-only.
      const health = automationHealthResponse(req, server.requestIP(req)?.address, opts.remote);
      if (health) return health;


      return dispatchWithLifecycleAdmission(req, admission, async () => {
        const ui = await handleUiRequest(req, launcher, store, opts.remote, {
          appConfig: opts.appConfig,
          taskbarMode,
          cooling,
          activity,
          paths: opts.paths,


          health: opts.health,
          scripts: scripts && tasks ? { ...scripts, tasks } : scripts,
          runtimeMode,
          proxyApprovals,
          codeApprovals,
          ...(audit ? { audit } : {}),
          ...(snapshots ? { snapshots } : {}),
          connectedAgents: () => agentHub?.connectedAgents() ?? [],
          shutdownSignal: shutdownController.signal,
        });
        if (ui) return ui;
        // Per-profile identity "card" (AdsPower-style landing page). Opened as a tab and
        // pointed to by the bookmark, so an operator can always see which account a window is.
        if (reqUrl.pathname === "/card") return renderProfileCard(store, reqUrl.searchParams.get("id") ?? "");
        return handleAutomationRequest(req, opts, lifecycle);
      });
    },
  });
  void agentHub?.cleanupTemporaryProfiles();
  log(`dashboard + API on http://${hostname}:${server.port}  (UI at /, Vela Local API under /api; AdsPower-compatible)`);
  const stopServer = server.stop.bind(server);
  return Object.assign(server, {
    async stop(closeActiveConnections?: boolean) {
      cooling?.stop();
      clearInterval(backupTimer); clearTimeout(firstBackup);
      taskbarMode?.stop();
      shutdownController.abort();
      await Promise.allSettled([
        subscriptionScheduler?.stop() ?? Promise.resolve(),
        drainPoolTasks(store),
      ]);
      return await stopServer(closeActiveConnections);
    },
    stopScripts: () => scripts?.runner.shutdown() ?? Promise.resolve(),
  });
}

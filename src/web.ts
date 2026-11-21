/**
 * Dashboard + API server. Serves the Phase A web UI at "/" and routes
 * `/ui/api/*` to the dashboard API, with the AdsPower-compatible API
 * (handleRequest) as the fallback — so automation `/api/v1|v2/*` calls are
 * unaffected. The HTML import lives only here so unit tests (which import
 * server.ts / ui.ts) never trigger React bundling.
 */

import { join } from "node:path";
import { availableParallelism, cpus } from "node:os";
import { TaskbarMode, taskbarModeSupported } from "./taskbar.ts";
import { ActivityLog, COOLING_DEFAULTS, CoolingMonitor, HostWorkBudget } from "./cooling.ts";
import { drainPoolTasks } from "./proxy-pool-api.ts";
import { SubscriptionScheduler } from "./subscription-scheduler.ts";
import index from "../web/index.html";
import { profileDisplayNo, type Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { RemoteCoordinator } from "./remote.ts";
import type { AppConfigStore } from "./app-config.ts";
import { allowsGroup, ruleFor, type AiAccessRule, type LocalAutomationScope } from "./ai-access.ts";
import type { StatePaths } from "./paths.ts";
import {
  handleRequest,
  handleRemoteBrowserControl,
  handleAutomationHealthSnapshot,
  isAdsPowerBrowserControl,
  isLoopbackAddress,
  type BrowserLifecycleContext,
} from "./server.ts";
import { handleUiRequest, SUPPORT_DIAGNOSTICS_PATH, type UiHealthMetadata } from "./ui.ts";
import { ScriptLibrary, ScriptSupervisor, prefetchPythonFor } from "./scripts.ts";
import { TaskRunner, TaskStore } from "./tasks.ts";
import { BrowserTaskError, BrowserTaskSupervisor, type BrowserTaskConnection } from "./browser-tasks.ts";
import { AGENT_CREDENTIALS_PATH, AgentCredentials } from "./agent-credentials.ts";
import { WORKSPACE_BACKUP_PATH, WorkspaceBackup } from "./workspace-backup.ts";
import { lstatSync } from "node:fs";
import { ProfileWrites } from "./profile-writes.ts";
import { KernelUpgrades } from "./kernel-upgrades.ts";
import { AndroidDevices } from "./android.ts";
import { MAX_PORTABLE_BYTES, PortableProfiles } from "./portable-profiles.ts";
import { WORKER_PATH, WorkerNodes } from "./worker-nodes.ts";
import { NetworkIdentity } from "./network-identity.ts";
import { AuditLog } from "./audit.ts";
import { backupSessions, SnapshotStore } from "./snapshots.ts";
import { setTunBypass } from "./egress-binding.ts";
import { MobileView } from "./mobile-view.ts";
import { ALIASMODE_VERSION } from "./version.ts";
import { PhoneWindows } from "./phone-window.ts";
import { IpScoreCache } from "./ip-score.ts";
import { PythonRuntime } from "./python-runtime.ts";
import { resolvePlaywrightRuntime, runPlaywrightWorker } from "./playwright-runtime.ts";
import { pluginsDirectory, scanPlugins } from "./plugins.ts";
import { WorkbenchHub, WORKBENCH_PATH, WORKBENCH_PROTOCOL, validWorkbenchAuthorization, workbenchGeneration, type WorkbenchConnection } from "./workbench.ts";
import { BROWSER_REPLAY_PATH, BrowserReplay } from "./browser-replay.ts";
import { browserReplayView } from "./browser-replay-view.ts";

import {
  handleUserApi,
} from "./adspower-users.ts";
import {
  AGENT_CONTROL_MAX_MESSAGE_BYTES,
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
  AgentControlHub,
  AgentControlSession,
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
  desktopAdminNonce?: string;
  /** Direct TLS listener for a dedicated Worker host. */
  workerTls?: Bun.TLSOptions;
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
  const pathname = new URL(req.url).pathname;
  let scope: LocalAutomationScope | undefined;
  if (!opts.remote && opts.appConfig && /^\/api\/v[12]\/(?:browser\/|browser-profile\/|group\/|user\/)/.test(pathname)) {
    let rule: AiAccessRule | undefined;
    try {
      rule = opts.appConfig.read().aiAccess?.default;
    } catch {
      return Response.json({ code: -1, msg: "Could not read the default AI access setting", data: {} });
    }
    // Compatibility clients have no MCP client name, so they use the default rule.
    if (rule && rule !== "all") {
      const folders = store.listFolders();
      const allowsAutomationGroup = (group: string) => allowsGroup(rule, group, folders);
      scope = {
        allowsGroup: allowsAutomationGroup,
        allowsProfile: (id) => {
          const profile = store.getProfile(id);
          return !!profile && allowsAutomationGroup(profile.group);
        },
      };
    }
  }

  const users = await handleUserApi(req, launcher, store, opts.remote, undefined, undefined, scope);
  if (users) return users;
  if (opts.remote && isAdsPowerBrowserControl(pathname)) {
    return handleRemoteBrowserControl(req, opts.remote, launcher, store, lifecycle);
  }

  return handleRequest(req, launcher, store, scope ? { ...lifecycle, automationScope: scope } : lifecycle);
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

export function lifecycleAdmission(options?: LifecycleAdmissionOptions): LifecycleAdmissionController {
  return new LifecycleAdmissionController({
    hostWork: new HostWorkBudget(availableParallelism()),
    ...options,
  });
}

function browserTaskCapacity() {
  const processors = availableParallelism();
  const cpuTimes = () => cpus().reduce((sample, { times }) => ({
    idle: sample.idle + times.idle,
    total: sample.total + times.user + times.nice + times.sys + times.idle + times.irq,
  }), { idle: 0, total: 0 });
  let previous = cpuTimes(), sampledAt = -Infinity, capacity = 1;
  return () => {
    const now = performance.now();
    if (now - sampledAt < 1000) return capacity;
    const cpu = cpuTimes(), elapsed = cpu.total - previous.total;
    const idleRatio = elapsed > 0 ? (cpu.idle - previous.idle) / elapsed : 1;
    capacity = Math.max(1, Math.min(8, Math.floor(processors * idleRatio)));
    previous = cpu;
    sampledAt = now;
    return capacity;
  };
}

export function serveAutomationApi(opts: Omit<DashboardServerOptions, "hostname">) {
  const { port = 50400 } = opts;
  const hostname = "127.0.0.1";
  const log = opts.log ?? ((m) => console.log(`[aliasmode] ${m}`));
  const admission = opts.lifecycleAdmission ?? lifecycleAdmission(opts.lifecycleAdmissionOptions);
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
  const admission = opts.lifecycleAdmission ?? lifecycleAdmission(opts.lifecycleAdmissionOptions);
  const lifecycle = { admission };
  const agentNonce = opts.agentNonce;
  if (opts.workerTls && (!agentNonce || !opts.paths || opts.remote)) throw new Error("Direct TLS requires a local Worker");
  // Desktop only: keep environment windows out of the Windows taskbar when the user asked for it.
  const taskbarMode = agentNonce && opts.appConfig && taskbarModeSupported() ? new TaskbarMode({
    store,
    enabled: () => { try { return opts.appConfig!.read().hideFromTaskbar === true; } catch { return false; } },
    log,
  }) : undefined;
  taskbarMode?.start();
  const activity = new ActivityLog();
  const writes = new ProfileWrites();
  const networkIdentity = agentNonce && !opts.remote ? new NetworkIdentity({ launcher, store, writes, admission, log }) : undefined;
  networkIdentity?.start(Number(process.env.ALIASMODE_EGRESS_RECHECK_SECONDS ?? 0) * 1000, process.env.ALIASMODE_REFRESH_EGRESS === "1");
  const adb = agentNonce && !opts.remote ? process.env.ALIASMODE_ADB_PATH || Bun.which("adb") : undefined;
  const android = adb ? new AndroidDevices(writes, adb,
    process.env.ALIASMODE_ANDROID_SERIALS ? new Set(process.env.ALIASMODE_ANDROID_SERIALS.split(",").map(value => value.trim()).filter(Boolean)) : undefined)
    : undefined;
  const kernels = agentNonce && opts.paths && !opts.remote
    ? new KernelUpgrades({ root: join(opts.paths.root, "kernel-upgrades"), launcher, store, admission, writes, log })
    : undefined;
  kernels?.recover();
  const workbenchHub = agentNonce ? new WorkbenchHub({
    launcher, store, activity, writes,
    canControl: async (id) => {

      if (opts.remote) {
        const profile = (await opts.remote.listRoster()).profiles.find((item) => item.id === id);
        return !!profile && !profile.lockedBy;
      }
      return true;
    },
  }) : undefined;
  const replay: BrowserReplay | undefined = workbenchHub && !opts.remote
    ? new BrowserReplay(id => workbenchHub.replaySource(id), (): string => {
        const host = hostname === "::1" ? "[::1]" : hostname === "localhost" ? "localhost" : "127.0.0.1";
        return "http://" + host + ":" + server.port;
      })
    : undefined;
  // Proxy changes an AI asks for wait here for a person on the dashboard (unless the user allowed them).
  const proxyApprovals = new ProxyApprovalQueue();
  const aiProxyPolicy = (): AiProxyPolicy => {
    try { return opts.appConfig?.read().aiProxyChanges ?? "ask"; } catch { return "ask"; }
  };
  // IP scores from many services, shared by the dashboard and AIs, kept half a day per IP.
  const ipScores = new IpScoreCache(opts.paths && !opts.remote ? join(opts.paths.root, "ip-scores.json") : undefined);
  // What AIs, scripts and tasks did, kept for six months next to the profiles.
  const audit = opts.paths && !opts.remote ? new AuditLog(join(opts.paths.root, "audit"), Date.now, undefined, log) : undefined;
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
      root: opts.paths!.root, library, launcher, store, admission, python, writes,
      remote: opts.remote,   log,
      report: (entry) => audit?.record({
        actor: { kind: "script", name: entry.scriptName }, action: "script.run", ok: entry.ok,
        profileId: entry.profileId, profileName: entry.profileName,
        detail: entry.startedBy ? `${entry.status}, started by ${entry.startedBy.kind === "ai" ? "AI " : entry.startedBy.kind === "task" ? "task " : ""}${entry.startedBy.name}` : entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      }),
    }),
  } : undefined;
  let tasks: TaskRunner | undefined;
  // Phone mode of the phone app: browser windows narrowed to a phone's width, and their old sizes.
  const phoneWindows = new PhoneWindows();
  // Watching from a phone: its own read-only listener, started only when turned on in Settings.
  const mobileView = workbenchHub && !opts.remote ? new MobileView({
    profiles: () => {
      const running = new Set(store.listLaunches().map((launch) => launch.profileId));
      return store.listProfiles().map((profile) => ({ id: profile.id, name: profile.name, group: profile.group ?? "", running: running.has(profile.id), engine: profile.engine }));
    },
    snapshot: (id) => workbenchHub.snapshot(id, 480),
    activity: () => {
      const run = scripts?.runner.status();
      const listing = tasks?.list();
      const task = listing?.runningTaskId ? listing.tasks.find((item) => item.id === listing.runningTaskId) : undefined;
      return {
        script: run && run.status !== "finished" ? { name: run.scriptName, total: run.profiles.length, done: run.profiles.filter((item) => ["succeeded", "failed", "cancelled"].includes(item.status)).length, failed: run.profiles.filter((item) => item.status === "failed").length } : null,
        task: task ? { name: task.name } : null,
      };
    },
  }, Date.now, {
    file: opts.paths ? join(opts.paths.root, "mobile-devices.json") : undefined,
    // The phone app: what a paired phone may do, the same as the dashboard on this computer.
    control: {
      version: ALIASMODE_VERSION,
      profiles: () => {
        const running = new Set(store.listLaunches().map((launch) => launch.profileId));
        return store.listProfiles().map((profile) => ({ id: profile.id, name: profile.name, group: profile.group ?? "", running: running.has(profile.id), engine: profile.engine ?? "chromium", tags: profile.tags ?? [] }));
      },
      open: async (id) => { activity.touch(id); await launcher.start(id); },
      close: async (id) => {
        const launch = store.getLaunch(id);
        cooling?.forget(id);
        await launcher.captureLocalSession(id);
        if (!await launcher.stop(id, launch ?? undefined)) throw new Error("The browser did not close");
      },
      scripts: async () => scripts ? (await scripts.library.list()).map((script) => ({ id: script.id, name: script.name, description: script.description, language: script.language })) : [],
      runScript: (scriptId, profileIds, by) => {
        if (!scripts) throw new Error("Scripts are unavailable");
        return scripts.runner.start({ scriptId, profileIds, inputs: {}, useCredentials: false, startedBy: { kind: "user", name: `Phone: ${by}` } });
      },
      stopScript: async () => await scripts?.runner.stop() ?? null,
      scriptStatus: () => scripts?.runner.status() ?? null,
      tasks: () => tasks?.list() ?? { tasks: [], history: [], runningTaskId: null },
      runTask: (id) => { if (!tasks) throw new Error("Tasks are unavailable"); void tasks.run(id).catch(() => {}); },
      approvals: () => ({ proxy: proxyApprovals.list(), code: codeApprovals.list() }),
      answer: (kind, id, allow) => kind === "code" ? codeApprovals.answer(id, allow) : proxyApprovals.answer(id, allow),
      connect: (id) => workbenchHub.connect(id),
      viewMode: async (id, mode) => {
        const launch = store.getLaunch(id);
        if (mode === "pc") { await phoneWindows.leave(id, launch?.ws); return; }
        if (!launch || launch.firefoxOwner || launch.webkitOwner || !launch.ws) throw new Error("Phone mode needs a running Chromium browser");
        const area = launcher.claimedArea(id);
        if (!area) throw new Error("Profile not found");
        await phoneWindows.enter(id, launch.ws, area);
      },
      visit: async (id, url) => {
        activity.touch(id);
        const launch = store.getLaunch(id);
        if (!launch) { await launcher.start(id, [url]); return; }
        if (launch.firefoxOwner || launch.webkitOwner) throw new Error("Firefox and WebKit browsers that are already open cannot get a new tab from here; close it first");
        await launcher.navigate(launch.ws, [url]);
      },
      record: (entry) => audit?.record({ actor: { kind: "user", name: `Phone: ${entry.device}` }, action: entry.action, ok: entry.ok, ...(entry.profileId ? { profileId: entry.profileId } : {}), ...(entry.profileName ? { profileName: entry.profileName } : {}), ...(entry.detail ? { detail: entry.detail } : {}), ...(entry.error ? { error: entry.error } : {}) }),
    },
  }) : undefined;
  try { if (mobileView && opts.appConfig?.read().mobileView === true) mobileView.start(); } catch (error) { log(`phone view could not start: ${error instanceof Error ? error.message : error}`); }
  // Scripts and plugins an AI writes wait here for a person to read them (unless the user allowed them).
  const codeApprovals = new CodeApprovalQueue();
  const aiCodePolicy = (): AiCodePolicy => {
    try { return opts.appConfig?.read().aiCodeChanges ?? "ask"; } catch { return "ask"; }
  };
  const aiAccess = () => opts.appConfig?.read().aiAccess;
  const agentCredentials = agentNonce && opts.paths && !opts.remote
    ? new AgentCredentials(join(opts.paths.root, "agent-credentials.json")) : undefined;
  const workspaceBackup = opts.desktopAdminNonce && agentCredentials
    ? new WorkspaceBackup(store, id => !!lstatSync(launcher.userDataDir(id), { throwIfNoEntry: false })) : undefined;
  const authorizeTask = (profileId: string, client: string, savedGroup?: string, actor?: import("./browser-tasks.ts").BrowserTaskActor) => {
    const profile = store.getProfile(profileId);
    if (!profile && savedGroup === undefined) throw new BrowserTaskError("no_such_profile", "The browser task profile was not found", 404);
    const group = profile?.group ?? savedGroup ?? "";
    if (actor?.scope.startsWith("worker")) {
      if (!workers?.allows(actor, group)) throw new BrowserTaskError("not_permitted", "Worker permission for the profile was revoked", 403);
      return group;
    }
    if ((actor?.scope === "local-auth" && !agentCredentials?.isActive(client)) ||
      (actor?.scope === "local" && agentCredentials?.permitsNameOnly(client) === false) ||
      !allowsGroup(ruleFor(aiAccess(), client), group, store.listFolders())) {
      throw new BrowserTaskError("not_permitted", "This AI may not use the profile's group", 403);
    }
    return group;
  };
  const browserTasks = agentNonce && opts.paths && !opts.remote ? new BrowserTaskSupervisor({
    root: join(opts.paths.root, "browser-tasks"),
    capacity: browserTaskCapacity(),
    hostWork: admission.hostWork,
    writes,
    authorize: authorizeTask,
    async open(profileId, client, signal, hostPermit, actor) {
      const session = new AgentControlSession({ launcher, store, admission, activity, log,
        validateProfile: id => { authorizeTask(id, client, undefined, actor); },
      }, signal, hostPermit);
      const call = async (method: string, params: Record<string, unknown>) => {
        const response = await session.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: 1, method, params }));
        if (!response.ok) throw new BrowserTaskError(response.error?.code ?? "operation_failed", response.error?.message ?? "Browser task could not open its profile");
        return response.result as { ownedByConnection?: boolean };
      };
      try {
        await call("session.identify", { name: client });
        const opened = await call("browser.open", { profileId });
        const launch = store.getLaunch(profileId);
        if (!launch?.ws) throw new BrowserTaskError("browser_not_running", "The task browser did not expose its control endpoint");
        const endpoint = launch.ws, generation = workbenchGeneration(launch);
        if (opened.ownedByConnection) await call("browser.detach", { profileId });
        const current = () => {
          const active = store.getLaunch(profileId);
          return !!active && workbenchGeneration(active) === generation;
        };
        const run = async <T>(input: object, timeoutMs: number): Promise<T> => {
          if (!current()) throw new BrowserTaskError("browser_changed", "The task browser closed or restarted");
          try {
            return await runPlaywrightWorker<T>("devtools-program", { ...input, endpoint }, { timeoutMs });
          } catch (error) {
            if (!current() || !(await launcher.certifiedActive(profileId).catch(() => false))) {
              throw new BrowserTaskError("browser_disconnected", "The task browser disconnected while executing a program");
            }
            throw error;
          }
        };
        const connection: BrowserTaskConnection = {
          async program(input) {
            const receipt = await run<Awaited<ReturnType<BrowserTaskConnection["program"]>>>(input, input.timeoutMs);
            if (input.tabId && !receipt.completed && !receipt.fault
              && (!current() || !(await launcher.certifiedActive(profileId).catch(() => false)))) {
              return { ...receipt, fault: "browser_disconnected" };
            }
            return receipt;
          },
          async bindTab(target, previous) {
            const id = previous ? (!previous.lost && previous.generation === generation ? previous.id : undefined) : target.tabId;
            const binding = await run<{ id?: string; fault?: string; error?: string }>({
              taskTab: { id, startUrl: target.startUrl, allowCreate: !!previous || !id },
            }, 65_000);
            if (!binding.id) throw new BrowserTaskError(binding.fault ?? "operation_failed", binding.error ?? "The task tab could not be bound");
            return { id: binding.id, generation };
          },
          close: () => session.disconnect(),
        };
        return connection;
      } catch (error) {
        await session.disconnect();
        throw error;
      }
    },
    hold: (profileId) => activity.hold(profileId),
    record: ({ runId, profileId, client, stepId, sequence, phase, ok }) => audit?.record({
      actor: { kind: "task", name: client }, profileId, action: "browserTask." + phase, ok,
      task: { runId, stepId, sequence },
    }),
    log,
  }) : undefined;
  const portable = browserTasks && opts.paths
    ? new PortableProfiles({ root: join(opts.paths.root, "portable-profiles"), store, launcher, writes, admission })
    : undefined;
  const workers = browserTasks && opts.paths && portable
    ? new WorkerNodes({ config: join(opts.paths.root, "worker-nodes.json"), store, tasks: browserTasks, portable, capacity: () => admission.capacity() })
    : undefined;
  if (scripts && opts.paths && !opts.remote) {
    tasks = new TaskRunner({
      store: new TaskStore(join(opts.paths.root, "tasks.json")),
      runner: scripts.runner,
      browserTasks,
      resolveProfiles: target => store.listProfiles().filter(profile => target.profileIds?.includes(profile.id)
        || target.groups?.includes(profile.group || "")
        || (profile.tags ?? []).some(tag => target.tags?.includes(tag))).map(profile => profile.id),
      scriptName: async id => (await scripts.library.get(id)).name,
      log,
    });
    tasks.start();
  }
  const agentHub = agentNonce
    ? new AgentControlHub({
        launcher,
        store,
        admission,
        remote: opts.remote,
        activity,
        writes,
        // Plugins are code on this computer; a remotely coordinated runtime offers none.
        ...(opts.paths && !opts.remote ? { plugins: () => scanPlugins(pluginsDirectory(opts.paths!.root), opts.appConfig?.read().disabledPlugins ?? []).specs } : {}),
        // The AI's pointer in a Chromium browser, drawn over that browser's card.
        pointer: (profileId, pointer) => workbenchHub?.pointer(profileId, pointer),
        replay,
        proxyApprovals,
        aiProxyPolicy,
        ...(scripts ? { scripts: { library: scripts.library, runner: scripts.runner } } : {}),
        browserTasks,
        taskSchedules: tasks,
        kernels,
        android,
        portable,
        workers,
        networkIdentity,
        ...(opts.paths && !opts.remote ? { pluginsRoot: pluginsDirectory(opts.paths.root) } : {}),
        codeApprovals,
        aiCodePolicy,
        aiAccess,
        agentCredentials,
        ipScores,
        ...(audit ? { audit } : {}),
        log,
      })
    : undefined;
  // Desktop only: idle browsers cool down when memory runs short and come back signed in.
  const finished = new Set(["succeeded", "failed", "cancelled", "skipped"]);
  const cooling = agentNonce && opts.appConfig && !opts.remote ? new CoolingMonitor({
    settings: () => { try { return opts.appConfig!.read().cooling ?? COOLING_DEFAULTS; } catch { return COOLING_DEFAULTS; } },
    running: () => store.listLaunches().map((launch) => ({ profileId: launch.profileId, startedAt: launch.startedAt ?? 0 })),
    busy: (id) => writes.busy(id) || activity.held(id) || !!agentHub?.holds(id)
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
    ...(opts.workerTls ? { tls: opts.workerTls } : {}),
    ...(workers ? { maxRequestBodySize: MAX_PORTABLE_BYTES } : {}),
    // Queue wait plus a complete remote restore can legitimately hold a lifecycle
    // response for several minutes while the shared transition cap does its job.
    idleTimeout: 240,
    // Development mode watches the app folder for hot reload. On Windows that
    // watcher leaks kernel memory on every database write until the host stalls.
    development: false,
    ...(opts.workerTls ? {} : { routes: { "/": index } }),
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
      const deniedHost = opts.workerTls ? null : loopbackHostGuard(req, hostname);
      if (deniedHost) return deniedHost;
      const reqUrl = new URL(req.url);
      if (reqUrl.pathname === WORKER_PATH + "/tasks" || reqUrl.pathname === WORKER_PATH + "/handoff") {
        if (!workers) return new Response(null, { status: 404 });
        return workers.serve(req, reqUrl.pathname);
      }
      if (opts.workerTls) return new Response(null, { status: 404 });
      if (reqUrl.pathname === BROWSER_REPLAY_PATH || reqUrl.pathname.startsWith(BROWSER_REPLAY_PATH + "/")) {
        if (!replay || !isAllowedLoopbackHostHeader(req.headers.get("host")) || !isLoopbackAddress(server.requestIP(req)?.address)) {
          return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        return browserReplayView(req, reqUrl.pathname, replay);
      }
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
      if ((reqUrl.pathname === AGENT_CREDENTIALS_PATH || reqUrl.pathname === WORKSPACE_BACKUP_PATH || reqUrl.pathname === SUPPORT_DIAGNOSTICS_PATH
        || reqUrl.pathname === "/ui/api/profiles/deletion-protection")
        && (!isAllowedLoopbackHostHeader(req.headers.get("host")) || !isLoopbackAddress(server.requestIP(req)?.address))) {
        return Response.json({ ok: false, error: "loopback access only" }, { status: 403 });
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
        const token = req.headers.get("x-vela-agent-token");
        let name: string | undefined;
        try {
          if (token !== null) name = agentCredentials?.resolve(token);
          if (token !== null ? !name : agentCredentials?.permitsNameOnly("unknown") === false) {
            return Response.json({ ok: false, error: "Agent credential required or rejected" }, { status: 401 });
          }
        } catch { return Response.json({ ok: false, error: "Agent credentials are unavailable" }, { status: 503 }); }
        const session = agentHub.connect(token !== null && name ? { token, name } : undefined);
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
          admission,
          paths: opts.paths,


          health: opts.health,
          scripts: scripts ? { ...scripts, tasks, browserTasks } : undefined,
          runtimeMode,
          proxyApprovals,
          codeApprovals,
          ...(audit ? { audit } : {}),
          ...(snapshots ? { snapshots } : {}),
          connectedAgents: () => agentHub?.connectedAgents() ?? [],
          authenticatedAgents: () => { try { return agentCredentials?.names() ?? []; } catch { return []; } },
          ...(agentCredentials && opts.desktopAdminNonce && workspaceBackup ? { desktopAdministration: {
            nonce: opts.desktopAdminNonce, credentials: agentCredentials, workspaceBackup, changed: () => agentHub?.disconnectInvalidIdentities(),
          } } : {}),
          ...(mobileView ? { mobileView } : {}),
          ipScores,
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
  browserTasks?.startRecovery();
  if (opts.workerTls) log(`Worker HTTPS API on https://${hostname}:${server.port}`);
  else log(`dashboard + API on http://${hostname}:${server.port}  (UI at /, Vela Local API under /api; AdsPower-compatible)`);
  const stopServer = server.stop.bind(server);
  return Object.assign(server, {
    async stop(closeActiveConnections?: boolean) {
      replay?.close();
      cooling?.stop();
      tasks?.stop();
      networkIdentity?.stop();
      clearInterval(backupTimer); clearTimeout(firstBackup);
      mobileView?.stop();
      taskbarMode?.stop();
      shutdownController.abort();
      await Promise.allSettled([
        browserTasks?.shutdown() ?? Promise.resolve(),
        subscriptionScheduler?.stop() ?? Promise.resolve(),
        drainPoolTasks(store),
      ]);
      return await stopServer(closeActiveConnections);
    },
    stopScripts: async () => { await Promise.all([scripts?.runner.shutdown(), browserTasks?.shutdown()]); },
  });
}

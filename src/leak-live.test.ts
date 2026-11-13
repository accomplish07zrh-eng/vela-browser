/**
 * Leak probe with real browsers (Windows). Skipped unless VELA_LEAK_LIVE=1.
 *
 *   VELA_LEAK_LIVE=1
 *   VELA_LEAK_CHROMIUM=<Vela Chromium 155 chrome.exe>          (optional)
 *   VELA_LEAK_FIREFOX=<Vela Firefox aliasmode.exe>             (optional)
 *   ALIASMODE_PLAYWRIGHT_RUNTIME=<packaged playwright folder>  (Firefox only)
 *
 * The profile's proxy is a fake exit on loopback that never touches the internet: it serves the
 * probe page and its subresources for *.vela-leak.test names and two documentation addresses
 * (203.0.113.7, [2001:db8::7]), records every request, and refuses everything else. A request
 * that reaches it went through the profile's relay. Anything else the browser does on the network
 * is a leak, which these independent observers look for:
 *
 *  - Chromium's own net log (every resolver job, DNS transaction, TCP and UDP connect), or
 *    Firefox's MOZ_LOG of its host resolver and socket transport;
 *  - the operating system's TCP and UDP tables for the browser's processes, sampled throughout;
 *  - the Windows DNS client cache, for the run's unique names.
 *
 * Covered: DNS (page names, dns-prefetch, preconnect, prefetch, WebSocket, STUN server names),
 * IPv4 and IPv6 literals, WebRTC candidates, and the kill switch (the relay goes away while the
 * page keeps requesting: nothing may go anywhere else). For Chromium the fingerprint captured with
 * and without the host-resolver rules is compared as well.
 *
 * This machine may run a system-wide TUN proxy. These checks do not depend on which exit IP a
 * leak would show, so they hold with or without one.
 */
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildNewProfile } from "./create.ts";
import { defaultSpawn, Launcher, PROXIED_DISABLED_FEATURES, PROXIED_HOST_RESOLVER_RULES } from "./launcher.ts";
import { ProfileStore } from "./store.ts";
import type { ObservedFingerprint, Profile } from "./types.ts";

const live = process.env.VELA_LEAK_LIVE === "1" && process.platform === "win32";
const chromiumBinary = process.env.VELA_LEAK_CHROMIUM?.trim() ?? "";
const firefoxBinary = process.env.VELA_LEAK_FIREFOX?.trim() ?? "";
const chromiumTest = live && chromiumBinary ? test : test.skip;
const firefoxTest = live && firefoxBinary ? test : test.skip;

const LEAK_DOMAIN = "vela-leak.test";
const V4 = "203.0.113.7";
const V6 = "2001:db8::7";
const FAKE_EXIT = { timezone: "America/New_York", country: "US", ip: "203.0.113.50" };
const MIN_OBSERVATION_MS = Number(process.env.VELA_LEAK_OBSERVE_MS ?? 60_000);

interface ExitRecord { at: number; kind: "connect" | "http"; target: string; path?: string }

/** The fake exit: an HTTP proxy that answers only for the probe's names and records everything. */
async function fakeExit(run: string, canary: Canary) {
  const records: ExitRecord[] = [];
  const reports: unknown[] = [];
  const page = probePage(run, canary);
  const ours = (host: string) => host === V4 || host === V6 || host === `[${V6}]` || host.endsWith(`.${LEAK_DOMAIN}`);
  const server = net.createServer((sock) => {
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      sock.removeListener("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const first = head.split("\r\n")[0] ?? "";
      const [method = "", target = ""] = first.split(/\s+/);
      if (/^CONNECT$/i.test(method)) {
        records.push({ at: Date.now(), kind: "connect", target });
        // No TLS here: a preconnect only has to arrive. Close it.
        sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      let url: URL;
      try { url = new URL(target); } catch { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      const host = url.hostname.replace(/^\[|\]$/g, "");
      records.push({ at: Date.now(), kind: "http", target: url.host, path: url.pathname });
      if (!ours(host)) { sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return; }
      if (/^upgrade:\s*websocket/im.test(head)) {
        sock.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const length = Number(/^content-length:\s*(\d+)/im.exec(head)?.[1] ?? 0);
      const finish = (body: Buffer) => {
        if (url.pathname === "/report") {
          try { reports.push(JSON.parse(body.toString("utf8"))); } catch { reports.push({ invalid: true }); }
        }
        const html = url.pathname === "/" ? page : "ok";
        const type = url.pathname === "/" ? "text/html; charset=utf-8" : "text/plain";
        sock.end(`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(html)}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${html}`);
      };
      let body = buf.subarray(end + 4);
      if (body.length >= length) { finish(body.subarray(0, length)); return; }
      sock.on("data", (more: Buffer) => {
        body = Buffer.concat([body, more]);
        if (body.length >= length) finish(body.subarray(0, length));
      });
    };
    sock.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as net.AddressInfo).port,
    records,
    reports,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Canary { v4?: string; v6?: string; tcpPort: number; udp4Port: number; udp6Port: number; hits: string[]; close(): void }

/**
 * Listeners on this computer's own LAN addresses. The page aims plain requests, STUN and TURN at
 * them. Through the relay those requests reach only the fake exit, which never forwards them, so
 * any TCP connection or UDP datagram that arrives here left the browser without the relay.
 */
/**
 * Joins the mDNS groups (224.0.0.251, ff02::fb) and records every packet this computer itself
 * multicasts there while the browser runs. The OS loops a host's own multicast back to its
 * members, so a query or announcement from the browser is seen here, from a real interface.
 */
async function mdnsWatch(): Promise<{ sent: string[]; close(): void }> {
  const own = new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map((entry) => entry!.address.replace(/%.*$/, "")));
  const sent: string[] = [];
  const record = (message: Buffer, from: { address: string; port: number }) => {
    if (!own.has(from.address.replace(/%.*$/, ""))) return;
    sent.push(`${from.address}:${from.port} ${[...message.toString("latin1").matchAll(/[\x20-\x7e]{3,}/g)].map((m) => m[0]).join(".")}`);
  };
  const v4 = createSocket({ type: "udp4", reuseAddr: true });
  v4.on("message", record);
  await new Promise<void>((resolve) => v4.bind(5353, () => resolve()));
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry && entry.family === "IPv4" && !entry.internal) { try { v4.addMembership("224.0.0.251", entry.address); } catch {} }
  }
  const v6 = createSocket({ type: "udp6", reuseAddr: true, ipv6Only: true });
  v6.on("message", record);
  await new Promise<void>((resolve) => v6.bind(5353, () => resolve()));
  try { v6.addMembership("ff02::fb"); } catch {}
  return { sent, close: () => { v4.close(); v6.close(); } };
}

async function directCanary(): Promise<Canary> {
  const hits: string[] = [];
  const all = Object.values(networkInterfaces()).flat().filter((entry) => entry && !entry.internal);
  const v4 = all.find((entry) => entry!.family === "IPv4" && !/^(169\.254|198\.1[89])\./.test(entry!.address))?.address;
  const v6 = all.find((entry) => entry!.family === "IPv6" && !/^fe80:/i.test(entry!.address))?.address;
  const tcp = net.createServer((socket) => { hits.push(`tcp from ${socket.remoteAddress}`); socket.destroy(); });
  await new Promise<void>((resolve) => tcp.listen({ port: 0, host: "::", ipv6Only: false }, () => resolve()));
  const udp4 = createSocket("udp4");
  udp4.on("message", (_message, from) => hits.push(`udp4 from ${from.address}:${from.port}`));
  await new Promise<void>((resolve) => udp4.bind(0, "0.0.0.0", () => resolve()));
  const udp6 = createSocket({ type: "udp6", ipv6Only: true });
  udp6.on("message", (_message, from) => hits.push(`udp6 from ${from.address}:${from.port}`));
  await new Promise<void>((resolve) => udp6.bind(0, "::", () => resolve()));
  return {
    ...(v4 ? { v4 } : {}),
    ...(v6 ? { v6 } : {}),
    tcpPort: (tcp.address() as net.AddressInfo).port,
    udp4Port: udp4.address().port,
    udp6Port: udp6.address().port,
    hits,
    close: () => { tcp.close(); udp4.close(); udp6.close(); },
  };
}

function probePage(run: string, canary: Canary): string {
  const n = (label: string) => `${label}-${run}.${LEAK_DOMAIN}`;
  const lan4 = canary.v4 ? JSON.stringify(canary.v4) : "null";
  const lan6 = canary.v6 ? JSON.stringify(canary.v6) : "null";
  return `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<link rel="dns-prefetch" href="//${n("dnsprefetch")}">
<link rel="preconnect" href="https://${n("preconnect")}">
<link rel="prefetch" href="http://${n("prefetch")}/p">
</head><body>
<a href="http://${n("anchor")}/a">anchor</a>
<img src="http://${n("img")}/i.png">
<script>
(async () => {
  const report = { candidates: [], errors: [] };
  const hit = (url) => fetch(url, { cache: "no-store" }).then(() => "ok", (e) => String(e));
  // What a page can see of casting (Presentation API, Remote Playback), compared across launches.
  report.cast = {
    presentation: typeof navigator.presentation,
    presentationRequest: typeof PresentationRequest,
    remote: "remote" in HTMLMediaElement.prototype,
  };
  try {
    report.cast.availability = await Promise.race([
      new PresentationRequest("https://cast.example/").getAvailability().then((a) => "value:" + a.value, (e) => "error:" + e.name),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 1500)),
    ]);
  } catch (e) { report.cast.availability = "throw:" + e.name; }
  try {
    const video = document.createElement("video");
    report.cast.remoteState = video.remote ? video.remote.state : "none";
    report.cast.remoteWatch = await Promise.race([
      video.remote ? video.remote.watchAvailability(() => {}).then(() => "ok", (e) => "error:" + e.name) : Promise.resolve("none"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 1500)),
    ]);
  } catch (e) { report.cast.remoteWatch = "throw:" + e.name; }
  report.v4 = await hit("http://${V4}/v4");
  report.v6 = await hit("http://[${V6}]/v6");
  report.name = await hit("http://${n("fetch")}/f");
  // Requests for this computer's own LAN addresses: through the relay they reach only the fake exit.
  const lan4 = ${lan4}, lan6 = ${lan6};
  if (lan4) report.lan4 = await hit("http://" + lan4 + ":${canary.tcpPort}/direct4");
  if (lan6) report.lan6 = await hit("http://[" + lan6 + "]:${canary.tcpPort}/direct6");
  try { const ws = new WebSocket("ws://${n("ws")}/s"); ws.onerror = () => {}; } catch (e) { report.errors.push(String(e)); }
  try {
    const iceServers = [
      { urls: "stun:${n("stun")}:3478" },
      { urls: "stun:203.0.113.9:3478" },
      { urls: "turn:${n("turn")}:3478?transport=tcp", username: "u", credential: "p" },
    ];
    // STUN and TURN servers on this computer's LAN addresses: a datagram or connection to them that
    // did not go through the relay arrives at the canary.
    if (lan4) iceServers.push(
      { urls: "stun:" + lan4 + ":${canary.udp4Port}" },
      { urls: "turn:" + lan4 + ":${canary.udp4Port}?transport=udp", username: "u", credential: "p" },
      { urls: "turn:" + lan4 + ":${canary.tcpPort}?transport=tcp", username: "u", credential: "p" },
    );
    if (lan6) iceServers.push({ urls: "stun:[" + lan6 + "]:${canary.udp6Port}" });
    const pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel("probe");
    pc.onicecandidate = (event) => { if (event.candidate) report.candidates.push(event.candidate.candidate); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => setTimeout(resolve, 6000));
    report.sdp = pc.localDescription && pc.localDescription.sdp;
    pc.close();
  } catch (e) { report.errors.push(String(e)); }
  await fetch("http://${n("report")}/report", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
  // Keep asking after the report, so a relay that goes away is observed under load.
  let i = 0;
  setInterval(() => {
    i++;
    fetch("http://${n("tick")}/t" + i, { cache: "no-store" }).catch(() => {});
    fetch("http://${V4}/t" + i, { cache: "no-store" }).catch(() => {});
    fetch("http://[${V6}]/t" + i, { cache: "no-store" }).catch(() => {});
  }, 300);
})();
</script></body></html>`;
}

/**
 * Samples the OS TCP/UDP tables of the probe's own browser: the process whose PID is written to
 * `rootFile` and all its descendants. Other windows of the same executable on this computer (the
 * user's own running profiles) are not part of the run and are left out.
 */
function socketSampler(rootFile: string, out: string) {
  const stop = `${out}.stop`;
  // PowerShell single-quoted strings take backslashes literally.
  const ps = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$set = New-Object 'System.Collections.Generic.HashSet[int]'
$refreshed = 0
while (-not (Test-Path -LiteralPath ${ps(stop)})) {
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  if ((Test-Path -LiteralPath ${ps(rootFile)}) -and ($now - $refreshed -gt 1500)) {
    $root = [int](Get-Content -LiteralPath ${ps(rootFile)} -Raw)
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine)
    [void]$set.Add($root)
    do {
      $before = $set.Count
      foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId)) { [void]$set.Add([int]$p.ProcessId) } }
    } while ($set.Count -gt $before)
    $procs = @($all | Where-Object { $set.Contains([int]$_.ProcessId) } | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = "$($_.Name)"; cmd = "$($_.CommandLine)".Substring(0, [Math]::Min(300, "$($_.CommandLine)".Length)) } })
    if ($procs.Count -gt 0) { Add-Content -LiteralPath ${ps(out + ".procs.jsonl")} -Value ($procs | ConvertTo-Json -Compress -Depth 3) }
    $refreshed = $now
  }
  $ids = @($set)
  if ($ids.Count -gt 0) {
    $split = { param($ep) if ($ep -match '^\\[(.*)\\]:(\\d+)$' -or $ep -match '^(.*):(\\d+)$') { @($Matches[1], [int]$Matches[2]) } else { @($ep, 0) } }
    $tcp = @(); $udp = @()
    # netstat is fast enough to sample several times a second; the Get-Net* cmdlets are not.
    foreach ($row in (netstat -ano)) {
      $c = -split $row
      if ($c.Count -ge 5 -and $c[0] -eq 'TCP' -and $set.Contains([int]$c[4]) -and $c[3] -ne 'LISTENING') {
        $r = & $split $c[2]; $tcp += @{ a = $r[0]; port = $r[1]; s = $c[3]; pid = [int]$c[4] }
      } elseif ($c.Count -ge 4 -and $c[0] -eq 'UDP' -and $set.Contains([int]$c[3])) {
        $l = & $split $c[1]; $udp += @{ a = $l[0]; port = $l[1]; pid = [int]$c[3] }
      }
    }
    $line = @{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); n = $ids.Count; tcp = $tcp; udp = $udp } | ConvertTo-Json -Compress -Depth 4
    Add-Content -LiteralPath ${ps(out)} -Value $line
  }
  Start-Sleep -Milliseconds 150
}`;
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "ignore", stderr: "ignore" });
  return {
    async stop(): Promise<Array<{ t: number; n: number; tcp: Array<{ a: string; port: number; s: string }>; udp: Array<{ a: string; port: number }> }>> {
      writeFileSync(stop, "");
      await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      proc.kill();
      if (!existsSync(out)) return [];
      return readFileSync(out, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
        const row = JSON.parse(line);
        const list = (value: unknown) => value == null ? [] : Array.isArray(value) ? value : [value];
        return { ...row, tcp: list(row.tcp), udp: list(row.udp) };
      });
    },
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);

async function dnsCacheNames(fragment: string): Promise<string[]> {
  const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    `Get-DnsClientCache | Where-Object { $_.Entry -like '*${fragment}*' -or $_.Name -like '*${fragment}*' } | ForEach-Object { $_.Entry }`], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Every host the Chromium net log resolved through a real resolver, and every socket it opened. */
function readNetLog(path: string) {
  let raw = readFileSync(path, "utf8").trim();
  // A log cut off by a hard kill lacks its tail; close it.
  if (!raw.endsWith("}")) raw = raw.replace(/,\s*$/, "") + "]}";
  const log = JSON.parse(raw) as { constants: { logEventTypes: Record<string, number> }; events: Array<{ type: number; params?: Record<string, unknown> }> };
  const names = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  /** Names a real resolver worked on: a job, a DNS transaction, a system or mDNS lookup. */
  const resolved: Array<{ event: string; host: string }> = [];
  /** Names the browser asked for. The host-resolver rules turn each into "~notfound". */
  const requested: string[] = [];
  const sockets: Array<{ event: string; address: string }> = [];
  /** UDP datagrams the browser actually sent. A UDP connect() alone sends nothing. */
  const udpSends: Array<{ event: string; params: unknown }> = [];
  for (const event of log.events) {
    const name = names[event.type] ?? String(event.type);
    const params = event.params ?? {};
    const host = String(params.host ?? params.hostname ?? params.dns_query ?? "");
    if (/^(HOST_RESOLVER_(MANAGER_JOB|DNS_TASK|SYSTEM_TASK|MDNS_TASK)|DNS_TRANSACTION|DOH_URL_REQUEST)/.test(name) && host) {
      resolved.push({ event: name, host });
    }
    if (name === "HOST_RESOLVER_MANAGER_REQUEST" && host) requested.push(host);
    if (/^(TCP_CONNECT_ATTEMPT|UDP_CONNECT)$/.test(name) && params.address) {
      sockets.push({ event: name, address: String(params.address) });
    }
    if (/^UDP_(BYTES_SENT|SEND_ERROR)$/.test(name)) udpSends.push({ event: name, params });
  }
  return { resolved, requested, sockets, udpSends };
}

/**
 * Chromium learns whether IPv6 is usable by connect()ing a UDP socket to Google's public DNS
 * address and reading the local address the OS picked. No datagram is sent (udpSends stays
 * empty), so nothing leaves the computer; stock Chrome does the same behind any proxy.
 */
const IPV6_REACHABILITY_PROBE = "[2001:4860:4860::8888]:443";

function hostOf(address: string): string {
  const v6 = /^\[([^\]]+)\]:\d+$/.exec(address);
  if (v6) return v6[1]!;
  return address.replace(/:\d+$/, "");
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface ProbeResult {
  canaryHits: string[];
  mdnsSent: string[];
  lan: { v4?: string; v6?: string };
  records: ExitRecord[];
  report: Record<string, unknown> | undefined;
  samples: Awaited<ReturnType<ReturnType<typeof socketSampler>["stop"]>>;
  /** Processes the sampler followed at its last refresh (root and descendants). */
  dnsCache: string[];
  fingerprint?: ObservedFingerprint;
  killAt: number;
  netLog?: ReturnType<typeof readNetLog>;
  mozLog?: string;
}

async function probe(
  engine: "chromium" | "firefox",
  opts: { stripResolverRules?: boolean; identity?: Profile } = {},
): Promise<ProbeResult> {
  const run = randomUUID().slice(0, 8);
  const root = join(tmpdir(), `vela-leak-${engine}-${run}`);
  mkdirSync(root, { recursive: true });
  const canary = await directCanary();
  const mdns = await mdnsWatch();
  const exit = await fakeExit(run, canary);
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const proxy = { type: "http" as const, host: "127.0.0.1", port: String(exit.port), user: "", pass: "" };
  const profile: Profile = opts.identity
    ? { ...structuredClone(opts.identity), proxy }
    : engine === "chromium"
      ? buildNewProfile({ name: `leak-${run}`, chromiumRuntime: "aliasmode", proxy, screen: "1280x800" }, () => false)
      : buildNewProfile({ name: `leak-${run}`, engine: "firefox", proxy, screen: "1280x800" }, () => false);
  store.upsertProfile(profile);
  const netLogPath = join(root, "netlog.json");
  const mozLogPath = join(root, "moz.log");
  const binary = engine === "chromium" ? chromiumBinary : firefoxBinary;
  if (engine === "firefox") {
    process.env.MOZ_LOG = process.env.VELA_LEAK_MOZ_LOG ?? "timestamp,nsHostResolver:5,nsSocketTransport:5";
    process.env.MOZ_LOG_FILE = mozLogPath;
  }
  const launcher = new Launcher({
    store,
    dataRoot: join(root, "profiles"),
    headless: false,
    portRange: { start: 9700, end: 9799 },
    cdpReadyTimeoutMs: 60_000,
    labelWindow: async () => {},
    lookupExitLocation: async () => FAKE_EXIT,
    ...(engine === "chromium" ? {
      chromiumRuntimeRoot: dirname(dirname(chromiumBinary)),
      ensureAliasmodeChromium: async () => chromiumBinary,
      baseArgs: [`--log-net-log=${netLogPath}`, "--net-log-capture-mode=Everything"],
      // Baseline only, never product: the same launch without the resolver rules and with Media
      // Router back on, as before this change.
      ...(opts.stripResolverRules ? {
        spawn: (bin: string, args: string[], env?: Record<string, string>) => defaultSpawn(bin, args
          .filter((arg) => !arg.startsWith("--host-resolver-rules="))
          .map((arg) => arg.startsWith("--disable-features=")
            ? "--disable-features=" + arg.slice("--disable-features=".length).split(",").filter((f) => !PROXIED_DISABLED_FEATURES.includes(f)).join(",")
            : arg), env),
      } : {}),
    } : {
      firefoxBinaryPath: firefoxBinary,
      expectedFirefoxBinarySha256: await sha256(firefoxBinary),
    }),
  } as ConstructorParameters<typeof Launcher>[0]);
  const rootPidFile = join(root, "browser.pid");
  const sampler = socketSampler(rootPidFile, join(root, "sockets.jsonl"));
  let killAt = 0;
  try {
    const startedAt = Date.now();
    await launcher.start(profile.id, [`http://page-${run}.${LEAK_DOMAIN}/`]);
    const browserPid = store.getLaunch(profile.id)?.pid;
    if (!browserPid) throw new Error("the probe browser has no recorded PID");
    writeFileSync(rootPidFile, String(browserPid));
    const deadline = Date.now() + 45_000;
    while (!exit.reports.length && Date.now() < deadline) await Bun.sleep(250);
    await Bun.sleep(3000);
    // Kill switch: the relay goes away while the page keeps requesting.
    killAt = Date.now();
    (launcher as unknown as { closeRelay(id: string): void }).closeRelay(profile.id);
    await Bun.sleep(5000);
    // Background discovery (Cast) starts at an uneven moment after launch. Every run watches at
    // least this long, so a quiet product run is not a run that ended too early.
    while (Date.now() - startedAt < MIN_OBSERVATION_MS) await Bun.sleep(500);
    const fingerprint = store.getProfile(profile.id)?.fpObserved;
    await launcher.stop(profile.id).catch(() => false);
    await Bun.sleep(1500);
    const samples = await sampler.stop();
    return {
      canaryHits: [...canary.hits],
      mdnsSent: [...mdns.sent],
      lan: { ...(canary.v4 ? { v4: canary.v4 } : {}), ...(canary.v6 ? { v6: canary.v6 } : {}) },
      records: exit.records,
      report: exit.reports[0] as Record<string, unknown> | undefined,
      samples,
      dnsCache: await dnsCacheNames(LEAK_DOMAIN),
      fingerprint,
      killAt,
      ...(engine === "chromium" && existsSync(netLogPath) ? { netLog: readNetLog(netLogPath) } : {}),
      ...(engine === "firefox" ? { mozLog: readMozLogs(root) } : {}),
    };
  } finally {
    await sampler.stop().catch(() => []);
    await launcher.stop(profile.id).catch(() => false);
    store.close();
    await exit.close();
    canary.close();
    mdns.close();
    if (process.env.VELA_LEAK_KEEP !== "1") rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else console.log(`[leak] kept ${root}`);
  }
}

function readMozLogs(root: string): string {
  // Firefox writes one file per process: moz.log.child-N, moz.log.moz_log etc.
  return readdirSync(root).filter((name) => name.startsWith("moz.log")).map((name) => readFileSync(join(root, name), "utf8")).join("\n");
}

function summarize(label: string, result: ProbeResult) {
  // TCP rows name the peer: anything but loopback is a connection that bypassed the relay.
  const remote = new Map<string, number>();
  // UDP rows name only the local address a socket is bound to; whether it sent anything is
  // answered by the engine's own log (Chromium udpSends, Firefox socket transport).
  const udpBound = new Set<string>();
  for (const sample of result.samples) {
    for (const row of sample.tcp) if (!LOOPBACK.has(row.a)) remote.set(`tcp ${row.a}:${row.port}`, (remote.get(`tcp ${row.a}:${row.port}`) ?? 0) + 1);
    for (const row of sample.udp) if (row.a !== "127.0.0.1" && row.a !== "::1") udpBound.add(`${row.a}:${row.port}`);
  }
  const afterKill = result.records.filter((record) => record.at > result.killAt + 200);
  const summary = {
    exitRequests: result.records.length,
    exitTargets: [...new Set(result.records.map((record) => record.target))].sort(),
    requestsAfterKill: afterKill.length,
    lan: result.lan,
    canaryHits: result.canaryHits,
    mdnsSent: result.mdnsSent,
    report: result.report,
    socketSamples: result.samples.length,
    nonLoopbackSockets: [...remote.entries()],
    tcpRowsSampled: result.samples.reduce((n, sample) => n + sample.tcp.length, 0),
    udpBoundNonLoopback: [...udpBound],
    dnsCache: result.dnsCache,
    ...(result.netLog ? {
      netLogResolved: result.netLog.resolved,
      netLogRequested: [...new Set(result.netLog.requested)],
      netLogTcp: [...new Set(result.netLog.sockets.filter((s) => s.event === "TCP_CONNECT_ATTEMPT").map((s) => hostOf(s.address)))],
      netLogUdpConnect: [...new Set(result.netLog.sockets.filter((s) => s.event === "UDP_CONNECT").map((s) => s.address))],
      netLogUdpSends: result.netLog.udpSends.length,
    } : {}),
  };
  console.log(`[leak] ${label}: ${JSON.stringify(summary)}`);
  if (process.env.VELA_LEAK_REPORT) {
    writeFileSync(`${process.env.VELA_LEAK_REPORT}.${label.replace(/\W+/g, "-")}.json`, JSON.stringify(summary, null, 2));
  }
  return { summary, remote, afterKill };
}

function expectNoLeak(result: ProbeResult, label: string) {
  const { summary, remote, afterKill } = summarize(label, result);
  // The probe ran: its page, subresources and literals all reached the fake exit through the relay.
  expect(result.report).toBeDefined();
  const targets = summary.exitTargets.join(" ");
  expect(targets).toContain(`page-`);
  expect(targets).toContain(V4);
  expect(targets).toContain(`[${V6}]`);
  // Direct traffic: nothing reached the LAN canary, while the same requests reached the exit.
  expect(result.canaryHits).toEqual([]);
  if (result.lan.v4) expect(targets).toContain(result.lan.v4);
  // DNS: no name of the run reached this computer's resolver.
  expect(result.dnsCache).toEqual([]);
  // IPv4/IPv6/WebRTC: the browser's processes held no socket to anything but loopback.
  expect(result.samples.length).toBeGreaterThan(20);
  expect([...remote.keys()]).toEqual([]);
  // No UDP socket bound anywhere but loopback, not even the wildcard address: nothing could send
  // a datagram (a STUN request, an mDNS announcement) from a real interface.
  // Only mDNS listeners (port 5353) may be bound beyond loopback. A browser with no other UDP
  // socket cannot send a datagram from a real interface.
  expect(summary.udpBoundNonLoopback.filter((socket) => !/^(0\.0\.0\.0|::):5353$/.test(socket))).toEqual([]);
  // The mDNS watch sees every multicast this computer sends, from any program (another browser the
  // user has open, Windows). What can only come from this run is a packet naming this run's own
  // WebRTC candidates: there must be none. Cast discovery is covered by the comparison test.
  const ownNames = ((result.report?.candidates as string[] | undefined) ?? [])
    .map((candidate) => candidate.split(" ")[4] ?? "").filter((address) => address.endsWith(".local"));
  expect(result.mdnsSent.filter((packet) => ownNames.some((name) => packet.includes(name.replace(/\.local$/, ""))))).toEqual([]);
  // WebRTC: no candidate carries this computer's address. Vela Chromium 155 shows the exit IP, as a
  // browser at the exit would. Vela Firefox, like stock Firefox, names its host candidate with a
  // random mDNS UUID; with no UDP socket bound (above) it has no address behind it.
  const candidates = ((result.report?.candidates as string[] | undefined) ?? []).filter(Boolean);
  expect(candidates.length).toBeGreaterThan(0);
  const MDNS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/;
  for (const candidate of candidates) {
    const address = candidate.split(" ")[4] ?? "";
    expect(address === FAKE_EXIT.ip || MDNS_UUID.test(address)).toBe(true);
    const related = / raddr (\S+)/.exec(candidate)?.[1];
    if (related) expect([FAKE_EXIT.ip, "0.0.0.0"]).toContain(related);
  }
  const sdpAddresses = [...String(result.report?.sdp ?? "").matchAll(/c=IN IP[46] (\S+)/g)].map((m) => m[1]!);
  for (const address of sdpAddresses) expect([FAKE_EXIT.ip, "0.0.0.0", "127.0.0.1"]).toContain(address);
  // Kill switch: once the relay is gone, nothing more reaches any exit (this one or another).
  expect(afterKill).toEqual([]);
  if (result.netLog) {
    // No real resolver ever worked on a name; every request became "~notfound".
    expect(result.netLog.resolved.filter((entry) => !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(entry.host))).toEqual([]);
    expect(result.netLog.requested.filter((host) => !/~notfound|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))).toEqual([]);
    // Every TCP connection went to loopback (the relay), and no UDP datagram was sent at all.
    expect(result.netLog.sockets.filter((socket) => socket.event === "TCP_CONNECT_ATTEMPT" && !LOOPBACK.has(hostOf(socket.address)))).toEqual([]);
    expect(result.netLog.sockets.filter((socket) => socket.event === "UDP_CONNECT" && socket.address !== IPV6_REACHABILITY_PROBE && !LOOPBACK.has(hostOf(socket.address)))).toEqual([]);
    expect(result.netLog.udpSends).toEqual([]);
  }
  if (result.mozLog !== undefined) {
    expect(result.mozLog.length).toBeGreaterThan(0);
    // Names Firefox asked its resolver about ("Resolving host"), and the ones it actually looked up:
    // NameLookup starts a lookup (system or DoH), NativeLookup and getaddrinfo ask this computer's
    // DNS. Behind the relay a request may be made (an HTTPS-record request is), but no lookup.
    const of = (pattern: RegExp) => [...new Set([...result.mozLog!.matchAll(pattern)].map((match) => match[1]!))];
    const requested = of(/Resolving host \[([^\]\s<]+)/g);
    const lookups = of(/(?:NameLookup host:|NativeLookup host:|getaddrinfo for host \[|CompleteLookup: )([^\]\s<]+)/g);
    console.log(`[leak] firefox resolver requests: ${JSON.stringify(requested)}; lookups: ${JSON.stringify(lookups)}`);
    expect(lookups.filter((host) => !/^(127\.0\.0\.1|localhost|::1)$/.test(host))).toEqual([]);
    // Every socket Firefox opened went to the relay: a page's names appear only as the origin of a
    // transport whose proxy is the loopback relay.
    const transports = result.mozLog.split(/\r?\n/).filter((line) => line.includes("nsSocketTransport::Init ["));
    expect(transports.length).toBeGreaterThan(0);
    const direct = transports.filter((line) => !/ proxy=127\.0\.0\.1:\d+\]/.test(line) && !/ host=(127\.0\.0\.1|localhost):\d+/.test(line));
    expect(direct).toEqual([]);
    // And the socket transport never tried an address other than loopback.
    const tried = of(/trying address: (\S+)/g);
    expect(tried.filter((address) => !/^(127\.0\.0\.1|::1)(:\d+)?$/.test(address))).toEqual([]);
  }
}

chromiumTest("Vela Chromium 155: no DNS, IPv4, IPv6 or WebRTC leak, and the kill switch holds", async () => {
  expect(PROXIED_HOST_RESOLVER_RULES).toContain("MAP * ~NOTFOUND");
  const result = await probe("chromium");
  expectNoLeak(result, "chromium");
}, 600_000);

chromiumTest("Vela Chromium 155: the resolver rules and Media Router off change no captured fingerprint field", async () => {
  // One identity, launched twice: as the product launches it, and (baseline only) without the
  // resolver rules and with Media Router on.
  const identity = buildNewProfile({ name: "leak-fingerprint", chromiumRuntime: "aliasmode", screen: "1280x800" }, () => false);
  const withRules = await probe("chromium", { identity });
  const without = await probe("chromium", { identity, stripResolverRules: true });
  summarize("chromium baseline (not product)", without);
  // The mDNS watch is live: the baseline's Cast discovery is seen, the product's absence is real.
  expect(without.mdnsSent.some((packet) => packet.includes("_googlecast"))).toBe(true);
  expect(withRules.mdnsSent).toEqual([]);
  // What pages can see of casting is the same either way.
  expect(withRules.report?.cast).toEqual(without.report?.cast);
  // Capture time and diagnostics are not identity; everything else is compared.
  const comparable = (fp: ObservedFingerprint | undefined) => {
    const { capturedAt: _a, details: _d, errors: _e, consistency: _c, ...rest } = fp ?? {};
    return rest;
  };
  expect(withRules.fingerprint).toBeDefined();
  expect(without.fingerprint).toBeDefined();
  console.log(`[leak] fingerprint with rules: ${JSON.stringify(comparable(withRules.fingerprint))}`);
  console.log(`[leak] fingerprint without rules: ${JSON.stringify(comparable(without.fingerprint))}`);
  expect(Object.keys(comparable(withRules.fingerprint)).length).toBeGreaterThan(10);
  expect(comparable(withRules.fingerprint)).toEqual(comparable(without.fingerprint));
}, 600_000);

firefoxTest("Vela Firefox: no DNS, IPv4, IPv6 or WebRTC leak, and the kill switch holds", async () => {
  const result = await probe("firefox");
  expectNoLeak(result, "firefox");
}, 600_000);

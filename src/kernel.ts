/**
 * The sing-box kernel for proxy-pool nodes (design §3): a pinned release, verified by hash before
 * it is unpacked and again before every start; one process per profile, so a crash or a switch
 * touches one profile only; and a watchdog that restarts a kernel that died while its profile
 * still needs it.
 *
 * A dead kernel is a dead network, never a direct one: the profile's relay points at the kernel's
 * loopback port, and nothing listens there until the kernel is back.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertKernelConfig, kernelConfig, needsKernelResolver, type KernelDnsServer } from "./kernel-config.ts";
import { downloadResumable } from "./runtime-download.ts";
import type { Outbound } from "./subscription.ts";
import type { ProxySpec } from "./types.ts";
import { extractZipTo } from "./unzip.ts";

export const SINGBOX_VERSION = "1.14.4";

interface SingBoxArchive {
  name: string;
  size: number;
  /** SHA-256 of the release archive, as GitHub publishes it for the release. */
  sha256: string;
  /** SHA-256 of the executable inside, where it was measured; otherwise recorded at unpacking. */
  exeSha256?: string;
}

/** Release v1.14.4 of github.com/SagerNet/sing-box. Bump all of these together. */
export const SINGBOX_ARCHIVES: Record<string, SingBoxArchive> = {
  "win32-x64": {
    name: "sing-box-1.14.4-windows-amd64.zip", size: 32891280,
    sha256: "99185d75d314a07dbba4a130c8ad986cbeb629a07927975636b341ca61f991df",
    exeSha256: "8f30682ee198855440d2a7fe070d5d3653793b2d01bb8c85eea88f93bbe7c8b9",
  },
  "darwin-arm64": { name: "sing-box-1.14.4-darwin-arm64.tar.gz", size: 29186204, sha256: "0d8c7f5ed5d587b0f1a5e9772a708ec3bfa4ac4c9329604b01d8d9c2ba406838" },
  "darwin-x64": { name: "sing-box-1.14.4-darwin-amd64.tar.gz", size: 31503132, sha256: "eae86b9b033bba50b7c44ab719e4bfac0aca05efd28483390ed3aa510f32db25" },
  "linux-x64": { name: "sing-box-1.14.4-linux-amd64.tar.gz", size: 31710753, sha256: "699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968" },
  "linux-arm64": { name: "sing-box-1.14.4-linux-arm64.tar.gz", size: 29140599, sha256: "436441f76ee2f7fe21b5b2d426d3cb261a480455a704865789ad533e4273ec26" },
};

const RELEASE_URL = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/`;
const MANIFEST = "vela-kernel.json";

export interface InstalledKernel {
  path: string;
  sha256: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function archiveFor(platform: string, arch: string): SingBoxArchive {
  const archive = SINGBOX_ARCHIVES[`${platform}-${arch}`];
  if (!archive) throw new Error(`the proxy kernel is not available for ${platform}-${arch}`);
  return archive;
}

/** The installed kernel, or null when it is missing or does not match what was verified. */
export function installedKernel(root: string, platform: string = process.platform, arch: string = process.arch): InstalledKernel | null {
  const archive = archiveFor(platform, arch);
  const dir = join(root, `sing-box-${SINGBOX_VERSION}`);
  try {
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as { version: string; exe: string; sha256: string; archive: string };
    if (manifest.version !== SINGBOX_VERSION || manifest.archive !== archive.sha256) return null;
    if (archive.exeSha256 && manifest.sha256 !== archive.exeSha256) return null;
    const path = join(dir, manifest.exe);
    if (!existsSync(path) || sha256File(path) !== manifest.sha256) return null;
    return { path, sha256: manifest.sha256 };
  } catch {
    return null;
  }
}

/**
 * Install the pinned kernel under `root` if it is not there. The archive is checked against its
 * pinned hash before anything is unpacked; a mismatch deletes it and fails.
 */
export async function ensureKernel(
  root: string,
  deps: { fetch?: (url: string, init: RequestInit) => Promise<Response>; platform?: string; arch?: string; log?: (msg: string) => void } = {},
): Promise<InstalledKernel> {
  const platform: string = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const ready = installedKernel(root, platform, arch);
  if (ready) return ready;
  const archive = archiveFor(platform, arch);
  mkdirSync(root, { recursive: true });
  const partial = join(root, `.${archive.name}.partial`);
  await downloadResumable(RELEASE_URL + archive.name, partial, archive.size, { ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const actual = sha256File(partial);
  if (actual !== archive.sha256) {
    rmSync(partial, { force: true });
    throw new Error("the downloaded proxy kernel does not match its pinned hash");
  }
  const staging = join(root, `.sing-box-${SINGBOX_VERSION}-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true });
  try {
    if (archive.name.endsWith(".zip")) await extractZipTo(new Uint8Array(readFileSync(partial)), staging);
    else {
      const tar = Bun.spawn(["tar", "-xzf", partial, "-C", staging], { stdout: "ignore", stderr: "pipe" });
      if (await tar.exited !== 0) throw new Error("the proxy kernel archive could not be unpacked");
    }
    const exeName = platform === "win32" ? "sing-box.exe" : "sing-box";
    const folder = readdirSync(staging).find((entry) => existsSync(join(staging, entry, exeName)));
    if (!folder) throw new Error("the proxy kernel archive holds no sing-box executable");
    const exe = join(folder, exeName);
    const sha256 = sha256File(join(staging, exe));
    if (archive.exeSha256 && sha256 !== archive.exeSha256) throw new Error("the proxy kernel executable does not match its pinned hash");
    writeFileSync(join(staging, MANIFEST), JSON.stringify({ version: SINGBOX_VERSION, archive: archive.sha256, exe, sha256 }));
    const dir = join(root, `sing-box-${SINGBOX_VERSION}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    rmSync(partial, { force: true });
    deps.log?.(`proxy kernel ${SINGBOX_VERSION} installed`);
    return { path: join(dir, exe), sha256 };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** A free loopback port, as the OS hands it out. */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, exited: Promise<number>, deadline: number, signal?: AbortSignal): Promise<void> {
  let gone = false;
  void exited.then(() => { gone = true; });
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("the proxy kernel start was aborted"));
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    const attempt = () => {
      if (settled) return;
      if (signal?.aborted) { onAbort(); return; }
      if (gone) { finish(new Error("the proxy kernel exited while starting")); return; }
      if (Date.now() > deadline) { finish(new Error("the proxy kernel did not start in time")); return; }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); finish(); });
      socket.once("error", () => {
        socket.destroy();
        if (!settled) timer = setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

export interface KernelProcess {
  pid: number;
  /** SOCKS5 on 127.0.0.1 with this kernel's own credentials. */
  spec: ProxySpec;
  exited: Promise<number>;
  stop(): void;
}

/** Failure to locate, verify, or spawn the kernel executable itself (not a node configuration error). */
export class KernelBinaryError extends Error {}

export interface KernelDeps {
  /** The verified kernel to run; checked again before each start. */
  binary: () => Promise<InstalledKernel>;
  /** Folder for the short-lived config files. */
  workDir: string;
  /** Encrypted DoH servers used when any inbound requires domain resolution or ECH. */
  resolveDns?: () => Promise<readonly KernelDnsServer[]> | readonly KernelDnsServer[];
  /** Called if a kernel needing DNS fails to start or hits DoH errors, so cached DoH probes can refresh. */
  onDnsFailure?: (primaryServer?: string) => void;
  log?: (msg: string) => void;
  spawn?: (cmd: string[]) => { pid: number; exited: Promise<number>; kill(): void; stderr?: ReadableStream<Uint8Array> };
  startTimeoutMs?: number;
  /** Null means the process is gone; throw if the lookup is inconclusive. */
  processCommandLine?: (pid: number) => Promise<string | null>;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number) => void | Promise<void>;
}

interface KernelRecord {
  pid: number;
  executable: string;
  marker: string;
  startedAt: number;
  ownerPid: number;
}

const KERNEL_RECORDS = "processes";

function kernelRecord(value: unknown, name: string): KernelRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<KernelRecord>;
  if (!Number.isSafeInteger(record.pid) || record.pid! <= 0
    || !Number.isSafeInteger(record.ownerPid) || record.ownerPid! <= 0
    || typeof record.executable !== "string" || !isAbsolute(record.executable) || /[\0\r\n]/.test(record.executable)
    || typeof record.marker !== "string" || !/^[0-9a-f]{32}$/.test(record.marker) || name !== `${record.marker}.json`
    || typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt) || record.startedAt <= 0) return null;
  return record as KernelRecord;
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

/** A missing process returns null; a failed or inaccessible scan is not proof of death. */
async function readProcessCommandLine(pid: number, isAlive: (pid: number) => boolean): Promise<string | null> {
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`;
  const cmd = process.platform === "win32"
    ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]
    : ["ps", "-o", "command=", "-p", String(pid)];
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10_000);
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    .finally(() => clearTimeout(timer));
  const commandLine = output.trim();
  if (code === 0 && commandLine) return commandLine;
  if (!isAlive(pid)) return null;
  throw new Error("could not read the proxy kernel process command line");
}

/** Match the executable at the start of the command, not merely in another program's arguments. */
function matchesKernelCommand(commandLine: string, record: KernelRecord): boolean {
  const line = commandLine.trimStart();
  const quoted = `"${record.executable}"`;
  const prefix = line.startsWith(quoted) ? quoted : record.executable;
  return line.startsWith(prefix) && (!line[prefix.length] || /\s/.test(line[prefix.length]!)) && line.includes(record.marker);
}

function spawnKernelProcess(cmd: string[], cwd: string): { pid: number; exited: Promise<number>; kill(): void; stderr?: ReadableStream<Uint8Array> } {
  // node:child_process uses windowsHide to avoid flashing console windows on desktop launches.
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "ignore", "pipe"], cwd, windowsHide: true });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  const stderr = child.stderr ? new ReadableStream<Uint8Array>({
    start(controller) {
      child.stderr!.on("data", (chunk: Buffer) => {
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
      });
      child.stderr!.once("end", () => { try { controller.close(); } catch {} });
      child.stderr!.once("error", () => { try { controller.close(); } catch {} });
    },
    cancel() {
      child.stderr?.destroy();
    },
  }) : undefined;
  return {
    pid: child.pid ?? 0,
    exited,
    kill: () => {
      try { child.kill(); } catch {}
      try { child.stderr?.destroy(); } catch {}
    },
    stderr,
  };
}

/**
 * Start a kernel with one inbound per entry. The config holds node credentials, so it is deleted
 * as soon as the kernel has read it.
 */
export async function startKernel(
  entries: Array<{ tag: string; outbound: Outbound }>,
  deps: KernelDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<{ process: KernelProcess; specs: Map<string, ProxySpec> }> {
  const signal = opts.signal;
  if (signal?.aborted) throw new Error("the proxy kernel start was aborted");
  let binary: InstalledKernel;
  try {
    binary = await deps.binary();
  } catch (error) {
    throw error instanceof KernelBinaryError ? error : new KernelBinaryError(error instanceof Error ? error.message : String(error));
  }
  if (signal?.aborted) throw new Error("the proxy kernel start was aborted");
  const executable = resolve(binary.path);
  if (sha256File(executable) !== binary.sha256) throw new KernelBinaryError("the proxy kernel executable changed since it was verified");
  const pickedPorts = new Set<number>();
  const inbounds = [];
  for (const entry of entries) {
    if (signal?.aborted) throw new Error("the proxy kernel start was aborted");
    let port = await freeLoopbackPort();
    for (let attempt = 0; attempt < 8 && pickedPorts.has(port); attempt++) {
      port = await freeLoopbackPort();
    }
    pickedPorts.add(port);
    inbounds.push({
      tag: entry.tag,
      port,
      username: randomBytes(12).toString("hex"),
      password: randomBytes(24).toString("hex"),
      outbound: entry.outbound,
    });
  }
  const needDns = needsKernelResolver(inbounds);
  const resolvers = needDns && deps.resolveDns ? await deps.resolveDns() : undefined;
  if (signal?.aborted) throw new Error("the proxy kernel start was aborted");
  const primaryDnsServer = resolvers?.[0]?.server;
  const config = kernelConfig(inbounds, resolvers?.length ? { resolvers } : {});
  assertKernelConfig(config);
  const workDir = resolve(deps.workDir);
  const recordsDir = join(workDir, KERNEL_RECORDS);
  mkdirSync(recordsDir, { recursive: true });
  const marker = randomBytes(16).toString("hex");
  const file = join(workDir, `kernel-${marker}.json`);
  const recordPath = join(recordsDir, `${marker}.json`);
  const cmd = [executable, "run", "-c", file, "-D", workDir, "--disable-color"];
  try {
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const startedAt = Date.now();
    let child: { pid: number; exited: Promise<number>; kill(): void; stderr?: ReadableStream<Uint8Array> };
    try {
      child = deps.spawn ? deps.spawn(cmd) : spawnKernelProcess(cmd, dirname(executable));
    } catch (error) {
      throw error instanceof KernelBinaryError ? error : new KernelBinaryError(error instanceof Error ? error.message : String(error));
    }
    try {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new KernelBinaryError("the proxy kernel has no valid process id");
      const record: KernelRecord = { pid: child.pid, executable, marker, startedAt, ownerPid: process.pid };
      writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    } catch (error) {
      try { child.kill(); } catch {}
      throw error;
    }
    // Keep the record until exit is confirmed, even when stop() or startup's kill fails.
    void child.exited.then(() => {
      try { rmSync(recordPath, { force: true }); }
      catch (error) { deps.log?.(`could not remove proxy kernel record: ${(error as Error).message}`); }
    }, () => {});
    const stderr = "stderr" in child && child.stderr instanceof ReadableStream ? child.stderr : undefined;
    let tail = "";
    let dnsFailureReported = false;
    const reportDnsFailure = () => {
      if (needDns && !dnsFailureReported) {
        dnsFailureReported = true;
        deps.onDnsFailure?.(primaryDnsServer);
      }
    };
    if (stderr) {
      void (async () => {
        const decoder = new TextDecoder();
        const reader = stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          tail = (tail + chunk).slice(-2000);
          if (needDns && !dnsFailureReported && (
            (primaryDnsServer && chunk.includes(primaryDnsServer))
            || /\bdns\b.*(?:fail|error|timeout|refused)|(?:lookup|resolve)\b.*(?:timeout|failed|refused|no such host)/i.test(chunk)
          )) {
            reportDnsFailure();
          }
        }
      })().catch(() => {});
    }
    try {
      const deadline = Date.now() + (deps.startTimeoutMs ?? 8_000);
      await Promise.all(inbounds.map((inbound) => waitForPort(inbound.port, child.exited, deadline, signal)));
    } catch (error) {
      try { child.kill(); } catch {}
      if (!signal?.aborted) reportDnsFailure();
      deps.log?.(`proxy kernel failed to start: ${(error as Error).message}${tail ? ` (${tail.trim().split("\n").at(-1)})` : ""}`);
      throw error;
    }
    const specs = new Map(inbounds.map((inbound) => [inbound.tag, {
      type: "socks5" as const, host: "127.0.0.1", port: String(inbound.port), user: inbound.username, pass: inbound.password,
    }]));
    return {
      process: {
        pid: child.pid,
        spec: specs.get(inbounds[0]!.tag)!,
        exited: child.exited,
        stop: () => { try { child.kill(); } catch {} },
      },
      specs,
    };
  } finally {
    rmSync(file, { force: true });
  }
}

interface Lease {
  outbound: Outbound;
  process?: KernelProcess;
  released: boolean;
  restarts: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  starting?: Promise<ProxySpec>;
}

/**
 * One kernel per key (a profile). acquire() starts it or returns the running one; release() stops
 * it for good. A kernel that exits on its own while its lease is held is restarted (on a new port,
 * with new credentials) and `onRestart` hands the new address to the profile's relay. Five deaths
 * within a minute stop the retries: the profile stays without network until it is reopened.
 */
export class KernelSupervisor {
  private leases = new Map<string, Lease>();
  private temporary = new Set<KernelProcess>();
  onRestart?: (key: string, spec: ProxySpec) => void;
  onGiveUp?: (key: string) => void;

  constructor(private readonly deps: KernelDeps) {}

  /** Reap only recorded kernels whose executable and random command-line marker still match. */
  async reconcileOrphans(): Promise<void> {
    const dir = join(this.deps.workDir, KERNEL_RECORDS);
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    const isAlive = this.deps.isPidAlive ?? pidIsAlive;
    const commandLine = this.deps.processCommandLine ?? ((pid: number) => readProcessCommandLine(pid, isAlive));
    const kill = this.deps.killPid ?? ((pid: number) => { process.kill(pid, "SIGKILL"); });
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const contents = readFileSync(path, "utf8");
        let record: KernelRecord | null = null;
        try { record = kernelRecord(JSON.parse(contents), name); } catch {}
        if (!record) { rmSync(path, { force: true }); continue; }
        const line = await commandLine(record.pid);
        if (!line || !matchesKernelCommand(line, record)) { rmSync(path, { force: true }); continue; }
        // A second manager can share this directory; its kernels are not orphans.
        if (isAlive(record.ownerPid)) continue;
        await kill(record.pid);
        rmSync(path, { force: true });
      } catch (error) {
        this.deps.log?.(`could not reconcile proxy kernel record ${name}: ${(error as Error).message}`);
      }
    }
  }

  async acquire(key: string, outbound: Outbound): Promise<ProxySpec> {
    const existing = this.leases.get(key);
    if (existing && !existing.released && JSON.stringify(existing.outbound) === JSON.stringify(outbound)) {
      if (existing.starting) return existing.starting;
      if (existing.process) return existing.process.spec;
    }
    if (existing) this.release(key);
    const lease: Lease = { outbound, released: false, restarts: [] };
    this.leases.set(key, lease);
    lease.starting = this.start(key, lease);
    try {
      return await lease.starting;
    } catch (error) {
      if (this.leases.get(key) === lease) this.leases.delete(key);
      throw error;
    } finally {
      lease.starting = undefined;
    }
  }

  /** The process id of a running kernel, for diagnostics and tests. */
  pid(key: string): number | undefined {
    const lease = this.leases.get(key);
    return lease && !lease.released ? lease.process?.pid : undefined;
  }

  /** The address of a running kernel, if any. */
  current(key: string): ProxySpec | undefined {
    const lease = this.leases.get(key);
    return lease && !lease.released ? lease.process?.spec : undefined;
  }

  release(key: string): void {
    const lease = this.leases.get(key);
    if (!lease) return;
    lease.released = true;
    if (lease.restartTimer) {
      clearTimeout(lease.restartTimer);
      lease.restartTimer = undefined;
    }
    lease.controller?.abort();
    this.leases.delete(key);
    lease.process?.stop();
  }

  /** A kernel outside any lease, for checks: one inbound per entry. The caller stops it. */
  async startTemporary(
    entries: Array<{ tag: string; outbound: Outbound }>,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ process: KernelProcess; specs: Map<string, ProxySpec> }> {
    const started = await startKernel(entries, this.deps, opts);
    this.temporary.add(started.process);
    void started.process.exited.finally(() => { this.temporary.delete(started.process); });
    const origStop = started.process.stop.bind(started.process);
    started.process.stop = () => {
      this.temporary.delete(started.process);
      origStop();
    };
    return started;
  }

  releaseAll(): void {
    for (const key of [...this.leases.keys()]) this.release(key);
    for (const proc of [...this.temporary]) proc.stop();
  }

  private async start(key: string, lease: Lease): Promise<ProxySpec> {
    const controller = new AbortController();
    lease.controller = controller;
    try {
      const { process } = await startKernel([{ tag: "node", outbound: lease.outbound }], this.deps, { signal: controller.signal });
      if (lease.released || controller.signal.aborted) {
        process.stop();
        throw new Error("the proxy kernel was released while starting");
      }
      lease.process = process;
      void process.exited.then(() => this.exited(key, lease, process));
      return process.spec;
    } finally {
      if (lease.controller === controller) lease.controller = undefined;
    }
  }

  private exited(key: string, lease: Lease, process: KernelProcess): void {
    if (lease.released || lease.process !== process || this.leases.get(key) !== lease) return;
    lease.process = undefined;
    this.scheduleRestart(key, lease);
  }

  private scheduleRestart(key: string, lease: Lease): void {
    const now = Date.now();
    lease.restarts = [...lease.restarts.filter((at) => now - at < 60_000), now];
    if (lease.restarts.length > 5) {
      this.deps.log?.(`proxy kernel for ${key} keeps exiting; the profile stays offline`);
      this.leases.delete(key);
      this.onGiveUp?.(key);
      return;
    }
    this.deps.log?.(`proxy kernel for ${key} exited; restarting`);
    const delay = 250 * 2 ** (lease.restarts.length - 1);
    lease.restartTimer = setTimeout(() => {
      lease.restartTimer = undefined;
      if (lease.released || this.leases.get(key) !== lease) return;
      this.start(key, lease).then((spec) => this.onRestart?.(key, spec), (error) => {
        this.deps.log?.(`proxy kernel for ${key} could not restart: ${(error as Error).message}`);
        if (!lease.released && this.leases.get(key) === lease) this.scheduleRestart(key, lease);
      });
    }, delay);
  }
}

/** Remove config files a crashed run left behind. They hold node credentials. */
export function clearKernelWorkDir(workDir: string): void {
  try {
    for (const entry of readdirSync(workDir)) {
      if (/^kernel-[0-9a-f]+\.json$/.test(entry)) rmSync(join(workDir, entry), { force: true });
    }
  } catch { /* no folder yet */ }
}

/** True when a file exists and is not empty: used by tests and diagnostics. */
export function nonEmpty(path: string): boolean {
  try { return statSync(path).size > 0; } catch { return false; }
}

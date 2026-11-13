/**
 * The sing-box kernel for proxy-pool nodes (design §3): a pinned release, verified by hash before
 * it is unpacked and again before every start; one process per profile, so a crash or a switch
 * touches one profile only; and a watchdog that restarts a kernel that died while its profile
 * still needs it.
 *
 * A dead kernel is a dead network, never a direct one: the profile's relay points at the kernel's
 * loopback port, and nothing listens there until the kernel is back.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { assertKernelConfig, kernelConfig } from "./kernel-config.ts";
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

function waitForPort(port: number, exited: Promise<number>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  void exited.then(() => { gone = true; });
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (gone) { reject(new Error("the proxy kernel exited while starting")); return; }
      if (Date.now() > deadline) { reject(new Error("the proxy kernel did not start in time")); return; }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => { socket.destroy(); setTimeout(attempt, 50); });
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

export interface KernelDeps {
  /** The verified kernel to run; checked again before each start. */
  binary: () => Promise<InstalledKernel>;
  /** Folder for the short-lived config files. */
  workDir: string;
  log?: (msg: string) => void;
  spawn?: (cmd: string[]) => { pid: number; exited: Promise<number>; kill(): void; stderr?: ReadableStream<Uint8Array> };
  startTimeoutMs?: number;
}

/**
 * Start a kernel with one inbound per entry. The config holds node credentials, so it is deleted
 * as soon as the kernel has read it.
 */
export async function startKernel(entries: Array<{ tag: string; outbound: Outbound }>, deps: KernelDeps): Promise<{ process: KernelProcess; specs: Map<string, ProxySpec> }> {
  const binary = await deps.binary();
  if (sha256File(binary.path) !== binary.sha256) throw new Error("the proxy kernel executable changed since it was verified");
  const inbounds = [];
  for (const entry of entries) {
    inbounds.push({
      tag: entry.tag,
      port: await freeLoopbackPort(),
      username: randomBytes(12).toString("hex"),
      password: randomBytes(24).toString("hex"),
      outbound: entry.outbound,
    });
  }
  const config = kernelConfig(inbounds);
  assertKernelConfig(config);
  mkdirSync(deps.workDir, { recursive: true });
  const file = join(deps.workDir, `kernel-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const cmd = [binary.path, "run", "-c", file, "-D", deps.workDir, "--disable-color"];
  const child = deps.spawn ? deps.spawn(cmd) : Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", cwd: dirname(binary.path) });
  const stderr = "stderr" in child && child.stderr instanceof ReadableStream ? child.stderr : undefined;
  let tail = "";
  if (stderr) {
    void (async () => {
      const decoder = new TextDecoder();
      const reader = stderr.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        tail = (tail + decoder.decode(value)).slice(-2000);
      }
    })().catch(() => {});
  }
  try {
    await waitForPort(inbounds[0]!.port, child.exited, deps.startTimeoutMs ?? 8_000);
    for (const inbound of inbounds.slice(1)) await waitForPort(inbound.port, child.exited, deps.startTimeoutMs ?? 8_000);
  } catch (error) {
    try { child.kill(); } catch {}
    deps.log?.(`proxy kernel failed to start: ${(error as Error).message}${tail ? ` (${tail.trim().split("\n").at(-1)})` : ""}`);
    throw error;
  } finally {
    rmSync(file, { force: true });
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
}

interface Lease {
  outbound: Outbound;
  process?: KernelProcess;
  released: boolean;
  restarts: number[];
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
  onRestart?: (key: string, spec: ProxySpec) => void;
  onGiveUp?: (key: string) => void;

  constructor(private readonly deps: KernelDeps) {}

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
    this.leases.delete(key);
    lease.process?.stop();
  }

  /** A kernel outside any lease, for checks: one inbound per entry. The caller stops it. */
  startTemporary(entries: Array<{ tag: string; outbound: Outbound }>): Promise<{ process: KernelProcess; specs: Map<string, ProxySpec> }> {
    return startKernel(entries, this.deps);
  }

  releaseAll(): void {
    for (const key of [...this.leases.keys()]) this.release(key);
  }

  private async start(key: string, lease: Lease): Promise<ProxySpec> {
    const { process } = await startKernel([{ tag: "node", outbound: lease.outbound }], this.deps);
    if (lease.released) { process.stop(); throw new Error("the proxy kernel was released while starting"); }
    lease.process = process;
    void process.exited.then(() => this.exited(key, lease, process));
    return process.spec;
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
    setTimeout(() => {
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

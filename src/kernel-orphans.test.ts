import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { clearKernelWorkDir, KernelSupervisor, startKernel } from "./kernel.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".kernel-orphans-"));
  roots.push(root);
  const workDir = join(root, "work");
  const records = join(workDir, "processes");
  const executable = join(root, "kernel path", "sing-box");
  mkdirSync(records, { recursive: true });
  mkdirSync(join(root, "kernel path"));
  writeFileSync(executable, "fake executable");
  const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const commandLines = new Map<number, string>();
  const liveOwners = new Set<number>();
  const killed: number[] = [];
  const deps = {
    binary: async () => ({ path: executable, sha256 }),
    workDir,
    processCommandLine: async (pid: number) => commandLines.get(pid) ?? null,
    isPidAlive: (pid: number) => liveOwners.has(pid),
    killPid: (pid: number) => { killed.push(pid); commandLines.delete(pid); },
  };
  function record(pid: number, marker: string, overrides: Record<string, unknown> = {}) {
    const value = { pid, executable, marker, startedAt: Date.now(), ownerPid: 410001, ...overrides };
    const path = join(records, `${marker}.json`);
    writeFileSync(path, JSON.stringify(value));
    return { path, value };
  }
  const commandLine = (marker: string) => `"${executable}" run -c "${join(workDir, `kernel-${marker}.json`)}" -D "${workDir}" --disable-color`;
  return { root, workDir, records, executable, commandLines, liveOwners, killed, deps, record, commandLine };
}

const marker1 = "11111111111111111111111111111111";
const marker2 = "22222222222222222222222222222222";
const marker3 = "33333333333333333333333333333333";
const outbound = { type: "shadowsocks", server: "127.0.0.1", server_port: 8388, method: "aes-128-gcm", password: "test" };

test("reconciliation ends a matching orphan and removes its record", async () => {
  const f = fixture();
  const { path } = f.record(47001, marker1);
  f.commandLines.set(47001, f.commandLine(marker1));
  // Credential cleanup in the launcher constructor must not remove ownership records.
  writeFileSync(join(f.workDir, `kernel-${marker1}.json`), "secret");
  clearKernelWorkDir(f.workDir);
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(f.workDir, `kernel-${marker1}.json`))).toBe(false);

  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([47001]);
  expect(existsSync(path)).toBe(false);
});

test("a reused pid with a different executable or marker is never ended", async () => {
  const f = fixture();
  const wrongPath = f.record(47001, marker1);
  const noMarker = f.record(47002, marker2);
  const pathOnlyInArgument = f.record(47003, marker3);
  f.commandLines.set(47001, `"${f.executable}-other" run -c kernel-${marker1}.json`);
  f.commandLines.set(47002, `"${f.executable}" run -c another-config.json`);
  f.commandLines.set(47003, `"${f.executable}-other" --original "${f.executable}" -c kernel-${marker3}.json`);

  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([]);
  expect([wrongPath, noMarker, pathOnlyInArgument].map(({ path }) => existsSync(path))).toEqual([false, false, false]);
});

test("a dead pid and corrupt or invalid records are removed without killing anything", async () => {
  const f = fixture();
  const dead = f.record(47001, marker1);
  const corrupt = join(f.records, `${marker2}.json`);
  writeFileSync(corrupt, "{broken");
  const invalid = f.record(47003, marker3, { marker: "" });
  f.commandLines.set(47003, f.commandLine(marker3));

  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([]);
  expect([dead.path, corrupt, invalid.path].map(existsSync)).toEqual([false, false, false]);
});

test("a kernel owned by a live manager is retained", async () => {
  const f = fixture();
  const { path } = f.record(47001, marker1);
  f.commandLines.set(47001, f.commandLine(marker1));
  f.liveOwners.add(410001);

  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([]);
  expect(existsSync(path)).toBe(true);
  f.liveOwners.clear();
  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([47001]);
  expect(existsSync(path)).toBe(false);
});

test("real owner liveness protects another manager's kernel until that manager exits", async () => {
  const f = fixture();
  const owner = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const { path } = f.record(47001, marker1, { ownerPid: owner.pid });
    f.commandLines.set(47001, f.commandLine(marker1));
    const supervisor = new KernelSupervisor({
      binary: f.deps.binary,
      workDir: f.workDir,
      processCommandLine: f.deps.processCommandLine,
      killPid: f.deps.killPid,
    });
    await supervisor.reconcileOrphans();
    expect(f.killed).toEqual([]);
    expect(existsSync(path)).toBe(true);
    owner.kill();
    await owner.exited;
    await supervisor.reconcileOrphans();
    expect(f.killed).toEqual([47001]);
    expect(existsSync(path)).toBe(false);
  } finally {
    try { owner.kill(); } catch {}
    await owner.exited;
  }
});

test("an inconclusive lookup or failed kill leaves its record for a later retry", async () => {
  const f = fixture();
  const { path } = f.record(47001, marker1);
  const lookupFails = new KernelSupervisor({ ...f.deps, processCommandLine: async () => { throw new Error("lookup failed"); } });
  await lookupFails.reconcileOrphans();
  expect(f.killed).toEqual([]);
  expect(existsSync(path)).toBe(true);

  f.commandLines.set(47001, f.commandLine(marker1));
  const killFails = new KernelSupervisor({ ...f.deps, killPid: () => { throw new Error("kill failed"); } });
  await killFails.reconcileOrphans();
  expect(existsSync(path)).toBe(true);
  await new KernelSupervisor(f.deps).reconcileOrphans();
  expect(f.killed).toEqual([47001]);
  expect(existsSync(path)).toBe(false);
});

test("a started kernel records its actual command line and removes the record on exit", async () => {
  const f = fixture();
  let exit!: (code: number) => void;
  let server!: net.Server;
  let cmd: string[] = [];
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const spawn = (args: string[]) => {
    cmd = args;
    const config = JSON.parse(readFileSync(args[args.indexOf("-c") + 1]!, "utf8"));
    server = net.createServer((socket) => socket.destroy());
    server.listen(config.inbounds[0].listen_port, "127.0.0.1");
    return { pid: 47001, exited, kill() { server.close(); exit(0); } };
  };
  const { process: child } = await startKernel([{ tag: "node", outbound }], { ...f.deps, spawn });
  try {
    const names = readdirSync(f.records);
    expect(names).toHaveLength(1);
    const raw = readFileSync(join(f.records, names[0]!), "utf8");
    expect(raw).not.toContain(outbound.password);
    const record = JSON.parse(raw);
    expect(record).toMatchObject({ pid: 47001, executable: f.executable, ownerPid: process.pid });
    expect(record.startedAt).toBeGreaterThan(0);
    expect(record.marker).toMatch(/^[0-9a-f]{32}$/);
    expect(cmd[0]).toBe(record.executable);
    expect(cmd[cmd.indexOf("-c") + 1]).toContain(record.marker);
    expect(existsSync(cmd[cmd.indexOf("-c") + 1]!)).toBe(false);

    server.close();
    exit(0);
    await child.exited;
    expect(readdirSync(f.records)).toEqual([]);
  } finally {
    child.stop();
  }
});

test("stopping a kernel removes its record once it has exited", async () => {
  const f = fixture();
  let server!: net.Server;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const spawn = (cmd: string[]) => {
    const config = JSON.parse(readFileSync(cmd[cmd.indexOf("-c") + 1]!, "utf8"));
    server = net.createServer((socket) => socket.destroy());
    server.listen(config.inbounds[0].listen_port, "127.0.0.1");
    return { pid: 47001, exited, kill() { server.close(); exit(0); } };
  };
  const { process: child } = await startKernel([{ tag: "node", outbound }], { ...f.deps, spawn });
  try {
    expect(readdirSync(f.records)).toHaveLength(1);
    child.stop();
    await child.exited;
    expect(readdirSync(f.records)).toEqual([]);
  } finally {
    child.stop();
  }
});

test("a kernel is recorded before readiness and cleaned up if startup fails", async () => {
  const f = fixture();
  let exit!: (code: number) => void;
  let spawned!: () => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const wasSpawned = new Promise<void>((resolve) => { spawned = resolve; });
  const starting = startKernel([{ tag: "node", outbound }], {
    ...f.deps,
    startTimeoutMs: 100,
    spawn: () => { spawned(); return { pid: 47001, exited, kill() { exit(1); } }; },
  });
  await wasSpawned;
  expect(readdirSync(f.records)).toHaveLength(1);
  await expect(starting).rejects.toThrow();
  await exited;
  expect(readdirSync(f.records)).toEqual([]);
  expect(readdirSync(f.workDir).filter((name) => name.startsWith("kernel-"))).toEqual([]);
});

test("a kernel is stopped if its ownership record cannot be written", async () => {
  const f = fixture();
  let killed = false;
  const spawn = () => {
    rmSync(f.records, { recursive: true, force: true });
    writeFileSync(f.records, "not a directory");
    return { pid: 47001, exited: Promise.resolve(0), kill() { killed = true; } };
  };
  await expect(startKernel([{ tag: "node", outbound }], { ...f.deps, spawn })).rejects.toThrow();
  expect(killed).toBe(true);
  expect(readdirSync(f.workDir).filter((name) => name.startsWith("kernel-"))).toEqual([]);
});

test("the real process lookup and kill can reap a child started by this test", async () => {
  const f = fixture();
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", marker1], { stdout: "ignore", stderr: "ignore" });
  try {
    const { path } = f.record(child.pid, marker1, { executable: process.execPath });
    const supervisor = new KernelSupervisor({
      binary: f.deps.binary,
      workDir: f.workDir,
      isPidAlive: () => false,
    });
    await supervisor.reconcileOrphans();
    expect(await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)])).toBe(true);
    expect(existsSync(path)).toBe(false);
  } finally {
    try { child.kill(); } catch {}
    await child.exited;
  }
}, 15_000);

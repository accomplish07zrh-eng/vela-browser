/**
 * The kernel with real sing-box (VELA_SINGBOX_ZIP=<the pinned Windows release archive>). A second
 * sing-box plays the node: a Shadowsocks server on loopback whose only exit is a local echo server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSocks5Tunnel } from "./geoip.ts";
import { ensureKernel, freeLoopbackPort, installedKernel, KernelSupervisor, SINGBOX_ARCHIVES, startKernel, type InstalledKernel } from "./kernel.ts";

const zip = process.env.VELA_SINGBOX_ZIP?.trim();
const live = zip && process.platform === "win32" && process.arch === "x64" ? test : test.skip;

let root = "";
let kernel: InstalledKernel;
let echo: net.Server;
let echoPort = 0;
let server: ReturnType<typeof Bun.spawn> | undefined;
let serverPort = 0;
const SS = { method: "aes-128-gcm", password: "test-only-password" };

const servedZip = (bytes: Uint8Array) => (async () => new Response(bytes as unknown as BodyInit, { headers: { "content-length": String(bytes.length) } })) as unknown as (url: string, init: RequestInit) => Promise<Response>;

beforeAll(async () => {
  if (!zip) return;
  root = mkdtempSync(join(tmpdir(), "vela-kernel-"));
  kernel = await ensureKernel(join(root, "runtimes"), { fetch: servedZip(new Uint8Array(readFileSync(zip))) });
  echo = net.createServer((socket) => { socket.on("data", (data: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), data]))); socket.on("error", () => {}); });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
  echoPort = (echo.address() as net.AddressInfo).port;
  serverPort = await freeLoopbackPort();
  const config = join(root, "server.json");
  writeFileSync(config, JSON.stringify({
    log: { level: "error" },
    inbounds: [{ type: "shadowsocks", listen: "127.0.0.1", listen_port: serverPort, method: SS.method, password: SS.password }],
    outbounds: [{ type: "direct" }],
  }));
  server = Bun.spawn([kernel.path, "run", "-c", config], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((resolve) => { const s = net.connect(serverPort, "127.0.0.1"); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => resolve(false)); });
    if (up) break;
    await Bun.sleep(50);
  }
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  echo?.close();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const node = () => ({ type: "shadowsocks", server: "127.0.0.1", server_port: serverPort, ...SS });

async function roundTrip(spec: { host: string; port: string; user: string; pass: string }, payload = "ping"): Promise<string> {
  const socket = await openSocks5Tunnel({ type: "socks5", ...spec }, "127.0.0.1", echoPort, 5000);
  return new Promise((resolve, reject) => {
    socket.once("data", (data) => { socket.destroy(); resolve(data.toString()); });
    socket.once("error", reject);
    // The SOCKS handshake leaves the socket paused.
    socket.resume();
    socket.write(payload);
  });
}

live("the pinned archive installs once, and a changed executable is no longer trusted", async () => {
  expect(kernel.sha256).toBe(SINGBOX_ARCHIVES["win32-x64"]!.exeSha256!);
  expect(installedKernel(join(root, "runtimes"))).toEqual(kernel);
  // A second call finds it installed and downloads nothing.
  const again = await ensureKernel(join(root, "runtimes"), { fetch: async () => { throw new Error("must not download"); } });
  expect(again).toEqual(kernel);
  // A tampered archive is refused before anything is unpacked.
  const bad = new Uint8Array(readFileSync(zip!)); bad[bad.length - 10]! ^= 0xff;
  const other = join(root, "other");
  await expect(ensureKernel(other, { fetch: servedZip(bad) })).rejects.toThrow("pinned hash");
  expect(readdirSync(other).filter((name) => !name.startsWith("."))).toEqual([]);
});

live("a kernel carries traffic only for its own credentials and deletes its config once started", async () => {
  const work = join(root, "work");
  const { process: proc, spec } = await startKernel([{ tag: "node", outbound: node() }], { binary: async () => kernel, workDir: work })
    .then(({ process, specs }) => ({ process, spec: specs.get("node")! }));
  try {
    expect(spec.host).toBe("127.0.0.1");
    expect(await roundTrip(spec)).toBe("echo:ping");
    await expect(roundTrip({ ...spec, pass: "wrong" })).rejects.toThrow();
    expect(readdirSync(work).filter((name) => name.endsWith(".json"))).toEqual([]);
  } finally {
    proc.stop();
  }
});

live("a kernel that dies is restarted on a new address, and a released one stays down", async () => {
  const supervisor = new KernelSupervisor({ binary: async () => kernel, workDir: join(root, "work2") });
  const restarted: string[] = [];
  supervisor.onRestart = (key, spec) => restarted.push(`${key}:${spec.port}`);
  const first = await supervisor.acquire("p1", node());
  expect(await supervisor.acquire("p1", node())).toEqual(first);
  expect(await roundTrip(first)).toBe("echo:ping");
  // Kill it from outside, as a crash would.
  process.kill(Number((supervisor as any).leases.get("p1").process.pid));
  for (let i = 0; i < 100 && !restarted.length; i++) await Bun.sleep(50);
  expect(restarted.length).toBe(1);
  const second = supervisor.current("p1")!;
  expect(second.port).not.toBe(first.port);
  expect(await roundTrip(second)).toBe("echo:ping");
  // The old address is gone: nothing answers there.
  await expect(roundTrip(first)).rejects.toThrow();
  supervisor.release("p1");
  await Bun.sleep(300);
  await expect(roundTrip(second)).rejects.toThrow();
  expect(supervisor.current("p1")).toBeUndefined();
});

live("a kernel that cannot start reports it, and leaves no config behind", async () => {
  const work = join(root, "work3");
  await expect(startKernel([{ tag: "node", outbound: { type: "shadowsocks", server: "127.0.0.1", server_port: serverPort, method: "not-a-cipher", password: "x" } }],
    { binary: async () => kernel, workDir: work, startTimeoutMs: 3000 })).rejects.toThrow();
  expect(readdirSync(work).filter((name) => name.endsWith(".json"))).toEqual([]);
});

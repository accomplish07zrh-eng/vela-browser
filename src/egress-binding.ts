import { execFile } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Going around this computer's own proxy client (Clash, mihomo, sing-box… in TUN mode). With it on,
 * the connections Vela Browser opens to a profile's proxy leave through the physical network
 * adapter instead of the TUN adapter, so traffic is not proxied twice. Only those connections:
 * websites are still reached through the profile's proxy, and the proxy's own name is looked up
 * with encrypted DNS over the same adapter, never with the TUN client's fake-ip DNS.
 *
 * When no physical adapter is found the connection takes the usual way, through the TUN client and
 * then the proxy: slower, but nothing leaves outside a proxy either way.
 */

export interface PhysicalInterface { name: string; address: string; description?: string }

/** Adapters that belong to proxy clients, VPNs and virtual machines, never the physical network. */
const VIRTUAL = /tun|tap|wintun|utun|clash|meta|mihomo|sing-?box|v2ray|xray|nekoray|wireguard|\bwg\d|tailscale|zerotier|openvpn|vpn|vethernet|hyper-v|vmware|virtualbox|vbox|docker|wsl|loopback|npcap|bluetooth|teredo|isatap|6to4|pseudo/i;
const FAKE_IP = (address: string) => /^198\.(1[89])\./.test(address);
const PRIVATE_OK = (address: string) => !address.startsWith("169.254.") && !FAKE_IP(address) && address !== "127.0.0.1";

/** The default routes, best first, as "route print" lists them: fast, and the same in every language. */
export function parseDefaultRoutes(text: string): Array<{ gateway: string; address: string; metric: number }> {
  const out: Array<{ gateway: string; address: string; metric: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 5 && parts[0] === "0.0.0.0" && parts[1] === "0.0.0.0" && isIP(parts[3]!) === 4 && /^\d+$/.test(parts[4]!)) {
      out.push({ gateway: parts[2]!, address: parts[3]!, metric: Number(parts[4]) });
    }
  }
  return out.sort((a, b) => a.metric - b.metric);
}

/** Windows: the adapters that hold a default route, named from this computer's adapter list. */
function windowsCandidates(): Promise<PhysicalInterface[]> {
  return new Promise((resolve) => {
    execFile("route", ["print", "-4", "0.0.0.0"], { encoding: "utf8", timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout) { resolve([]); return; }
      const names = new Map<string, string>();
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses ?? []) if (address.family === "IPv4") names.set(address.address, name);
      }
      resolve(parseDefaultRoutes(stdout).map((route) => ({ name: names.get(route.address) ?? route.address, address: route.address, description: `gateway ${route.gateway}` })));
    });
  });
}

export function pickPhysicalInterface(candidates: PhysicalInterface[]): PhysicalInterface | null {
  return candidates.find((item) => isIP(item.address) === 4 && PRIVATE_OK(item.address) && !VIRTUAL.test(item.name) && !VIRTUAL.test(item.description ?? "")) ?? null;
}

export async function detectPhysicalInterface(platform = process.platform): Promise<PhysicalInterface | null> {
  if (platform === "win32") {
    const picked = pickPhysicalInterface(await windowsCandidates());
    if (picked) return picked;
  }
  const list: PhysicalInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) if (address.family === "IPv4" && !address.internal) list.push({ name, address: address.address });
  }
  // Wired and Wi-Fi adapters first.
  list.sort((a, b) => Number(/ethernet|以太网|wi-?fi|wlan|^en\d|^eth\d|^wl/i.test(b.name)) - Number(/ethernet|以太网|wi-?fi|wlan|^en\d|^eth\d|^wl/i.test(a.name)));
  return pickPhysicalInterface(list);
}

/** Encrypted DNS servers reached by address, so no lookup is needed to reach them. */
const DOH_SERVERS = ["223.5.5.5", "1.12.12.12", "1.1.1.1", "8.8.8.8"] as const;
const DOH_NAMES: Record<string, string> = { "223.5.5.5": "dns.alidns.com", "1.12.12.12": "doh.pub", "1.1.1.1": "cloudflare-dns.com", "8.8.8.8": "dns.google" };

function encodeQuery(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".").map((label) => { const bytes = Buffer.from(label, "utf8"); return Buffer.concat([Buffer.from([bytes.length]), bytes]); });
  return Buffer.concat([Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

/** The IPv4 addresses in a DNS answer. */
export function parseAnswer(message: Buffer): string[] {
  if (message.length < 12) return [];
  const answers = message.readUInt16BE(6);
  let offset = 12;
  const skipName = () => {
    while (offset < message.length) {
      const length = message[offset]!;
      if (length === 0) { offset += 1; return; }
      if ((length & 0xc0) === 0xc0) { offset += 2; return; }
      offset += length + 1;
    }
  };
  for (let count = message.readUInt16BE(4); count > 0; count--) { skipName(); offset += 4; }
  const out: string[] = [];
  for (let index = 0; index < answers && offset < message.length; index++) {
    skipName();
    if (offset + 10 > message.length) break;
    const type = message.readUInt16BE(offset), length = message.readUInt16BE(offset + 8);
    offset += 10;
    if (type === 1 && length === 4 && offset + 4 <= message.length) out.push([...message.subarray(offset, offset + 4)].join("."));
    offset += length;
  }
  return out;
}

function dohQuery(server: string, name: string, localAddress: string, timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const query = encodeQuery(name).toString("base64url");
    const req = httpsRequest({ host: server, servername: DOH_NAMES[server], port: 443, path: `/dns-query?dns=${query}`, localAddress, headers: { accept: "application/dns-message" }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => { chunks.push(chunk); if (chunks.reduce((sum, item) => sum + item.length, 0) > 16_384) req.destroy(new Error("answer too large")); });
      res.on("end", () => res.statusCode === 200 ? resolve(parseAnswer(Buffer.concat(chunks))) : reject(new Error(`DoH ${res.statusCode}`)));
    });
    req.on("timeout", () => req.destroy(new Error("DoH timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** Looks a proxy's name up with encrypted DNS through the physical adapter; fake-ip answers are refused. */
export async function resolveDirect(name: string, localAddress: string, query = dohQuery): Promise<string> {
  let lastError: unknown;
  for (const server of DOH_SERVERS) {
    try {
      const addresses = (await query(server, name, localAddress)).filter((address) => !FAKE_IP(address));
      if (addresses.length) return addresses[0]!;
      lastError = new Error(`no address for ${name}`);
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(`could not resolve ${name}`);
}

let enabled = false;
let cached: { at: number; value: PhysicalInterface | null } | undefined;
let refreshing: Promise<PhysicalInterface | null> | undefined;

/** Looks the adapter up again in the background; connections keep using the last answer meanwhile. */
export function refreshInterface(): Promise<PhysicalInterface | null> {
  return refreshing ??= detectPhysicalInterface()
    .then((value) => { cached = { at: Date.now(), value }; return value; }, () => cached?.value ?? null)
    .finally(() => { refreshing = undefined; });
}

export function setTunBypass(on: boolean): void { enabled = on; if (on) void refreshInterface(); else cached = undefined; }
export function tunBypassEnabled(): boolean { return enabled; }

/**
 * The adapter in use, never waiting: the last known one, refreshed in the background every 30
 * seconds (networks change). Before the first answer there is none, so the usual path is taken.
 */
export function currentInterface(now = Date.now()): PhysicalInterface | null {
  if (!enabled) return null;
  if (!cached || now - cached.at > 30_000) void refreshInterface();
  return cached?.value ?? null;
}

/**
 * Extra options for a socket to a profile's upstream proxy. Empty when the bypass is off or no
 * physical adapter is found. Spread into net.connect / tls.connect next to the upstream's host.
 */
export function upstreamDial(host: string): { localAddress?: string; lookup?: LookupFunction } {
  // The proxy kernel on loopback, or a proxy on the local network, is reached the usual way.
  if (isLocalHost(host)) return {};
  const physical = currentInterface();
  if (!physical) return {};
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolveDirect(hostname, physical.address).then(
      (address) => (options as { all?: boolean })?.all ? (callback as any)(null, [{ address, family: 4 }]) : callback(null, address, 4),
      (error) => callback(error as NodeJS.ErrnoException, "", 4),
    );
  };
  return { localAddress: physical.address, lookup };
}

export function isLocalHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")) return true;
  if (isIP(name) !== 4) return false;
  const [a, b] = name.split(".").map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** The adapter's name for the proxy kernel (sing-box binds every dial to it). */
export function kernelInterface(): string | undefined {
  return currentInterface()?.name;
}

export interface TunBypassTest {
  interface: PhysicalInterface | null;
  /** The name resolved with encrypted DNS through the physical adapter, and whether it was a fake-ip answer. */
  resolved?: { name: string; address: string };
  /** The local address a connection actually used: bound, and the computer's own choice. */
  boundLocal?: string;
  defaultLocal?: string;
  /** The address websites would see for each path, as Cloudflare reports it. */
  directExit?: string;
  defaultExit?: string;
  ok: boolean;
  problem?: string;
}

/** Services that answer with the address a connection came from; the first that answers wins. */
const ECHO = [
  { host: "4.ipw.cn", path: "/" },
  { host: "api64.ipify.org", path: "/?format=json" },
  { host: "ipinfo.io", path: "/json" },
] as const;

/** The address in an echo answer: a JSON "ip" field, or the whole plain-text body. */
export function echoAddress(body: string): string | undefined {
  const json = /"ip"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? body.trim();
  return isIP(json) ? json : undefined;
}

function echoOnce(target: { host: string; path: string }, localAddress: string | undefined, timeoutMs: number): Promise<{ ip?: string; local?: string }> {
  return new Promise((resolve) => {
    void (async () => {
      // Through the physical adapter the name is looked up the same way the relay looks up a proxy.
      let address: string;
      try { address = localAddress ? await resolveDirect(target.host, localAddress) : target.host; } catch { resolve({}); return; }
      let local: string | undefined;
      const req = httpsRequest({ host: address, servername: target.host, port: 443, path: target.path, timeout: timeoutMs,
        headers: { host: target.host, "user-agent": "curl/8" }, ...(localAddress ? { localAddress } : {}) }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
        res.on("end", () => resolve({ ip: echoAddress(body), local }));
      });
      req.on("socket", (socket) => socket.once("connect", () => { local = socket.localAddress; }));
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ local }));
      req.end();
    })();
  });
}

async function traceIp(localAddress?: string, timeoutMs = 6000): Promise<{ ip?: string; local?: string }> {
  let last: { ip?: string; local?: string } = {};
  for (const target of ECHO) {
    last = await echoOnce(target, localAddress, timeoutMs);
    if (last.ip) return last;
  }
  return last;
}

/**
 * Proves the bypass with real connections: the physical adapter is found, a proxy name resolves to
 * a real address through it, a bound connection really uses it, and its exit differs from the
 * computer's default path when a TUN client is running.
 */
export async function testTunBypass(): Promise<TunBypassTest> {
  const physical = await detectPhysicalInterface();
  if (!physical) return { interface: null, ok: false, problem: "No physical network adapter was found" };
  const result: TunBypassTest = { interface: physical, ok: false };
  try {
    const name = "www.gstatic.com";
    result.resolved = { name, address: await resolveDirect(name, physical.address) };
  } catch (error) {
    result.problem = `Encrypted DNS through ${physical.name} failed: ${error instanceof Error ? error.message : error}`;
    return result;
  }
  const [direct, viaDefault] = await Promise.all([traceIp(physical.address), traceIp()]);
  result.boundLocal = direct.local; result.defaultLocal = viaDefault.local;
  result.directExit = direct.ip; result.defaultExit = viaDefault.ip;
  if (!direct.ip) { result.problem = `A connection through ${physical.name} did not get out`; return result; }
  if (direct.local && direct.local !== physical.address) { result.problem = "The connection did not use the physical adapter"; return result; }
  result.ok = true;
  return result;
}

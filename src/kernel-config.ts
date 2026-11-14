/**
 * sing-box configurations for proxy-pool nodes (design §3.3). A profile's kernel has one inbound
 * (SOCKS5 on 127.0.0.1, with credentials only its relay knows) and one outbound (the node). There
 * is no direct outbound, no TUN, no system proxy, no route changes and no sniffing: the kernel
 * forwards the name the relay hands it and never resolves a destination on this computer.
 *
 * The only name the kernel resolves is the node server's own, and not through this computer's
 * DNS server: through a dedicated DNS-over-HTTPS server reached by IP, like Clash Verge's
 * proxy-server-nameserver.
 */

import { isIP } from "node:net";
import { canonicalIp } from "./ip.ts";
import type { Outbound } from "./subscription.ts";

/** Default resolver for node server names: AliDNS DoH, reached by IP. */
export const NODE_RESOLVER = { type: "https", server: "223.5.5.5" } as const;

export interface KernelDnsServer {
  type: "https";
  server: string;
}

export type KernelDnsEnvironment = "auto" | "cn" | "global";

export const MAX_KERNEL_DNS_SERVERS = 6;

/** Encrypted DoH IP-only presets per network environment. */
export const KERNEL_DNS_PRESETS: Record<KernelDnsEnvironment, readonly KernelDnsServer[]> = {
  cn: [
    { type: "https", server: "223.5.5.5" },
    { type: "https", server: "223.6.6.6" },
    { type: "https", server: "1.12.12.12" },
  ],
  global: [
    { type: "https", server: "1.1.1.1" },
    { type: "https", server: "8.8.8.8" },
  ],
  auto: [
    { type: "https", server: "223.5.5.5" },
    { type: "https", server: "223.6.6.6" },
    { type: "https", server: "1.12.12.12" },
    { type: "https", server: "1.1.1.1" },
    { type: "https", server: "8.8.8.8" },
  ],
};

export function parseKernelDnsEnvironment(value: unknown): KernelDnsEnvironment | undefined {
  return value === "auto" || value === "cn" || value === "global" ? value : undefined;
}

export interface KernelInbound {
  /** Tag, unique in the config. */
  tag: string;
  port: number;
  username: string;
  password: string;
  outbound: Outbound;
}

const KERNEL_TYPES = new Set(["shadowsocks", "vmess", "vless", "trojan", "hysteria2", "tuic", "anytls"]);
const RESOLVER_TAG = "node-resolver";
// Minimal RFC 8484 root NS wire query: avoids querying or leaking any real hostname during DoH reachability checks.
const DOH_PROBE_QUERY = "AAABAAABAAAAAAAAAAACAAE";

export function needsKernelResolver(inbounds: readonly KernelInbound[]): boolean {
  return inbounds.some((inbound) => isIP(inbound.outbound.server) === 0 || usesEch(inbound.outbound));
}

function normalizeResolvers(opts: {
  resolver?: KernelDnsServer;
  resolvers?: readonly KernelDnsServer[];
}): KernelDnsServer[] {
  const input = opts.resolvers ?? (opts.resolver ? [opts.resolver] : [NODE_RESOLVER]);
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_KERNEL_DNS_SERVERS) {
    throw new Error("the node resolver must include between 1 and 6 DoH servers");
  }
  const seen = new Set<string>();
  const unique: KernelDnsServer[] = [];
  for (const resolver of input) {
    const canonical = resolver && typeof resolver.server === "string" ? canonicalIp(resolver.server) : null;
    if (!resolver || resolver.type !== "https" || !canonical) {
      throw new Error("the node resolver must be a DNS-over-HTTPS server given by IP");
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      unique.push({ type: "https", server: canonical });
    }
  }
  return unique;
}

/** Build a config: each inbound routes to its own outbound, and nowhere else. */
export function kernelConfig(
  inbounds: KernelInbound[],
  opts: { resolver?: KernelDnsServer; resolvers?: readonly KernelDnsServer[] } = {},
): Record<string, unknown> {
  if (!inbounds.length) throw new Error("a kernel needs at least one inbound");
  const resolvers = normalizeResolvers(opts);
  // A node given by name, or one that looks up its ECH config: only encrypted IP-addressed DoH servers are permitted.
  const needsResolver = needsKernelResolver(inbounds);
  const config = {
    log: { level: "warn", timestamp: false },
    ...(needsResolver ? {
      dns: {
        servers: resolvers.map((resolver, index) => ({
          type: "https",
          tag: index === 0 ? RESOLVER_TAG : `${RESOLVER_TAG}-${index}`,
          server: resolver.server,
        })),
      },
    } : {}),
    inbounds: inbounds.map((inbound) => ({
      type: "socks",
      tag: `in-${inbound.tag}`,
      listen: "127.0.0.1",
      listen_port: inbound.port,
      users: [{ username: inbound.username, password: inbound.password }],
    })),
    outbounds: inbounds.map((inbound) => {
      const { type, ...rest } = inbound.outbound;
      if (!KERNEL_TYPES.has(type)) throw new Error(`not a kernel protocol: ${type}`);
      return {
        type,
        tag: `out-${inbound.tag}`,
        ...rest,
        ...(isIP(inbound.outbound.server) === 0 ? { domain_resolver: RESOLVER_TAG } : {}),
      };
    }),
    route: {
      rules: inbounds.map((inbound) => ({ inbound: [`in-${inbound.tag}`], action: "route", outbound: `out-${inbound.tag}` })),
      // Every connection comes from an inbound above; this only names a node, never a direct route.
      final: `out-${inbounds[0]!.tag}`,
      ...(needsResolver ? { default_domain_resolver: RESOLVER_TAG } : {}),
    },
  };
  assertKernelConfig(config);
  return config;
}

function usesEch(outbound: Record<string, unknown>): boolean {
  const tls = outbound.tls as Record<string, any> | undefined;
  return !!tls?.ech?.enabled;
}

function hasForbiddenPathOption(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPathOption);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith("_path") || (key === "config" && nested !== undefined)) return true;
    if (hasForbiddenPathOption(nested)) return true;
  }
  return false;
}

/**
 * The invariants, checked on every config before it is written and again before a kernel starts.
 * A config that breaks one is never run.
 */
export function assertKernelConfig(config: unknown): void {
  const fail = (why: string): never => { throw new Error(`unsafe kernel config: ${why}`); };
  if (!config || typeof config !== "object") fail("not an object");
  const c = config as Record<string, any>;
  for (const key of Object.keys(c)) {
    if (!["log", "dns", "inbounds", "outbounds", "route"].includes(key)) fail(`unexpected section ${key}`);
  }
  if (!Array.isArray(c.inbounds) || !c.inbounds.length) fail("no inbound");
  for (const inbound of c.inbounds) {
    if (inbound.type !== "socks") fail(`inbound type ${inbound.type}`);
    if (inbound.listen !== "127.0.0.1") fail("inbound not on loopback");
    if (!Array.isArray(inbound.users) || inbound.users.length !== 1 || !inbound.users[0].username || !inbound.users[0].password) fail("inbound without credentials");
    for (const key of Object.keys(inbound)) if (!["type", "tag", "listen", "listen_port", "users"].includes(key)) fail(`inbound option ${key}`);
  }
  if (!Array.isArray(c.outbounds) || !c.outbounds.length) fail("no outbound");
  const tags = new Set<string>();
  for (const outbound of c.outbounds) {
    if (!KERNEL_TYPES.has(outbound.type)) fail(`outbound type ${outbound.type}`);
    for (const key of ["detour", "bind_interface", "inet4_bind_address", "inet6_bind_address", "routing_mark", "multiplex"]) {
      if (key in outbound) fail(`outbound option ${key}`);
    }
    if (outbound.tls !== undefined && hasForbiddenPathOption(outbound.tls)) fail("outbound tls option references local or inline config");
    // Without the DoH resolver, sing-box would look the ECH config up with this computer's DNS.
    if (usesEch(outbound) && !c.dns) fail("ECH needs the node resolver");
    if (typeof outbound.server === "string" && isIP(outbound.server) === 0 && !c.dns) {
      fail("hostname outbound requires the DoH node resolver");
    }
    tags.add(outbound.tag);
  }
  const route = c.route ?? fail("no route");
  for (const key of Object.keys(route)) if (!["rules", "final", "default_domain_resolver"].includes(key)) fail(`route option ${key}`);
  if (!tags.has(route.final)) fail("final is not a node");
  for (const rule of route.rules ?? []) {
    if (rule.action !== "route" || !tags.has(rule.outbound)) fail("a rule leads somewhere other than a node");
    for (const key of Object.keys(rule)) if (!["inbound", "action", "outbound"].includes(key)) fail(`rule option ${key}`);
  }
  if (c.dns) {
    for (const key of Object.keys(c.dns)) if (key !== "servers") fail(`dns option ${key}`);
    if (!Array.isArray(c.dns.servers) || c.dns.servers.length < 1 || c.dns.servers.length > MAX_KERNEL_DNS_SERVERS) {
      fail("dns must hold between 1 and 6 DoH resolvers");
    }
    const resolverTags = new Set<string>();
    for (const server of c.dns.servers) {
      if (!server || typeof server !== "object") fail("dns server must be DoH by IP");
      if (server.type !== "https" || typeof server.tag !== "string" || !server.tag || typeof server.server !== "string" || isIP(server.server) === 0) {
        fail("dns server must be DoH by IP");
      }
      for (const key of Object.keys(server)) if (!["type", "tag", "server"].includes(key)) fail(`dns server option ${key}`);
      if (resolverTags.has(server.tag)) fail(`duplicate dns tag ${server.tag}`);
      resolverTags.add(server.tag);
    }
    const hasDefaultResolver = typeof route.default_domain_resolver === "string" && resolverTags.has(route.default_domain_resolver);
    if (route.default_domain_resolver !== undefined && !hasDefaultResolver) {
      fail("default domain resolver must reference a configured DoH server");
    }
    for (const outbound of c.outbounds) {
      if (outbound.domain_resolver !== undefined && !resolverTags.has(outbound.domain_resolver)) {
        fail("outbound domain resolver must reference a configured DoH server");
      }
      if (((typeof outbound.server === "string" && isIP(outbound.server) === 0) || usesEch(outbound))
        && !outbound.domain_resolver && !hasDefaultResolver) {
        fail("hostname or ECH outbound requires a configured DoH domain resolver");
      }
    }
  } else {
    if (route.default_domain_resolver !== undefined) fail("default domain resolver requires configured dns");
    for (const outbound of c.outbounds) {
      if (outbound.domain_resolver !== undefined) fail("outbound domain resolver requires configured dns");
    }
  }
}

export async function probeKernelDohServer(
  server: KernelDnsServer,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 1_200,
): Promise<boolean> {
  const ip = typeof server.server === "string" ? canonicalIp(server.server) : null;
  if (server.type !== "https" || !ip) return false;
  const host = isIP(ip) === 6 ? `[${ip}]` : ip;
  try {
    const response = await fetchFn(`https://${host}/dns-query?dns=${DOH_PROBE_QUERY}`, {
      headers: { accept: "application/dns-message" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/dns-message")) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Must be >= 12-byte DNS header matching probe query ID 0x0001 with the QR response bit set.
    return bytes.length >= 12 && bytes[0] === 0x00 && bytes[1] === 0x01 && (bytes[2]! & 0x80) !== 0;
  } catch {
    return false;
  }
}

/**
 * Picks an active DoH order for the current network environment and caches it briefly so repeated
 * kernel launches don't re-probe while still failing over when a primary endpoint becomes unreachable.
 */
export class KernelDnsSelector {
  private readonly cache = new Map<KernelDnsEnvironment, { resolvers: KernelDnsServer[]; expiresAt: number }>();
  private readonly inflight = new Map<KernelDnsEnvironment, Promise<KernelDnsServer[]>>();
  private readonly epochs = new Map<KernelDnsEnvironment, number>();
  private readonly failedUntil = new Map<string, number>();

  constructor(private readonly opts: {
    probe?: (server: KernelDnsServer) => Promise<boolean>;
    now?: () => number;
    ttlMs?: number;
  } = {}) {}

  private bumpEpoch(env: KernelDnsEnvironment): number {
    const next = (this.epochs.get(env) ?? 0) + 1;
    this.epochs.set(env, next);
    return next;
  }

  /** Record a failed primary DoH IP temporarily so the next resolve promotes a healthy backup. */
  markFailed(serverIp?: string, cooldownMs = 60_000): void {
    const canonical = serverIp ? canonicalIp(serverIp) : null;
    if (canonical) {
      const now = this.opts.now?.() ?? Date.now();
      this.failedUntil.set(canonical, now + cooldownMs);
    }
    this.invalidate();
  }

  invalidate(env?: KernelDnsEnvironment): void {
    if (env) {
      this.bumpEpoch(env);
      this.cache.delete(env);
      this.inflight.delete(env);
    } else {
      for (const candidate of ["auto", "cn", "global"] as const) this.bumpEpoch(candidate);
      this.cache.clear();
      this.inflight.clear();
    }
  }

  async resolve(env: KernelDnsEnvironment = "auto"): Promise<KernelDnsServer[]> {
    const now = this.opts.now?.() ?? Date.now();
    const cached = this.cache.get(env);
    if (cached && cached.expiresAt > now) return cached.resolvers.map((s) => ({ ...s }));
    const existing = this.inflight.get(env);
    if (existing) return (await existing).map((s) => ({ ...s }));

    const epoch = this.epochs.get(env) ?? 0;
    const run = this.measure(env, epoch).finally(() => {
      if (this.inflight.get(env) === run) this.inflight.delete(env);
    });
    this.inflight.set(env, run);
    return (await run).map((s) => ({ ...s }));
  }

  private async measure(env: KernelDnsEnvironment, epoch: number): Promise<KernelDnsServer[]> {
    const preset = [...KERNEL_DNS_PRESETS[env]];
    const probe = this.opts.probe ?? ((server) => probeKernelDohServer(server));
    const probed = await Promise.all(preset.map(async (server, index) => {
      const start = performance.now();
      const ok = await probe(server).catch(() => false);
      return { server, ok, index, elapsed: performance.now() - start };
    }));
    const now = this.opts.now?.() ?? Date.now();
    const isCooledDown = (server: KernelDnsServer) => {
      const ip = canonicalIp(server.server) ?? server.server;
      const until = this.failedUntil.get(ip);
      if (until !== undefined && until <= now) this.failedUntil.delete(ip);
      return until !== undefined && until > now;
    };
    const reachable = probed.filter((entry) => entry.ok && !isCooledDown(entry.server));
    const demotedReachable = probed.filter((entry) => entry.ok && isCooledDown(entry.server));
    const unreachable = probed.filter((entry) => !entry.ok);
    // In "auto", sort healthy servers fastest-first so China uses CN DoH and overseas uses global DoH.
    // In explicit "cn" / "global", keep preset priority unless the primary server failed to answer.
    if (env === "auto") {
      reachable.sort((a, b) => a.elapsed - b.elapsed || a.index - b.index);
      demotedReachable.sort((a, b) => a.elapsed - b.elapsed || a.index - b.index);
    }
    const prioritized = [...reachable, ...demotedReachable];
    const ordered = prioritized.length > 0
      ? [...prioritized.map((entry) => ({ ...entry.server })), ...unreachable.map((entry) => ({ ...entry.server }))]
      : preset.map((server) => ({ ...server }));
    // Never write results back if invalidate() ran while probes were in flight, and cap empty-failure caching.
    if ((this.epochs.get(env) ?? 0) === epoch) {
      const ttl = prioritized.length > 0 ? (this.opts.ttlMs ?? 5 * 60_000) : Math.min(this.opts.ttlMs ?? 5 * 60_000, 3_000);
      this.cache.set(env, { resolvers: ordered, expiresAt: now + ttl });
    }
    return ordered;
  }
}

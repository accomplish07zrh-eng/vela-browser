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
import type { Outbound } from "./subscription.ts";

/** Default resolver for node server names: AliDNS DoH, reached by IP. */
export const NODE_RESOLVER = { type: "https", server: "223.5.5.5" } as const;

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

/** Build a config: each inbound routes to its own outbound, and nowhere else. */
export function kernelConfig(inbounds: KernelInbound[], opts: { resolver?: { type: "https"; server: string } } = {}): Record<string, unknown> {
  if (!inbounds.length) throw new Error("a kernel needs at least one inbound");
  const resolver = opts.resolver ?? NODE_RESOLVER;
  if (resolver.type !== "https" || isIP(resolver.server) === 0) throw new Error("the node resolver must be a DNS-over-HTTPS server given by IP");
  const needsResolver = inbounds.some((inbound) => isIP(inbound.outbound.server) === 0);
  const config = {
    log: { level: "warn", timestamp: false },
    ...(needsResolver ? { dns: { servers: [{ type: "https", tag: RESOLVER_TAG, server: resolver.server }] } } : {}),
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
    if (!Array.isArray(c.dns.servers) || c.dns.servers.length !== 1) fail("dns must hold exactly the node resolver");
    const server = c.dns.servers[0];
    if (server.type !== "https" || server.tag !== RESOLVER_TAG || isIP(server.server) === 0) fail("dns server must be DoH by IP");
    for (const key of Object.keys(server)) if (!["type", "tag", "server"].includes(key)) fail(`dns server option ${key}`);
  }
}

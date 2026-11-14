/**
 * Proxy subscriptions: fetch one, recognise its format, and turn every exit it lists into a
 * kernel outbound (docs/plans/2026-11-13-proxy-pool-design.md §2).
 *
 * Hard rules:
 *  - Only the protocols listed here become nodes. Everything else is "unsupported" or "not a node";
 *    nothing is ever taken as a node by default. `direct` in particular would be no proxy at all.
 *  - A field this parser does not know makes the whole node unsupported. Dropping a transport or
 *    TLS setting would change where and how the node connects.
 *  - Entries that only carry provider information ("剩余流量", "到期") are not nodes.
 *  - Rules and proxy groups (select, url-test, fallback…) are ignored: a profile has one exit.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isNonPublicIp } from "./ip.ts";
import { regionHintFromName } from "./proxy-pool.ts";

export type KernelProtocol = "shadowsocks" | "vmess" | "vless" | "trojan" | "hysteria2" | "tuic" | "anytls";
export type NodeProtocol = KernelProtocol | "http" | "https" | "socks5";

/** A sing-box outbound without its tag. */
export type Outbound = Record<string, unknown> & { type: string; server: string; server_port: number };

export interface ParsedNode {
  name: string;
  protocol: NodeProtocol;
  server: string;
  port: number;
  /** For http/https/socks5: the plain proxy. For the others: the kernel outbound. */
  outbound: Outbound;
  /** The provider asked to skip certificate checks to the node. */
  insecureTls: boolean;
  regionHint?: string;
  /** Same node, same key: protocol, address and credentials. Never shown; it contains secrets. */
  key: string;
}

export interface SubscriptionUsage {
  uploadBytes?: number;
  downloadBytes?: number;
  totalBytes?: number;
  expireAt?: number;
}

export interface ParsedSubscription {
  format: "clash" | "sing-box" | "uri";
  nodes: ParsedNode[];
  /** direct, reject, dns and other entries that are not exits. */
  nonNodes: number;
  /** Provider notices dressed up as nodes. */
  infoEntries: string[];
  unsupported: Array<{ name: string; reason: string }>;
}

export class SubscriptionError extends Error {}

/** Words providers put in fake nodes that only carry account information. */
export const INFO_KEYWORDS = [
  "剩余流量", "流量", "到期", "过期", "有效期", "官网", "网址", "套餐", "重置", "客服", "公告", "官方", "续费", "订阅",
  "traffic", "expire", "website", "reset", "renew", "subscription",
];

export function isNonPublicHostName(host: string): boolean {
  const cleaned = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!cleaned) return true;
  if (cleaned === "localhost" || cleaned.endsWith(".localhost") || cleaned.endsWith(".local") || cleaned.endsWith(".internal")) return true;
  if (isIP(cleaned) !== 0) return isNonPublicIp(cleaned);
  return false;
}

export function isInfoEntry(name: string, server: string, port: number): boolean {
  if (isNonPublicHostName(server) || port === 0 || port === 1) return true;
  const lower = name.toLowerCase();
  return INFO_KEYWORDS.some((word) => lower.includes(word));
}

/** subscription-userinfo: "upload=1; download=2; total=3; expire=4". Missing or broken: nothing. */
export function parseSubscriptionUserinfo(header: string | null | undefined): SubscriptionUsage | undefined {
  if (!header) return undefined;
  const usage: SubscriptionUsage = {};
  for (const part of header.split(";")) {
    const [rawKey, rawValue] = part.split("=").map((s) => s?.trim());
    if (!rawKey || rawValue === undefined || !/^\d+(\.\d+)?$/.test(rawValue)) continue;
    const value = Math.floor(Number(rawValue));
    if (!Number.isSafeInteger(value)) continue;
    if (rawKey === "upload") usage.uploadBytes = value;
    else if (rawKey === "download") usage.downloadBytes = value;
    else if (rawKey === "total") usage.totalBytes = value;
    else if (rawKey === "expire" && value > 0) usage.expireAt = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

class Unsupported extends Error {}
const unsupported = (reason: string): never => { throw new Unsupported(reason); };

function text(value: unknown, what: string): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string" || !value.trim()) unsupported(`missing ${what}`);
  return (value as string).trim();
}

function port(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 65535) unsupported("invalid port");
  return n as number;
}

function server(value: unknown): string {
  const host = text(value, "server").replace(/^\[|\]$/g, "");
  if (/[\s/@?#]/.test(host)) unsupported("invalid server");
  return host;
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Fields every Clash proxy may carry that do not change where or how it connects for a profile. */
const CLASH_COMMON = new Set(["name", "type", "server", "port", "udp", "tfo", "mptcp", "ip-version", "smux", "interface-name", "routing-mark"]);
const CLASH_TLS = new Set(["tls", "sni", "servername", "skip-cert-verify", "client-fingerprint", "alpn", "reality-opts", "ech-opts"]);
const CLASH_TRANSPORT = new Set(["network", "ws-opts", "grpc-opts", "h2-opts", "http-opts"]);

function onlyKnown(proxy: Record<string, unknown>, known: Set<string>[]): void {
  for (const key of Object.keys(proxy)) {
    if (!known.some((set) => set.has(key))) unsupported(`unknown field ${key}`);
  }
}

function clashTls(proxy: Record<string, unknown>, opts: { always?: boolean; host: string }): Record<string, unknown> | undefined {
  const enabled = opts.always || bool(proxy.tls) || !!proxy["reality-opts"];
  if (!enabled) return undefined;
  const tls: Record<string, unknown> = { enabled: true };
  const sni = proxy.sni ?? proxy.servername;
  if (sni !== undefined) tls.server_name = text(sni, "sni");
  else if (!isIP(opts.host)) tls.server_name = opts.host;
  if (bool(proxy["skip-cert-verify"])) tls.insecure = true;
  if (proxy.alpn !== undefined) {
    if (!Array.isArray(proxy.alpn) || proxy.alpn.some((v) => typeof v !== "string")) unsupported("invalid alpn");
    tls.alpn = proxy.alpn;
  }
  if (proxy["client-fingerprint"] !== undefined) tls.utls = { enabled: true, fingerprint: text(proxy["client-fingerprint"], "client-fingerprint") };
  const reality = proxy["reality-opts"];
  if (reality !== undefined) {
    if (!reality || typeof reality !== "object") unsupported("invalid reality-opts");
    const r = reality as Record<string, unknown>;
    for (const key of Object.keys(r)) if (!["public-key", "short-id"].includes(key)) unsupported(`unknown reality field ${key}`);
    tls.reality = { enabled: true, public_key: text(r["public-key"], "reality public key"), ...(r["short-id"] !== undefined ? { short_id: String(r["short-id"]) } : {}) };
    // REALITY needs a uTLS fingerprint; Clash defaults to chrome.
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: "chrome" };
  }
  const ech = proxy["ech-opts"];
  if (ech !== undefined) {
    if (!ech || typeof ech !== "object") unsupported("invalid ech-opts");
    const e = ech as Record<string, unknown>;
    for (const key of Object.keys(e)) if (!["enable", "query-server-name", "config"].includes(key)) unsupported(`unknown ech field ${key}`);
    if (bool(e.enable)) {
      // An ECH config given inline is a different encoding in sing-box; only the DNS lookup is taken.
      if (e.config !== undefined && e.config !== "") unsupported("ech config");
      // The lookup goes through the kernel's own DNS-over-HTTPS resolver (kernel-config.ts).
      tls.ech = { enabled: true, ...(e["query-server-name"] !== undefined ? { query_server_name: text(e["query-server-name"], "ech query server name") } : {}) };
    }
  }
  return tls;
}

function clashTransport(proxy: Record<string, unknown>): Record<string, unknown> | undefined {
  const network = proxy.network === undefined ? "tcp" : text(proxy.network, "network");
  if (network === "tcp") {
    for (const key of ["ws-opts", "grpc-opts", "h2-opts", "http-opts"]) if (proxy[key] !== undefined) unsupported(`${key} without its network`);
    return undefined;
  }
  const opts = (key: string, allowed: string[]): Record<string, unknown> => {
    const value = proxy[key] ?? {};
    if (typeof value !== "object" || Array.isArray(value)) unsupported(`invalid ${key}`);
    for (const field of Object.keys(value as object)) if (!allowed.includes(field)) unsupported(`unknown ${key} field ${field}`);
    return value as Record<string, unknown>;
  };
  if (network === "ws") {
    const ws = opts("ws-opts", ["path", "headers", "max-early-data", "early-data-header-name"]);
    const transport: Record<string, unknown> = { type: "ws" };
    if (ws.path !== undefined) transport.path = String(ws.path);
    if (ws.headers !== undefined) {
      if (typeof ws.headers !== "object" || Array.isArray(ws.headers)) unsupported("invalid ws headers");
      transport.headers = Object.fromEntries(Object.entries(ws.headers as object).map(([k, v]) => [k, String(v)]));
    }
    if (ws["max-early-data"] !== undefined) transport.max_early_data = Number(ws["max-early-data"]);
    if (ws["early-data-header-name"] !== undefined) transport.early_data_header_name = String(ws["early-data-header-name"]);
    return transport;
  }
  if (network === "grpc") {
    const grpc = opts("grpc-opts", ["grpc-service-name"]);
    return { type: "grpc", ...(grpc["grpc-service-name"] !== undefined ? { service_name: String(grpc["grpc-service-name"]) } : {}) };
  }
  if (network === "h2") {
    const h2 = opts("h2-opts", ["host", "path"]);
    return {
      type: "http",
      ...(h2.host !== undefined ? { host: Array.isArray(h2.host) ? h2.host.map(String) : [String(h2.host)] } : {}),
      ...(h2.path !== undefined ? { path: String(h2.path) } : {}),
    };
  }
  return unsupported(`network ${network}`);
}

function finish(name: string, protocol: NodeProtocol, outbound: Outbound): ParsedNode {
  const tls = outbound.tls as Record<string, unknown> | undefined;
  const secretFree = { ...outbound };
  return {
    name,
    protocol,
    server: outbound.server,
    port: outbound.server_port,
    outbound,
    insecureTls: !!tls?.insecure,
    ...(regionHintFromName(name) ? { regionHint: regionHintFromName(name) } : {}),
    key: createHash("sha256").update(JSON.stringify(sortKeys(secretFree))).digest("hex"),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  return value;
}

/** Clash entries that are not exits. */
const CLASH_NON_EXIT = new Set(["direct", "reject", "reject-drop", "dns", "pass", "compatible", "relay", "select", "url-test", "fallback", "load-balance"]);

/** One Clash `proxies` entry. Returns null for non-exit entries. */
export function parseClashProxy(proxy: Record<string, unknown>): ParsedNode | null {
  const type = String(proxy.type ?? "").toLowerCase();
  if (CLASH_NON_EXIT.has(type)) return null;
  const name = typeof proxy.name === "string" ? proxy.name : "";
  const host = server(proxy.server);
  const p = port(proxy.port);
  const base = { server: host, server_port: p };
  switch (type) {
    case "ss": {
      onlyKnown(proxy, [CLASH_COMMON, new Set(["cipher", "password", "plugin", "plugin-opts", "udp-over-tcp", "udp-over-tcp-version"])]);
      const outbound: Outbound = { type: "shadowsocks", ...base, method: text(proxy.cipher, "cipher"), password: text(proxy.password, "password") };
      if (proxy.plugin !== undefined) {
        const plugin = text(proxy.plugin, "plugin");
        const opts = (proxy["plugin-opts"] ?? {}) as Record<string, unknown>;
        if (plugin === "obfs") {
          outbound.plugin = "obfs-local";
          outbound.plugin_opts = [`obfs=${text(opts.mode, "obfs mode")}`, ...(opts.host !== undefined ? [`obfs-host=${String(opts.host)}`] : [])].join(";");
        } else if (plugin === "v2ray-plugin") {
          if (opts.mode !== undefined && opts.mode !== "websocket") unsupported("v2ray-plugin mode");
          outbound.plugin = "v2ray-plugin";
          outbound.plugin_opts = ["mode=websocket", ...(bool(opts.tls) ? ["tls"] : []), ...(opts.host !== undefined ? [`host=${String(opts.host)}`] : []), ...(opts.path !== undefined ? [`path=${String(opts.path)}`] : [])].join(";");
        } else unsupported(`ss plugin ${plugin}`);
      }
      return finish(name, "shadowsocks", outbound);
    }
    case "vmess": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, CLASH_TRANSPORT, new Set(["uuid", "alterId", "cipher", "packet-encoding", "global-padding", "authenticated-length"])]);
      const outbound: Outbound = { type: "vmess", ...base, uuid: text(proxy.uuid, "uuid"), alter_id: Number(proxy.alterId ?? 0), security: String(proxy.cipher ?? "auto") };
      if (bool(proxy["global-padding"])) outbound.global_padding = true;
      if (bool(proxy["authenticated-length"])) outbound.authenticated_length = true;
      const tls = clashTls(proxy, { host: host });
      if (tls) outbound.tls = tls;
      const transport = clashTransport(proxy);
      if (transport) outbound.transport = transport;
      return finish(name, "vmess", outbound);
    }
    case "vless": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, CLASH_TRANSPORT, new Set(["uuid", "flow", "packet-encoding", "encryption", "xudp", "alterId", "cipher"])]);
      if (proxy.encryption !== undefined && proxy.encryption !== "" && proxy.encryption !== "none") unsupported("vless encryption");
      // Clash generators copy VMess's alterId and cipher onto VLESS nodes. VLESS has neither, so only
      // the values that mean "nothing" pass.
      if (proxy.alterId !== undefined && Number(proxy.alterId) !== 0) unsupported(`vless alterId ${String(proxy.alterId)}`);
      if (proxy.cipher !== undefined && !["", "auto", "none"].includes(String(proxy.cipher))) unsupported(`vless cipher ${String(proxy.cipher)}`);
      const outbound: Outbound = { type: "vless", ...base, uuid: text(proxy.uuid, "uuid") };
      if (proxy.flow !== undefined && proxy.flow !== null && proxy.flow !== "") outbound.flow = text(proxy.flow, "flow");
      const tls = clashTls(proxy, { host: host });
      if (tls) outbound.tls = tls;
      const transport = clashTransport(proxy);
      if (transport) outbound.transport = transport;
      return finish(name, "vless", outbound);
    }
    case "trojan": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, CLASH_TRANSPORT, new Set(["password"])]);
      const outbound: Outbound = { type: "trojan", ...base, password: text(proxy.password, "password") };
      outbound.tls = clashTls(proxy, { always: true, host: host });
      const transport = clashTransport(proxy);
      if (transport) outbound.transport = transport;
      return finish(name, "trojan", outbound);
    }
    case "hysteria2": case "hy2": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, new Set(["password", "auth", "obfs", "obfs-password", "up", "down", "ports", "mport", "hop-interval"])]);
      const outbound: Outbound = { type: "hysteria2", ...base, password: text(proxy.password ?? proxy.auth, "password") };
      if (proxy.obfs !== undefined && proxy.obfs !== "") {
        if (proxy.obfs !== "salamander") unsupported(`hysteria2 obfs ${String(proxy.obfs)}`);
        outbound.obfs = { type: "salamander", password: text(proxy["obfs-password"], "obfs password") };
      }
      const mbps = (v: unknown) => { const m = /^(\d+)/.exec(String(v)); return m ? Number(m[1]) : unsupported("invalid bandwidth"); };
      // An empty bandwidth (null) is the same as none given.
      if (proxy.up !== undefined && proxy.up !== null && proxy.up !== "") outbound.up_mbps = mbps(proxy.up);
      if (proxy.down !== undefined && proxy.down !== null && proxy.down !== "") outbound.down_mbps = mbps(proxy.down);
      // "mport" is the older name of "ports"; some providers write both.
      const mport = proxy.mport === undefined || proxy.mport === null || proxy.mport === "" ? undefined : String(proxy.mport).trim();
      if (mport !== undefined && proxy.ports !== undefined && String(proxy.ports).trim() !== mport) unsupported("mport differs from ports");
      const ports = proxy.ports ?? mport;
      if (ports !== undefined) outbound.server_ports = String(ports).split(",").map((range) => range.trim().replace("-", ":"));
      if (proxy["hop-interval"] !== undefined) outbound.hop_interval = `${Number(proxy["hop-interval"])}s`;
      outbound.tls = clashTls(proxy, { always: true, host: host });
      return finish(name, "hysteria2", outbound);
    }
    case "tuic": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, new Set(["uuid", "password", "congestion-controller", "udp-relay-mode", "reduce-rtt", "heartbeat-interval", "request-timeout", "disable-sni", "fast-open", "max-open-streams"])]);
      const outbound: Outbound = { type: "tuic", ...base, uuid: text(proxy.uuid, "uuid"), password: text(proxy.password, "password") };
      if (proxy["congestion-controller"] !== undefined) outbound.congestion_control = text(proxy["congestion-controller"], "congestion controller");
      if (proxy["udp-relay-mode"] !== undefined) outbound.udp_relay_mode = text(proxy["udp-relay-mode"], "udp relay mode");
      if (bool(proxy["reduce-rtt"])) outbound.zero_rtt_handshake = true;
      if (proxy["heartbeat-interval"] !== undefined) outbound.heartbeat = `${Number(proxy["heartbeat-interval"])}ms`;
      const tls = clashTls(proxy, { always: true, host: host })!;
      if (bool(proxy["disable-sni"])) tls.disable_sni = true;
      outbound.tls = tls;
      return finish(name, "tuic", outbound);
    }
    case "anytls": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, new Set(["password", "idle-session-check-interval", "idle-session-timeout", "min-idle-session"])]);
      const outbound: Outbound = { type: "anytls", ...base, password: text(proxy.password, "password") };
      if (proxy["idle-session-check-interval"] !== undefined) outbound.idle_session_check_interval = `${Number(proxy["idle-session-check-interval"])}s`;
      if (proxy["idle-session-timeout"] !== undefined) outbound.idle_session_timeout = `${Number(proxy["idle-session-timeout"])}s`;
      if (proxy["min-idle-session"] !== undefined) outbound.min_idle_session = Number(proxy["min-idle-session"]);
      outbound.tls = clashTls(proxy, { always: true, host: host });
      return finish(name, "anytls", outbound);
    }
    case "http": case "socks5": {
      onlyKnown(proxy, [CLASH_COMMON, CLASH_TLS, new Set(["username", "password", "headers"])]);
      if (proxy.headers !== undefined) unsupported("custom proxy headers");
      const protocol: NodeProtocol = type === "socks5" ? "socks5" : bool(proxy.tls) ? "https" : "http";
      if (protocol !== "https" && bool(proxy["skip-cert-verify"])) { /* meaningless without TLS */ }
      if (protocol === "https" && bool(proxy["skip-cert-verify"])) unsupported("HTTPS proxy without certificate checks");
      const outbound: Outbound = {
        type: protocol, ...base,
        ...(proxy.username !== undefined ? { username: String(proxy.username) } : {}),
        ...(proxy.password !== undefined ? { password: String(proxy.password) } : {}),
      };
      return finish(name, protocol, outbound);
    }
    default:
      return unsupported(`protocol ${type || "(none)"}`);
  }
}

function query(url: URL): Record<string, string> {
  return Object.fromEntries([...url.searchParams.entries()]);
}

function uriTls(q: Record<string, string>, host: string, security: string | undefined): Record<string, unknown> | undefined {
  const sec = (security ?? q.security ?? "").toLowerCase();
  if (sec === "" || sec === "none") return undefined;
  if (sec !== "tls" && sec !== "reality" && sec !== "xtls") unsupported(`security ${sec}`);
  const tls: Record<string, unknown> = { enabled: true };
  const sni = q.sni ?? q.peer ?? q.serverName;
  if (sni) tls.server_name = sni;
  else if (!isIP(host)) tls.server_name = host;
  if (bool(q.allowInsecure) || bool(q.insecure) || bool(q.allow_insecure)) tls.insecure = true;
  if (q.alpn) tls.alpn = q.alpn.split(",").map((a) => a.trim()).filter(Boolean);
  if (q.fp) tls.utls = { enabled: true, fingerprint: q.fp };
  if (sec === "reality") {
    tls.reality = { enabled: true, public_key: text(q.pbk, "reality public key"), ...(q.sid !== undefined ? { short_id: q.sid } : {}) };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: "chrome" };
  }
  return tls;
}

function uriTransport(q: Record<string, string>): Record<string, unknown> | undefined {
  const type = (q.type ?? q.net ?? "tcp").toLowerCase();
  if (type === "tcp" || type === "") {
    if (q.headerType && q.headerType !== "none") unsupported(`tcp header ${q.headerType}`);
    return undefined;
  }
  if (type === "ws") return { type: "ws", ...(q.path ? { path: q.path } : {}), ...(q.host ? { headers: { Host: q.host } } : {}) };
  if (type === "grpc") return { type: "grpc", ...(q.serviceName ? { service_name: q.serviceName } : {}) };
  if (type === "h2" || type === "http") return { type: "http", ...(q.host ? { host: q.host.split(",") } : {}), ...(q.path ? { path: q.path } : {}) };
  return unsupported(`transport ${type}`);
}

/** Query keys each URI scheme may carry. Anything else makes the node unsupported. */
const URI_KNOWN: Record<string, Set<string>> = {
  vless: new Set(["type", "security", "encryption", "flow", "sni", "peer", "serverName", "fp", "pbk", "sid", "spx", "alpn", "allowInsecure", "insecure", "path", "host", "serviceName", "mode", "headerType"]),
  trojan: new Set(["type", "security", "sni", "peer", "fp", "alpn", "allowInsecure", "insecure", "path", "host", "serviceName", "headerType"]),
  hysteria2: new Set(["sni", "insecure", "obfs", "obfs-password", "alpn", "mport", "up", "down", "pinSHA256"]),
  tuic: new Set(["sni", "congestion_control", "udp_relay_mode", "alpn", "allow_insecure", "allowInsecure", "insecure", "disable_sni"]),
  anytls: new Set(["sni", "insecure", "allowInsecure", "fp", "alpn"]),
  ss: new Set(["plugin", "group"]),
};

function checkQuery(scheme: string, q: Record<string, string>): void {
  for (const key of Object.keys(q)) if (!URI_KNOWN[scheme]!.has(key)) unsupported(`unknown parameter ${key}`);
}

function decodeBase64(value: string): string {
  const clean = value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) throw new SubscriptionError("not base64");
  return Buffer.from(padded, "base64").toString("utf8");
}

/** One share link. Returns null for a line that is not a link. */
export function parseShareLink(line: string): ParsedNode | null {
  const trimmed = line.trim();
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (!scheme) return null;
  if (scheme === "vmess") {
    let json: Record<string, unknown>;
    try { json = JSON.parse(decodeBase64(trimmed.slice(8))); } catch { return unsupported("vmess link is not base64 JSON"); }
    const host = server(json.add);
    const known = new Set(["v", "ps", "add", "port", "id", "aid", "scy", "net", "type", "host", "path", "tls", "sni", "alpn", "fp", "allowInsecure", "insecure"]);
    for (const key of Object.keys(json)) if (!known.has(key)) unsupported(`unknown vmess field ${key}`);
    const q: Record<string, string> = Object.fromEntries(Object.entries({
      type: json.net, host: json.host, path: json.path, sni: json.sni, alpn: json.alpn, fp: json.fp, allowInsecure: json.allowInsecure ?? json.insecure,
      headerType: json.type,
    }).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    const outbound: Outbound = { type: "vmess", server: host, server_port: port(json.port), uuid: text(json.id, "uuid"), alter_id: Number(json.aid ?? 0), security: String(json.scy || "auto") };
    const tls = uriTls(q, host, json.tls ? String(json.tls) : undefined);
    if (tls) outbound.tls = tls;
    const transport = uriTransport(q);
    if (transport) outbound.transport = transport;
    return finish(String(json.ps ?? ""), "vmess", outbound);
  }
  let url: URL;
  try { url = new URL(trimmed.replace(/^hy2:\/\//i, "hysteria2://")); } catch { return unsupported("invalid link"); }
  const name = (() => { try { return decodeURIComponent(url.hash.slice(1)); } catch { return url.hash.slice(1); } })();
  const host = server(url.hostname);
  const q = query(url);
  const user = (() => { try { return decodeURIComponent(url.username); } catch { return url.username; } })();
  const pass = (() => { try { return decodeURIComponent(url.password); } catch { return url.password; } })();
  switch (url.protocol.replace(/:$/, "")) {
    case "vless": {
      checkQuery("vless", q);
      if (q.encryption && q.encryption !== "none") unsupported("vless encryption");
      const outbound: Outbound = { type: "vless", server: host, server_port: port(url.port), uuid: text(user, "uuid") };
      if (q.flow) outbound.flow = q.flow;
      const tls = uriTls(q, host, undefined);
      if (tls) outbound.tls = tls;
      const transport = uriTransport(q);
      if (transport) outbound.transport = transport;
      return finish(name, "vless", outbound);
    }
    case "trojan": {
      checkQuery("trojan", q);
      const outbound: Outbound = { type: "trojan", server: host, server_port: port(url.port || 443), password: text(user, "password") };
      outbound.tls = uriTls(q, host, q.security || "tls");
      const transport = uriTransport(q);
      if (transport) outbound.transport = transport;
      return finish(name, "trojan", outbound);
    }
    case "hysteria2": {
      checkQuery("hysteria2", q);
      if (q.pinSHA256) unsupported("certificate pinning");
      const outbound: Outbound = { type: "hysteria2", server: host, server_port: port(url.port || 443), password: text(pass ? `${user}:${pass}` : user, "password") };
      if (q.obfs) {
        if (q.obfs !== "salamander") unsupported(`hysteria2 obfs ${q.obfs}`);
        outbound.obfs = { type: "salamander", password: text(q["obfs-password"], "obfs password") };
      }
      if (q.mport) outbound.server_ports = q.mport.split(",").map((range) => range.trim().replace("-", ":"));
      outbound.tls = uriTls({ ...q, security: "tls" }, host, "tls");
      return finish(name, "hysteria2", outbound);
    }
    case "tuic": {
      checkQuery("tuic", q);
      const outbound: Outbound = { type: "tuic", server: host, server_port: port(url.port), uuid: text(user, "uuid"), password: text(pass, "password") };
      if (q.congestion_control) outbound.congestion_control = q.congestion_control;
      if (q.udp_relay_mode) outbound.udp_relay_mode = q.udp_relay_mode;
      const tls = uriTls(q, host, "tls")!;
      if (bool(q.disable_sni)) tls.disable_sni = true;
      outbound.tls = tls;
      return finish(name, "tuic", outbound);
    }
    case "anytls": {
      checkQuery("anytls", q);
      const outbound: Outbound = { type: "anytls", server: host, server_port: port(url.port || 443), password: text(user, "password") };
      outbound.tls = uriTls(q, host, "tls");
      return finish(name, "anytls", outbound);
    }
    case "ss": {
      checkQuery("ss", q);
      let method: string, password: string, ssHost = host, ssPort = url.port;
      if (pass) { method = user; password = pass; }
      else if (user) {
        const decoded = decodeBase64(user);
        const colon = decoded.indexOf(":");
        if (colon < 0) return unsupported("invalid ss credentials");
        method = decoded.slice(0, colon); password = decoded.slice(colon + 1);
      } else {
        // Legacy form: ss://base64(method:password@host:port)#name
        const decoded = decodeBase64(url.hostname.replace(/^\[|\]$/g, ""));
        const m = /^([^:]+):(.*)@([^@:]+|\[[^\]]+\]):(\d+)$/.exec(decoded);
        if (!m) return unsupported("invalid legacy ss link");
        [, method, password, ssHost] = m as unknown as [string, string, string, string];
        ssHost = ssHost.replace(/^\[|\]$/g, ""); ssPort = m[4]!;
      }
      const outbound: Outbound = { type: "shadowsocks", server: server(ssHost), server_port: port(ssPort), method: text(method, "method"), password: text(password, "password") };
      if (q.plugin) {
        const [plugin, ...opts] = q.plugin.split(";");
        if (plugin === "obfs-local" || plugin === "simple-obfs") { outbound.plugin = "obfs-local"; outbound.plugin_opts = opts.join(";"); }
        else if (plugin === "v2ray-plugin") { outbound.plugin = "v2ray-plugin"; outbound.plugin_opts = opts.join(";"); }
        else unsupported(`ss plugin ${plugin}`);
      }
      return finish(name, "shadowsocks", outbound);
    }
    case "http": case "https": case "socks5": case "socks": {
      if (url.pathname && url.pathname !== "/") unsupported("proxy URL with a path");
      if (Object.keys(q).length) unsupported("proxy URL with parameters");
      const protocol: NodeProtocol = url.protocol.startsWith("socks") ? "socks5" : url.protocol === "https:" ? "https" : "http";
      const outbound: Outbound = {
        type: protocol, server: host, server_port: port(url.port || (protocol === "https" ? 443 : protocol === "http" ? 80 : 1080)),
        ...(user ? { username: user } : {}), ...(pass ? { password: pass } : {}),
      };
      return finish(name, protocol, outbound);
    }
    default:
      return unsupported(`protocol ${url.protocol.replace(/:$/, "")}`);
  }
}

/** sing-box outbounds that may come in a subscription, and the fields each may keep. */
const SINGBOX_FIELDS: Record<string, string[]> = {
  shadowsocks: ["method", "password", "plugin", "plugin_opts"],
  vmess: ["uuid", "alter_id", "security", "global_padding", "authenticated_length", "tls", "transport", "packet_encoding"],
  vless: ["uuid", "flow", "tls", "transport", "packet_encoding"],
  trojan: ["password", "tls", "transport"],
  hysteria2: ["password", "obfs", "up_mbps", "down_mbps", "server_ports", "hop_interval", "tls"],
  tuic: ["uuid", "password", "congestion_control", "udp_relay_mode", "zero_rtt_handshake", "heartbeat", "tls"],
  anytls: ["password", "idle_session_check_interval", "idle_session_timeout", "min_idle_session", "tls"],
  http: ["username", "password", "tls", "path", "headers"],
  socks: ["username", "password", "version"],
};
/** Fields Vela sets itself or never uses: dropped. Multiplexing stays off; every profile resolves the node server its own way. */
const SINGBOX_DROPPED = new Set(["tag", "multiplex", "domain_resolver", "domain_strategy", "network", "udp_over_tcp", "tcp_fast_open", "tcp_multi_path"]);
const SINGBOX_NON_EXIT = new Set(["direct", "block", "dns", "selector", "urltest"]);

function validateSingBoxNestedObject(value: unknown, what: string, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported(`invalid ${what}`);
  const obj = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(obj)) {
    if (key.endsWith("_path")) unsupported(`${what} ${key}`);
    if (allowedKeys && !allowedKeys.includes(key)) unsupported(`unknown ${what} field ${key}`);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) validateSingBoxNestedObject(nested, `${what}.${key}`);
  }
  return obj;
}

export function parseSingBoxOutbound(raw: Record<string, unknown>): ParsedNode | null {
  const type = String(raw.type ?? "");
  if (SINGBOX_NON_EXIT.has(type)) return null;
  const fields = SINGBOX_FIELDS[type];
  if (!fields) return unsupported(`protocol ${type || "(none)"}`);
  const outbound: Outbound = { type, server: server(raw.server), server_port: port(raw.server_port) };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "type" || key === "server" || key === "server_port" || SINGBOX_DROPPED.has(key)) continue;
    if (!fields.includes(key)) unsupported(`unknown field ${key}`);
    if (key === "tls" && value !== undefined) {
      const tls = validateSingBoxNestedObject(value, "tls", [
        "enabled", "disable_sni", "server_name", "alpn", "min_version", "max_version",
        "cipher_suites", "curve_preferences", "certificate", "insecure", "utls", "reality", "ech",
        "fragment", "record_fragment",
      ]);
      if (tls.ech !== undefined) {
        const ech = validateSingBoxNestedObject(tls.ech, "tls.ech", [
          "enabled", "pq_signature_schemes_enabled", "dynamic_record_sizing_disabled", "query_server_name", "config",
        ]);
        if (ech.config !== undefined && ech.config !== "" && (!Array.isArray(ech.config) || ech.config.length > 0)) {
          unsupported("ech config");
        }
      }
      if (tls.utls !== undefined) validateSingBoxNestedObject(tls.utls, "tls.utls", ["enabled", "fingerprint"]);
      if (tls.reality !== undefined) validateSingBoxNestedObject(tls.reality, "tls.reality", ["enabled", "public_key", "short_id"]);
    } else if (key === "transport" && value !== undefined) {
      validateSingBoxNestedObject(value, "transport");
    } else if (key === "obfs" && value !== undefined) {
      validateSingBoxNestedObject(value, "obfs", ["type", "password"]);
    } else if (key === "plugin" && value !== undefined) {
      if (value !== "obfs-local" && value !== "v2ray-plugin") unsupported(`ss plugin ${String(value)}`);
    }
    outbound[key] = value;
  }
  if (type === "socks" && raw.version !== undefined && String(raw.version) !== "5") unsupported("socks version");
  const rawTls = raw.tls as { enabled?: boolean; insecure?: boolean } | undefined;
  const protocol: NodeProtocol = type === "socks" ? "socks5" : type === "http" ? (rawTls?.enabled ? "https" : "http") : type as KernelProtocol;
  if (protocol === "https" && rawTls?.insecure) unsupported("insecure https proxy");
  if (protocol === "socks5") { delete outbound.version; outbound.type = "socks5"; }
  if (protocol === "https") { delete outbound.tls; outbound.type = "https"; }
  if (type === "http" && (raw.path !== undefined || raw.headers !== undefined)) unsupported("custom HTTP proxy path or headers");
  return finish(typeof raw.tag === "string" ? raw.tag : "", protocol, outbound);
}

/** Recognise a subscription body and parse it. */
export function parseSubscription(body: string): ParsedSubscription {
  const trimmed = body.replace(/^﻿/, "").trim();
  if (!trimmed) throw new SubscriptionError("The subscription is empty");
  const result: ParsedSubscription = { format: "uri", nodes: [], nonNodes: 0, infoEntries: [], unsupported: [] };
  const add = (name: string, parse: () => ParsedNode | null) => {
    try {
      const node = parse();
      if (!node) { result.nonNodes++; return; }
      if (isInfoEntry(node.name, node.server, node.port)) { result.infoEntries.push(node.name); return; }
      result.nodes.push(node);
    } catch (error) {
      if (error instanceof Unsupported) result.unsupported.push({ name, reason: error.message });
      else if (error instanceof SubscriptionError) result.unsupported.push({ name, reason: error.message });
      else throw error;
    }
  };

  if (trimmed.startsWith("{")) {
    let json: unknown;
    try { json = JSON.parse(trimmed); } catch { throw new SubscriptionError("The subscription is not valid JSON"); }
    const outbounds = (json as { outbounds?: unknown }).outbounds;
    if (!Array.isArray(outbounds)) throw new SubscriptionError("The subscription has no outbounds");
    result.format = "sing-box";
    for (const raw of outbounds) {
      if (!raw || typeof raw !== "object") { result.nonNodes++; continue; }
      const entry = raw as Record<string, unknown>;
      add(String(entry.tag ?? ""), () => parseSingBoxOutbound(entry));
    }
    return dedupe(result);
  }

  if (/^(proxies|proxy-groups|port|mixed-port|rules|dns|mode)\s*:/m.test(trimmed)) {
    let yaml: unknown;
    try { yaml = Bun.YAML.parse(trimmed); } catch { throw new SubscriptionError("The subscription is not valid YAML"); }
    const proxies = (yaml as { proxies?: unknown } | null)?.proxies;
    if (!Array.isArray(proxies)) throw new SubscriptionError("The subscription has no proxies");
    result.format = "clash";
    for (const raw of proxies) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { result.nonNodes++; continue; }
      const entry = raw as Record<string, unknown>;
      add(String(entry.name ?? ""), () => parseClashProxy(entry));
    }
    return dedupe(result);
  }

  let lines = trimmed.split(/\r?\n/);
  if (!lines.some((line) => /^[a-z0-9+.-]+:\/\//i.test(line.trim()))) {
    let decoded: string;
    try { decoded = decodeBase64(trimmed); } catch { throw new SubscriptionError("The subscription format is not recognised"); }
    lines = decoded.split(/\r?\n/);
    if (!lines.some((line) => /^[a-z0-9+.-]+:\/\//i.test(line.trim()))) throw new SubscriptionError("The subscription format is not recognised");
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    const name = (() => { const hash = line.indexOf("#"); try { return hash >= 0 ? decodeURIComponent(line.slice(hash + 1)) : ""; } catch { return line.slice(hash + 1); } })();
    add(name, () => {
      const node = parseShareLink(line);
      if (node === null) throw new Unsupported("not a link");
      return node;
    });
  }
  return dedupe(result);
}

function dedupe(result: ParsedSubscription): ParsedSubscription {
  const seen = new Set<string>();
  result.nodes = result.nodes.filter((node) => (seen.has(node.key) ? false : (seen.add(node.key), true)));
  return result;
}

export interface FetchedSubscription {
  body: string;
  usage?: SubscriptionUsage;
  userAgent: string;
}

/** User-Agents in the order they are tried: Clash first (the fullest format), then v2rayN (base64). */
export const SUBSCRIPTION_USER_AGENTS = ["clash.meta", "v2rayN/7.0"];
const MAX_BYTES = 5 * 1024 * 1024;

async function assertPublicSubscriptionTarget(
  target: URL,
  opts: { allowPrivate?: boolean; lookupHost?: (host: string) => Promise<string[]> },
): Promise<void> {
  if (opts.allowPrivate) return;
  if (isNonPublicHostName(target.hostname)) {
    throw new SubscriptionError("The subscription link cannot target a local or private address");
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 || !opts.lookupHost) return;
  let addresses: string[];
  try {
    addresses = await opts.lookupHost(host);
  } catch {
    return;
  }
  if (addresses.some((ip) => isNonPublicIp(ip))) {
    throw new SubscriptionError("The subscription link cannot resolve to a local or private address");
  }
}

/**
 * Fetch a subscription. With no `userAgent`, Clash's first; a body that does not parse falls back
 * to the next. Only https, unless `allowHttp`. Redirects are followed at most three times.
 */
export async function fetchSubscription(
  url: string,
  opts: {
    userAgent?: string;
    allowHttp?: boolean;
    allowPrivate?: boolean;
    fetchFn?: typeof fetch;
    lookupHost?: (host: string) => Promise<string[]>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FetchedSubscription & { parsed: ParsedSubscription }> {
  let target: URL;
  try { target = new URL(url); } catch { throw new SubscriptionError("The subscription link is not a valid URL"); }
  if (target.protocol !== "https:" && !(opts.allowHttp && target.protocol === "http:")) {
    throw new SubscriptionError("The subscription link must use https");
  }
  const resolveHost = opts.lookupHost
    ?? (!opts.fetchFn ? async (host: string) => (await dnsLookup(host, { all: true })).map((entry) => entry.address) : undefined);
  await assertPublicSubscriptionTarget(target, { allowPrivate: opts.allowPrivate, lookupHost: resolveHost });
  const agents = opts.userAgent ? [opts.userAgent] : SUBSCRIPTION_USER_AGENTS;
  let lastError: Error = new SubscriptionError("The subscription could not be read");
  for (const agent of agents) {
    if (opts.signal?.aborted) throw new SubscriptionError("Subscription refresh was cancelled");
    let response: Response;
    let current = target;
    let redirects = 0;
    try {
      while (true) {
        const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
        response = await (opts.fetchFn ?? fetch)(current, {
          headers: { "User-Agent": agent, Accept: "*/*" },
          redirect: "manual",
          signal,
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          if (++redirects > 3) throw new SubscriptionError("The subscription link redirects too many times");
          const next = new URL(response.headers.get("location")!, current);
          if (next.protocol !== "https:" && !(opts.allowHttp && next.protocol === "http:")) throw new SubscriptionError("The subscription link redirects to an insecure address");
          await assertPublicSubscriptionTarget(next, { allowPrivate: opts.allowPrivate, lookupHost: resolveHost });
          current = next;
          continue;
        }
        break;
      }
      if (!response!.ok) { lastError = new SubscriptionError(`The subscription server answered ${response!.status}`); continue; }
      const length = Number(response!.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) throw new SubscriptionError("The subscription is too large");
      const buffer = await response!.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES) throw new SubscriptionError("The subscription is too large");
      const body = new TextDecoder().decode(buffer);
      const usage = parseSubscriptionUserinfo(response!.headers.get("subscription-userinfo"));
      let parsed: ParsedSubscription;
      try { parsed = parseSubscription(body); } catch (error) { lastError = error as Error; continue; }
      if (!parsed.nodes.length && agents.indexOf(agent) < agents.length - 1) { lastError = new SubscriptionError("The subscription lists no usable node"); continue; }
      return { body, ...(usage ? { usage } : {}), userAgent: agent, parsed };
    } catch (error) {
      if (error instanceof SubscriptionError) throw error;
      lastError = new SubscriptionError("The subscription could not be downloaded");
    }
  }
  throw lastError;
}

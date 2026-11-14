import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertKernelConfig,
  KERNEL_DNS_PRESETS,
  kernelConfig,
  KernelDnsSelector,
  probeKernelDohServer,
  type KernelInbound,
} from "./kernel-config.ts";
import { parseSubscription } from "./subscription.ts";

const SAMPLE = [
  "vless://11111111-2222-3333-4444-555555555555@jp.node.example:443?flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0&sid=0123abcd&type=tcp#reality",
  "vless://11111111-2222-3333-4444-666666666666@203.0.113.20:8443?security=tls&sni=cdn.example&allowInsecure=1&type=ws&path=%2Fray&host=cdn.example#ws",
  "hysteria2://HY2PASS@hk.node.example:30000/?sni=hk.node.example&insecure=1&obfs=salamander&obfs-password=OBFS#hy2",
  "anytls://ANYPASS@sg.node.example:443?sni=sg.node.example&insecure=1#anytls",
  "trojan://TRPASS@tw.node.example:443?sni=tw.node.example&type=grpc&serviceName=svc#trojan",
  `ss://${Buffer.from("2022-blake3-aes-128-gcm:AAAAAAAAAAAAAAAAAAAAAA==").toString("base64url")}@198.51.100.4:8388#ss`,
  `vmess://${Buffer.from(JSON.stringify({ v: "2", ps: "vmess", add: "vm.node.example", port: "443", id: "11111111-2222-3333-4444-777777777777", aid: "0", scy: "auto", net: "ws", path: "/vm", tls: "tls" })).toString("base64")}`,
  "tuic://11111111-2222-3333-4444-888888888888:TUPASS@tu.node.example:443?congestion_control=bbr&alpn=h3&sni=tu.node.example#tuic",
].join("\n");

const inbounds = (): KernelInbound[] => parseSubscription(SAMPLE).nodes.map((node, i) => ({
  tag: `n${i}`, port: 41000 + i, username: `user${i}`, password: `pass${i}`, outbound: node.outbound,
}));

test("a profile's kernel: one loopback inbound with credentials, its node, and nothing else", () => {
  const [first] = inbounds();
  const config = kernelConfig([first!]) as any;
  expect(config.inbounds).toEqual([{ type: "socks", tag: "in-n0", listen: "127.0.0.1", listen_port: 41000, users: [{ username: "user0", password: "pass0" }] }]);
  expect(config.outbounds.map((o: any) => o.type)).toEqual(["vless"]);
  expect(config.outbounds[0].domain_resolver).toBe("node-resolver");
  expect(config.route).toEqual({ rules: [{ inbound: ["in-n0"], action: "route", outbound: "out-n0" }], final: "out-n0", default_domain_resolver: "node-resolver" });
  // The only DNS server resolves node servers, over HTTPS, by IP.
  expect(config.dns).toEqual({ servers: [{ type: "https", tag: "node-resolver", server: "223.5.5.5" }] });
  const text = JSON.stringify(config);
  for (const forbidden of ['"direct"', '"tun"', "sniff", "set_system_proxy", "auto_route", "detour", "multiplex"]) expect(text).not.toContain(forbidden);
});

test("a node given by IP needs no resolver at all", () => {
  const ws = inbounds()[1]!;
  const config = kernelConfig([ws]) as any;
  expect(config.dns).toBeUndefined();
  expect(config.outbounds[0].domain_resolver).toBeUndefined();
  expect(config.route.default_domain_resolver).toBeUndefined();
});

test("the invariants refuse anything that could route around the node", () => {
  const good = kernelConfig(inbounds().slice(0, 2)) as any;
  const broken = (mutate: (c: any) => void) => { const c = structuredClone(good); mutate(c); return () => assertKernelConfig(c); };
  expect(broken(() => {})).not.toThrow();
  expect(broken((c) => c.outbounds.push({ type: "direct", tag: "direct" }))).toThrow("outbound type direct");
  expect(broken((c) => { c.route.final = "direct"; })).toThrow("final is not a node");
  expect(broken((c) => c.route.rules.push({ action: "route", outbound: "direct" }))).toThrow();
  expect(broken((c) => { c.route.rules[0].action = "sniff"; })).toThrow();
  expect(broken((c) => { c.inbounds[0].listen = "0.0.0.0"; })).toThrow("not on loopback");
  expect(broken((c) => { c.inbounds[0].users = []; })).toThrow("without credentials");
  expect(broken((c) => { c.inbounds[0].sniff = true; })).toThrow("inbound option sniff");
  expect(broken((c) => c.inbounds.push({ type: "tun", tag: "t" }))).toThrow("inbound type tun");
  expect(broken((c) => { c.experimental = {}; })).toThrow("unexpected section experimental");
  expect(broken((c) => { c.dns.servers.push({ type: "local", tag: "local" }); })).toThrow();
  expect(broken((c) => { c.dns.rules = []; })).toThrow("dns option rules");
  expect(broken((c) => { c.dns.servers[0].server = "dns.alidns.com"; })).toThrow("DoH by IP");
  expect(broken((c) => { c.outbounds[0].detour = "x"; })).toThrow("outbound option detour");
  expect(broken((c) => { c.outbounds[0].multiplex = { enabled: true }; })).toThrow("outbound option multiplex");
  expect(() => kernelConfig([{ ...inbounds()[0]!, outbound: { type: "direct", server: "x", server_port: 1 } }])).toThrow("not a kernel protocol");
  expect(() => kernelConfig(inbounds(), { resolver: { type: "https", server: "dns.google" } })).toThrow("by IP");
});

// Real sing-box accepts every config this module writes (VELA_SINGBOX=<sing-box executable>).
const binary = process.env.VELA_SINGBOX?.trim();
(binary ? test : test.skip)("sing-box itself accepts the configs, one inbound per protocol and all together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-kernel-config-"));
  try {
    const all = inbounds();
    for (const config of [...all.map((inbound) => kernelConfig([inbound])), kernelConfig(all)]) {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify(config));
      const proc = Bun.spawn([binary!, "check", "-c", file], { stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect({ code, err: err.trim() }).toEqual({ code: 0, err: "" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a node using ECH always gets the DoH resolver, even when it is given by IP, so the lookup never uses this computer's DNS", () => {
  const ech = parseSubscription(`proxies:
  - { name: e, type: vless, server: 203.0.113.30, port: 443, uuid: 11111111-2222-3333-4444-555555555555, tls: true, servername: c.node.example, ech-opts: { enable: true, query-server-name: cloudflare-ech.com } }
`).nodes[0]!;
  const config = kernelConfig([{ tag: "e", port: 41100, username: "u", password: "p", outbound: ech.outbound }]) as any;
  expect(config.dns).toEqual({ servers: [{ type: "https", tag: "node-resolver", server: "223.5.5.5" }] });
  expect(config.route.default_domain_resolver).toBe("node-resolver");
  const withoutDns = structuredClone(config);
  delete withoutDns.dns;
  expect(() => assertKernelConfig(withoutDns)).toThrow("ECH needs the node resolver");
});

test("multi-resolver DoH backups pass validation and reject non-https, hostnames, overflow, or missing tags", async () => {
  const [first] = inbounds();
  const resolvers = KERNEL_DNS_PRESETS.cn;
  const config = kernelConfig([first!], { resolvers }) as any;
  assertKernelConfig(config);
  expect(config.dns.servers.map((s: any) => [s.type, s.tag, s.server])).toEqual([
    ["https", "node-resolver", "223.5.5.5"],
    ["https", "node-resolver-1", "223.6.6.6"],
    ["https", "node-resolver-2", "1.12.12.12"],
  ]);

  const dir = binary ? mkdtempSync(join(tmpdir(), "vela-kernel-multi-dns-")) : null;
  if (dir) {
    try {
      const file = join(dir, "config.json");
      writeFileSync(file, JSON.stringify(config));
      const proc = Bun.spawn([binary!, "check", "-c", file], { stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect({ code, err: err.trim() }).toEqual({ code: 0, err: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const badHost = structuredClone(config);
  badHost.dns.servers.push({ type: "https", tag: "node-resolver-3", server: "dns.google" });
  expect(() => assertKernelConfig(badHost)).toThrow("DoH by IP");

  const badType = structuredClone(config);
  badType.dns.servers[1] = { type: "udp", tag: "node-resolver-1", server: "8.8.8.8" };
  expect(() => assertKernelConfig(badType)).toThrow("DoH by IP");

  const tooMany = structuredClone(config);
  while (tooMany.dns.servers.length < 7) {
    tooMany.dns.servers.push({ type: "https", tag: `node-resolver-${tooMany.dns.servers.length}`, server: "9.9.9.9" });
  }
  expect(() => assertKernelConfig(tooMany)).toThrow("between 1 and 6 DoH resolvers");

  const missingTag = structuredClone(config);
  missingTag.route.default_domain_resolver = "missing-tag";
  expect(() => assertKernelConfig(missingTag)).toThrow("default domain resolver must reference a configured DoH server");

  const badOutboundTag = structuredClone(config);
  badOutboundTag.outbounds.push({ type: "vless", tag: "out-n1", server: "node2.example", server_port: 443, domain_resolver: "missing-tag" });
  badOutboundTag.route.rules.push({ inbound: ["in-n0"], action: "route", outbound: "out-n1" });
  expect(() => assertKernelConfig(badOutboundTag)).toThrow("outbound domain resolver must reference a configured DoH server");
});

test("KernelDnsSelector probes according to environment preset, promotes failover, caches, and supports invalidation", async () => {
  const probed: string[] = [];
  let behavior: Record<string, { ok: boolean; delayMs?: number }> = {
    "223.5.5.5": { ok: false },
    "223.6.6.6": { ok: true, delayMs: 45 },
    "1.12.12.12": { ok: false },
    "1.1.1.1": { ok: true, delayMs: 0 },
    "8.8.8.8": { ok: true, delayMs: 90 },
  };
  let clock = 10_000;
  const selector = new KernelDnsSelector({
    probe: async (server) => {
      probed.push(server.server);
      const spec = behavior[server.server];
      if (spec?.delayMs) await Bun.sleep(spec.delayMs);
      return spec?.ok ?? false;
    },
    now: () => clock,
    ttlMs: 60_000,
  });

  // Auto: sorts reachable candidates by lowest latency and demotes unreachable ones to the tail.
  const autoOrder = (await selector.resolve("auto")).map((s) => s.server);
  expect(autoOrder.slice(0, 3)).toEqual(["1.1.1.1", "223.6.6.6", "8.8.8.8"]);
  expect(autoOrder.slice(3)).toEqual(["223.5.5.5", "1.12.12.12"]);
  expect(probed).toHaveLength(5);

  // Cached hit avoids re-probing before TTL expires.
  probed.length = 0;
  expect((await selector.resolve("auto")).map((s) => s.server)).toEqual(autoOrder);
  expect(probed).toEqual([]);

  // Expired TTL triggers fresh probe.
  clock += 60_001;
  await selector.resolve("auto");
  expect(probed).toHaveLength(5);

  // CN: only probes domestic servers and preserves preset order while demoting failed primary.
  probed.length = 0;
  behavior = {
    "223.5.5.5": { ok: false },
    "223.6.6.6": { ok: true },
    "1.12.12.12": { ok: true },
    "1.1.1.1": { ok: true },
    "8.8.8.8": { ok: true },
  };
  expect((await selector.resolve("cn")).map((s) => s.server)).toEqual(["223.6.6.6", "1.12.12.12", "223.5.5.5"]);
  expect(probed.sort()).toEqual(["1.12.12.12", "223.5.5.5", "223.6.6.6"]);

  // Global: only probes global servers and promotes backup when 1.1.1.1 is blocked.
  probed.length = 0;
  behavior = { "1.1.1.1": { ok: false }, "8.8.8.8": { ok: true }, "223.5.5.5": { ok: true } };
  expect((await selector.resolve("global")).map((s) => s.server)).toEqual(["8.8.8.8", "1.1.1.1"]);
  expect(probed.sort()).toEqual(["1.1.1.1", "8.8.8.8"]);

  // Invalidating forces a fresh probe on the next call, and total failure falls back to preset order.
  probed.length = 0;
  behavior = { "1.1.1.1": { ok: false }, "8.8.8.8": { ok: false } };
  selector.invalidate("global");
  expect((await selector.resolve("global")).map((s) => s.server)).toEqual(["1.1.1.1", "8.8.8.8"]);
  expect(probed.sort()).toEqual(["1.1.1.1", "8.8.8.8"]);
});

test("assertKernelConfig blocks inline ech.config, file paths, and dangling resolvers", () => {
  const [first] = inbounds();
  const base = kernelConfig([first!]) as any;

  // Inline ech.config is rejected.
  const badEch = structuredClone(base);
  badEch.outbounds[0].tls = { enabled: true, ech: { enabled: true, config: "deadbeef" } };
  expect(() => assertKernelConfig(badEch)).toThrow();

  // Path properties (*_path) inside outbounds are rejected.
  const badPath = structuredClone(base);
  badPath.outbounds[0].tls = { enabled: true, certificate_path: "/etc/passwd" };
  expect(() => assertKernelConfig(badPath)).toThrow();

  // Dangling domain_resolver is rejected.
  const dangling = structuredClone(base);
  dangling.outbounds[0].domain_resolver = "missing-resolver";
  expect(() => assertKernelConfig(dangling)).toThrow();

  // Hostname server without domain_resolver (or default_domain_resolver) is rejected.
  const unresolvedHost = structuredClone(base);
  delete unresolvedHost.outbounds[0].domain_resolver;
  delete unresolvedHost.route.default_domain_resolver;
  expect(() => assertKernelConfig(unresolvedHost)).toThrow();
});

test("KernelDnsSelector fences stale probes across invalidate() and markFailed promotes backups; probeKernelDohServer handles IPv6", async () => {
  let clock = 1_000;
  let releaseFirst!: () => void;
  let firstCall = true;
  const selector = new KernelDnsSelector({
    now: () => clock,
    probe: async (server) => {
      if (firstCall && server.server === "223.5.5.5") {
        firstCall = false;
        await new Promise<void>((r) => { releaseFirst = r; });
        return false;
      }
      return true;
    },
  });

  const slowResolve = selector.resolve("cn");
  await Promise.resolve();
  selector.invalidate("cn");
  const fastResolve = await selector.resolve("cn");
  expect(fastResolve[0]!.server).toBe("223.5.5.5");
  releaseFirst();
  await slowResolve;
  // Stale Call 1 (where 223.5.5.5 failed) must not overwrite Call 2's healthy cache.
  expect((await selector.resolve("cn"))[0]!.server).toBe("223.5.5.5");

  // markFailed demotes 223.5.5.5 below healthy servers without dropping it permanently.
  selector.markFailed("223.5.5.5", 30_000);
  const afterFailure = await selector.resolve("cn");
  expect(afterFailure[0]!.server).toBe("223.6.6.6");
  expect(afterFailure[afterFailure.length - 1]!.server).toBe("223.5.5.5");

  // Cooldown expiry restores 223.5.5.5 on next fresh probe.
  clock += 31_000;
  selector.invalidate("cn");
  expect((await selector.resolve("cn"))[0]!.server).toBe("223.5.5.5");

  // IPv6 DoH URL uses brackets and validates the DNS response wire header.
  const seenUrls: string[] = [];
  const ok = await probeKernelDohServer(
    { type: "https", server: "2001:4860:4860::8888" },
    (async (url: string) => {
      seenUrls.push(url);
      return new Response(new Uint8Array([0x00, 0x01, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0]), {
        status: 200,
        headers: { "Content-Type": "application/dns-message" },
      });
    }) as unknown as typeof fetch,
  );
  expect(ok).toBe(true);
  expect(seenUrls[0]).toStartWith("https://[2001:4860:4860::8888]/dns-query?dns=");
});

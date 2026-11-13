import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKernelConfig, kernelConfig, type KernelInbound } from "./kernel-config.ts";
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

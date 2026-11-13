import { expect, test } from "bun:test";
import {
  fetchSubscription,
  isInfoEntry,
  parseShareLink,
  parseSubscription,
  parseSubscriptionUserinfo,
  SubscriptionError,
} from "./subscription.ts";

// Every sample here is made up. Real subscriptions are credentials and never go into tests.
const CLASH = `
mixed-port: 7890
proxies:
  - { name: "剩余流量：100 GB", type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x }
  - { name: "套餐到期：2027-01-01", type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: x }
  - name: "🇯🇵 东京 Reality"
    type: vless
    server: jp.node.example
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    network: tcp
    tls: true
    udp: true
    flow: xtls-rprx-vision
    servername: www.apple.com
    client-fingerprint: chrome
    reality-opts: { public-key: PUBKEY_A, short-id: 0123abcd }
  - name: "🇺🇸 洛杉矶 WS"
    type: vless
    server: 203.0.113.20
    port: 8443
    uuid: 11111111-2222-3333-4444-666666666666
    network: ws
    tls: true
    skip-cert-verify: true
    servername: cdn.example
    ws-opts: { path: /ray, headers: { Host: cdn.example } }
  - { name: "HK Hy2", type: hysteria2, server: hk.node.example, port: 30000, password: HY2PASS, sni: hk.node.example, skip-cert-verify: true, obfs: salamander, obfs-password: OBFS, up: "50 Mbps", down: 200 }
  - { name: "SG AnyTLS", type: anytls, server: sg.node.example, port: 443, password: ANYPASS, sni: sg.node.example, client-fingerprint: chrome, idle-session-check-interval: 30, idle-session-timeout: 30, min-idle-session: 0 }
  - { name: "TW Trojan", type: trojan, server: tw.node.example, port: 443, password: TRPASS, sni: tw.node.example }
  - { name: "SS obfs", type: ss, server: 198.51.100.4, port: 8388, cipher: chacha20-ietf-poly1305, password: SSPASS, plugin: obfs, plugin-opts: { mode: http, host: bing.com } }
  - { name: "VMess WS", type: vmess, server: vm.node.example, port: 443, uuid: 11111111-2222-3333-4444-777777777777, alterId: 0, cipher: auto, tls: true, network: ws, ws-opts: { path: /vm } }
  - { name: "TUIC", type: tuic, server: tu.node.example, port: 443, uuid: 11111111-2222-3333-4444-888888888888, password: TUPASS, congestion-controller: bbr, udp-relay-mode: native, alpn: [h3] }
  - { name: "plain socks", type: socks5, server: 198.51.100.9, port: 1080, username: su, password: sp }
  - { name: "DIRECT", type: direct }
  - { name: "REJECT", type: reject }
  - { name: "unknown field", type: trojan, server: x.example, port: 443, password: p, fancy-new-option: true }
  - { name: "chain", type: trojan, server: x.example, port: 443, password: p, dialer-proxy: other }
  - { name: "snell", type: snell, server: x.example, port: 443, psk: p }
  - { name: "🇯🇵 东京 Reality", type: vless, server: jp.node.example, port: 443, uuid: 11111111-2222-3333-4444-555555555555, network: tcp, tls: true, flow: xtls-rprx-vision, servername: www.apple.com, client-fingerprint: chrome, reality-opts: { public-key: PUBKEY_A, short-id: 0123abcd } }
proxy-groups:
  - { name: Proxy, type: select, proxies: [DIRECT] }
rules:
  - MATCH,Proxy
`;

test("Clash YAML: every supported protocol becomes a kernel outbound; non-exits, notices and unknowns do not", () => {
  const parsed = parseSubscription(CLASH);
  expect(parsed.format).toBe("clash");
  expect(parsed.nonNodes).toBe(2);
  expect(parsed.infoEntries).toEqual(["剩余流量：100 GB", "套餐到期：2027-01-01"]);
  expect(parsed.unsupported).toEqual([
    { name: "unknown field", reason: "unknown field fancy-new-option" },
    { name: "chain", reason: "unknown field dialer-proxy" },
    { name: "snell", reason: "protocol snell" },
  ]);
  // The repeated Reality node is kept once.
  expect(parsed.nodes.map((node) => [node.name, node.protocol])).toEqual([
    ["🇯🇵 东京 Reality", "vless"], ["🇺🇸 洛杉矶 WS", "vless"], ["HK Hy2", "hysteria2"], ["SG AnyTLS", "anytls"],
    ["TW Trojan", "trojan"], ["SS obfs", "shadowsocks"], ["VMess WS", "vmess"], ["TUIC", "tuic"], ["plain socks", "socks5"],
  ]);
  const byName = Object.fromEntries(parsed.nodes.map((node) => [node.name, node]));
  expect(byName["🇯🇵 东京 Reality"]!.outbound).toEqual({
    type: "vless", server: "jp.node.example", server_port: 443, uuid: "11111111-2222-3333-4444-555555555555", flow: "xtls-rprx-vision",
    tls: { enabled: true, server_name: "www.apple.com", utls: { enabled: true, fingerprint: "chrome" }, reality: { enabled: true, public_key: "PUBKEY_A", short_id: "0123abcd" } },
  });
  expect(byName["🇯🇵 东京 Reality"]!.regionHint).toBe("JP");
  expect(byName["🇺🇸 洛杉矶 WS"]!.outbound).toMatchObject({
    tls: { enabled: true, server_name: "cdn.example", insecure: true }, transport: { type: "ws", path: "/ray", headers: { Host: "cdn.example" } },
  });
  expect(byName["🇺🇸 洛杉矶 WS"]!.insecureTls).toBe(true);
  expect(byName["HK Hy2"]!.outbound).toEqual({
    type: "hysteria2", server: "hk.node.example", server_port: 30000, password: "HY2PASS", obfs: { type: "salamander", password: "OBFS" },
    up_mbps: 50, down_mbps: 200, tls: { enabled: true, server_name: "hk.node.example", insecure: true },
  });
  expect(byName["SG AnyTLS"]!.outbound).toEqual({
    type: "anytls", server: "sg.node.example", server_port: 443, password: "ANYPASS", idle_session_check_interval: "30s", idle_session_timeout: "30s", min_idle_session: 0,
    tls: { enabled: true, server_name: "sg.node.example", utls: { enabled: true, fingerprint: "chrome" } },
  });
  expect(byName["SS obfs"]!.outbound).toMatchObject({ type: "shadowsocks", method: "chacha20-ietf-poly1305", plugin: "obfs-local", plugin_opts: "obfs=http;obfs-host=bing.com" });
  expect(byName["VMess WS"]!.outbound).toMatchObject({ type: "vmess", alter_id: 0, security: "auto", tls: { enabled: true, server_name: "vm.node.example" }, transport: { type: "ws", path: "/vm" } });
  expect(byName["TUIC"]!.outbound).toMatchObject({ type: "tuic", congestion_control: "bbr", udp_relay_mode: "native", tls: { alpn: ["h3"] } });
  expect(byName["plain socks"]!.outbound).toEqual({ type: "socks5", server: "198.51.100.9", server_port: 1080, username: "su", password: "sp" });
});

const LINKS = [
  "vless://11111111-2222-3333-4444-555555555555@jp.node.example:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.apple.com&fp=chrome&pbk=PUBKEY_A&sid=0123abcd&type=tcp#%F0%9F%87%AF%F0%9F%87%B5%20Tokyo",
  "vless://11111111-2222-3333-4444-666666666666@203.0.113.20:8443?security=tls&sni=cdn.example&allowInsecure=1&type=ws&path=%2Fray&host=cdn.example#LA%20WS",
  "hysteria2://HY2PASS@hk.node.example:30000/?sni=hk.node.example&insecure=1&obfs=salamander&obfs-password=OBFS#HK%20Hy2",
  "hy2://HY2B@hk2.node.example:443?sni=hk2.node.example#HK2",
  "anytls://ANYPASS@sg.node.example:443?sni=sg.node.example&insecure=1#SG%20AnyTLS",
  "trojan://TRPASS@tw.node.example:443?sni=tw.node.example#TW",
  `ss://${Buffer.from("aes-256-gcm:SSPASS").toString("base64url")}@198.51.100.4:8388#SS`,
  `ss://${Buffer.from("aes-128-gcm:LEGACY@198.51.100.5:8389").toString("base64")}#SS%20legacy`,
  `vmess://${Buffer.from(JSON.stringify({ v: "2", ps: "VMess", add: "vm.node.example", port: "443", id: "11111111-2222-3333-4444-777777777777", aid: "0", scy: "auto", net: "ws", type: "none", host: "vm.node.example", path: "/vm", tls: "tls", sni: "vm.node.example" })).toString("base64")}`,
  "tuic://11111111-2222-3333-4444-888888888888:TUPASS@tu.node.example:443?congestion_control=bbr&alpn=h3&sni=tu.node.example#TUIC",
  "vless://u@x.example:443?security=tls&fancy=1#unknown%20param",
  "wireguard://k@x.example:51820#WG",
  "vless://11111111-2222-3333-4444-999999999999@127.0.0.1:1?security=none#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A10GB",
].join("\n");

test("base64 share-link lists parse to the same outbounds as Clash, and keep unknowns out", () => {
  for (const body of [LINKS, Buffer.from(LINKS).toString("base64"), Buffer.from(LINKS).toString("base64url")]) {
    const parsed = parseSubscription(body);
    expect(parsed.format).toBe("uri");
    expect(parsed.nodes.map((node) => node.protocol)).toEqual(["vless", "vless", "hysteria2", "hysteria2", "anytls", "trojan", "shadowsocks", "shadowsocks", "vmess", "tuic"]);
    expect(parsed.unsupported).toEqual([{ name: "unknown param", reason: "unknown parameter fancy" }, { name: "WG", reason: "protocol wireguard" }]);
    expect(parsed.infoEntries).toEqual(["剩余流量：10GB"]);
    const [reality, ws, hy2, , any, , ss, legacy, vmess] = parsed.nodes;
    expect(reality!.name).toBe("🇯🇵 Tokyo");
    expect(reality!.outbound).toEqual({
      type: "vless", server: "jp.node.example", server_port: 443, uuid: "11111111-2222-3333-4444-555555555555", flow: "xtls-rprx-vision",
      tls: { enabled: true, server_name: "www.apple.com", utls: { enabled: true, fingerprint: "chrome" }, reality: { enabled: true, public_key: "PUBKEY_A", short_id: "0123abcd" } },
    });
    expect(ws!.outbound).toMatchObject({ tls: { insecure: true, server_name: "cdn.example" }, transport: { type: "ws", path: "/ray", headers: { Host: "cdn.example" } } });
    expect(hy2!.outbound).toMatchObject({ password: "HY2PASS", obfs: { type: "salamander", password: "OBFS" }, tls: { insecure: true } });
    expect(any!.outbound).toMatchObject({ type: "anytls", password: "ANYPASS", tls: { enabled: true, insecure: true, server_name: "sg.node.example" } });
    expect(ss!.outbound).toMatchObject({ method: "aes-256-gcm", password: "SSPASS", server: "198.51.100.4" });
    expect(legacy!.outbound).toMatchObject({ method: "aes-128-gcm", password: "LEGACY", server: "198.51.100.5", server_port: 8389 });
    expect(vmess!.outbound).toMatchObject({ type: "vmess", transport: { type: "ws", path: "/vm", headers: { Host: "vm.node.example" } }, tls: { enabled: true, server_name: "vm.node.example" } });
  }
});

test("sing-box JSON keeps exits, drops multiplexing and Vela-owned fields, and never takes direct as a node", () => {
  const parsed = parseSubscription(JSON.stringify({ outbounds: [
    { type: "direct", tag: "direct" },
    { type: "block", tag: "block" },
    { type: "selector", tag: "select", outbounds: ["a"] },
    { type: "trojan", tag: "a", server: "a.example", server_port: 443, password: "p", tls: { enabled: true, server_name: "a.example" }, multiplex: { enabled: true }, domain_resolver: "x" },
    { type: "vless", tag: "b", server: "b.example", server_port: 443, uuid: "u", detour: "other" },
  ] }));
  expect(parsed.format).toBe("sing-box");
  expect(parsed.nonNodes).toBe(3);
  expect(parsed.nodes.map((node) => node.outbound)).toEqual([
    { type: "trojan", server: "a.example", server_port: 443, password: "p", tls: { enabled: true, server_name: "a.example" } },
  ]);
  expect(parsed.unsupported).toEqual([{ name: "b", reason: "unknown field detour" }]);
});

test("provider notices are recognised by address or by name", () => {
  expect(isInfoEntry("HK 01", "127.0.0.1", 443)).toBe(true);
  expect(isInfoEntry("HK 01", "hk.example", 1)).toBe(true);
  for (const name of ["剩余流量：50G", "距离下次重置剩余：3 天", "套餐到期：2027-01-01", "官网 example.com", "Traffic: 10GB", "Expire: 2027"]) {
    expect(isInfoEntry(name, "hk.example", 443)).toBe(true);
  }
  expect(isInfoEntry("🇭🇰 香港 01", "hk.example", 443)).toBe(false);
});

test("subscription-userinfo gives usage and expiry; a missing or broken header gives nothing", () => {
  expect(parseSubscriptionUserinfo("upload=1024; download=2048; total=10737418240; expire=1798000000")).toEqual({
    uploadBytes: 1024, downloadBytes: 2048, totalBytes: 10737418240, expireAt: 1798000000,
  });
  expect(parseSubscriptionUserinfo("upload=1; expire=0")).toEqual({ uploadBytes: 1 });
  expect(parseSubscriptionUserinfo("garbage")).toBeUndefined();
  expect(parseSubscriptionUserinfo(null)).toBeUndefined();
});

test("an unrecognised body is an error, not an empty pool", () => {
  for (const body of ["", "hello world", "{not json", "proxies: [unclosed"]) {
    expect(() => parseSubscription(body)).toThrow(SubscriptionError);
  }
  expect(parseShareLink("not a link")).toBeNull();
});

function fakeServer(routes: Record<string, (agent: string) => Response>) {
  const calls: Array<{ url: string; agent: string }> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const agent = new Headers(init?.headers).get("user-agent") ?? "";
    calls.push({ url, agent });
    const route = routes[url];
    return route ? route(agent) : new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("fetching asks for Clash first and falls back to the share-link format", async () => {
  const { fetchFn, calls } = fakeServer({
    "https://sub.example/a": (agent) => agent.startsWith("clash")
      ? new Response("<html>login</html>", { headers: { "subscription-userinfo": "upload=1; download=2; total=3" } })
      : new Response(Buffer.from(LINKS).toString("base64"), { headers: { "subscription-userinfo": "upload=5; download=6; total=70; expire=1798000000" } }),
  });
  const result = await fetchSubscription("https://sub.example/a", { fetchFn });
  expect(calls.map((call) => call.agent)).toEqual(["clash.meta", "v2rayN/7.0"]);
  expect(result.userAgent).toBe("v2rayN/7.0");
  expect(result.parsed.nodes.length).toBe(10);
  expect(result.usage).toEqual({ uploadBytes: 5, downloadBytes: 6, totalBytes: 70, expireAt: 1798000000 });
});

test("fetching refuses plain http, follows at most three redirects, and caps the size", async () => {
  await expect(fetchSubscription("http://sub.example/a")).rejects.toThrow("must use https");
  const loop = fakeServer(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`https://sub.example/${i}`, () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } })])));
  await expect(fetchSubscription("https://sub.example/0", { fetchFn: loop.fetchFn, userAgent: "clash.meta" })).rejects.toThrow("too many times");
  const downgrade = fakeServer({ "https://sub.example/x": () => new Response(null, { status: 302, headers: { location: "http://sub.example/y" } }) });
  await expect(fetchSubscription("https://sub.example/x", { fetchFn: downgrade.fetchFn, userAgent: "clash.meta" })).rejects.toThrow("insecure address");
  const big = fakeServer({ "https://sub.example/big": () => new Response("x".repeat(6 * 1024 * 1024)) });
  await expect(fetchSubscription("https://sub.example/big", { fetchFn: big.fetchFn, userAgent: "clash.meta" })).rejects.toThrow("too large");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { echoAddress, isLocalHost, parseAnswer, pickPhysicalInterface, resolveDirect, setTunBypass, upstreamDial } from "./egress-binding.ts";
import { assertKernelConfig, kernelConfig } from "./kernel-config.ts";

test("the physical adapter is chosen over TUN, VPN and virtual adapters, and never a fake-ip address", () => {
  expect(pickPhysicalInterface([
    { name: "Meta", address: "198.18.0.1", description: "Meta Tunnel" },
    { name: "以太网 2", address: "10.0.0.5", description: "Wintun Userspace Tunnel" },
    { name: "vEthernet (WSL)", address: "172.20.0.1", description: "Hyper-V Virtual Ethernet Adapter" },
    { name: "WLAN", address: "192.168.0.184", description: "Intel(R) Wi-Fi 6 AX201" },
  ])).toEqual({ name: "WLAN", address: "192.168.0.184", description: "Intel(R) Wi-Fi 6 AX201" });
  expect(pickPhysicalInterface([{ name: "utun3", address: "10.8.0.2" }])).toBeNull();
});

test("a DNS answer's addresses are read, and fake-ip answers are refused", async () => {
  // Header: 1 question, 2 answers; question example.com A IN; answers with compressed names.
  const question = Buffer.from([7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0, 0, 1, 0, 1]);
  const answer = (ip: number[]) => Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...ip]);
  const message = Buffer.concat([Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]), question, answer([93, 184, 216, 34]), answer([198, 18, 0, 7])]);
  expect(parseAnswer(message)).toEqual(["93.184.216.34", "198.18.0.7"]);
  const asked: string[] = [];
  const address = await resolveDirect("proxy.example", "192.168.0.2", async (server, name) => { asked.push(server); return server === "223.5.5.5" ? ["198.18.0.9"] : ["203.0.113.7"]; });
  expect(address).toBe("203.0.113.7");
  expect(asked[0]).toBe("223.5.5.5");
});

test("echo answers are read from JSON or plain text", () => {
  expect(echoAddress('{"ip":"203.0.113.9","country":"JP"}')).toBe("203.0.113.9");
  expect(echoAddress("203.0.113.9\n")).toBe("203.0.113.9");
  expect(echoAddress("<html>not an address</html>")).toBeUndefined();
});

test("loopback and local-network proxies, and a bypass that is off, are dialled the usual way", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "10.1.2.3", "172.16.0.1", "192.168.1.1"]) expect(isLocalHost(host)).toBe(true);
  for (const host of ["8.8.8.8", "proxy.example.com", "172.32.0.1"]) expect(isLocalHost(host)).toBe(false);
  setTunBypass(false);
  expect(upstreamDial("proxy.example.com")).toEqual({});
  setTunBypass(true);
  expect(upstreamDial("127.0.0.1")).toEqual({});
  setTunBypass(false);
});

test("the kernel binds every dial to the adapter only when asked, and nothing else may", () => {
  const inbound = { tag: "a", port: 1080, username: "u", password: "p", outbound: { type: "vless", server: "203.0.113.5", server_port: 443, uuid: "00000000-0000-0000-0000-000000000000" } } as any;
  const plain = kernelConfig([inbound]) as any;
  expect(plain.route.default_interface).toBeUndefined();
  const bound = kernelConfig([inbound], { defaultInterface: "WLAN" }) as any;
  expect(bound.route.default_interface).toBe("WLAN");
  expect(() => assertKernelConfig({ ...bound, route: { ...bound.route, default_interface: "" } })).toThrow("adapter name");
});

test("the bypass module resolves names only with encrypted DNS, never with this computer's resolver", () => {
  const source = readFileSync(join(import.meta.dir, "egress-binding.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/\s.*$/gm, "$1");
  expect(source).not.toMatch(/\bnode:dns\b|\bdns\s*\.\s*(lookup|resolve)|\bBun\.dns\b|\bgetaddrinfo\b/);
});

test("default routes are read from route print, best metric first", async () => {
  const { parseDefaultRoutes } = await import("./egress-binding.ts");
  const text = [
    "IPv4 路由表", "===", "活动路由:", "网络目标        网络掩码          网关       接口   跃点数",
    "          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.184     30",
    "          0.0.0.0          0.0.0.0       198.18.0.2       198.18.0.1      0",
    "        127.0.0.0        255.0.0.0            在链路上         127.0.0.1    331",
  ].join("\r\n");
  expect(parseDefaultRoutes(text)).toEqual([
    { gateway: "198.18.0.2", address: "198.18.0.1", metric: 0 },
    { gateway: "192.168.0.1", address: "192.168.0.184", metric: 30 },
  ]);
});

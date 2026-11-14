import { expect, test } from "bun:test";
import { detectFakeIpResolver, resetNetworkEnvironmentCache } from "./network-environment.ts";

test("a resolver that answers every name with a fake-ip address is a TUN proxy client", async () => {
  resetNetworkEnvironmentCache();
  expect(await detectFakeIpResolver(async () => ["198.18.3.4", "2001:2::1"])).toBe(true);
  resetNetworkEnvironmentCache();
  expect(await detectFakeIpResolver(async (host) => host === "example.com" ? ["198.18.0.9"] : ["93.184.215.14"])).toBe(false);
  resetNetworkEnvironmentCache();
  expect(await detectFakeIpResolver(async () => { throw new Error("offline"); })).toBe(false);
});

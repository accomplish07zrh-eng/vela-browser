import { lookup } from "node:dns/promises";
import { isFakeIpAddress } from "./subscription.ts";

/** Well-known names whose real addresses are never in the benchmark ranges. */
const PROBES = ["example.com", "www.gstatic.com", "cloudflare.com"];
const CACHE_MS = 60_000;
let cached: { at: number; value: boolean } | null = null;

/**
 * True when this computer's resolver answers ordinary names with fake-ip addresses: a proxy client
 * (Clash, mihomo, sing-box) is running in TUN fake-ip mode and carries all traffic, Vela Browser's
 * included. Every probe must agree, so one odd answer is not taken for it.
 */
export async function detectFakeIpResolver(
  resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
  now: () => number = Date.now,
): Promise<boolean> {
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const answers = await Promise.all(PROBES.map((host) => resolve(host).catch(() => [] as string[])));
  const resolved = answers.filter((addresses) => addresses.length > 0);
  const value = resolved.length > 0 && resolved.every((addresses) => addresses.every((address) => isFakeIpAddress(address)));
  cached = { at: now(), value };
  return value;
}

/** Tests only. */
export function resetNetworkEnvironmentCache(): void { cached = null; }

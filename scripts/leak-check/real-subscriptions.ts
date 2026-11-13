/**
 * Real-subscription acceptance (design §8.3). Run it yourself, with your links only in this
 * shell's environment:
 *
 *   $env:VELA_SUB_1 = "https://…"; $env:VELA_SUB_2 = "https://…"; $env:VELA_SUB_3 = "https://…"
 *   bun scripts/leak-check/real-subscriptions.ts
 *
 * It fetches each subscription, parses it, and checks a few nodes of every protocol through the
 * real proxy kernel. What it prints is safe to share: counts, protocols, reasons, check results
 * and exit countries. It never prints or stores a link, a node name, a server address or a
 * credential. Optional: VELA_SINGBOX_ZIP (a local copy of the pinned kernel archive; otherwise it
 * is downloaded from the sing-box release and checked against its pinned hash),
 * VELA_SUB_CHECKS_PER_PROTOCOL (default 3).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDirectEgress } from "../../src/egress.ts";
import { ensureKernel, KernelSupervisor } from "../../src/kernel.ts";
import { checkProxy } from "../../src/proxy-check.ts";
import { fetchSubscription, type ParsedNode } from "../../src/subscription.ts";

const links = [1, 2, 3, 4, 5].map((i) => process.env[`VELA_SUB_${i}`]?.trim()).filter((link): link is string => !!link);
if (!links.length) {
  console.error("Set VELA_SUB_1 (and VELA_SUB_2, VELA_SUB_3) to your subscription links in this shell first.");
  process.exit(2);
}
const perProtocol = Number(process.env.VELA_SUB_CHECKS_PER_PROTOCOL ?? 3);
const root = mkdtempSync(join(tmpdir(), "vela-real-subs-"));
const zip = process.env.VELA_SINGBOX_ZIP?.trim();

const count = <T extends string>(values: T[]) => values.reduce<Record<string, number>>((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});

try {
  const kernel = await ensureKernel(join(root, "runtimes"), zip ? { fetch: (async () => new Response(readFileSync(zip) as unknown as BodyInit)) as never } : {});
  const kernels = new KernelSupervisor({ binary: async () => kernel, workDir: join(root, "kernels") });
  const direct = await fetchDirectEgress().catch(() => null);
  for (const [index, link] of links.entries()) {
    const label = `subscription ${index + 1}`;
    try {
      const fetched = await fetchSubscription(link);
      const parsed = fetched.parsed;
      const summary: Record<string, unknown> = {
        format: parsed.format,
        fetchedAs: fetched.userAgent,
        nodes: parsed.nodes.length,
        byProtocol: count(parsed.nodes.map((node) => node.protocol)),
        insecureTls: parsed.nodes.filter((node) => node.insecureTls).length,
        nonNodes: parsed.nonNodes,
        providerNotices: parsed.infoEntries.length,
        unsupported: count(parsed.unsupported.map((row) => row.reason)),
        usageHeader: fetched.usage ? Object.keys(fetched.usage).sort() : "absent",
      };
      // A few nodes of each protocol, through one temporary kernel.
      const byProtocol = new Map<string, ParsedNode[]>();
      for (const node of parsed.nodes) byProtocol.set(node.protocol, [...(byProtocol.get(node.protocol) ?? []), node]);
      const sample = [...byProtocol.values()].flatMap((nodes) => nodes.slice(0, perProtocol));
      const kernelNodes = sample.filter((node) => !["http", "https", "socks5"].includes(node.protocol));
      const temporary = kernelNodes.length
        ? await kernels.startTemporary(kernelNodes.map((node, i) => ({ tag: `n${i}`, outbound: node.outbound })))
        : undefined;
      try {
        const checks: Array<Record<string, unknown>> = [];
        await Promise.all(kernelNodes.map(async (node, i) => {
          const result = await checkProxy(temporary!.specs.get(`n${i}`)!, { direct }).catch(() => null);
          checks.push({
            protocol: node.protocol,
            status: result?.status ?? "error",
            ...(result?.reason ? { reason: result.reason } : {}),
            ...(result?.country ? { exitCountry: result.country } : {}),
            ...(node.regionHint ? { nameSays: node.regionHint } : {}),
          });
        }));
        summary.checks = checks.sort((a, b) => String(a.protocol).localeCompare(String(b.protocol)));
      } finally {
        temporary?.process.stop();
      }
      console.log(`${label}: ${JSON.stringify(summary)}`);
    } catch (error) {
      // The message comes from Vela's own fetcher and carries no link.
      console.log(`${label}: failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

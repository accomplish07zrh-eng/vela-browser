/** Uses an isolated Chromium profile and a deterministic local forward proxy. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { aliasmodeChromiumArchive, aliasmodeChromiumExecutable } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { buildNewProfile } from "../src/create.ts";
import { Launcher } from "../src/launcher.ts";
import { LifecycleAdmissionController } from "../src/lifecycle-admission.ts";
import { NetworkIdentity } from "../src/network-identity.ts";
import { ProfileWrites } from "../src/profile-writes.ts";
import { ProfileStore } from "../src/store.ts";

const executable = aliasmodeChromiumExecutable(join(resolve(process.argv[2] ?? "."), "reports/runtimes/chromium"));
assert.equal(await sha256File(executable), aliasmodeChromiumArchive(process.platform).executableSha256);
mkdirSync("reports", { recursive: true });
const reports = realpathSync("reports"), root = mkdtempSync(join(reports, "vela-network-qa-"));
let exit = { ip: "203.0.113.12", timezone: "America/New_York" };
let requests = 0, online = true;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  if (!new URL(req.url).pathname.endsWith("/vela-egress")) return new Response("fixture", { status: 404 });
  requests++;
  return online ? Response.json(exit, { headers: { "cache-control": "no-store" } }) : new Response("upstream unavailable", { status: 503 });
} });
const endpoints = process.env.ALIASMODE_EGRESS_ENDPOINTS;
process.env.ALIASMODE_EGRESS_ENDPOINTS = "http://vela-qa.invalid/vela-egress";
const store = new ProfileStore(":memory:");
const launcher = new Launcher({ store, dataRoot: join(root, "profiles"), headless: true,
  portRange: { start: 13100, end: 13149 },
  ensureAliasmodeChromium: async () => executable,
  lookupExitLocation: async () => online ? exit : null,
  log(line) { if (line.includes("rejected") || line.includes("proxy")) console.log(line); },
});
const profile = buildNewProfile({ chromiumRuntime: "aliasmode", name: "Network QA",
  proxy: { type: "http", host: "127.0.0.1", port: String(proxy.port) } }, () => false);
store.upsertProfile(profile);
const identity = new NetworkIdentity({ store, launcher, writes: new ProfileWrites(), admission: new LifecycleAdmissionController() });
try {
  await launcher.start(profile.id);
  const original = await identity.check(profile.id, false);
  assert.equal(original.egress?.ip, exit.ip, JSON.stringify(original));
  assert.equal(original.browserTimezone, exit.timezone);
  exit = { ip: "2001:db8::12", timezone: "Asia/Taipei" };
  const drift = await identity.check(profile.id, false);
  assert.ok(drift.differences.includes("egress_ip") && drift.differences.includes("timezone"));
  const refreshed = await identity.check(profile.id, true);
  assert.equal(refreshed.refreshed, true);
  assert.equal(refreshed.egress?.ip, exit.ip);
  assert.equal(refreshed.browserTimezone, exit.timezone);
  assert.equal(refreshed.differences.includes("egress_ip"), false);
  online = false;
  const unavailable = await identity.check(profile.id, true);
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.refreshed, false);
  assert.ok(requests >= 5);
  console.log("Verified controlled IPv4 to IPv6 proxy egress change, timezone refresh, and failed upstream in a real browser.");
} catch (error) {
  console.error("Network identity acceptance failed", error, { requests });
  process.exitCode = 1;
} finally {
  const stopped = await launcher.stop(profile.id);
  await launcher.cacheCleanupSettled(profile.id);
  await proxy.stop(true);
  store.close();
  if (endpoints === undefined) delete process.env.ALIASMODE_EGRESS_ENDPOINTS;
  else process.env.ALIASMODE_EGRESS_ENDPOINTS = endpoints;
  const path = realpathSync(root);
  if (stopped && path === root && dirname(path) === reports && basename(path).startsWith("vela-network-qa-")) {
    try { await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); }
    catch (error) { console.error("Could not clean the network fixture", error); process.exitCode = 1; }
  }
}

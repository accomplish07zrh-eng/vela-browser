import { diagnoseOverCDP } from "./diagnose.ts";
import { isNonPublicIp, sameIp } from "./ip.ts";
import { launchedProfile, type Launcher } from "./launcher.ts";
import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import type { ProfileWrites } from "./profile-writes.ts";
import type { ProfileStore } from "./store.ts";
import { workbenchGeneration } from "./workbench.ts";

type Evidence = Awaited<ReturnType<typeof diagnoseOverCDP>>;

export function compareNetworkIdentity(result: Evidence, expected: { ip?: string; timezone?: string }, proxied: boolean, timezoneManual: boolean) {
  const differences: string[] = [];
  const actual = result.egress;
  if (actual?.ip && expected.ip && !sameIp(actual.ip, expected.ip)) differences.push("egress_ip");
  if (proxied && !timezoneManual && actual?.timezone && result.fingerprint?.timezone && result.fingerprint.timezone !== actual.timezone) {
    differences.push("timezone");
  }
  const candidates = [...new Set(result.webrtcIps ?? [])].filter(ip => !isNonPublicIp(ip));
  if (proxied && actual?.ip && candidates.some(ip => !sameIp(ip, actual.ip))) differences.push("webrtc");
  return { state: !actual ? "unavailable" : differences.length ? "changed" : "observed",
    differences, expected, egress: actual, browserTimezone: result.fingerprint?.timezone, publicWebRtc: candidates };
}

export class NetworkIdentity {
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private next = 0;
  private automaticRefreshes = new Map<string, string>();

  constructor(private readonly options: {
    launcher: Launcher; store: ProfileStore; writes: ProfileWrites; admission: LifecycleAdmissionController;
    diagnostic?: typeof diagnoseOverCDP;
    log?: (text: string) => void;
  }) {}

  private async sample(profileId: string) {
    const { launcher, store } = this.options;
    const profile = store.getProfile(profileId), launch = store.getLaunch(profileId);
    if (!profile || !launch || !await launcher.certifiedActive(profileId)) throw new Error("Open the profile before checking its network identity");
    const generation = workbenchGeneration(launch), current = launchedProfile(profile, launch);
    const measured = await (this.options.diagnostic ?? diagnoseOverCDP)(launch.ws, current, {
      timeoutMs: 3500, collectLogin: false, networkOnly: true,
    });
    const latest = store.getLaunch(profileId);
    if (!latest || workbenchGeneration(latest) !== generation) throw new Error("The browser changed during its network identity check");
    const expected = { ip: launch.egressAtLaunch?.ip, timezone: current.timezone };
    return { launch, report: compareNetworkIdentity(measured, expected, !!current.proxy, current.timezoneManual === true) };
  }

  check(profileId: string, refresh: boolean, signal?: AbortSignal) {
    return this.options.writes.run(profileId, () => this.checkWhileHeld(profileId, refresh), signal);
  }

  private async checkWhileHeld(profileId: string, refresh: boolean, automatic = false) {
    const { launcher, admission } = this.options;
    const { launch, report } = await this.sample(profileId);
    if (report.state === "observed") this.automaticRefreshes.delete(profileId);
    if (!refresh || report.state !== "changed") return { profileId, ...report, refreshed: false };
    const signature = JSON.stringify([report.egress?.ip, report.egress?.timezone, report.differences]);
    if (automatic && this.automaticRefreshes.get(profileId) === signature) return { profileId, ...report, refreshed: false };
    const certain = await this.sample(profileId);
    if (workbenchGeneration(launch) !== workbenchGeneration(certain.launch) || certain.report.state !== "changed"
      || !report.egress || !certain.report.egress || !sameIp(report.egress.ip, certain.report.egress.ip)
      || report.egress.timezone !== certain.report.egress.timezone) {
      return { profileId, ...certain.report, refreshed: false };
    }
    if (automatic) this.automaticRefreshes.set(profileId, signature);
    await admission.run({ kind: "start", profileIds: [profileId] }, async () => {
      await launcher.captureLocalSession(profileId);
      if (!await launcher.stopForStateTransfer(profileId, launch)) throw new Error("Could not close the old profile generation");
      await launcher.start(profileId, [], { headless: launch.headless });
    });
    const { report: after } = await this.sample(profileId);
    return { profileId, ...after, refreshed: true };
  }

  start(intervalMs: number, refresh: boolean) {
    if (this.timer || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2 ** 31 - 1) return;
    this.timer = setInterval(() => {
      if (this.checking) return;
      const proxied = this.options.store.listLaunches().filter(launch => this.options.store.getProfile(launch.profileId)?.proxy);
      const live = new Set(proxied.map(launch => launch.profileId));
      for (const id of this.automaticRefreshes.keys()) if (!live.has(id)) this.automaticRefreshes.delete(id);
      if (!proxied.length) return;
      const profileId = proxied[this.next++ % proxied.length]!.profileId;
      const lease = this.options.writes.tryAcquire(profileId);
      if (!lease) return;
      this.checking = true;
      void this.checkWhileHeld(profileId, refresh, true).then(result => {
        if (result.state === "changed" || result.refreshed) this.options.log?.(`Network identity ${profileId} ${result.state} ${result.differences.join(",")} ${result.refreshed ? "after reconnect" : ""}`);
      }).catch(error => this.options.log?.(`Network identity ${profileId}: ${error.message}`)).finally(() => {
        this.checking = false;
        lease.release();
      });
    }, intervalMs).unref();
  }

  stop() { clearInterval(this.timer); this.timer = undefined; }
}

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalIp } from "./ip.ts";

/**
 * An IP's quality, judged by the free IP-intelligence services that answer without an account:
 * whether it is a datacenter address, known as a proxy, VPN or Tor exit, flagged for abuse, how
 * risky the services rate it, and whether they agree on where it is. Each service's own verdict
 * is kept, so the score can be checked against them. Only the IP is sent to these services.
 */
export type IpFlag = "proxy" | "vpn" | "tor" | "hosting" | "abuser" | "anonymous" | "mobile";
export interface SourceVerdict {
  id: string;
  name: string;
  ok: boolean;
  country?: string;
  timezone?: string;
  isp?: string;
  /** The kind of network the service says the IP is on: isp, hosting, business, … */
  network?: string;
  flags: IpFlag[];
  /** The service's own risk rating, 0 to 100. */
  risk?: number;
}
export interface IpFinding { id: string; severity: "high" | "medium" | "low" | "good"; message: string; params?: Record<string, string | number> }
export interface IpScore {
  ip: string;
  score: number;
  grade: "clean" | "good" | "fair" | "poor";
  /** A home or business line, a mobile network, or a datacenter. */
  kind: "residential" | "mobile" | "hosting" | "unknown";
  country?: string;
  timezone?: string;
  isp?: string;
  findings: IpFinding[];
  sources: SourceVerdict[];
  answered: number;
  checkedAt: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Source { id: string; name: string; url(ip: string): string; parse(body: any, ip: string): Omit<SourceVerdict, "id" | "name" | "ok"> }

const code = (value: unknown) => typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : undefined;
const zone = (value: unknown) => typeof value === "string" && /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(value.trim()) ? value.trim() : undefined;
const flagsOf = (entries: Array<[IpFlag, unknown]>): IpFlag[] => entries.filter(([, value]) => value === true || value === "yes").map(([flag]) => flag);

export const IP_SOURCES: Source[] = [
  { id: "proxycheck", name: "proxycheck.io", url: (ip) => `https://proxycheck.io/v2/${ip}?vpn=1&asn=1&risk=1`, parse: (body, ip) => {
    const entry = body?.[ip] ?? {};
    const type = text(entry.type)?.toLowerCase();
    return {
      country: code(entry.isocode), timezone: zone(entry.timezone), isp: text(entry.provider), network: type,
      flags: flagsOf([["proxy", entry.proxy === "yes" && type !== "vpn" && type !== "tor"], ["vpn", type === "vpn"], ["tor", type === "tor"], ["hosting", type === "hosting"]]),
      ...(typeof entry.risk === "number" ? { risk: entry.risk } : {}),
    };
  } },
  { id: "ip-api", name: "ip-api.com", url: (ip) => `http://ip-api.com/json/${ip}?fields=status,countryCode,timezone,isp,mobile,proxy,hosting`, parse: (body) => ({
    country: code(body.countryCode), timezone: zone(body.timezone), isp: text(body.isp),
    flags: flagsOf([["proxy", body.proxy], ["hosting", body.hosting], ["mobile", body.mobile]]),
  }) },
  { id: "ipquery", name: "ipquery.io", url: (ip) => `https://api.ipquery.io/${ip}`, parse: (body) => ({
    country: code(body.location?.country_code), timezone: zone(body.location?.timezone), isp: text(body.isp?.isp ?? body.isp?.org),
    flags: flagsOf([["proxy", body.risk?.is_proxy], ["vpn", body.risk?.is_vpn], ["tor", body.risk?.is_tor], ["hosting", body.risk?.is_datacenter], ["mobile", body.risk?.is_mobile]]),
    ...(typeof body.risk?.risk_score === "number" ? { risk: body.risk.risk_score } : {}),
  }) },
  { id: "iplocate", name: "iplocate.io", url: (ip) => `https://www.iplocate.io/api/lookup/${ip}`, parse: (body) => ({
    country: code(body.country_code), timezone: zone(body.time_zone), isp: text(body.asn?.name ?? body.company?.name), network: text(body.asn?.type)?.toLowerCase(),
    flags: flagsOf([["proxy", body.privacy?.is_proxy], ["vpn", body.privacy?.is_vpn], ["tor", body.privacy?.is_tor], ["hosting", body.privacy?.is_hosting], ["abuser", body.privacy?.is_abuser], ["anonymous", body.privacy?.is_anonymous]]),
  }) },
  { id: "ip2location", name: "ip2location.io", url: (ip) => `https://api.ip2location.io/?ip=${ip}`, parse: (body) => ({
    country: code(body.country_code), isp: text(body.as), flags: flagsOf([["proxy", body.is_proxy]]),
  }) },
  { id: "ipapi-is", name: "ipapi.is", url: (ip) => `https://api.ipapi.is/?q=${ip}`, parse: (body) => ({
    timezone: zone(body.timezone), isp: text(typeof body.company === "object" ? body.company?.name : body.company),
    flags: flagsOf([["proxy", body.is_proxy], ["vpn", body.is_vpn], ["tor", body.is_tor], ["hosting", body.is_datacenter], ["abuser", body.is_abuser], ["mobile", body.is_mobile]]),
  }) },
  { id: "ipinfo", name: "ipinfo.io", url: (ip) => `https://ipinfo.io/${ip}/json`, parse: (body) => ({ country: code(body.country), timezone: zone(body.timezone), isp: text(body.org), flags: [] }) },
  { id: "ipwhois", name: "ipwho.is", url: (ip) => `https://ipwho.is/${ip}`, parse: (body) => ({ country: code(body.country_code), timezone: zone(body.timezone?.id), isp: text(body.connection?.isp), flags: [] }) },
  { id: "ipsb", name: "ip.sb", url: (ip) => `https://api.ip.sb/geoip/${ip}`, parse: (body) => ({ country: code(body.country_code), timezone: zone(body.timezone), isp: text(body.isp), flags: [] }) },
  { id: "dbip", name: "db-ip.com", url: (ip) => `https://api.db-ip.com/v2/free/${ip}`, parse: (body) => ({ country: code(body.countryCode), flags: [] }) },
  { id: "geojs", name: "geojs.io", url: (ip) => `https://get.geojs.io/v1/ip/geo/${ip}.json`, parse: (body) => ({ country: code(body.country_code), timezone: zone(body.timezone), isp: text(body.organization_name), flags: [] }) },
  { id: "ipapi-co", name: "ipapi.co", url: (ip) => `https://ipapi.co/${ip}/json/`, parse: (body) => ({ country: code(body.country_code), timezone: zone(body.timezone), isp: text(body.org), flags: [] }) },
];

/** The UTC offset of a timezone now, to compare zones that differ in name only. */
function offset(timezone: string, at: number): string | undefined {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value; }
  catch { return undefined; }
}
function most(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The composite score from the services' verdicts. */
export function scoreVerdicts(ip: string, sources: SourceVerdict[], now = Date.now()): IpScore {
  const answered = sources.filter((source) => source.ok);
  const voters = (flag: IpFlag) => answered.filter((source) => source.flags.includes(flag) || (flag === "hosting" && source.network === "hosting"));
  const hosting = voters("hosting"), tor = voters("tor"), abuser = voters("abuser"), mobile = voters("mobile");
  const masked = answered.filter((source) => source.flags.some((flag) => flag === "proxy" || flag === "vpn" || flag === "anonymous"));
  const risks = answered.flatMap((source) => source.risk === undefined ? [] : [{ name: source.name, risk: source.risk }]).sort((a, b) => b.risk - a.risk);
  const highest = risks[0];
  // Only a country most services agree on counts; one outlier database is noted, two or more cost points.
  const countryVotes = answered.flatMap((source) => source.country ? [source.country] : []);
  const majority = most(countryVotes);
  const outliers = [...new Set(countryVotes.filter((country) => country !== majority))];
  const offsets = [...new Set(answered.flatMap((source) => source.timezone ? [offset(source.timezone, now)] : []).filter(Boolean))];
  const names = (list: SourceVerdict[]) => list.map((source) => source.name).join(", ");
  const findings: IpFinding[] = [];
  let score = 100;
  if (tor.length) { score -= 60; findings.push({ id: "tor", severity: "high", message: "A Tor exit, according to {sources}", params: { sources: names(tor) } }); }
  if (masked.length) {
    score -= masked.length >= 3 ? 35 : masked.length === 2 ? 25 : 15;
    findings.push({ id: "proxy", severity: masked.length >= 2 ? "high" : "medium", message: "Known as a proxy or VPN by {count} of {total} services: {sources}", params: { count: masked.length, total: answered.length, sources: names(masked) } });
  }
  if (hosting.length) {
    score -= hosting.length >= 2 ? 30 : 20;
    findings.push({ id: "hosting", severity: hosting.length >= 2 ? "high" : "medium", message: "A datacenter address, according to {sources}: sites that check this treat it as automated traffic", params: { sources: names(hosting) } });
  }
  if (abuser.length) { score -= 20; findings.push({ id: "abuser", severity: "high", message: "Reported for abuse, according to {sources}", params: { sources: names(abuser) } }); }
  if (highest && highest.risk > 0) {
    score -= Math.round(highest.risk / 4);
    findings.push({ id: "risk", severity: highest.risk >= 60 ? "high" : highest.risk >= 30 ? "medium" : "low", message: "Risk rating {risk} out of 100 from {source}", params: { risk: highest.risk, source: highest.name } });
  }
  const disagreeing = countryVotes.filter((country) => country !== majority).length;
  if (disagreeing >= 2) { score -= 10; findings.push({ id: "country", severity: "medium", message: "The services place it in different countries: {countries}", params: { countries: [majority, ...outliers].join(", ") } }); }
  else if (disagreeing === 1) findings.push({ id: "country-outlier", severity: "low", message: "One service places it in {country} instead of {majority}", params: { country: outliers[0]!, majority: majority! } });
  if (offsets.length > 1) { score -= 5; findings.push({ id: "timezone", severity: "low", message: "The services give it different timezones" }); }
  if (mobile.length && !hosting.length) findings.push({ id: "mobile", severity: "good", message: "A mobile network address, which many people share and sites rarely block" });
  if (!masked.length && !hosting.length && !tor.length && !abuser.length && answered.length >= 3) findings.push({ id: "clean", severity: "good", message: "No service lists it as a proxy, VPN, Tor exit or datacenter" });
  if (answered.length < 3) findings.push({ id: "few", severity: "low", message: "Only {count} services answered, so the score is less certain", params: { count: answered.length } });
  score = Math.max(0, Math.min(100, score));
  return {
    ip, score, grade: score >= 85 ? "clean" : score >= 70 ? "good" : score >= 50 ? "fair" : "poor",
    kind: !answered.length ? "unknown" : hosting.length ? "hosting" : mobile.length ? "mobile" : "residential",
    ...(majority ? { country: majority } : {}),
    ...(most(answered.flatMap((source) => source.timezone ? [source.timezone] : [])) ? { timezone: most(answered.flatMap((source) => source.timezone ? [source.timezone] : [])) } : {}),
    ...(most(answered.flatMap((source) => source.isp ? [source.isp] : [])) ? { isp: most(answered.flatMap((source) => source.isp ? [source.isp] : [])) } : {}),
    findings, sources, answered: answered.length, checkedAt: now,
  };
}

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|198\.1[89]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** Asks every service at once, each with its own time limit, and scores what came back. */
export async function scoreIp(ip: string, fetchFn: Fetch = fetch, now = Date.now()): Promise<IpScore> {
  const address = canonicalIp(ip);
  if (!address) throw new Error("Not an IP address");
  if (PRIVATE.test(address) || address === "::1" || /^f[cd]/i.test(address)) throw new Error("A private or local address has no public reputation");
  const sources = await Promise.all(IP_SOURCES.map(async (source): Promise<SourceVerdict> => {
    const failed: SourceVerdict = { id: source.id, name: source.name, ok: false, flags: [] };
    try {
      const response = await fetchFn(source.url(address), { signal: AbortSignal.timeout(8000), headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } });
      if (!response.ok) return failed;
      const body = await response.json();
      if (!body || body.status === "fail" || body.success === false || body.status === "error" || body.status === "denied" || body.error) return failed;
      return { id: source.id, name: source.name, ok: true, ...source.parse(body, address) };
    } catch { return failed; }
  }));
  return scoreVerdicts(address, sources, now);
}

/** Scores kept for half a day per IP in ip-scores.json, so lookups stay within the services' free limits. */
export class IpScoreCache {
  private data: Record<string, IpScore> = {};
  private pending = new Map<string, Promise<IpScore>>();
  constructor(private readonly path?: string, private readonly fetchFn: Fetch = fetch, private readonly now: () => number = Date.now) {
    if (path && existsSync(path)) { try { this.data = JSON.parse(readFileSync(path, "utf8")); } catch { this.data = {}; } }
  }
  get(ip: string): IpScore | undefined {
    const entry = this.data[ip];
    return entry && this.now() - entry.checkedAt < 12 * 3600_000 ? entry : undefined;
  }
  async score(ip: string, fresh = false): Promise<IpScore> {
    const cached = fresh ? undefined : this.get(ip);
    if (cached) return cached;
    let pending = this.pending.get(ip);
    if (!pending) {
      pending = scoreIp(ip, this.fetchFn, this.now()).then((result) => {
        // A lookup that most services failed is not kept: the next one may get through.
        if (result.answered >= 3) { this.data[ip] = result; this.save(); }
        return result;
      }).finally(() => this.pending.delete(ip));
      this.pending.set(ip, pending);
    }
    return await pending;
  }
  private save(): void {
    if (!this.path) return;
    const cutoff = this.now() - 7 * 86_400_000;
    for (const [ip, entry] of Object.entries(this.data)) if (entry.checkedAt < cutoff) delete this.data[ip];
    try { const temp = `${this.path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 }); renameSync(temp, this.path); } catch { /* kept in memory */ }
  }
}

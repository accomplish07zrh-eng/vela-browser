import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Profile } from "./types.ts";

/**
 * A profile's health: whether everything a website can see about it tells one consistent story.
 * The exit (where its traffic comes out), the timezone and language it claims, the system its user
 * agent names, and what the browser actually reported the last time it started. Each finding costs
 * points; the score is 100 when nothing disagrees.
 */
export type Severity = "high" | "medium" | "low";
export interface HealthIssue { id: string; severity: Severity; message: string; params?: Record<string, string | number> }
export interface ExitInfo { status: "ok" | "failed"; ip?: string; country?: string; city?: string; timezone?: string; rotating?: boolean; unstable?: boolean; reason?: string; checkedAt: number; via: "proxy" | "pool" | "direct" }
export interface HealthReport { profileId: string; score: number; level: "good" | "fair" | "poor"; issues: HealthIssue[]; exit?: ExitInfo; measuredAt?: string }

const COST: Record<Severity, number> = { high: 25, medium: 10, low: 4 };

/** The languages people in a country commonly browse in; English is accepted almost everywhere. */
const COUNTRY_LANGUAGES: Record<string, string[]> = {
  US: ["en", "es"], GB: ["en"], CA: ["en", "fr"], AU: ["en"], NZ: ["en"], IE: ["en"], SG: ["en", "zh", "ms"], IN: ["en", "hi"],
  CN: ["zh"], TW: ["zh"], HK: ["zh", "en"], MO: ["zh", "pt"], JP: ["ja"], KR: ["ko"], VN: ["vi"], TH: ["th"], ID: ["id"], MY: ["ms", "en", "zh"], PH: ["en", "fil", "tl"],
  DE: ["de"], AT: ["de"], CH: ["de", "fr", "it"], FR: ["fr"], BE: ["fr", "nl"], NL: ["nl"], LU: ["fr", "de", "lb"], ES: ["es", "ca"], PT: ["pt"], IT: ["it"],
  PL: ["pl"], CZ: ["cs"], SK: ["sk"], HU: ["hu"], RO: ["ro"], BG: ["bg"], GR: ["el"], SE: ["sv"], NO: ["no", "nb", "nn"], DK: ["da"], FI: ["fi", "sv"],
  RU: ["ru"], UA: ["uk", "ru"], BY: ["be", "ru"], KZ: ["kk", "ru"], TR: ["tr"], IL: ["he"], AE: ["ar"], SA: ["ar"], EG: ["ar"],
  BR: ["pt"], MX: ["es"], AR: ["es"], CL: ["es"], CO: ["es"], PE: ["es"], ZA: ["en", "af"], NG: ["en"],
};

function osOfUa(ua: string | undefined): "windows" | "macos" | "linux" | "android" | "ios" | undefined {
  if (!ua) return undefined;
  if (/Windows NT/i.test(ua)) return "windows";
  if (/iPhone|iPad/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return undefined;
}

function osOfPlatform(platform: string | undefined): "windows" | "macos" | "linux" | undefined {
  if (!platform) return undefined;
  if (/^win/i.test(platform)) return "windows";
  if (/^mac/i.test(platform)) return "macos";
  if (/linux|x11/i.test(platform)) return "linux";
  return undefined;
}

const primary = (language: string | undefined) => language?.split(/[-_,]/)[0]?.trim().toLowerCase() || undefined;

/** Two timezone names mean the same clock when they are equal or one is a known alias of the other. */
function sameZone(a: string, b: string, at = Date.now()): boolean {
  if (a === b) return true;
  try {
    const offset = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
    // Same offset now and half a year from now: the same clock all year (summer time included).
    return offset(a) === offset(b) && (() => { const later = at + 182 * 86_400_000; const o = (zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(later).find((part) => part.type === "timeZoneName")?.value; return o(a) === o(b); })();
  } catch { return false; }
}

export function assessProfile(profile: Profile, exit: ExitInfo | undefined, context: { sharedExit?: number; now?: number } = {}): HealthReport {
  const issues: HealthIssue[] = [];
  const add = (id: string, severity: Severity, message: string, params?: Record<string, string | number>) => issues.push({ id, severity, message, ...(params ? { params } : {}) });
  const now = context.now ?? Date.now();
  const observed = profile.fpObserved;

  // Where the traffic comes out.
  if (profile.proxyError) add("proxy-invalid", "high", "Its proxy settings are invalid");
  else if (!profile.proxy) add("no-proxy", "high", "No proxy: websites see this computer's own address");
  if (exit?.status === "failed") add("exit-failed", "high", "Its exit could not be reached when checked");
  if (exit?.rotating) add("exit-rotating", "medium", "Its exit address changes between requests");
  if (exit?.unstable) add("exit-unstable", "medium", "Its exit only answered some of the checks");
  if (!exit) add("exit-unchecked", "low", "Its exit has not been checked yet");
  if ((context.sharedExit ?? 0) > 0) add("exit-shared", "medium", "Shares its exit address with {count} other profiles", { count: context.sharedExit! });

  // What it claims, against where it comes out.
  const exitZone = exit?.status === "ok" ? exit.timezone : undefined;
  if (exitZone && profile.timezone && !sameZone(profile.timezone, exitZone, now)) {
    add("timezone-exit", "high", "Its timezone {timezone} does not match its exit ({exit})", { timezone: profile.timezone, exit: exitZone });
  }
  const country = exit?.status === "ok" ? exit.country?.toUpperCase() : undefined;
  const language = primary(profile.locale) ?? primary(observed?.languages);
  if (country && language && COUNTRY_LANGUAGES[country] && language !== "en" && !COUNTRY_LANGUAGES[country]!.includes(language)) {
    add("language-exit", "medium", "Its language {language} is unusual for its exit country {country}", { language: profile.locale || language, country });
  }

  // What its own settings say about each other.
  const uaOs = osOfUa(profile.ua);
  if (uaOs && profile.platformOs && (uaOs === "windows" || uaOs === "macos" || uaOs === "linux") && uaOs !== profile.platformOs) {
    add("ua-system", "high", "Its user agent names {ua} but its system is {system}", { ua: uaOs, system: profile.platformOs });
  }

  // What the browser actually reported the last time it started.
  if (!observed?.capturedAt) add("never-measured", "low", "Never measured: open it once so its fingerprint can be checked");
  else {
    const age = now - Date.parse(observed.capturedAt);
    if (Number.isFinite(age) && age > 30 * 86_400_000) add("measured-long-ago", "low", "Last measured more than 30 days ago");
    if (profile.fpVerdict?.verdict === "mismatch") {
      add("fingerprint-changed", "high", "Its fingerprint differs from the one it was imported with: {fields}", { fields: profile.fpVerdict.differences.map((difference) => difference.field).slice(0, 5).join(", ") });
    }
    if (observed.timezone && profile.timezone && !sameZone(observed.timezone, profile.timezone, now)) {
      add("timezone-applied", "high", "The browser reported timezone {observed}, not {stored}", { observed: observed.timezone, stored: profile.timezone });
    }
    const observedOs = osOfPlatform(observed.platform);
    if (observedOs && profile.platformOs && observedOs !== profile.platformOs) {
      add("platform-applied", "high", "The browser reported system {observed}, not {stored}", { observed: observedOs, stored: profile.platformOs });
    }
    const observedUaOs = osOfUa(observed.ua);
    if (observedOs && observedUaOs && (observedUaOs === "windows" || observedUaOs === "macos" || observedUaOs === "linux") && observedUaOs !== observedOs) {
      add("ua-platform", "high", "The browser's user agent and platform disagree ({ua} / {platform})", { ua: observedUaOs, platform: observedOs });
    }
    const stored = profile.screenWidth && profile.screenHeight ? `${profile.screenWidth}*${profile.screenHeight}` : undefined;
    if (stored && observed.screen && observed.screen !== stored) {
      add("screen-applied", "medium", "The browser reported screen {observed}, not {stored}", { observed: observed.screen.replace("*", "×"), stored: stored.replace("*", "×") });
    }
    const observedLanguage = primary(observed.languages ?? observed.language);
    if (profile.locale && observedLanguage && observedLanguage !== primary(profile.locale)) {
      add("language-applied", "medium", "The browser reported language {observed}, not {stored}", { observed: observed.languages ?? observed.language ?? "", stored: profile.locale });
    }
  }

  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + COST[issue.severity], 0));
  issues.sort((a, b) => COST[b.severity] - COST[a.severity]);
  return {
    profileId: profile.id, score, level: score >= 80 ? "good" : score >= 55 ? "fair" : "poor", issues,
    ...(exit ? { exit } : {}), ...(observed?.capturedAt ? { measuredAt: observed.capturedAt } : {}),
  };
}

/** Exit addresses shared across profiles: how many others each profile shares its exit with. */
export function sharedExits(exits: Map<string, ExitInfo>): Map<string, number> {
  const byIp = new Map<string, string[]>();
  for (const [profileId, exit] of exits) {
    if (exit.status !== "ok" || !exit.ip || exit.via === "direct") continue;
    byIp.set(exit.ip, [...(byIp.get(exit.ip) ?? []), profileId]);
  }
  const out = new Map<string, number>();
  for (const ids of byIp.values()) for (const id of ids) out.set(id, ids.length - 1);
  return out;
}

/** The last exit check of each profile, kept in health.json next to the profiles. */
export class ExitCache {
  private data: Record<string, ExitInfo> = {};
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) { try { this.data = JSON.parse(readFileSync(path, "utf8")); } catch { this.data = {}; } }
  }
  get(profileId: string): ExitInfo | undefined { return this.data[profileId]; }
  all(): Map<string, ExitInfo> { return new Map(Object.entries(this.data)); }
  set(profileId: string, exit: ExitInfo): void {
    this.data[profileId] = exit;
    if (!this.path) return;
    try { const temp = `${this.path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 }); renameSync(temp, this.path); } catch { /* kept in memory */ }
  }
  forget(keep: Set<string>): void { for (const id of Object.keys(this.data)) if (!keep.has(id)) delete this.data[id]; }
}

/** An account shown without giving it away: the first two characters and the domain's first two. */
export function maskAccount(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const [user, domain] = text.split("@");
  const head = (part: string) => part.length <= 2 ? part[0] + "*" : `${part.slice(0, 2)}***`;
  if (domain) {
    const dot = domain.lastIndexOf(".");
    return `${head(user!)}@${dot > 0 ? `${head(domain.slice(0, dot))}${domain.slice(dot)}` : head(domain)}`;
  }
  return head(text);
}

const platformKey = (platform: string | undefined) => (platform ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const accountKey = (profile: Pick<Profile, "username" | "email">) => (profile.username || profile.email || "").trim().toLowerCase();

export interface AssociationProfile { id: string; name: string; group: string; platform: string; account: string }
export interface ExitAssociation { ip: string; country?: string; city?: string; via: ExitInfo["via"]; profiles: AssociationProfile[]; risk: "high" | "medium" | "none"; platforms: string[] }
export interface AccountAssociation { account: string; platform: string; profiles: AssociationProfile[] }

/**
 * Who comes out where. An exit that several profiles share links them in a website's eyes, worst
 * when they sign in to the same site; one account signed in from several profiles links them too.
 */
export function associations(profiles: Profile[], exits: Map<string, ExitInfo>): { exits: ExitAssociation[]; accounts: AccountAssociation[]; unchecked: number } {
  const view = (profile: Profile): AssociationProfile => ({ id: profile.id, name: profile.name, group: profile.group ?? "", platform: platformKey(profile.platform), account: maskAccount(profile.username || profile.email || "") });
  const byIp = new Map<string, { exit: ExitInfo; profiles: Profile[] }>();
  let unchecked = 0;
  for (const profile of profiles) {
    const exit = exits.get(profile.id);
    if (!exit || exit.status !== "ok" || !exit.ip) { if (profile.proxy) unchecked++; continue; }
    const entry = byIp.get(exit.ip) ?? { exit, profiles: [] };
    entry.profiles.push(profile);
    byIp.set(exit.ip, entry);
  }
  const exitList: ExitAssociation[] = [...byIp.entries()].filter(([, entry]) => entry.profiles.length > 1).map(([ip, entry]) => {
    const platforms = entry.profiles.map((profile) => platformKey(profile.platform)).filter(Boolean);
    const repeated = [...new Set(platforms.filter((platform, index) => platforms.indexOf(platform) !== index))];
    return {
      ip, country: entry.exit.country, city: entry.exit.city, via: entry.exit.via, profiles: entry.profiles.map(view),
      risk: repeated.length ? "high" : "medium", platforms: repeated,
    } satisfies ExitAssociation;
  }).sort((a, b) => (a.risk === b.risk ? b.profiles.length - a.profiles.length : a.risk === "high" ? -1 : 1));
  const byAccount = new Map<string, Profile[]>();
  for (const profile of profiles) {
    const key = accountKey(profile);
    if (!key) continue;
    const full = `${platformKey(profile.platform)}\n${key}`;
    byAccount.set(full, [...(byAccount.get(full) ?? []), profile]);
  }
  const accounts = [...byAccount.entries()].filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ account: maskAccount(key.split("\n")[1]!), platform: key.split("\n")[0]!, profiles: list.map(view) }));
  return { exits: exitList, accounts, unchecked };
}

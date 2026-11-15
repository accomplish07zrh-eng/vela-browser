import { useState } from "react";
import { useTranslation } from "./i18n.tsx";

/**
 * Sites people use to see what a browser gives away: its IP, where that IP is, and its fingerprint.
 * Opened inside the profile's own browser, so what they show is what websites see from it.
 */
export const CHECK_SITES: Array<{ group: string; sites: Array<{ name: string; url: string }> }> = [
  { group: "Fingerprint and IP together", sites: [
    { name: "BrowserLeaks", url: "https://browserleaks.com/ip" }, { name: "Whoer", url: "https://whoer.net/" },
    { name: "Net.Coffee", url: "https://ip.net.coffee/" }, { name: "ping0", url: "https://ping0.cc/" }, { name: "IPOK", url: "https://ipok.io/" },
  ] },
  { group: "Where the IP is", sites: [
    { name: "ipinfo", url: "https://ipinfo.io/" }, { name: "ip-api", url: "https://ip-api.com/" }, { name: "IP.SB", url: "https://ip.sb/" },
    { name: "WhatIsMyIPAddress", url: "https://whatismyipaddress.com/" }, { name: "WorldIP", url: "https://worldip.io/" }, { name: "ShowMyIP", url: "https://showmyip.com/" },
  ] },
  { group: "Chinese lookups", sites: [
    { name: "IP138", url: "https://ip138.com/" }, { name: "IPIP", url: "https://www.ipip.net/" }, { name: "cip.cc", url: "https://cip.cc/" },
    { name: "ip.cn", url: "https://ip.cn/" }, { name: "Chinaz", url: "https://ip.tool.chinaz.com/" },
  ] },
  { group: "Just the IP", sites: [
    { name: "Amazon checkip", url: "https://checkip.amazonaws.com/" }, { name: "ifconfig.me", url: "https://ifconfig.me/" }, { name: "icanhazip", url: "https://icanhazip.com/" },
  ] },
];

/** The profile detail section: open any of these sites in the profile's own browser. */
export function CheckSitesSection({ profileId, running, engine }: { profileId: string; running: boolean; engine?: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(""), [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const visit = async (url: string) => {
    setBusy(url); setMessage(null);
    try {
      const response = await fetch(`/ui/api/profiles/${encodeURIComponent(profileId)}/visit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.error || t("Could not open it"));
      setMessage({ text: running ? t("Opened in a new tab of this profile's browser.") : t("The browser is starting with this site.") });
    } catch (error) { setMessage({ text: t(error instanceof Error ? error.message : String(error)), bad: true }); }
    finally { setBusy(""); }
  };
  return <section className="check-sites"><h3>{t("Check it with a test site")}</h3>
    <p className="snapshots-note">{t("Opens the site inside this profile's own browser, through its proxy, so it shows exactly what websites see.")}{running && engine && engine !== "chromium" ? ` ${t("Firefox and WebKit browsers that are already open cannot get a new tab from here; close it first.")}` : ""}</p>
    {CHECK_SITES.map((group) => <div key={group.group} className="check-sites-group"><span>{t(group.group)}</span>
      <div>{group.sites.map((site) => <button key={site.url} type="button" className="btn ghost xs" disabled={!!busy} title={site.url} onClick={() => void visit(site.url)}>{busy === site.url ? "…" : site.name}</button>)}</div>
    </div>)}
    {message && <p className={`snapshots-message${message.bad ? " bad" : ""}`} role="status">{message.text}</p>}
  </section>;
}

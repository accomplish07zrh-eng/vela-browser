import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { trapDialogTab } from "./dialog-focus.ts";
import { useTranslation } from "./i18n.tsx";
import "./health.css";

interface Issue { id: string; severity: "high" | "medium" | "low"; message: string; params?: Record<string, string | number> }
interface Exit { status: "ok" | "failed"; ip?: string; country?: string; city?: string; timezone?: string; checkedAt: number; via: "proxy" | "pool" | "direct"; reason?: string }
export interface HealthRow { profileId: string; name: string; group: string; score: number; level: "good" | "fair" | "poor"; issues: Issue[]; exit?: Exit; measuredAt?: string }
interface AssociationProfile { id: string; name: string; group: string; platform: string; account: string }
interface Associations {
  exits: Array<{ ip: string; country?: string; city?: string; via: string; profiles: AssociationProfile[]; risk: "high" | "medium" | "none"; platforms: string[] }>;
  accounts: Array<{ account: string; platform: string; profiles: AssociationProfile[] }>;
  unchecked: number;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

/** A small score badge, coloured by level. */
export function HealthScore({ row, onClick }: { row: Pick<HealthRow, "score" | "level">; onClick?(): void }) {
  const { t } = useTranslation();
  const label = t("Health {score}", { score: row.score });
  return onClick
    ? <button type="button" className={`health-score ${row.level}`} title={label} aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>{row.score}</button>
    : <span className={`health-score ${row.level}`} title={label}>{row.score}</span>;
}

/** The self-check: every profile's health, worst first, and who shares an exit or an account. */
export function HealthSheet({ ids, focus, onClose, onOpenProfile }: { ids?: string[]; focus?: string; onClose(): void; onOpenProfile?(id: string): void }) {
  const { t, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"health" | "links">("health");
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [links, setLinks] = useState<Associations | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(true);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const apply = useCallback((data: { reports: HealthRow[]; associations: Associations }) => { setRows(data.reports); setLinks(data.associations); }, []);
  useEffect(() => { call<{ reports: HealthRow[]; associations: Associations }>("/ui/api/profile-health").then(apply, (cause) => setError(String(cause.message ?? cause))); }, [apply]);
  const run = async () => {
    setBusy(true); setError("");
    try { apply(await call("/ui/api/profile-health/check", { ids: ids ?? [] })); }
    catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  };
  const scope = useMemo(() => (rows ?? []).filter((row) => !ids?.length || ids.includes(row.profileId)), [rows, ids]);
  const shown = scope.filter((row) => !onlyProblems || row.issues.length > 0 || row.profileId === focus);
  const average = scope.length ? Math.round(scope.reduce((sum, row) => sum + row.score, 0) / scope.length) : 0;
  const counts = { poor: scope.filter((row) => row.level === "poor").length, fair: scope.filter((row) => row.level === "fair").length, good: scope.filter((row) => row.level === "good").length };
  const neverChecked = scope.filter((row) => !row.exit).length;
  const when = (at: number) => new Date(at).toLocaleString(language, { dateStyle: "short", timeStyle: "short" });
  const message = (issue: Issue) => t(issue.message, issue.params);
  return <dialog ref={dialog} className="modal health-modal" aria-labelledby="health-title" onKeyDown={trapDialogTab} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-head"><span id="health-title">{ids?.length ? t("Self-check of {count} profiles", { count: ids.length }) : t("Self-check")}</span>
      <button className="modal-close" type="button" aria-label={t("Close")} onClick={onClose}><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </div>
    <div className="modal-body health-body">
      <div className="health-summary">
        <div className="health-average"><strong>{rows ? average : "—"}</strong><span>{t("Average health")}</span></div>
        <div className="health-counts">
          <span className="poor">{t("{count} need fixing", { count: counts.poor })}</span>
          <span className="fair">{t("{count} worth a look", { count: counts.fair })}</span>
          <span className="good">{t("{count} consistent", { count: counts.good })}</span>
        </div>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? t("Checking…") : neverChecked ? t("Check exits now") : t("Check again")}</button>
      </div>
      <p className="health-note">{t("Checks each profile's exit (address, country, timezone) through its own proxy, then compares it with the profile's timezone, language and system and with what the browser reported the last time it started. Nothing is sent anywhere else.")}</p>
      {error && <p className="health-error" role="alert">{error}</p>}
      <div className="segmented health-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "health"} className={tab === "health" ? "active" : ""} onClick={() => setTab("health")}>{t("Health")}</button>
        <button type="button" role="tab" aria-selected={tab === "links"} className={tab === "links" ? "active" : ""} onClick={() => setTab("links")}>
          {t("Shared exits and accounts")}{links && (links.exits.length + links.accounts.length) > 0 && <span className="health-tab-count">{links.exits.length + links.accounts.length}</span>}
        </button>
      </div>
      {tab === "health" && <>
        <label className="health-filter"><input type="checkbox" checked={onlyProblems} onChange={(event) => setOnlyProblems(event.target.checked)} />{t("Only profiles with findings")}</label>
        {rows === null ? <p className="formnote">{t("Loading…")}</p> : shown.length === 0 ? <p className="formnote">{scope.length ? t("Every profile tells a consistent story.") : t("No profiles.")}</p> :
          <ol className="health-list">{shown.map((row) => <li key={row.profileId} className={row.profileId === focus ? "focus" : ""}>
            <HealthScore row={row} />
            <div className="health-row-main">
              <div className="health-row-head">
                {onOpenProfile ? <button type="button" className="health-name" onClick={() => onOpenProfile(row.profileId)}>{row.name}</button> : <strong className="health-name">{row.name}</strong>}
                {row.group && <span className="health-group">{row.group}</span>}
                <span className="health-exit">{row.exit?.status === "ok" ? [row.exit.ip, row.exit.city, row.exit.country, row.exit.timezone].filter(Boolean).join(" · ") || t("Direct") : row.exit ? t("Exit unreachable") : t("Exit not checked")}{row.exit ? ` · ${when(row.exit.checkedAt)}` : ""}</span>
              </div>
              {row.issues.length > 0 && <ul className="health-issues">{row.issues.map((issue) => <li key={issue.id} className={issue.severity}>{message(issue)}</li>)}</ul>}
            </div>
          </li>)}</ol>}
      </>}
      {tab === "links" && links && <div className="health-links">
        {links.unchecked > 0 && <p className="formnote">{t("{count} profiles have not had their exit checked; check exits to include them.", { count: links.unchecked })}</p>}
        <h3>{t("Exits shared by several profiles")}</h3>
        {links.exits.length === 0 ? <p className="formnote">{t("No two profiles come out at the same address.")}</p> :
          <ul className="links-list">{links.exits.map((exit) => <li key={exit.ip} className={exit.risk}>
            <div className="links-head"><strong className="mono">{exit.ip}</strong><span>{[exit.city, exit.country].filter(Boolean).join(" · ")}</span>
              <span className={`links-risk ${exit.risk}`}>{exit.risk === "high" ? t("Same site from one address: {sites}", { sites: exit.platforms.join(", ") }) : t("Linked by address")}</span></div>
            <div className="links-profiles">{exit.profiles.map((profile) => <span key={profile.id} className="links-profile">{profile.name}{profile.platform && <em>{profile.platform}</em>}{profile.account && <em>{profile.account}</em>}</span>)}</div>
          </li>)}</ul>}
        <h3>{t("Accounts signed in from several profiles")}</h3>
        {links.accounts.length === 0 ? <p className="formnote">{t("Each account lives in one profile.")}</p> :
          <ul className="links-list">{links.accounts.map((account) => <li key={`${account.platform}:${account.account}`} className="high">
            <div className="links-head"><strong>{account.account}</strong><span>{account.platform || t("No platform set")}</span></div>
            <div className="links-profiles">{account.profiles.map((profile) => <span key={profile.id} className="links-profile">{profile.name}{profile.group && <em>{profile.group}</em>}</span>)}</div>
          </li>)}</ul>}
        <p className="cardnote">{t("Websites link accounts that sign in from the same address or share one account across browsers. Give each profile its own exit, and keep each account in one profile.")}</p>
      </div>}
    </div>
    <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>{t("Close")}</button></div>
  </dialog>;
}

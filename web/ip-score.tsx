import { useLayoutEffect, useRef, useState } from "react";
import { trapDialogTab } from "./dialog-focus.ts";
import { useTranslation } from "./i18n.tsx";
import "./ip-score.css";

export interface SourceVerdict { id: string; name: string; ok: boolean; country?: string; timezone?: string; isp?: string; network?: string; flags: string[]; risk?: number }
export interface IpFinding { id: string; severity: "high" | "medium" | "low" | "good"; message: string; params?: Record<string, string | number> }
export interface IpScore { ip: string; score: number; grade: "clean" | "good" | "fair" | "poor"; kind: "residential" | "mobile" | "hosting" | "unknown"; country?: string; timezone?: string; isp?: string; findings: IpFinding[]; sources: SourceVerdict[]; answered: number; checkedAt: number }

async function call<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
/** Scores already looked up (nothing new is asked of the services). */
export const cachedIpScores = (ips: string[]) => call<{ scores: Record<string, IpScore> }>("/ui/api/ip-score/cached", { ips }).then((data) => data.scores);
/** Looks the IPs up with every service (three at a time); fresh ignores what was looked up today. */
export const scoreIps = (ips: string[], fresh = false) => call<{ scores: Record<string, IpScore | { ip: string; error: string }> }>("/ui/api/ip-score/batch", { ips, fresh }).then((data) => data.scores);

export const KIND_LABELS: Record<IpScore["kind"], string> = { residential: "Home or business line", mobile: "Mobile network", hosting: "Datacenter", unknown: "Unknown" };
export const GRADE_LABELS: Record<IpScore["grade"], string> = { clean: "Clean", good: "Good", fair: "Fair", poor: "Poor" };
const FLAG_LABELS: Record<string, string> = { proxy: "Proxy", vpn: "VPN", tor: "Tor", hosting: "Datacenter", abuser: "Abuse", anonymous: "Anonymizer", mobile: "Mobile" };
/** The short labels the self-check shows for an exit IP's problems. */
export const IP_SUMMARY_LABELS: Record<string, string> = { tor: "a Tor exit", proxy: "known as a proxy or VPN", hosting: "a datacenter address", abuser: "reported for abuse", risk: "rated risky", country: "placed in different countries" };

export function IpScoreBadge({ score, onClick }: { score: Pick<IpScore, "score" | "grade" | "kind">; onClick?(): void }) {
  const { t } = useTranslation();
  const label = `${t("IP score {score}", { score: score.score })} · ${t(GRADE_LABELS[score.grade])} · ${t(KIND_LABELS[score.kind])}`;
  const body = <><b>{score.score}</b><span>{t(KIND_LABELS[score.kind])}</span></>;
  return onClick
    ? <button type="button" className={`ip-score-badge ${score.grade}`} title={label} aria-label={label} onClick={(event) => { event.stopPropagation(); onClick(); }}>{body}</button>
    : <span className={`ip-score-badge ${score.grade}`} title={label}>{body}</span>;
}

/** Everything the services said about one IP, and the score made from it. */
export function IpScoreDialog({ initial, onClose, onUpdated }: { initial: IpScore; onClose(): void; onUpdated?(score: IpScore): void }) {
  const { t, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [score, setScore] = useState(initial);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const again = async () => {
    setBusy(true); setError("");
    try {
      const result = (await scoreIps([score.ip], true))[score.ip];
      if (!result || "error" in result) throw new Error(result && "error" in result ? result.error : "No answer");
      setScore(result); onUpdated?.(result);
    } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="modal ip-score-modal" aria-labelledby="ip-score-title" onKeyDown={trapDialogTab} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => event.stopPropagation()}>
    <div className="modal-head"><span id="ip-score-title">{t("IP score")} · <span className="mono">{score.ip}</span></span>
      <button className="modal-close" type="button" aria-label={t("Close")} onClick={onClose}><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </div>
    <div className="modal-body ip-score-body">
      <div className="ip-score-summary">
        <div className={`ip-score-big ${score.grade}`}><strong>{score.score}</strong><span>{t(GRADE_LABELS[score.grade])}</span></div>
        <dl>
          <div><dt>{t("Network")}</dt><dd>{t(KIND_LABELS[score.kind])}</dd></div>
          <div><dt>{t("Where")}</dt><dd>{[score.country, score.timezone].filter(Boolean).join(" · ") || "—"}</dd></div>
          <div><dt>{t("Operator")}</dt><dd>{score.isp ?? "—"}</dd></div>
          <div><dt>{t("Checked")}</dt><dd>{t("{answered} of {total} services answered", { answered: score.answered, total: score.sources.length })} · {new Date(score.checkedAt).toLocaleString(language, { dateStyle: "short", timeStyle: "short" })}</dd></div>
        </dl>
      </div>
      <ul className="ip-score-findings">{score.findings.map((finding) => <li key={finding.id} className={finding.severity}>{t(finding.message, finding.params)}</li>)}</ul>
      <table className="ip-score-sources"><thead><tr><th>{t("Service")}</th><th>{t("Country")}</th><th>{t("Says")}</th><th>{t("Risk")}</th></tr></thead>
        <tbody>{score.sources.map((source) => <tr key={source.id} className={source.ok ? "" : "off"}>
          <td>{source.name}</td>
          <td>{source.ok ? source.country ?? "—" : ""}</td>
          <td>{!source.ok ? <span className="muted">{t("No answer")}</span> : source.flags.length
            ? source.flags.map((flag) => <span key={flag} className={`ip-flag ${flag}`}>{t(FLAG_LABELS[flag] ?? flag)}</span>)
            : <span className="ip-flag ok">{t(source.network === "hosting" ? "Datacenter" : "Nothing flagged")}</span>}</td>
          <td>{source.risk ?? ""}</td>
        </tr>)}</tbody>
      </table>
      <p className="cardnote">{t("Only the IP address is sent to these services. Free lookups are limited per day, so a score is kept for half a day.")}</p>
      {error && <p className="health-error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot"><button type="button" className="btn" disabled={busy} onClick={() => void again()}>{busy ? t("Checking…") : t("Check again")}</button><button type="button" className="btn primary" onClick={onClose}>{t("Close")}</button></div>
  </dialog>;
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, AuditStatus } from "../src/audit.ts";
import type { AgentCredentialSettings } from "../src/agent-credentials.ts";
import { agentCredentialSettings, type AgentCredentialAction } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import "./ai-settings.css";

type Rule = "all" | "none" | string[];
interface Access { default: Rule; agents: Record<string, Rule> }
interface AccessListing { access: Access; agents: string[]; authenticated?: string[]; connected: string[]; groups: string[] }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const UNGROUPED = "";

/** How a rule reads in one line. */
function ruleSummary(rule: Rule, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (rule === "all") return t("Every group");
  if (rule === "none") return t("No profiles");
  if (!rule.length) return t("No profiles");
  return rule.map((group) => group === UNGROUPED ? t("Ungrouped") : group).join(" · ");
}

function RuleEditor({ rule, groups, onChange, allowInherit, inherited }: {
  rule: Rule | undefined; groups: string[]; onChange(next: Rule | undefined): void; allowInherit?: boolean; inherited?: Rule;
}) {
  const { t } = useTranslation();
  const mode = rule === undefined ? "inherit" : rule === "all" ? "all" : rule === "none" ? "none" : "some";
  const chosen = Array.isArray(rule) ? rule : [];
  const choices = [...(allowInherit ? [["inherit", "Same as default"]] : []), ["all", "Every group"], ["some", "Only some groups"], ["none", "No profiles"]] as const;
  return <div className="ai-rule">
    <div className="segmented" role="radiogroup">
      {choices.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "active" : ""}
        onClick={() => onChange(value === "inherit" ? undefined : value === "some" ? chosen : value as "all" | "none")}>{t(label)}</button>)}
    </div>
    {mode === "inherit" && inherited !== undefined && <small className="ai-rule-note">{t("Now: {rule}", { rule: ruleSummary(inherited, t) })}</small>}
    {mode === "some" && <div className="ai-rule-groups">
      {[UNGROUPED, ...groups].map((group) => {
        const on = chosen.includes(group);
        return <button key={group || "(ungrouped)"} type="button" className={`ai-group${on ? " on" : ""}`} aria-pressed={on}
          onClick={() => onChange(on ? chosen.filter((item) => item !== group) : [...chosen, group])}>{group === UNGROUPED ? t("Ungrouped") : group}</button>;
      })}
      {!chosen.length && <small className="ai-rule-note">{t("Pick at least one group, or this AI can use no profiles.")}</small>}
    </div>}
  </div>;
}

/** Settings: which groups of profiles each AI may see and use. */
export function AiAccessCard({ flash, manageCredentials }: { flash(message: string): void; manageCredentials?: boolean }) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<AccessListing | null>(null);
  const [adding, setAdding] = useState("");
  const load = useCallback(() => call<AccessListing>("/ui/api/ai-access").then(setListing, (error) => flash(String(error.message ?? error))), [flash]);
  useEffect(() => { void load(); }, [load]);
  const save = (access: Access) => {
    setListing((current) => current ? { ...current, access } : current);
    call<AccessListing>("/ui/api/ai-access", { access }).then(setListing, () => { flash(t("Could not save")); void load(); });
  };
  if (!listing) return null;
  const { access } = listing;
  const agents = [...new Set([...listing.agents, ...Object.keys(access.agents)])].sort();
  const setAgent = (name: string, rule: Rule | undefined) => {
    const next = Object.assign(Object.create(null) as Access["agents"], access.agents);
    if (rule === undefined) delete next[name]; else next[name] = rule;
    save({ ...access, agents: next });
  };
  return <><section className="settings-card ai-access-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg><h2>{t("What each AI may use")}</h2></header>
    <div className="card-body">
      <p>{t("Give each AI only the groups it works on. Profiles in other groups are hidden from it, and it cannot open, change or run scripts in them.")}</p>
      <div className="ai-access-row ai-access-default">
        <div className="ai-access-name"><strong>{t("Default")}</strong><small>{t("For any AI without a rule of its own")}</small></div>
        <RuleEditor rule={access.default} groups={listing.groups} onChange={(rule) => save({ ...access, default: rule ?? "all" })} />
      </div>
      {agents.map((name) => <div key={name} className="ai-access-row">
        <div className="ai-access-name">
          <strong>{name}</strong>
          <small>{listing.connected.includes(name) ? <><i className="ai-live" aria-hidden="true" />{t("Connected now")}</> : t("Seen before")}</small>
          {listing.authenticated?.includes(name) && <small>{t("Credential required")}</small>}
        </div>
        <RuleEditor rule={Object.hasOwn(access.agents, name) ? access.agents[name] : undefined} groups={listing.groups} allowInherit inherited={access.default} onChange={(rule) => setAgent(name, rule)} />
      </div>)}
      <form className="ai-access-add" onSubmit={(event) => { event.preventDefault(); const name = adding.trim().toLowerCase(); if (name) { setAgent(name, access.default === "all" ? [] : access.default); setAdding(""); } }}>
        <input className="input" value={adding} maxLength={64} placeholder={t("Add an AI by name, such as claude code or cursor")} onChange={(event) => setAdding(event.target.value)} />
        <button type="submit" className="btn" disabled={!adding.trim()}>{t("Add")}</button>
      </form>
      <p className="cardnote">{t("Configured Agent credentials verify names and protect task access. Other Agent names are supplied by their client.")}</p>
    </div>
  </section>
    {manageCredentials && <AgentCredentialsCard onChanged={load} flash={flash} />}
  </>;
}

function AgentCredentialsCard({ onChanged, flash }: { onChanged(): void; flash(message: string): void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AgentCredentialSettings>();
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ name: string; token: string }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void agentCredentialSettings().then(value => { if (active) setSettings(value); }, () => {
      if (active) setError("Agent credentials are unavailable.");
    });
    return () => { active = false; };
  }, []);
  const change = async (action: AgentCredentialAction) => {
    setBusy(true);
    setIssued(undefined);
    setError("");
    try {
      const { credentials, requireCredentials, issued: refreshed } = await agentCredentialSettings(action);
      setSettings({ credentials, requireCredentials });
      setIssued(refreshed);
      if (action.action === "issue") setName("");
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent credentials are unavailable.");
    } finally { setBusy(false); }
  };
  const copy = async (token: string) => {
    try { await navigator.clipboard.writeText(token); flash(t("Copied")); }
    catch { setError("Could not copy"); }
  };
  return <section className="settings-card ai-access-card">
    <header><h2>{t("Agent credentials")}</h2></header>
    <div className="card-body">
      {error && <p role="alert" className="modal-err">{t(error)}</p>}
      {settings ? <>
        <label className="activity-failed">
          <input type="checkbox" checked={settings.requireCredentials} disabled={busy}
            onChange={event => void change({ action: "policy", required: event.target.checked })} />
          {t("Require credentials for every MCP Agent")}
        </label>
        {settings.credentials.map(credential => <div key={credential.name} className="ai-access-row">
          <div className="ai-access-name"><strong>{credential.name}</strong><small>{t(credential.revoked ? "Credential revoked" : "Credential active")}</small></div>
          <div className="ai-credential-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void change({ action: "rotate", name: credential.name })}>
              {t(credential.revoked ? "Issue new credential" : "Rotate credential")}
            </button>
            {!credential.revoked && <button type="button" className="btn" disabled={busy} onClick={() => void change({ action: "revoke", name: credential.name })}>{t("Revoke credential")}</button>}
          </div>
        </div>)}
        <form className="ai-access-add" onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void change({ action: "issue", name }); }}>
          <input className="input" aria-label={t("Agent name")} placeholder={t("Agent name")} maxLength={64} value={name} onChange={event => setName(event.target.value)} />
          <button type="submit" className="btn" disabled={busy || !name.trim()}>{t("Issue credential")}</button>
        </form>
        {issued && <div className="ai-credential-issued">
          <p id="agent-credential-hint" className="formnote">{t("Set VELA_AGENT_TOKEN for {agent}. This value is shown once.", { agent: issued.name })}</p>
          <div className="ai-credential-actions">
            <input className="input ai-token" aria-label={t("Agent token")} aria-describedby="agent-credential-hint" readOnly value={issued.token} autoComplete="off" spellCheck={false} />
            <button type="button" className="btn" onClick={() => void copy(issued.token)}>{t("Copy")}</button>
            <button type="button" className="btn" onClick={() => setIssued(undefined)}>{t("Done")}</button>
          </div>
        </div>}
      </> : !error && <p className="formnote">{t("Loading…")}</p>}
    </div>
  </section>;
}

const KINDS = [["", "Everything"], ["ai", "AI"], ["script", "Scripts"], ["task", "Browser tasks"]] as const;

function actionLabel(entry: AuditEntry, t: (key: string, values?: Record<string, string | number>) => string): string {
  const known: Record<string, string> = {
    "browser.open": "Opened the browser", "browser.close": "Closed the browser", "browser.detach": "Let go of the browser",
    "profiles.create": "Created a profile", "profiles.update": "Changed a profile", "profiles.delete": "Deleted a profile",
    "profiles.setProxy": "Changed the proxy", "scripts.save": "Saved a script", "scripts.run": "Ran a script", "scripts.stop": "Stopped a script",
    "plugins.save": "Saved a plugin", "proxyPool.check": "Checked pool nodes", "script.run": "Script run", "browser.status": "Looked at a profile",
    "browserTask.run": "Action", "browserTask.verify": "Verification",
  };
  if (known[entry.action]) return t(known[entry.action]!);
  if (entry.action.startsWith("page.")) return t("Page: {tool}", { tool: entry.action.slice(5).replace(/^browser_/, "").replace(/_/g, " ") });
  return entry.action;
}

/** Settings: what AIs and scripts did, newest first. */
export function ActivityCard({ flash, onReceipt }: { flash(message: string): void; onReceipt(receipt: NonNullable<AuditEntry["task"]>): void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<string>("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [health, setHealth] = useState<AuditStatus>();
  const [failedOnly, setFailedOnly] = useState(false);
  const params = useMemo(() => { const search = new URLSearchParams(); if (kind) search.set("kind", kind); if (query.trim()) search.set("q", query.trim()); return search.toString(); }, [kind, query]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      call<{ entries: AuditEntry[]; status?: AuditStatus }>(`/ui/api/audit?${params}&limit=300`).then((data) => {
        if (live) { setEntries(data.entries); setHealth(data.status); }
      }, (error) => { if (live) { setEntries([]); flash(String(error.message ?? error)); } });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [params, flash]);
  const exportCsv = async () => {
    try {
      const response = await fetch(`/ui/api/audit.csv?${params}`);
      if (!response.ok) throw new Error(t("Could not export"));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = "vela-activity.csv";
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) { flash(error instanceof Error ? error.message : String(error)); }
  };
  const shown = (entries ?? []).filter((entry) => !failedOnly || !entry.ok);
  const time = new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <section className="settings-card activity-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5z" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></svg><h2>{t("Activity record")}</h2></header>
    <div className="card-body">
      <p>{t("Activity is kept on this computer and rotated by age and size.")}</p>
      {health?.issue && <p role="alert" className="modal-err">
        {health.issue === "write_failed" ? t("Activity entries could not be saved ({count} dropped).", { count: health.dropped })
          : t("The activity record could not rotate files.")}
      </p>}
      <div className="activity-tools">
        <div className="segmented" role="radiogroup" aria-label={t("Show")}>
          {KINDS.map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={kind === value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{t(label)}</button>)}
        </div>
        <label className="activity-failed"><input type="checkbox" checked={failedOnly} onChange={(event) => setFailedOnly(event.target.checked)} />{t("Only failures")}</label>
        <input className="input activity-search" value={query} placeholder={t("Search profile, AI, script or address…")} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="btn" onClick={() => void exportCsv()}>{t("Export CSV")}</button>
      </div>
      {entries === null ? <p className="formnote">{t("Loading…")}</p> : shown.length === 0 ? <p className="formnote">{t("Nothing recorded yet.")}</p> :
        <ol className="activity-list">
          {shown.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.ok ? "" : "failed"}>
            <time dateTime={new Date(entry.at).toISOString()}>{time.format(entry.at)}</time>
            <span className={`activity-actor ${entry.actor.kind}`}>{entry.actor.kind === "ai" ? "AI" : entry.actor.kind === "script" ? t("Script") : entry.actor.kind === "task" ? t("Task") : t("You")} · {entry.actor.name}</span>
            <span className="activity-action">{actionLabel(entry, t)}{entry.profileName || entry.profileId ? <em> · {entry.profileName ?? entry.profileId}</em> : null}</span>
            {(entry.detail || entry.error) && <span className="activity-detail" title={entry.error ?? entry.detail}>{entry.error ?? entry.detail}</span>}
            {entry.task && <button className="btn ghost xs" type="button" onClick={() => onReceipt(entry.task!)}>{t("View step evidence")}</button>}
          </li>)}
        </ol>}
    </div>
  </section>;
}

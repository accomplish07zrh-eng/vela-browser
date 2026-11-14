import { useEffect, useState } from "react";
import { checkProxy, createProfile, openProfile, type ProxyCheckResult } from "./api.ts";
import { fetchPool } from "./proxy-pool.tsx";
import { parsePastedProxy } from "./proxy-input.ts";
import { useTranslation } from "./i18n.tsx";
import "./first-run.css";

type Exit = "paste" | "pool" | "direct";
const DISMISSED = "vela.firstRun.dismissed";

export function firstRunDismissed(): boolean {
  try { return localStorage.getItem(DISMISSED) === "1"; } catch { return false; }
}
export function resetFirstRun(): void {
  try { localStorage.removeItem(DISMISSED); } catch { /* storage off */ }
}

/**
 * The workbench before there is any profile: three steps to a first browser on the wall.
 * Name it, give it an exit, open it.
 */
export function FirstRunGuide({ onDone, onSkip, onImport }: { onDone(id: string): void; onSkip(): void; onImport(): void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(() => t("My first profile"));
  const [engine, setEngine] = useState<"chromium" | "firefox">("chromium");
  const [exit, setExit] = useState<Exit>("paste");
  const [line, setLine] = useState("");
  const [nodes, setNodes] = useState<Array<{ id: string; name: string; regionHint?: string; check?: { status?: string; country?: string } }>>([]);
  const [nodeId, setNodeId] = useState("");
  const [check, setCheck] = useState<ProxyCheckResult | null>(null);
  const [busy, setBusy] = useState<"check" | "create" | null>(null), [error, setError] = useState("");
  useEffect(() => { void fetchPool().then((list) => { setNodes(list as any); if (list.length) setExit((current) => current === "paste" ? "pool" : current); }, () => setNodes([])); }, []);
  const parsed = line.trim() ? parsePastedProxy(line.trim()) : null;
  const proxy = exit === "pool" && nodeId ? { type: "pool", host: nodeId, port: "0" }
    : exit === "paste" && parsed?.host && parsed.port ? { type: parsed.type, host: parsed.host, port: parsed.port, user: parsed.user, pass: parsed.pass } : null;
  const exitReady = exit === "direct" || !!proxy;
  const runCheck = async () => {
    if (!proxy || exit !== "paste") return;
    setBusy("check"); setError(""); setCheck(null);
    try { setCheck(await checkProxy(proxy)); } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(null); }
  };
  const finish = async () => {
    setBusy("create"); setError("");
    try {
      const created = await createProfile({ name: name.trim() || t("My first profile"), engine, proxy: exit === "direct" ? null : proxy });
      if (!created.ok || !created.id) throw new Error(created.error || t("Could not create the profile"));
      const opened = await openProfile(created.id);
      if ((opened as any)?.ok === false) throw new Error((opened as any).error || t("The profile was created but did not open"));
      try { localStorage.setItem(DISMISSED, "1"); } catch { /* storage off */ }
      onDone(created.id);
    } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); setBusy(null); }
  };
  const steps = [t("Name it"), t("Give it an exit"), t("Open it")];
  return <section className="first-run" aria-labelledby="first-run-title">
    <header>
      <h2 id="first-run-title">{t("Your first browser in three steps")}</h2>
      <p>{t("Each profile is a separate browser: its own fingerprint, sign-ins and exit. Websites cannot tell two profiles are the same computer.")}</p>
      <ol className="first-run-steps">{steps.map((label, index) => <li key={label} className={index + 1 === step ? "on" : index + 1 < step ? "done" : ""}><span>{index + 1}</span>{label}</li>)}</ol>
    </header>
    {step === 1 && <div className="first-run-body">
      <label className="fld"><span>{t("Name")}</span><input autoFocus maxLength={60} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) setStep(2); }} /></label>
      <div className="fld"><span>{t("Browser")}</span>
        <div className="segmented" role="radiogroup">
          {([["chromium", "Chromium"], ["firefox", "Firefox"]] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={engine === value} className={engine === value ? "active" : ""} onClick={() => setEngine(value)}>{label}</button>)}
        </div>
        <small>{t("Chromium suits most sites. The fingerprint is generated for you and stays the same every time.")}</small>
      </div>
      <div className="first-run-actions"><button type="button" className="btn ghost" onClick={onImport}>{t("I have profiles to import")}</button><span className="spacer" /><button type="button" className="btn primary" disabled={!name.trim()} onClick={() => setStep(2)}>{t("Continue")}</button></div>
    </div>}
    {step === 2 && <div className="first-run-body">
      <div className="segmented" role="radiogroup" aria-label={t("Exit")}>
        {([["paste", "Paste a proxy"], ...(nodes.length ? [["pool", "From the proxy pool"]] : []), ["direct", "Connect directly"]] as Array<[Exit, string]>).map(([value, label]) =>
          <button key={value} type="button" role="radio" aria-checked={exit === value} className={exit === value ? "active" : ""} onClick={() => { setExit(value); setCheck(null); }}>{t(label)}</button>)}
      </div>
      {exit === "paste" && <>
        <label className="fld"><span>{t("Proxy")}</span><input autoFocus value={line} placeholder="socks5://user:pass@host:port" onChange={(event) => { setLine(event.target.value); setCheck(null); }} /></label>
        <div className="first-run-check">
          <button type="button" className="btn" disabled={!proxy || busy === "check"} onClick={() => void runCheck()}>{busy === "check" ? t("Checking…") : t("Check it")}</button>
          {check && <span className={check.status === "working" ? "ok" : "bad"}>{check.status === "working" || check.status === "unstable"
            ? t("Comes out at {address}", { address: [check.ip, check.city, check.country].filter(Boolean).join(" · ") }) : t("Could not connect through it")}</span>}
          {line.trim() && !proxy && <span className="bad">{t("Use host:port, or user:pass@host:port, with an optional socks5:// or http://")}</span>}
        </div>
      </>}
      {exit === "pool" && <div className="first-run-nodes" role="listbox">
        {nodes.slice(0, 12).map((node) => <button key={node.id} type="button" role="option" aria-selected={nodeId === node.id} className={nodeId === node.id ? "on" : ""} onClick={() => setNodeId(node.id)}>
          <strong>{node.name}</strong><span>{node.check?.country ?? node.regionHint ?? ""}</span></button>)}
      </div>}
      {exit === "direct" && <p className="first-run-warn">{t("Without a proxy, websites see this computer's own address. Fine for trying things out; give it a proxy before signing in to accounts.")}</p>}
      <div className="first-run-actions"><button type="button" className="btn ghost" onClick={() => setStep(1)}>{t("Back")}</button><span className="spacer" /><button type="button" className="btn primary" disabled={!exitReady} onClick={() => setStep(3)}>{t("Continue")}</button></div>
    </div>}
    {step === 3 && <div className="first-run-body">
      <dl className="first-run-summary">
        <div><dt>{t("Name")}</dt><dd>{name}</dd></div>
        <div><dt>{t("Browser")}</dt><dd>{engine === "chromium" ? "Chromium" : "Firefox"}</dd></div>
        <div><dt>{t("Exit")}</dt><dd>{exit === "direct" ? t("Direct") : exit === "pool" ? nodes.find((node) => node.id === nodeId)?.name : `${proxy?.type}://${proxy?.host}:${proxy?.port}`}</dd></div>
      </dl>
      <p className="first-run-note">{t("It opens here on the workbench. Double-click its card to work in it; the timezone and language follow its exit.")}</p>
      <div className="first-run-actions"><button type="button" className="btn ghost" onClick={() => setStep(2)}>{t("Back")}</button><span className="spacer" /><button type="button" className="btn primary" disabled={busy === "create"} onClick={() => void finish()}>{busy === "create" ? t("Creating…") : t("Create and open")}</button></div>
    </div>}
    {error && <p className="first-run-error" role="alert">{error}</p>}
    <button type="button" className="first-run-skip" onClick={() => { try { localStorage.setItem(DISMISSED, "1"); } catch { /* storage off */ } onSkip(); }}>{t("Skip, I know my way around")}</button>
  </section>;
}

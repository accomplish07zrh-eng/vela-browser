import { useEffect, useState } from "react";
import { changeBrowserTask, fetchBrowserTask, fetchBrowserTaskEvidence, fetchBrowserTasks, type BrowserTaskView } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { Select } from "./select.tsx";

const LABELS = { queued: "Waiting in queue", running: "Running", recovering: "Recovering browser task", blocked: "Profile blocked",
  completed: "Completed", cancelled: "Cancelled", paused: "Paused",
  interrupted: "Interrupted", needs_verification: "Needs verification", uncertain: "Needs verification", pending: "Pending" } as const;
const PARTS = { value: "Result", logs: "Console", network: "Network traffic", events: "Developer events", screenshot: "Screenshot" } as const;
const WAIT_LABELS = { memory: "Waiting for available memory", profile_write: "Waiting for profile access", capacity: "Waiting for an execution slot" } as const;
type EvidencePart = keyof typeof PARTS;
type Summary = { stepId: string; actionKey: string; phase: "run" | "verify"; attempt: number; startedAt: string; endedAt: string;
  completed: boolean; error?: string; detailsExpired?: boolean; available: Record<EvidencePart, boolean> };

export function BrowserTasksPanel({ receipt }: { receipt?: { runId: string; sequence: number } }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<BrowserTaskView[]>([]);
  const [runId, setRunId] = useState(receipt?.runId ?? "");
  const [count, setCount] = useState(1);
  const [more, setMore] = useState(false);
  const [sequence, setSequence] = useState(receipt?.sequence ?? 0);
  const [part, setPart] = useState<EvidencePart>("value");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verifier, setVerifier] = useState("");
  const [delegateEdit, setDelegateEdit] = useState<string | null>(null);
  const task = tasks.find(item => item.runId === runId) ?? tasks[0];

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const records: BrowserTaskView[] = [];
        let offset = 0, more = false;
        for (let page = 0; page < count; page++) {
          const result = await fetchBrowserTasks(offset);
          records.push(...result.tasks); more = result.hasMore; offset = result.nextOffset;
          if (!more) break;
        }
        if (runId && !records.some(record => record.runId === runId)) {
          const task = await fetchBrowserTask(runId);
          records.unshift(task);
        }
        if (mounted) { setTasks(records); setMore(more); }
      } catch (error) { if (mounted) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (mounted) setLoading(false); }
    }
    const timer = setInterval(() => { void load(); }, 2000);
    void load();
    return () => { mounted = false; clearInterval(timer); };
  }, [count, busy, runId]);

  const oldest = task?.firstEvidence ?? 1;
  const evidenceSequence = oldest <= (task?.evidenceCount ?? 0)
    ? Math.min(sequence || task!.evidenceCount, task!.evidenceCount) : 0;
  useEffect(() => {
    if (!task?.runId || !evidenceSequence) { setSummary(null); setDetail(null); return; }
    const abort = new AbortController();
    setSummary(null); setDetail(null);
    void (async () => {
      const meta = await fetchBrowserTaskEvidence(task.runId, evidenceSequence, "summary", abort.signal) as Summary;
      if (abort.signal.aborted) return;
      setSummary(meta);
      const data = meta.available[part] ? await fetchBrowserTaskEvidence(task.runId, evidenceSequence, part, abort.signal) : null;
      if (!abort.signal.aborted) setDetail(data);
    })().catch(
      error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, [task?.runId, evidenceSequence, part]);

  const uncertain = task?.steps.find(step => step.state === "uncertain");
  const change = async (operation: "pause" | "cancel" | "resume" | "delegate") => {
    if (!task) return;
    setBusy(true); setError("");
    try {
      const input = operation === "resume" && verifier.trim() && uncertain
        ? { verify: verifier.trim(), expectedAttempt: uncertain.expectedAttempt }
        : operation === "delegate" ? { delegates: (delegateEdit ?? "").split(",").map(name => name.trim()).filter(Boolean) } : undefined;
      await changeBrowserTask(task.runId, operation, input);
      if (operation === "resume") setVerifier("");
      if (operation === "delegate") setDelegateEdit(null);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const screenshot = part === "screenshot" && detail && typeof detail === "object" && "base64" in detail ? String(detail.base64) : null;
  const canPause = task && ["queued", "running", "recovering"].includes(task.state);
  return <section aria-label={t("Browser tasks")}>
    {error && <div className="modal-err" role="alert">{error}</div>}
    {loading ? <p role="status">{t("Loading…")}</p> : !task ? <p>{t("No browser tasks yet")}</p> :
      <div className="scripts-layout">
        <div className="scripts-list" aria-label={t("Browser tasks")}>
          {tasks.map(item => <button key={item.runId} type="button" className={`script-row${item.runId === task.runId ? " active" : ""}`}
            onClick={() => { setRunId(item.runId); setSequence(0); setError(""); setVerifier(""); setDelegateEdit(null); }}>
            <span className="script-row-text"><b>{item.name}</b><small>{t(LABELS[item.state])} · {item.client}</small></span>
          </button>)}
          {more && <button type="button" className="btn ghost" onClick={() => setCount(count + 1)}>{t("Load more")}</button>}
        </div>
        <section className="script-detail">
          <header className="script-detail-head">
            <div className="script-detail-title"><h2>{task.name}</h2><span>{t(LABELS[task.state])} · <code>{task.runId}</code></span></div>
            {!["completed", "cancelled"].includes(task.state) && <div className="script-actions">
              {canPause ? <button className="btn ghost" type="button" disabled={busy || !!task.stopRequested} onClick={() => void change("pause")}>{t("Pause task")}</button>
                : <button className="btn ghost" type="button" disabled={busy} onClick={() => void change("resume")}>{t("Resume task")}</button>}
              <button className="btn ghost danger" type="button" disabled={busy} onClick={() => void change("cancel")}>{t("Cancel task")}</button>
            </div>}
          </header>
          {(task.blocked || task.error) && <p className="modal-err">{task.blocked?.message || task.error || task.blocked?.code}</p>}
          {task.retryAt && <p role="status">{t("Retry at {time}", { time: new Date(task.retryAt).toLocaleTimeString() })}</p>}
          {task.waitReason && <p role="status">{t(WAIT_LABELS[task.waitReason])}</p>}
          {!!task.recoveries && <small>{t("Recovery attempts {count}", { count: task.recoveries })}</small>}
          {uncertain && !canPause && !["completed", "cancelled"].includes(task.state) && <label className="fld">
            <span>{t("Replacement verifier for {step}", { step: uncertain.id })}</span>
            <textarea rows={4} value={verifier} className="script-code" onChange={event => setVerifier(event.target.value)}
              placeholder={t("JavaScript function returning applied, absent, or unknown")} />
          </label>}
          <div className="browser-task-controls">
            {delegateEdit === null ? <button className="btn ghost xs" type="button"
              onClick={() => setDelegateEdit(task.delegates?.join(", ") ?? "")}>{t("Manage task delegates")}</button>
              : <>
                <input className="input" value={delegateEdit} onChange={event => setDelegateEdit(event.target.value)}
                  aria-label={t("Agent names separated by commas")} />
                <button className="btn ghost xs" type="button" disabled={busy} onClick={() => void change("delegate")}>{t("Save")}</button>
                <button className="btn ghost xs" type="button" onClick={() => setDelegateEdit(null)}>{t("Cancel")}</button>
              </>}
          </div>
          <ol className="browser-task-steps">
            {task.steps.map(step => <li key={step.id}>
              <button className="btn ghost xs" type="button" disabled={!step.evidence || step.evidence < oldest}
                onClick={() => step.evidence && setSequence(step.evidence)}>{step.id}</button>
              <span>{t(LABELS[step.state])}</span>
              {step.error && <small>{step.error}</small>}
            </li>)}
          </ol>
          {!!evidenceSequence && <div className="browser-task-evidence">
            <div className="browser-task-controls">
              <button type="button" className="btn ghost xs" disabled={evidenceSequence <= oldest} onClick={() => setSequence(evidenceSequence - 1)}>{t("Previous")}</button>
              <span>{evidenceSequence} / {task.evidenceCount}</span>
              <button type="button" className="btn ghost xs" disabled={evidenceSequence >= task.evidenceCount} onClick={() => setSequence(evidenceSequence + 1)}>{t("Next")}</button>
              <Select className="select" value={part} onChange={event => setPart(event.target.value as EvidencePart)} aria-label={t("Step evidence")}>
                {(Object.keys(PARTS) as EvidencePart[]).map(key => <option key={key} value={key}>{t(PARTS[key])}</option>)}
              </Select>
            </div>
            {summary && <div className="browser-task-receipt">
              <b>{summary.stepId} · {summary.phase === "run" ? t("Action") : t("Verification")}</b>
              <small>{new Date(summary.startedAt).toLocaleTimeString()} · {t("{count} attempts", { count: summary.attempt })}</small>
              <code>{summary.actionKey}</code>
              {summary.error && <p>{summary.error}</p>}
            </div>}
            {screenshot ? <img alt={t("Step screenshot")} src={`data:image/jpeg;base64,${screenshot}`} />
              : detail === null ? <p>{t(summary?.detailsExpired ? "Evidence details exceeded the storage limit" : "No evidence for this view")}</p> : <pre className="script-code">{JSON.stringify(detail, null, 2)}</pre>}
          </div>}
        </section>
      </div>}
  </section>;
}

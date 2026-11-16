import { useEffect, useState } from "react";
import { changeBrowserTask, fetchBrowserTaskEvidence, fetchBrowserTasks, type BrowserTaskView } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { Select } from "./select.tsx";

const LABELS = { running: "Running", completed: "Completed", cancelled: "Cancelled", paused: "Paused",
  interrupted: "Interrupted", needs_verification: "Needs verification", uncertain: "Needs verification", pending: "Pending" } as const;
const PARTS = { value: "Result", logs: "Console", network: "Network traffic", events: "Developer events", screenshot: "Screenshot" } as const;
type EvidencePart = keyof typeof PARTS;
type Summary = { stepId: string; phase: "run" | "verify"; attempt: number; startedAt: string; endedAt: string; completed: boolean; error?: string };

export function BrowserTasksPanel() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<BrowserTaskView[]>([]);
  const [runId, setRunId] = useState("");
  const [count, setCount] = useState(1);
  const [more, setMore] = useState(false);
  const [sequence, setSequence] = useState(0);
  const [part, setPart] = useState<EvidencePart>("value");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
        if (mounted) { setTasks(records); setMore(more); }
      } catch (error) { if (mounted) setError(error instanceof Error ? error.message : String(error)); }
      finally { if (mounted) setLoading(false); }
    }
    const timer = setInterval(() => { void load(); }, 2000);
    void load();
    return () => { mounted = false; clearInterval(timer); };
  }, [count, busy]);

  const evidenceSequence = Math.min(sequence || task?.evidenceCount || 0, task?.evidenceCount ?? 0);
  useEffect(() => {
    if (!task?.runId || !evidenceSequence) { setSummary(null); setDetail(null); return; }
    const abort = new AbortController();
    setSummary(null); setDetail(null);
    void Promise.all([
      fetchBrowserTaskEvidence(task.runId, evidenceSequence, "summary", abort.signal),
      fetchBrowserTaskEvidence(task.runId, evidenceSequence, part, abort.signal),
    ]).then(([meta, data]) => { if (!abort.signal.aborted) { setSummary(meta as Summary); setDetail(data); } },
      error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, [task?.runId, evidenceSequence, part]);

  const change = async (operation: "pause" | "cancel" | "resume") => {
    if (!task) return;
    setBusy(true); setError("");
    try { await changeBrowserTask(task.runId, operation); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const screenshot = part === "screenshot" && detail && typeof detail === "object" && "base64" in detail ? String(detail.base64) : null;
  return <section aria-label={t("Browser tasks")}>
    {error && <div className="modal-err" role="alert">{error}</div>}
    {loading ? <p role="status">{t("Loading…")}</p> : !task ? <p>{t("No browser tasks yet")}</p> :
      <div className="scripts-layout">
        <div className="scripts-list" aria-label={t("Browser tasks")}>
          {tasks.map(item => <button key={item.runId} type="button" className={`script-row${item.runId === task.runId ? " active" : ""}`}
            onClick={() => { setRunId(item.runId); setSequence(0); setError(""); }}>
            <span className="script-row-text"><b>{item.name}</b><small>{t(LABELS[item.state])} · {item.client}</small></span>
          </button>)}
          {more && <button type="button" className="btn ghost" onClick={() => setCount(count + 1)}>{t("Load more")}</button>}
        </div>
        <section className="script-detail">
          <header className="script-detail-head">
            <div className="script-detail-title"><h2>{task.name}</h2><span>{t(LABELS[task.state])} · <code>{task.runId}</code></span></div>
            {!["completed", "cancelled"].includes(task.state) && <div className="script-actions">
              {task.state === "running" ? <button className="btn ghost" type="button" disabled={busy} onClick={() => void change("pause")}>{t("Pause task")}</button>
                : <button className="btn ghost" type="button" disabled={busy} onClick={() => void change("resume")}>{t("Resume task")}</button>}
              <button className="btn ghost danger" type="button" disabled={busy} onClick={() => void change("cancel")}>{t("Cancel task")}</button>
            </div>}
          </header>
          {task.error && <p className="modal-err">{task.error}</p>}
          <ol className="browser-task-steps">
            {task.steps.map(step => <li key={step.id}>
              <button className="btn ghost xs" type="button" disabled={!step.evidence} onClick={() => step.evidence && setSequence(step.evidence)}>{step.id}</button>
              <span>{t(LABELS[step.state])}</span>
              {step.error && <small>{step.error}</small>}
            </li>)}
          </ol>
          {!!evidenceSequence && <div className="browser-task-evidence">
            <div className="browser-task-controls">
              <button type="button" className="btn ghost xs" disabled={evidenceSequence <= 1} onClick={() => setSequence(evidenceSequence - 1)}>{t("Previous")}</button>
              <span>{evidenceSequence} / {task.evidenceCount}</span>
              <button type="button" className="btn ghost xs" disabled={evidenceSequence >= task.evidenceCount} onClick={() => setSequence(evidenceSequence + 1)}>{t("Next")}</button>
              <Select className="select" value={part} onChange={event => setPart(event.target.value as EvidencePart)} aria-label={t("Step evidence")}>
                {(Object.keys(PARTS) as EvidencePart[]).map(key => <option key={key} value={key}>{t(PARTS[key])}</option>)}
              </Select>
            </div>
            {summary && <div className="browser-task-receipt">
              <b>{summary.stepId} · {summary.phase === "run" ? t("Action") : t("Verification")}</b>
              <small>{new Date(summary.startedAt).toLocaleTimeString()} · {t("{count} attempts", { count: summary.attempt })}</small>
              {summary.error && <p>{summary.error}</p>}
            </div>}
            {screenshot ? <img alt={t("Step screenshot")} src={`data:image/jpeg;base64,${screenshot}`} />
              : detail === null ? <p>{t("No evidence for this view")}</p> : <pre className="script-code">{JSON.stringify(detail, null, 2)}</pre>}
          </div>}
        </section>
      </div>}
  </section>;
}

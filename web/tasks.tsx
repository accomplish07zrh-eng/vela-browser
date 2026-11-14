import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "./select.tsx";
import { NumberInput } from "./controls.tsx";
import { confirmDialog } from "./dialog.tsx";
import { useTranslation } from "./i18n.tsx";
import { deleteTask, fetchProfiles, fetchScripts, fetchTasks, runTask, saveTask, type TaskDefinition, type TaskRunRecord, type TaskSchedule } from "./api.ts";
import type { ScriptSummary } from "../contracts/cloud-v1.ts";
import "./tasks.css";
import { parseTags, TagInput } from "./tags.tsx";

type Draft = {
  id?: string; name: string; enabled: boolean; groups: string[]; tags: string;
  steps: Array<{ scriptId: string; inputs: string }>;
  concurrency: string; retries: string; schedule: "manual" | "daily" | "interval"; time: string; days: number[]; minutes: string;
};

const EMPTY: Draft = { name: "", enabled: true, groups: [], tags: "", steps: [{ scriptId: "", inputs: "{}" }], concurrency: "5", retries: "1", schedule: "manual", time: "09:00", days: [], minutes: "60" };

function toDraft(task: TaskDefinition): Draft {
  const schedule = task.schedule;
  return {
    id: task.id, name: task.name, enabled: task.enabled, groups: task.target.groups ?? [], tags: (task.target.tags ?? []).join(", "),
    steps: task.steps.map((step) => ({ scriptId: step.scriptId, inputs: JSON.stringify(step.inputs, null, 2) })),
    concurrency: String(task.concurrency), retries: String(task.retries), schedule: schedule.kind,
    time: schedule.kind === "daily" ? schedule.time : "09:00", days: schedule.kind === "daily" ? schedule.days ?? [] : [],
    minutes: schedule.kind === "interval" ? String(schedule.minutes) : "60",
  };
}

const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Automated tasks: saved scripts in order over chosen groups or tags, by hand or on a schedule,
 * with retries and a report of every run.
 */
export function TasksPanel() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskDefinition[]>([]);
  const [history, setHistory] = useState<TaskRunRecord[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchTasks();
      setTasks(next.tasks); setHistory(next.history); setRunningId(next.runningTaskId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }, []);
  useEffect(() => {
    void load();
    void fetchScripts().then(setScripts, () => {});
    void fetchProfiles().then((roster) => { setGroups(roster.groups); setKnownTags([...new Set(roster.profiles.flatMap((profile) => profile.tags ?? []))].sort((a, b) => a.localeCompare(b))); }, () => {});
  }, [load]);
  useEffect(() => {
    if (!runningId) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [runningId, load]);

  const scheduleText = (schedule: TaskSchedule) => schedule.kind === "manual" ? t("By hand")
    : schedule.kind === "interval" ? t("Every {minutes} min", { minutes: schedule.minutes })
    : schedule.days?.length ? t("{days} at {time}", { days: schedule.days.map((day) => t(DAY_KEYS[day]!)).join(" "), time: schedule.time })
    : t("Every day at {time}", { time: schedule.time });

  const save = async () => {
    if (!draft) return;
    setBusy(true); setError(null);
    try {
      const steps = draft.steps.map((step, index) => {
        let inputs: unknown;
        try { inputs = JSON.parse(step.inputs || "{}"); } catch { throw new Error(t("Step {n}: inputs must be valid JSON.", { n: index + 1 })); }
        return { scriptId: step.scriptId, inputs: inputs as Record<string, unknown> };
      });
      const tags = parseTags(draft.tags);
      const schedule: TaskSchedule = draft.schedule === "manual" ? { kind: "manual" }
        : draft.schedule === "interval" ? { kind: "interval", minutes: Number(draft.minutes) }
        : { kind: "daily", time: draft.time.trim(), ...(draft.days.length ? { days: draft.days } : {}) };
      const saved = await saveTask({ ...(draft.id ? { id: draft.id } : {}), name: draft.name, enabled: draft.enabled, target: { ...(draft.groups.length ? { groups: draft.groups } : {}), ...(tags.length ? { tags } : {}) },
        steps, concurrency: Number(draft.concurrency), retries: Number(draft.retries), schedule } as Partial<TaskDefinition>);
      setDraft(toDraft(saved));
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!draft?.id || !await confirmDialog(t("Delete the task “{name}”?", { name: draft.name }), { danger: true, confirmLabel: t("Delete") })) return;
    try { await deleteTask(draft.id); setDraft(null); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const start = async (id: string) => {
    setError(null);
    try { await runTask(id); setRunningId(id); setTimeout(() => void load(), 600); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const ownHistory = useMemo(() => draft?.id ? history.filter((record) => record.taskId === draft.id) : history, [history, draft?.id]);
  const set = (change: Partial<Draft>) => setDraft((current) => current ? { ...current, ...change } : current);

  return <div className="scripts-layout tasks-layout">
    <div className="scripts-list" aria-label={t("Automated tasks")}>
      <button type="button" className="btn primary tasks-new" onClick={() => setDraft({ ...EMPTY, steps: [{ scriptId: scripts[0]?.id ?? "", inputs: "{}" }] })}>{t("New task")}</button>
      {tasks.length === 0 && <p className="formnote">{t("No tasks yet.")}</p>}
      {tasks.map((task) => <button key={task.id} type="button" className={`script-row${draft?.id === task.id ? " active" : ""}`} onClick={() => setDraft(toDraft(task))}>
        <span className={`script-lang task-mark${task.enabled ? "" : " off"}`} aria-hidden="true">{runningId === task.id ? "▶" : "⏱"}</span>
        <span className="script-row-text"><b>{task.name}</b><small>{task.enabled ? scheduleText(task.schedule) : t("Paused")}{task.nextRunAt ? ` · ${t("next {time}", { time: new Date(task.nextRunAt).toLocaleString() })}` : ""}</small></span>
      </button>)}
    </div>
    <section className="script-detail tasks-detail">
      {error && <div className="modal-err" role="alert">{error}</div>}
      {draft ? <>
        <header className="script-detail-head">
          <div className="script-detail-title"><h2>{draft.id ? draft.name : t("New task")}</h2><span>{t("Runs saved scripts in order; each step continues with the profiles that succeeded the one before.")}</span></div>
          <div className="script-actions">
            {draft.id && <button type="button" className="btn ghost" disabled={busy || !!runningId} onClick={() => void start(draft.id!)}>{runningId === draft.id ? t("Running…") : t("Run now")}</button>}
            {draft.id && <button type="button" className="btn ghost danger" disabled={busy} onClick={() => void remove()}>{t("Delete")}</button>}
          </div>
        </header>
        <div className="tasks-form">
          <label className="fld"><span>{t("Name")}</span><input className="input" value={draft.name} maxLength={80} placeholder={t("Morning check-in")} onChange={(event) => set({ name: event.target.value })} /></label>
          <div className="fld"><span>{t("Groups")}</span><div className="tasks-chips">
            {groups.length === 0 && <small className="muted">{t("No groups yet.")}</small>}
            {groups.map((group) => <button key={group} type="button" className={`tasks-chip${draft.groups.includes(group) ? " on" : ""}`} aria-pressed={draft.groups.includes(group)}
              onClick={() => set({ groups: draft.groups.includes(group) ? draft.groups.filter((item) => item !== group) : [...draft.groups, group] })}>{group}</button>)}
          </div></div>
          <div className="fld"><span>{t("Tags")}</span><TagInput value={parseTags(draft.tags)} suggestions={knownTags} onChange={(next) => set({ tags: next.join(", ") })} /></div>
          <div className="fld"><span>{t("Steps")}</span><ol className="tasks-steps">
            {draft.steps.map((step, index) => <li key={index}>
              <Select className="select" aria-label={t("Script")} value={step.scriptId} onChange={(event) => set({ steps: draft.steps.map((item, i) => i === index ? { ...item, scriptId: event.target.value } : item) })}>
                <option value="">{t("Choose a script…")}</option>
                {scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
              </Select>
              <textarea className="input tasks-inputs" spellCheck={false} aria-label={t("JSON inputs")} value={step.inputs} onChange={(event) => set({ steps: draft.steps.map((item, i) => i === index ? { ...item, inputs: event.target.value } : item) })} />
              {draft.steps.length > 1 && <button type="button" className="btn ghost sm" onClick={() => set({ steps: draft.steps.filter((_, i) => i !== index) })}>{t("Remove")}</button>}
            </li>)}
          </ol>
          {draft.steps.length < 10 && <button type="button" className="btn ghost sm tasks-add" onClick={() => set({ steps: [...draft.steps, { scriptId: "", inputs: "{}" }] })}>{t("Add a step")}</button>}</div>
          <div className="fld"><span>{t("When")}</span>
            <div className="segmented" role="radiogroup" aria-label={t("When")}>
              {(["manual", "daily", "interval"] as const).map((kind) => <button key={kind} type="button" role="radio" aria-checked={draft.schedule === kind} className={draft.schedule === kind ? "active" : ""} onClick={() => set({ schedule: kind })}>
                {kind === "manual" ? t("By hand") : kind === "daily" ? t("At a time") : t("Every few minutes")}</button>)}
            </div>
            {draft.schedule === "daily" && <div className="tasks-when">
              <input className="input tasks-time" value={draft.time} inputMode="numeric" placeholder="09:00" aria-label={t("Time")} onChange={(event) => set({ time: event.target.value })} />
              <div className="tasks-chips">{DAY_KEYS.map((key, day) => <button key={key} type="button" className={`tasks-chip${draft.days.includes(day) ? " on" : ""}`} aria-pressed={draft.days.includes(day)}
                onClick={() => set({ days: draft.days.includes(day) ? draft.days.filter((item) => item !== day) : [...draft.days, day] })}>{t(key)}</button>)}</div>
              <small className="muted">{t("No day chosen means every day.")}</small>
            </div>}
            {draft.schedule === "interval" && <div className="tasks-when"><NumberInput min={15} step={5} value={draft.minutes} aria-label={t("Minutes")} onChange={(event) => set({ minutes: event.target.value })} /><small className="muted">{t("minutes, at least 15")}</small></div>}
          </div>
          <div className="fld-row">
            <label className="fld"><span>{t("Parallel browsers")}</span><NumberInput min={1} max={50} value={draft.concurrency} onChange={(event) => set({ concurrency: event.target.value })} /></label>
            <label className="fld"><span>{t("Retries for failed profiles")}</span><Select className="select" value={draft.retries} onChange={(event) => set({ retries: event.target.value })}>
              {["0", "1", "2", "3"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></label>
          </div>
          <label className="tasks-enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} /><span>{t("Run on its schedule")}</span></label>
          <div className="tasks-save"><button type="button" className="btn primary" disabled={busy || !draft.name.trim() || draft.steps.some((step) => !step.scriptId)} onClick={() => void save()}>{busy ? t("Saving…") : t("Save task")}</button></div>
        </div>
      </> : <div className="script-pick tasks-empty"><b>{t("Let scripts run by themselves")}</b><p>{t("A task runs saved scripts in order over chosen groups or tags, by hand or on a schedule, retries the profiles that failed, and keeps a report of every run.")}</p></div>}
      <div className="tasks-history">
        <h3>{t("Run history")}</h3>
        {ownHistory.length === 0 ? <p className="formnote">{t("No runs yet.")}</p> : ownHistory.slice(0, 20).map((record) => <details key={record.id} className={`tasks-run ${record.outcome}`}>
          <summary><span className={`tasks-outcome ${record.outcome}`}>{t(record.outcome === "succeeded" ? "Succeeded" : record.outcome === "partial" ? "Partly done" : record.outcome === "failed" ? "Failed" : record.outcome === "skipped" ? "Skipped" : "Running")}</span>
            <b>{record.taskName}</b><small>{new Date(record.startedAt).toLocaleString()} · {record.trigger === "schedule" ? t("on schedule") : t("by hand")} · {t("{count} profiles", { count: record.profiles })}</small></summary>
          {record.note && <p className="formnote">{t(record.note)}</p>}
          <ul>{record.steps.map((step, index) => <li key={index}>
            <span>{step.scriptName}</span><small>{t("{ok} succeeded · {failed} failed · {attempts} tries", { ok: step.succeeded, failed: step.failed, attempts: step.attempts })}</small>
            {step.failures.length > 0 && <ul className="tasks-failures">{step.failures.slice(0, 20).map((failure) => <li key={failure.profileId}><b>{failure.name}</b>{failure.error ? `: ${failure.error}` : ""}</li>)}</ul>}
          </li>)}</ul>
        </details>)}
      </div>
    </section>
  </div>;
}

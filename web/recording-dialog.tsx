import { useEffect, useRef, useState } from "react";
import { createScript } from "./api.ts";
import { trapDialogTab } from "./dialog-focus.ts";
import { useTranslation } from "./i18n.tsx";

/** Shown when a recording stops: the script it became, to name and keep, or to throw away. */
export function RecordingDialog({ source, steps, profileName, onClose, onSaved }: {
  source: string; steps: number; profileName: string; onClose(): void; onSaved?(name: string): void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(() => t("Recorded in {name}", { name: profileName }));
  const [code, setCode] = useState(source);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await createScript({ name: name.trim(), description: t("Recorded on the workbench, {count} steps.", { count: steps }), language: "javascript", source: code });
      setSaved(true); onSaved?.(name.trim());
    } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="modal recording-modal" aria-labelledby="recording-title" onKeyDown={(event) => { event.stopPropagation(); trapDialogTab(event); }}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <div className="modal-head"><span id="recording-title">{saved ? t("Saved to My scripts") : t("Recording finished · {count} steps", { count: steps })}</span>
      <button className="modal-close" type="button" aria-label={t("Close")} onClick={onClose}>
        <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
      </button>
    </div>
    <div className="modal-body recording-body">
      <p className="recording-note">{t("Clicks are found by what the control is called, so the script keeps working when the page moves. Typed text is not kept: fill it in as inputs when you run the script.")}</p>
      <label className="fld"><span>{t("Script name")}</span>
        <input autoFocus maxLength={80} value={name} disabled={saved} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
      </label>
      <label className="fld"><span>{t("Script")}</span>
        <textarea className="recording-source" spellCheck={false} value={code} readOnly={saved} onChange={(event) => setCode(event.target.value)} />
      </label>
      {error && <p className="recording-error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot">
      {saved ? <button type="button" className="btn primary" onClick={onClose}>{t("Done")}</button> : <>
        <button type="button" className="btn ghost" onClick={onClose}>{t("Discard")}</button>
        <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void save()}>{busy ? t("Saving…") : t("Save script")}</button>
      </>}
    </div>
  </dialog>;
}

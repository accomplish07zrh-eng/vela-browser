import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Select } from "./select.tsx";
import { useTranslation } from "./i18n.tsx";
import { trapDialogTab } from "./dialog-focus.ts";
import {
  MAX_SAVED_PROFILE_ITEMS, batchProfileNames, managementStorageKey, parseManagementItems,
  profileTemplateSettings, serializeManagementItems,
  type BatchCreateItem, type ProfileFilters, type ProfileTemplate, type ProfileTemplateSettings, type SavedProfileView,
} from "./profile-management.ts";

function readItems(kind: "views", scope: string): SavedProfileView[];
function readItems(kind: "templates", scope: string): ProfileTemplate[];
function readItems(kind: "views" | "templates", scope: string): (SavedProfileView | ProfileTemplate)[] {
  try {
    const raw = localStorage.getItem(managementStorageKey(kind, scope));
    return kind === "views" ? parseManagementItems("views", raw) : parseManagementItems("templates", raw);
  } catch { return []; }
}

function saveItems(kind: "views" | "templates", scope: string, items: (SavedProfileView | ProfileTemplate)[]): boolean {
  try { localStorage.setItem(managementStorageKey(kind, scope), serializeManagementItems(items)); return true; }
  catch { return false; }
}

function CloseGlyph() {
  return <svg viewBox="0 0 24 24" className="icon sm" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

export function ProfileCreationDialog({ children, onCancel }: { children: ReactNode; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="modal profile-create-modal" aria-labelledby="create-profile-title" onKeyDown={trapDialogTab} onCancel={(event) => {
    event.preventDefault(); event.stopPropagation(); onCancel();
  }}>{children}</dialog>;
}

/** The parent keys this component by workspace so saved views stay with their local data. */
export function SavedProfileViews({ scope, filters, onApply }: { scope: string; filters: ProfileFilters; onApply(filters: ProfileFilters): void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState(() => readItems("views", scope));
  const [naming, setNaming] = useState(false), [name, setName] = useState(""), [error, setError] = useState("");
  const active = items.find((item) => JSON.stringify(item.filters) === JSON.stringify(filters));
  const persist = (next: SavedProfileView[]) => {
    if (!saveItems("views", scope, next)) { setError(t("This device could not save the view. Check local storage and try again.")); return false; }
    setItems(next); setError(""); return true;
  };
  const save = () => {
    if (!name.trim() || items.length >= MAX_SAVED_PROFILE_ITEMS) return;
    if (items.some((item) => item.name === name.trim())) { setError(t("Choose a different name. A view with this name already exists.")); return; }
    if (persist([...items, { id: crypto.randomUUID(), name: name.trim(), filters: { ...filters } }])) { setNaming(false); setName(""); }
  };
  return <div className="saved-profile-views">
    <div className="saved-view-actions">
      <Select className="select quiet-select" aria-label={t("Saved views")} value={active?.id ?? ""} onChange={(event) => {
        const item = items.find((entry) => entry.id === event.target.value); if (item) onApply({ ...item.filters });
      }}>
        <option value="">{t("Saved views")}{items.length ? ` · ${items.length}` : ""}</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </Select>
      {active && <button type="button" className="iconbtn" title={t("Remove saved view")} aria-label={t("Remove saved view")} onClick={() => persist(items.filter((item) => item.id !== active.id))}><CloseGlyph /></button>}
      <button type="button" className="btn ghost" aria-expanded={naming} disabled={items.length >= MAX_SAVED_PROFILE_ITEMS} onClick={() => { setNaming(!naming); setError(""); }}>{t("Save view")}</button>
    </div>
    {naming && <form className="management-name-row" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input className="input" autoFocus maxLength={64} aria-label={t("View name")} placeholder={t("A name for this view")} value={name} onChange={(event) => setName(event.target.value)} />
      <button className="btn" type="submit" disabled={!name.trim()}>{t("Save")}</button>
      <button className="iconbtn" type="button" title={t("Cancel")} aria-label={t("Cancel saving view")} onClick={() => setNaming(false)}><CloseGlyph /></button>
    </form>}
    {error && <p className="management-inline-error" role="alert">{error}</p>}
  </div>;
}

export function ProfileTemplateBar({ scope, settings, disabled, available, onApply }: {
  scope: string; settings: ProfileTemplateSettings; disabled: boolean;
  available(settings: ProfileTemplateSettings): boolean; onApply(settings: ProfileTemplateSettings): void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState(() => readItems("templates", scope));
  const [name, setName] = useState(""), [naming, setNaming] = useState(false), [chosen, setChosen] = useState("");
  const [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const persist = (next: ProfileTemplate[]) => {
    if (!saveItems("templates", scope, next)) { setError(t("This device could not save the template. Check local storage and try again.")); return false; }
    setItems(next); setError(""); return true;
  };
  const save = () => {
    if (disabled || !name.trim() || items.length >= MAX_SAVED_PROFILE_ITEMS) return;
    if (items.some((item) => item.name === name.trim())) { setError(t("Choose a different name. A template with this name already exists.")); return; }
    const id = crypto.randomUUID();
    if (persist([...items, { id, name: name.trim(), settings: profileTemplateSettings(settings) }])) { setChosen(id); setName(""); setNaming(false); setSaved(true); }
  };
  return <div className="profile-template-bar">
    <div className="profile-template-actions">
      <Select className="select quiet-select" aria-label={t("Profile template")} value={chosen} disabled={disabled} onChange={(event) => {
        const item = items.find((entry) => entry.id === event.target.value);
        if (!item) { setChosen(""); return; }
        if (!available(item.settings)) { setError(t("This template uses a browser or folder that is unavailable in this workspace.")); return; }
        setChosen(item.id); setError(""); setSaved(false); onApply(profileTemplateSettings(item.settings));
      }}>
        <option value="">{t("Start from a template")}</option>
        {items.map((item) => <option key={item.id} value={item.id} disabled={!available(item.settings)}>{item.name}</option>)}
      </Select>
      {chosen && <button type="button" className="iconbtn" disabled={disabled} title={t("Remove template")} aria-label={t("Remove template")} onClick={() => {
        if (persist(items.filter((item) => item.id !== chosen))) { setChosen(""); setSaved(false); }
      }}><CloseGlyph /></button>}
      <button type="button" className="btn ghost" disabled={disabled || items.length >= MAX_SAVED_PROFILE_ITEMS} aria-expanded={naming} onClick={() => { setNaming(!naming); setSaved(false); }}>{t("Save as template")}</button>
    </div>
    {naming && <form className="management-name-row" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input className="input" autoFocus aria-label={t("Template name")} placeholder={t("A name for these settings")} maxLength={64} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="btn" disabled={disabled || !name.trim()}>{t("Save")}</button>
      <button type="button" className="iconbtn" disabled={disabled} title={t("Cancel")} aria-label={t("Cancel saving template")} onClick={() => setNaming(false)}><CloseGlyph /></button>
    </form>}
    {naming && <p className="management-note">{t("Templates save browser, folder and display settings. Enter the proxy separately when you use one.")}</p>}
    {saved && <p className="management-note" role="status">{t("Template saved on this device for this workspace.")}</p>}
    {error && <p className="management-inline-error" role="alert">{error}</p>}
  </div>;
}

export function ProfileBatchOptions({ enabled, count, pattern, start, disabled, onEnabled, onCount, onPattern, onStart }: {
  enabled: boolean; count: string; pattern: string; start: string; disabled: boolean;
  onEnabled(value: boolean): void; onCount(value: string): void; onPattern(value: string): void; onStart(value: string): void;
}) {
  const { t } = useTranslation();
  const preview = useMemo(() => {
    if (!enabled) return { names: [], error: "" };
    try { return { names: batchProfileNames(Number(count), pattern, Number(start)), error: "" }; }
    catch (error) { return { names: [], error: error instanceof Error ? error.message : "" }; }
  }, [enabled, count, pattern, start]);
  return <section className="profile-batch-options">
    <label className="batch-toggle"><input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onEnabled(event.target.checked)} /><span>{t("Create several profiles")}</span></label>
    {enabled && <div className="batch-options-body">
      <div className="fld-row">
        <label className="fld batch-count"><span>{t("Quantity")}</span><input type="number" min={1} max={100} step={1} value={count} disabled={disabled} onChange={(event) => onCount(event.target.value)} /></label>
        <label className="fld grow"><span>{t("Naming rule")}</span><input value={pattern} disabled={disabled} maxLength={120} placeholder="Studio {n:2}" onChange={(event) => onPattern(event.target.value)} /></label>
        <label className="fld batch-start"><span>{t("Start at")}</span><input type="number" min={1} max={999999} step={1} value={start} disabled={disabled} onChange={(event) => onStart(event.target.value)} /></label>
      </div>
      <p className="management-note">{t("Use {n} for a number, or {n:2} for 01, 02… Each profile gets a new identity.")}</p>
      <div className="batch-name-preview" aria-label={t("Name preview")} aria-live="polite">
        {preview.error ? <span className="management-inline-error">{t(preview.error)}</span> : <>{preview.names.slice(0, 3).map((name) => <span key={name}>{name}</span>)}{preview.names.length > 3 && <span>… {preview.names.at(-1)}</span>}</>}
      </div>
    </div>}
  </section>;
}

export function ProfileCreationReceipt({ items, busy }: { items: BatchCreateItem[]; busy: boolean }) {
  const { t } = useTranslation();
  const created = items.filter((item) => item.state === "created").length;
  const labels = { queued: "Waiting", creating: "Creating…", created: "Created", failed: "Failed", uncertain: "Needs verification" };
  return <section className="profile-create-receipt" aria-label={t("Creation results")}>
    <div className="creation-progress" role="status" aria-live="polite"><span>{t("{created} of {total} created", { created, total: items.length })}</span><span>{busy ? t("Creating…") : t("Results saved in this dialog")}</span></div>
    <progress max={items.length} value={items.filter((item) => item.state !== "queued" && item.state !== "creating").length} aria-label={t("Creation progress")} />
    <ol>{items.map((item, index) => <li key={index} data-state={item.state}>
      <span className="creation-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{item.input.name || t("Automatic name")}</strong>{item.id && <small>{item.id}</small>}{item.error && <small className="management-inline-error">{t(item.error)}</small>}</div><span>{t(labels[item.state])}</span>
    </li>)}</ol>
    {items.some((item) => item.state === "uncertain") && <p className="management-note">{t("A request has an unknown result. Refresh the profile list and verify it before creating again.")}</p>}
  </section>;
}

export function ProfileCreateSummary({ browser, screen, platformOs, group, hasProxy, count }: {
  browser: string; screen: string; platformOs: string; group: string; hasProxy: boolean; count: number;
}) {
  const { t } = useTranslation();
  return <aside className="profile-create-summary" aria-label={t("New identity summary")}>
    <span className="management-eyebrow">{t("A new identity")}</span>
    <p>{t("A separate space, ready for its own work.")}</p>
    <dl>
      <div><dt>{t("Browser")}</dt><dd>{browser}</dd></div>
      <div><dt>{t("Screen")}</dt><dd>{screen || t("Chosen at creation")}</dd></div>
      <div><dt>{t("Operating system")}</dt><dd>{{ windows: "Windows", macos: "macOS", linux: "Linux" }[platformOs] || t("This computer")}</dd></div>
      <div><dt>{t("Group")}</dt><dd>{group || t("Ungrouped")}</dd></div>
      <div><dt>{t("Proxy")}</dt><dd>{hasProxy ? t("Custom proxy") : t("Direct connection")}</dd></div>
      <div><dt>{t("Quantity")}</dt><dd>{Number.isInteger(count) && count > 0 ? count : "—"}</dd></div>
    </dl>
    <p className="management-note">{t("The identity is generated when you create it. This summary shows your selected settings.")}</p>
  </aside>;
}

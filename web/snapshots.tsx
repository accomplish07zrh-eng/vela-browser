import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceBackupPreview } from "../src/workspace-backup.ts";
import { downloadWorkspaceBackup, inspectWorkspaceBackup } from "./api.ts";
import { confirmDialog } from "./dialog.tsx";
import { useTranslation } from "./i18n.tsx";
import "./snapshots.css";
import { TunBypassControl } from "./tun-bypass.tsx";

interface SnapshotMeta { id: string; at: number; reason: "before-change" | "backup" | "manual" | "before-rollback"; changed?: string[]; hasSession: boolean; bytes: number }

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

const FIELD_LABELS: Record<string, string> = {
  proxy: "Proxy", ua: "User agent", timezone: "Timezone", locale: "Language", screenWidth: "Screen", screenHeight: "Screen", fingerprintSeed: "Fingerprint seed",
  platformOs: "Operating system", hardware: "Hardware", firefox: "Firefox settings", webkit: "WebKit settings", displayScale: "Display scale", engine: "Browser", chromiumRuntime: "Browser",
};

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The profile detail panel's list of snapshots: take one, roll back to one, delete one. */
export function SnapshotsSection({ profileId, running }: { profileId: string; running: boolean }) {
  const { t, language } = useTranslation();
  const [items, setItems] = useState<SnapshotMeta[] | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const base = `/ui/api/profiles/${encodeURIComponent(profileId)}/snapshots`;
  const load = useCallback(() => call<{ snapshots: SnapshotMeta[] }>(base).then((data) => setItems(data.snapshots), () => setItems([])), [base]);
  useEffect(() => { void load(); }, [load]);
  const act = async (task: () => Promise<string>) => {
    setBusy(true); setMessage(null);
    try { setMessage({ text: await task() }); } catch (error) { setMessage({ text: t(error instanceof Error ? error.message : String(error)), bad: true }); }
    finally { setBusy(false); void load(); }
  };
  const reasonLabel = (meta: SnapshotMeta) => meta.reason === "before-change"
    ? t("Before changing {fields}", { fields: [...new Set((meta.changed ?? []).map((field) => t(FIELD_LABELS[field] ?? field)))].join(", ") || t("settings") })
    : meta.reason === "backup" ? t("Daily backup of sign-ins") : meta.reason === "manual" ? t("Saved by hand") : t("Before a rollback");
  const when = (at: number) => new Date(at).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" });
  return <section className="snapshots-section"><h3>{t("Snapshots")}</h3>
    <p className="snapshots-note">{t("Taken by themselves before a fingerprint or proxy change, and each day for sign-ins that changed. Rolling back keeps the name, group and tags.")}</p>
    <div className="snapshots-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void act(async () => { await call(base, "POST"); return t("Snapshot saved."); })}>{t("Save a snapshot now")}</button>
    </div>
    {message && <p className={`snapshots-message${message.bad ? " bad" : ""}`} role="status">{message.text}</p>}
    {items === null ? <i className="detail-skeleton" /> : items.length === 0 ? <p className="snapshots-empty">{t("No snapshots yet.")}</p> :
      <ol className="snapshots-list">{items.map((meta) => <li key={meta.id}>
        <div className="snapshot-main"><strong>{reasonLabel(meta)}</strong><span>{when(meta.at)} · {meta.hasSession ? t("with sign-ins") : t("without sign-ins")} · {size(meta.bytes)}</span></div>
        <div className="snapshot-actions">
          <button type="button" className="btn ghost xs" disabled={busy || running} title={running ? t("Close the browser first") : undefined}
            onClick={async () => {
              if (!await confirmDialog(t("Roll this profile back to {time}?", { time: when(meta.at) }) + "\n\n" + t("Its fingerprint, proxy and account details go back to how they were; its sign-ins come back at the next start. The current state is saved first, so you can undo this."), { confirmLabel: t("Roll back") })) return;
              void act(async () => { const result = await call<{ session: boolean }>(`${base}/${encodeURIComponent(meta.id)}/restore`, "POST"); return result.session ? t("Rolled back. Sign-ins come back at the next start.") : t("Rolled back."); });
            }}>{t("Roll back")}</button>
          <button type="button" className="btn ghost xs" disabled={busy} aria-label={t("Delete snapshot")} title={t("Delete snapshot")}
            onClick={async () => { if (await confirmDialog(t("Delete this snapshot?"), { danger: true, confirmLabel: t("Delete") })) void act(async () => { await call(`${base}/${encodeURIComponent(meta.id)}`, "DELETE"); return t("Snapshot deleted."); }); }}>×</button>
        </div>
      </li>)}</ol>}
  </section>;
}

/** Settings: the daily backup of sign-ins as a whole. */
export function BackupsCard({ flash }: { flash(message: string): void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ enabled: boolean; usage: { profiles: number; snapshots: number; bytes: number }; directory: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<any>("/ui/api/snapshots").then(setState, () => setState(null)); }, []);
  if (!state) return null;
  return <section className="settings-card backups-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v12H4z" /><path d="M8 7V5h8v2M9 13l2 2 4-4" /></svg><h2>{t("Snapshots and backups")}</h2></header>
    <div className="card-body">
      <p>{t("Before a fingerprint or proxy change, Vela Browser saves the profile as it was. Each day it also backs up the sign-ins that changed. Everything is encrypted with this computer's key, so a copied folder cannot be read. Roll back from a profile's details.")}</p>
      <div className="settings-row"><span>{t("Daily backup of sign-ins")}</span>
        <label className="plugin-switch"><input type="checkbox" role="switch" checked={state.enabled} disabled={busy}
          onChange={(event) => { setBusy(true); call<any>("/ui/api/snapshots", "POST", { enabled: event.target.checked }).then(setState, () => flash(t("Could not save"))).finally(() => setBusy(false)); }} />
          <span>{state.enabled ? t("On") : t("Off")}</span></label>
      </div>
      <div className="settings-row"><span>{t("Stored")}</span><strong>{t("{count} snapshots of {profiles} profiles · {size}", { count: state.usage.snapshots, profiles: state.usage.profiles, size: size(state.usage.bytes) })}</strong></div>
      <div className="plugin-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); call<any>("/ui/api/snapshots/backup", "POST").then((result) => { setState((current) => current ? { ...current, usage: result.usage } : current); flash(t("Backed up the sign-ins of {count} profiles.", { count: result.saved })); }, (error) => flash(String(error.message ?? error))).finally(() => setBusy(false)); }}>{t("Back up now")}</button>
      </div>
      <p className="cardnote">{t("Saved in")}: <span className="mono">{state.directory}</span></p>
    </div>
  </section>;
}

export function WorkspaceBackupCard({ onRestored, flash }: { onRestored(): void; flash(message: string): void }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<WorkspaceBackupPreview>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const act = async (action: "export" | "preview" | "restore") => {
    if (pending.current || (action !== "export" && !file)) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      if (action === "export") {
        const archive = await downloadWorkspaceBackup(passphrase, controller.signal);
        const url = URL.createObjectURL(archive);
        const link = document.createElement("a");
        link.href = url;
        link.download = `Vela-Workspace-${new Date().toISOString().slice(0, 10)}.vela-workspace`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setPassphrase("");
        setPreview(undefined);
      } else {
        const summary = await inspectWorkspaceBackup(file!, passphrase, action, controller.signal);
        setPreview(summary);
        if (action === "restore") {
          setPassphrase("");
          setPreview(undefined);
          onRestored();
          flash(t("Restored {count} profiles from the workspace backup.", { count: summary.profiles }));
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not process the workspace backup.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const ready = passphrase.trim().length >= 12 && !busy;
  return <section className="settings-card">
    <header><h2>{t("Workspace backup")}</h2></header>
    <div className="card-body">
      <p>{t("Save profiles, folders, deletion protection and the latest saved browser sessions in a passphrase-protected file.")}</p>
      <label className="settings-row"><span>{t("Backup passphrase")}</span>
        <input type="password" className="input" value={passphrase} maxLength={4096} autoComplete="new-password" disabled={busy}
          onChange={event => { setPassphrase(event.target.value); setPreview(undefined); }} />
      </label>
      <div className="plugin-actions">
        <button type="button" className="btn" disabled={!ready} onClick={() => void act("export")}>{t("Download workspace backup")}</button>
      </div>
      <label className="settings-row"><span>{t("Workspace backup file")}</span>
        <input type="file" accept=".vela-workspace" disabled={busy} onChange={event => { setFile(event.target.files?.[0]); setPreview(undefined); }} />
      </label>
      <div className="plugin-actions">
        <button type="button" className="btn" disabled={!ready || !file} onClick={() => void act("preview")}>{t("Preview workspace restore")}</button>
        {preview && <button type="button" className="btn accent" disabled={!ready || !!preview.conflicts.length} onClick={() => void act("restore")}>{t("Restore workspace backup")}</button>}
      </div>
      {busy && <p className="formnote" role="status">{t("Processing…")}</p>}
      {error && <p className="modal-err" role="alert">{t(error)}</p>}
      {preview && <div aria-live="polite">
        <p className="formnote">{t("{profiles} profiles, {folders} folders, {sessions} saved sessions and {protected} protected profiles.", {
          profiles: preview.profiles, folders: preview.folders, sessions: preview.savedSessions, protected: preview.protectedProfiles,
        })}</p>
        {preview.trashed > 0 && <p className="formnote">{t("{count} profiles will return to Trash.", { count: preview.trashed })}</p>}
        {preview.conflicts.length > 0 && <p className="modal-err">{t("{count} profile or folder conflicts block restoration.", { count: preview.conflicts.length })} {preview.conflicts.slice(0, 8).map(item => item.id).join(" · ")}</p>}
        {preview.heldProxies > 0 && <p className="formnote">{t("Choose a proxy for {count} restored profiles before opening them.", { count: preview.heldProxies })}</p>}
      </div>}
    </div>
  </section>;
}

/** Settings: encrypting account passwords, 2FA secrets, cookies and saved sign-ins at rest. */
export function DataEncryptionCard({ flash }: { flash(message: string): void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ enabled: boolean; protection: string; available?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call<any>("/ui/api/data-encryption").then(setState, () => setState(null)); }, []);
  if (!state) return null;
  const toggle = async (enabled: boolean) => {
    if (enabled && !await confirmDialog(t("Encrypt account passwords, 2FA secrets, cookies and saved sign-ins?") + "\n\n" + (state.protection === "dpapi"
      ? t("They will open only for this Windows account on this computer. If you reinstall Windows or move the data folder to another computer, export your profiles first.")
      : t("The key is a file in the data folder that only your account can read. A full copy of the folder can still be opened elsewhere.")), { confirmLabel: t("Encrypt") })) return;
    setBusy(true);
    try {
      const result = await call<any>("/ui/api/data-encryption", "POST", { enabled });
      setState((current) => current ? { ...current, enabled: result.enabled } : current);
      flash(result.unreadable ? t("Done. {count} values could not be read with this computer's key and were left as they were.", { count: result.unreadable }) : enabled ? t("Sensitive data is now encrypted.") : t("Sensitive data is stored unencrypted again."));
    } catch (error) { flash(t(error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); }
  };
  return <section className="settings-card encryption-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></svg><h2>{t("Encrypt sensitive data")}</h2></header>
    <div className="card-body">
      <p>{t("Account passwords, email passwords, 2FA secrets, imported cookies and saved sign-ins are kept in the profile database. Encrypted, a copy of that file is useless without this computer's key. Proxy pool secrets are always encrypted.")}</p>
      <div className="settings-row"><span>{t("Encrypt")}</span>
        <label className="plugin-switch"><input type="checkbox" role="switch" checked={state.enabled} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
          <span>{state.enabled ? t("On") : t("Off")}</span></label>
      </div>
      <p className="cardnote">{state.protection === "dpapi" ? t("Key protected by Windows for your account (DPAPI).") : t("Key stored in the data folder, readable only by your account.")}</p>
    </div>
  </section>;
}

/** Settings: the network path to profiles' proxies when a TUN proxy client runs on this computer. */
export function TunBypassCard() {
  const { t } = useTranslation();
  // Windows only (see egress-binding.ts); elsewhere the card is not shown.
  if (!/Win/i.test(navigator.platform || navigator.userAgent)) return null;
  return <section className="settings-card tun-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h5l2-5 2 10 2-5h5" /></svg><h2>{t("Around this computer's proxy client")}</h2></header>
    <div className="card-body">
      <p>{t("When Clash, mihomo or sing-box runs in TUN mode here, every profile's traffic goes through it before reaching the profile's own proxy: two proxies deep, and its rules decide the path. Turned on, Vela Browser reaches profiles' proxies directly.")}</p>
      <TunBypassControl />
    </div>
  </section>;
}

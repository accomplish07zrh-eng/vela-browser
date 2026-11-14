import { useEffect, useRef, useState } from "react";
import { fetchProfileEdit, type EditProfile, type UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import { profileNeedsAttention } from "./profile-management.ts";
import { trapDialogTab } from "./dialog-focus.ts";
import { TagChip } from "./tags.tsx";
import { SnapshotsSection } from "./snapshots.tsx";

type StoredSummary = Pick<EditProfile, "platformOs" | "resolution" | "timezone" | "locale" | "cores" | "hardware" | "extensions">;

export function ProfileDetailDrawer({ profile, number, browser, canEdit, busy, onClose, onEdit, onToggle, onCookies }: {
  profile: UiProfile; number: string; browser: string; canEdit: boolean; busy: boolean;
  onClose(): void; onEdit(): void; onToggle(): void; onCookies(): void;
}) {
  const { t, language } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null), closing = useRef(false);
  const live = useRef(true);
  const [detail, setDetail] = useState<StoredSummary | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { live.current = false; dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let live = true; setDetail(null); setError(false);
    void fetchProfileEdit(profile.id).then((stored) => {
      if (!live) return;
      // Retain only public settings; the edit response also contains website credentials.
      const { platformOs, resolution, timezone, locale, cores, hardware, extensions } = stored;
      setDetail({ platformOs, resolution, timezone, locale, cores, hardware, extensions });
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [profile.id, attempt]);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const element = dialog.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    const easing = getComputedStyle(element).getPropertyValue("--spring-layout").trim();
    const animation = element.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(32px)" }], { duration: 180, easing, fill: "forwards" });
    void animation.finished.catch(() => {}).then(() => { if (live.current) onClose(); });
  };
  const time = (value?: number) => value && Number.isFinite(value) ? new Date(value).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" }) : t("Not recorded");
  const status = profile.running ? t("running") : profile.lockedBy ? t("In use elsewhere") : t("Not started");
  const os = detail?.platformOs ? ({ windows: "Windows", macos: "macOS", linux: "Linux" }[detail.platformOs] ?? detail.platformOs) : "—";
  return <dialog ref={dialog} className="profile-detail-sheet" aria-labelledby="profile-detail-title" onKeyDown={trapDialogTab} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
    onPointerDown={(event) => { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientY < box.top || event.clientX > box.right || event.clientY > box.bottom) close(); }}>
    <header className="profile-detail-head"><span className="management-eyebrow">{t("Profile details")} <span>/{number}</span></span>
      <button autoFocus type="button" className="iconbtn" title={t("Close details")} aria-label={t("Close details")} onClick={close}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </header>
    <div className="profile-detail-scroll">
      <div className="profile-detail-title"><h2 id="profile-detail-title">{profile.name}</h2><span className="profile-detail-id">{profile.id}</span><span className="profile-detail-state"><i data-status={profileNeedsAttention(profile) ? "attention" : profile.running ? "running" : "idle"} />{status}{profileNeedsAttention(profile) && <> · {t("Needs attention")}</>}</span></div>
      <section><h3>{t("Stored fingerprint")}</h3>
        <dl>
          <div><dt>{t("Browser")}</dt><dd>{browser}</dd></div>
          <div><dt>{t("Operating system")}</dt><dd>{!detail && !error ? <i className="detail-skeleton" /> : os}</dd></div>
          <div><dt>{t("Screen")}</dt><dd>{detail?.resolution || profile.screen || "—"}</dd></div>
          <div><dt>{t("Timezone")}</dt><dd>{detail?.timezone || profile.timezone || "—"}</dd></div>
          <div><dt>{t("Language")}</dt><dd>{!detail && !error ? <i className="detail-skeleton" /> : detail?.locale || t("Browser default")}</dd></div>
          {detail?.hardware?.gpu && <div><dt>GPU</dt><dd>{detail.hardware.gpu}</dd></div>}
          {(detail?.cores || detail?.hardware?.cores) && <div><dt>CPU</dt><dd>{t("{count} cores", { count: detail.cores || detail.hardware!.cores! })}</dd></div>}
        </dl>
        {error && <div className="detail-load-error" role="status"><span>{t("Some saved settings could not be loaded.")}</span><button className="btn ghost" type="button" onClick={() => setAttempt((value) => value + 1)}>{t("Try again")}</button></div>}
        <p className="management-note">{t("Saved settings are shown here. Opening this panel does not run a fingerprint test.")}</p>
        {profile.fpVerdict && <p className={`detail-verdict ${profile.fpVerdict.verdict}`}>{profile.fpVerdict.verdict === "match" ? t("Last measured fingerprint matched the imported identity.") : t("Last measured fingerprint differed from the imported identity.")}</p>}
      </section>
      <section><h3>{t("Connection and storage")}</h3><dl>
        <div><dt>{t("Proxy")}</dt><dd>{profile.proxy || t("Direct connection")}</dd></div>
        {profile.proxyError && <div><dt>{t("Proxy status")}</dt><dd className="management-inline-error">{profile.proxyError}</dd></div>}
        <div><dt>{t("Group")}</dt><dd>{profile.group || t("Ungrouped")}</dd></div>
        <div><dt>{t("Platform")}</dt><dd>{profile.platform || "—"}</dd></div>
        <div><dt>{t("Cookies in saved profile")}</dt><dd>{profile.cookieCount}</dd></div>
        {!!profile.pendingCookieCount && <div><dt>{t("Cookies at next start")}</dt><dd><button className="detail-text-action" type="button" onClick={onCookies}>{profile.pendingCookieCount} · {t("View")}</button></dd></div>}
      </dl>{profile.tags.length > 0 && <div className="detail-tags">{profile.tags.map((tag) => <TagChip key={tag} tag={tag} />)}</div>}</section>
      <section><h3>{t("Launch activity")}</h3><dl>
        <div><dt>{t("Created at")}</dt><dd>{time(profile.createdAt)}</dd></div>
        <div><dt>{t("Last opened")}</dt><dd>{time(profile.lastOpenAt)}</dd></div>
        {profile.running && <div><dt>{t("Current session")}</dt><dd>{time(profile.startedAt)}</dd></div>}
      </dl>{profile.restartPending && <p className="management-note">{t("Saved changes apply at the next start.")}</p>}</section>
      {canEdit && <SnapshotsSection profileId={profile.id} running={profile.running} />}
    </div>
    <footer>{canEdit && <button type="button" className="btn" onClick={onEdit}>{t("Edit profile")}</button>}<span className="spacer" /><button type="button" className="btn primary" disabled={busy || !!profile.mobilePersona} onClick={onToggle}>{busy ? t("Processing…") : profile.running ? t("Close browser") : t("Open browser")}</button></footer>
  </dialog>;
}

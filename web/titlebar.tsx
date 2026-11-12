import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "./i18n.tsx";
import "./titlebar.css";

/** The desktop app on Windows and Linux draws its own title bar; macOS keeps the native one. */
export function usesOwnTitleBar(): boolean {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return false;
  return !/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

/**
 * A title bar in the app's own colours instead of the system's white one. The whole strip moves the
 * window and double-clicking it maximizes; the controls are drawn to match the app's icons.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    document.documentElement.setAttribute("data-titlebar", "");
    const window_ = getCurrentWindow();
    let alive = true;
    const read = () => { void window_.isMaximized().then((value) => { if (alive) setMaximized(value); }).catch(() => {}); };
    read();
    window.addEventListener("resize", read);
    return () => { alive = false; window.removeEventListener("resize", read); document.documentElement.removeAttribute("data-titlebar"); };
  }, []);
  const act = (action: "minimize" | "toggleMaximize" | "close") => { void getCurrentWindow()[action]().catch(() => {}); };
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-controls">
        <button type="button" aria-label={t("Minimize")} title={t("Minimize")} onClick={() => act("minimize")}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.25h7" /></svg>
        </button>
        <button type="button" aria-label={t(maximized ? "Restore" : "Maximize")} title={t(maximized ? "Restore" : "Maximize")} onClick={() => act("toggleMaximize")}>
          {maximized
            ? <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.25" y="3.75" width="6" height="6" rx="1.4" /><path d="M4.25 3.75V3.4c0-.78.63-1.4 1.4-1.4H8.6c.78 0 1.4.62 1.4 1.4v2.95c0 .78-.62 1.4-1.4 1.4h-.35" /></svg>
            : <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" rx="1.6" /></svg>}
        </button>
        <button type="button" className="close" aria-label={t("Close")} title={t("Close")} onClick={() => act("close")}>
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
        </button>
      </div>
    </header>
  );
}

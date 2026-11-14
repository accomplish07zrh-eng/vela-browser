import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "./i18n.tsx";
import "./shortcuts.css";

/**
 * Keyboard shortcuts for the whole dashboard. They do nothing while you type in a field or work
 * inside a browser on the workbench, so they never take a key from a page.
 */
export interface Shortcut { id: string; label: string; keys: string; group: "Go to" | "Do" }
export const SHORTCUTS: Shortcut[] = [
  { id: "palette", label: "Search and commands", keys: "Mod+K", group: "Do" },
  { id: "new", label: "New Profile", keys: "Mod+N", group: "Do" },
  { id: "import", label: "Import profiles", keys: "Mod+I", group: "Do" },
  { id: "health", label: "Self-check every profile", keys: "Mod+Shift+H", group: "Do" },
  { id: "theme", label: "Switch light and dark", keys: "Mod+Shift+L", group: "Do" },
  { id: "shortcuts", label: "Keyboard shortcuts", keys: "?", group: "Do" },
  { id: "workbench", label: "Multi-view workbench", keys: "Mod+1", group: "Go to" },
  { id: "profiles", label: "All profiles", keys: "Mod+2", group: "Go to" },
  { id: "proxies", label: "Proxies", keys: "Mod+3", group: "Go to" },
  { id: "scripts", label: "Scripts", keys: "Mod+4", group: "Go to" },
  { id: "trash", label: "Trash", keys: "Mod+5", group: "Go to" },
  { id: "extensions", label: "Extensions", keys: "Mod+6", group: "Go to" },
  { id: "settings", label: "Settings", keys: "Mod+,", group: "Go to" },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "Mod+Shift+H" as this computer writes it: ⌘⇧H on a Mac, Ctrl+Shift+H elsewhere. */
export function keyLabel(keys: string): string {
  if (keys === "?") return "?";
  const parts = keys.split("+");
  return isMac ? parts.map((part) => ({ Mod: "⌘", Shift: "⇧", Alt: "⌥" }[part] ?? part)).join("") : parts.map((part) => part === "Mod" ? "Ctrl" : part).join("+");
}

function matches(keys: string, event: KeyboardEvent): boolean {
  if (keys === "?") return event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey;
  const parts = keys.split("+"), key = parts.at(-1)!.toLowerCase();
  const mod = parts.includes("Mod"), shift = parts.includes("Shift");
  return (isMac ? event.metaKey : event.ctrlKey) === mod && event.shiftKey === shift && !event.altKey && (event.key.toLowerCase() === key || event.code === `Digit${key}`);
}

/** Typing somewhere, or working in a browser on the workbench: shortcuts stay out of the way. */
function typing(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || !!element.closest(".viewport-input, .browser-viewport.expanded");
}

export function useShortcuts(run: (id: string) => void): void {
  const handler = useRef(run);
  handler.current = run;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || typing(event.target)) return;
      // A dialog of its own keeps the keys, except the one that shows this list.
      const shortcut = SHORTCUTS.find((item) => item.id !== "palette" && matches(item.keys, event));
      if (!shortcut) return;
      if (document.querySelector("dialog[open]") && shortcut.id !== "shortcuts") return;
      event.preventDefault();
      handler.current(shortcut.id);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/** The list of shortcuts, opened with ? or from the command palette. */
export function ShortcutsSheet({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const groups = ["Do", "Go to"] as const;
  return <dialog ref={dialog} className="modal shortcuts-modal" aria-labelledby="shortcuts-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); }}>
    <div className="modal-head"><span id="shortcuts-title">{t("Keyboard shortcuts")}</span>
      <button className="modal-close" type="button" aria-label={t("Close")} onClick={onClose}><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </div>
    <div className="modal-body shortcuts-body">
      {groups.map((group) => <section key={group}><h3>{t(group)}</h3>
        <dl>{SHORTCUTS.filter((item) => item.group === group).map((item) => <div key={item.id}><dt>{t(item.label)}</dt><dd><kbd>{keyLabel(item.keys)}</kbd></dd></div>)}</dl>
      </section>)}
      <p className="cardnote">{t("Shortcuts wait while you type in a field or work inside a browser on the workbench.")}</p>
    </div>
  </dialog>;
}

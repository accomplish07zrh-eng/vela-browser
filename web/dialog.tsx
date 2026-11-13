import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "./i18n.tsx";
import "./dialog.css";

/**
 * Vela Browser's own confirm and notice dialogs, in place of the browser's: those open as a plain
 * system box in the desktop window ("localhost says"), in English, outside the app's look.
 * `await confirmDialog(text)` reads like `confirm(text)`. Text with blank lines between
 * paragraphs shows its first paragraph as the question and the rest underneath.
 */
export interface DialogOptions {
  /** The heading; without it the first paragraph of the text is the heading. */
  title?: string;
  /** The button that answers yes. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** A destructive answer: the button is drawn in red and Cancel holds the focus. */
  danger?: boolean;
}

interface Request extends DialogOptions {
  id: number;
  kind: "confirm" | "notice";
  message: string;
  resolve: (answer: boolean) => void;
}

const queue: Request[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function ask(kind: Request["kind"], message: string, options: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...options, id: ++nextId, kind, message, resolve });
    for (const listener of listeners) listener();
  });
}

export function confirmDialog(message: string, options: DialogOptions = {}): Promise<boolean> {
  return ask("confirm", message, options);
}

export async function noticeDialog(message: string, options: Omit<DialogOptions, "danger" | "cancelLabel"> = {}): Promise<void> {
  await ask("notice", message, options);
}

/** Splits the text into a heading and the paragraphs under it. */
export function dialogParts(message: string, title?: string): { heading: string; body: string[] } {
  const paragraphs = message.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (title) return { heading: title, body: paragraphs };
  // The question leads, wherever the text puts it; the explanation stays in its order beneath.
  const question = Math.max(0, paragraphs.findIndex((part) => /[?？]$/.test(part)));
  return { heading: paragraphs[question] ?? "", body: paragraphs.filter((_, index) => index !== question) };
}

export function DialogHost() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<Request | null>(null);
  const [leaving, setLeaving] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const next = () => setCurrent((shown) => shown ?? queue[0] ?? null);
    listeners.add(next);
    next();
    return () => { listeners.delete(next); };
  }, []);

  useLayoutEffect(() => {
    if (!current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    card.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [current?.id]);

  if (!current) return null;

  const answer = (value: boolean) => {
    if (leaving) return;
    setLeaving(true);
    const request = current;
    window.setTimeout(() => {
      queue.splice(queue.indexOf(request), 1);
      request.resolve(value);
      setLeaving(false);
      setCurrent(queue[0] ?? null);
      if (!queue.length) returnFocus.current?.focus?.();
    }, 140);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); answer(current.kind === "notice"); return; }
    if (event.key !== "Tab") return;
    const buttons = [...(card.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };

  const { heading, body } = dialogParts(current.message, current.title);
  const notice = current.kind === "notice";
  const danger = !!current.danger && !notice;
  return createPortal(
    <div className={`modal-backdrop vdialog-backdrop${leaving ? " leaving" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget) answer(notice); }}>
      <div
        ref={card}
        className={`modal vdialog${danger ? " danger" : ""}${leaving ? " leaving" : ""}`}
        role={notice ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={`vdialog-${current.id}`}
        aria-describedby={body.length ? `vdialog-${current.id}-body` : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="vdialog-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">{danger
            ? <><path className="duo" d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0zM12 9.5v4M12 17v.3" /></>
            : notice
              ? <><circle className="duo" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /><path d="m8.2 12.3 2.6 2.6 5-5.3" /></>
              : <><circle className="duo" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /><path d="M9.4 9.1a2.7 2.7 0 0 1 5.3.7c0 1.8-2.7 2.2-2.7 3.7M12 16.8v.3" /></>}
          </svg>
        </div>
        <h2 id={`vdialog-${current.id}`} className="vdialog-heading">{heading}</h2>
        {!!body.length && <div id={`vdialog-${current.id}-body`} className="vdialog-body">{body.map((part, index) => <p key={index}>{part}</p>)}</div>}
        <div className="modal-foot vdialog-foot">
          {!notice && <button type="button" className="btn ghost" data-autofocus={danger || undefined} onClick={() => answer(false)}>{current.cancelLabel ?? t("Cancel")}</button>}
          <button type="button" className={`btn ${danger ? "solid-danger" : "primary"}`} data-autofocus={!danger || undefined} onClick={() => answer(true)}>
            {current.confirmLabel ?? t(notice ? "Got it" : "Confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

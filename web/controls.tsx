import { useRef, type InputHTMLAttributes } from "react";
import "./controls.css";

/**
 * A number field with the app's own stepper in place of the system's tiny arrows. It is a plain
 * `<input type="number">` underneath: typing, arrow keys and onChange work as before; the stepper
 * steps it the way the arrow keys do, so min, max and step hold.
 */
export function NumberInput({ className, disabled, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const input = useRef<HTMLInputElement>(null);
  const step = (direction: 1 | -1) => {
    const field = input.current;
    if (!field || field.disabled || field.readOnly) return;
    if (field.value === "") {
      const floor = field.min !== "" ? Number(field.min) : 0;
      field.value = String(floor);
    } else if (direction > 0) field.stepUp();
    else field.stepDown();
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus({ preventScroll: true });
  };
  return <span className={`vnumber${disabled ? " disabled" : ""}`}>
    <input ref={input} type="number" className={className} disabled={disabled} {...props} />
    <span className="vnumber-steps" aria-hidden="true">
      <button type="button" tabIndex={-1} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => step(1)}>
        <svg viewBox="0 0 12 12"><path d="M3 7.5 6 4.5l3 3" /></svg>
      </button>
      <button type="button" tabIndex={-1} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => step(-1)}>
        <svg viewBox="0 0 12 12"><path d="M3 4.5 6 7.5l3-3" /></svg>
      </button>
    </span>
  </span>;
}

/**
 * In the desktop window, a right click outside text shows nothing instead of the web view's own
 * menu (Back, Refresh, Save as, Print). Fields and selected text keep it, for copy and paste.
 * In a normal browser tab the page keeps the browser's menu.
 */
export function guardContextMenu(target: Document = document): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => {};
  const listener = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const element = event.target instanceof Element ? event.target : null;
    if (element?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    if ((target.getSelection()?.toString() ?? "").trim()) return;
    event.preventDefault();
  };
  target.addEventListener("contextmenu", listener);
  return () => target.removeEventListener("contextmenu", listener);
}

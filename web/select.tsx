import { Children, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./select.css";

interface Choice { value: string; label: ReactNode; text: string; disabled: boolean; group?: string }

function text(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement(node)) return text((node.props as { children?: ReactNode }).children);
  return "";
}

/** The <option>s and <optgroup>s written inside, however they were composed. */
export function choices(children: ReactNode, group?: string, into: Choice[] = []): Choice[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const props = child.props as { value?: unknown; children?: ReactNode; disabled?: boolean; label?: string };
    if (child.type === "option") {
      const label = props.children;
      into.push({ value: props.value === undefined ? text(label) : String(props.value), label, text: text(label), disabled: !!props.disabled, group });
    } else if (child.type === "optgroup") choices(props.children, props.label, into);
    else choices(props.children, group, into);
  });
  return into;
}

export interface SelectProps {
  value?: string | number;
  onChange?: (event: { target: { value: string }; currentTarget: { value: string } }) => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  title?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/**
 * A drop-in for <select>, written the same way: value, onChange reading event.target.value, and
 * <option>/<optgroup> children. The closed control keeps the field look; the list opens as a
 * floating sheet in the app's own style instead of the system's menu, with full keyboard support.
 */
export function Select({ value, onChange, children, className, disabled, id, title, style, autoFocus, ...aria }: SelectProps) {
  const list = useMemo(() => choices(children), [children]);
  const current = String(value ?? list[0]?.value ?? "");
  const selected = list.find((choice) => choice.value === current) ?? list[0];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const choose = useCallback((choice: Choice | undefined) => {
    if (!choice || choice.disabled) return;
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
    if (choice.value !== current) onChange?.({ target: { value: choice.value }, currentTarget: { value: choice.value } });
  }, [current, onChange]);

  const measure = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const wanted = Math.min(320, list.length * 34 + 12);
    const up = below < Math.min(wanted, 200) && above > below;
    const maxHeight = Math.max(120, Math.min(320, up ? above : below));
    setPlace({ left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)), top: up ? rect.top - 6 : rect.bottom + 6, width: Math.max(rect.width, 180), maxHeight, up });
  }, [list.length]);

  useLayoutEffect(() => { if (open) measure(); }, [open, measure]);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, list.findIndex((choice) => choice.value === current)));
    const away = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const reposition = (event: Event) => { if (!panel.current?.contains(event.target as Node)) measure(); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", reposition, true);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("resize", measure); window.removeEventListener("scroll", reposition, true); };
  }, [open, list, current, measure]);
  useEffect(() => {
    if (!open || active < 0) return;
    panel.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const step = (from: number, by: number) => {
    for (let index = from + by; index >= 0 && index < list.length; index += by) if (!list[index]!.disabled) return index;
    return from;
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;
    const key = event.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") { event.preventDefault(); setOpen(true); }
      return;
    }
    if (key === "Escape" || key === "Tab") { if (key === "Escape") event.preventDefault(); setOpen(false); return; }
    if (key === "ArrowDown") { event.preventDefault(); setActive((index) => step(index, 1)); return; }
    if (key === "ArrowUp") { event.preventDefault(); setActive((index) => step(index, -1)); return; }
    if (key === "Home") { event.preventDefault(); setActive(step(-1, 1)); return; }
    if (key === "End") { event.preventDefault(); setActive(step(list.length, -1)); return; }
    if (key === "Enter" || key === " ") { event.preventDefault(); choose(list[active]); return; }
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing jumps to the first choice that starts with what was typed.
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + key.toLowerCase(), at: now };
      const found = list.findIndex((choice) => !choice.disabled && choice.text.toLowerCase().startsWith(typed.current.text));
      if (found >= 0) setActive(found);
    }
  };

  let lastGroup: string | undefined;
  return <>
    <button ref={trigger} type="button" id={id} title={title} style={style} autoFocus={autoFocus} disabled={disabled}
      className={`${className ?? "select"} vselect${open ? " open" : ""}`} role="combobox" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
      {...aria} onClick={() => !disabled && setOpen((value) => !value)} onKeyDown={onKeyDown}>
      <span className="vselect-value">{selected?.label ?? ""}</span>
      <svg className="vselect-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.75 3 3 3-3" /></svg>
    </button>
    {open && place && createPortal(
      <div ref={panel} id={listId} role="listbox" className={`vselect-panel${place.up ? " up" : ""}`} tabIndex={-1}
        style={{ left: place.left, top: place.top, minWidth: place.width, maxHeight: place.maxHeight }} onKeyDown={onKeyDown}>
        {list.map((choice, index) => {
          const header = choice.group && choice.group !== lastGroup ? <div className="vselect-group" key={`group-${index}`}>{choice.group}</div> : null;
          lastGroup = choice.group;
          return [header,
            <div key={`${choice.value}-${index}`} id={`${listId}-${index}`} data-index={index} role="option" aria-selected={choice.value === current} aria-disabled={choice.disabled || undefined}
              className={`vselect-option${index === active ? " active" : ""}${choice.value === current ? " selected" : ""}${choice.disabled ? " disabled" : ""}`}
              onPointerEnter={() => !choice.disabled && setActive(index)} onPointerDown={(event) => event.preventDefault()} onClick={() => choose(choice)}>
              <span className="vselect-label">{choice.label}</span>
              <svg className="vselect-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 2.9 2.8 6.1-6.4" /></svg>
            </div>];
        })}
      </div>,
      document.querySelector(".app") ?? document.body,
    )}
  </>;
}

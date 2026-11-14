import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TOP_LAYER_PROPS, useTopLayer } from "./top-layer.ts";
import { updateProfileTags } from "./api.ts";
import { useTranslation } from "./i18n.tsx";
import "./tags.css";

/**
 * Tags are the operator's own labels, kept apart from groups: a group is where a profile lives (one
 * each), tags say what it is (any number). Each tag keeps one colour everywhere it appears.
 */
const TAG_TONES = 8;
export function tagTone(tag: string): number {
  let hash = 0;
  for (const character of tag.trim().toLowerCase()) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % TAG_TONES;
}

/** Splits typed text into tags: commas (either width), semicolons and new lines separate them. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const part of text.split(/[,，;；\n]/)) {
    const tag = part.trim().slice(0, 40);
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); out.push(tag); }
  }
  return out;
}

export function TagChip({ tag, active, onClick, onRemove, title }: { tag: string; active?: boolean; onClick?(): void; onRemove?(): void; title?: string }) {
  const { t } = useTranslation();
  const tone = `tag-chip tone-${tagTone(tag)}${active ? " active" : ""}${onClick ? " clickable" : ""}`;
  const body = <><i aria-hidden="true" /><span>{tag}</span></>;
  return <span className={tone} title={title ?? tag}>
    {onClick ? <button type="button" onClick={(event) => { event.stopPropagation(); onClick(); }} aria-pressed={active}>{body}</button> : body}
    {onRemove && <button type="button" className="tag-chip-remove" aria-label={t("Remove tag {tag}", { tag })} onClick={(event) => { event.stopPropagation(); onRemove(); }}>×</button>}
  </span>;
}

/** A row of tags that stays one line: the first few, then “+N”. */
export function TagList({ tags, max = 3, activeTag, onPick }: { tags: string[]; max?: number; activeTag?: string; onPick?(tag: string): void }) {
  if (!tags.length) return null;
  const shown = tags.slice(0, max), rest = tags.slice(max);
  return <span className="tag-list">
    {shown.map((tag) => <TagChip key={tag} tag={tag} active={activeTag === tag} onClick={onPick ? () => onPick(tag) : undefined} />)}
    {rest.length > 0 && <span className="tag-more" title={rest.join(", ")}>+{rest.length}</span>}
  </span>;
}

/** Typing a tag and pressing Enter (or a comma) adds it; existing tags are offered as you type. */
export function TagInput({ value, onChange, suggestions, placeholder, autoFocus, label }: {
  value: string[]; onChange(next: string[]): void; suggestions: string[]; placeholder?: string; autoFocus?: boolean; label?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(""), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), panel = useRef<HTMLDivElement>(null), listId = useId();
  const matches = useMemo(() => {
    const query = draft.trim().toLowerCase(), taken = new Set(value.map((item) => item.toLowerCase()));
    return suggestions.filter((tag) => !taken.has(tag.toLowerCase()) && (!query || tag.toLowerCase().includes(query))).slice(0, 8);
  }, [draft, suggestions, value]);
  const showing = open && matches.length > 0 && !!place;
  useTopLayer(panel, showing);
  useLayoutEffect(() => {
    if (!open || !box.current) { setPlace(null); return; }
    const rect = box.current.getBoundingClientRect();
    setPlace({ left: rect.left, top: rect.bottom + 4, width: rect.width });
  }, [open, value.length]);
  const add = (text: string) => {
    const next = [...value];
    for (const tag of parseTags(text)) if (!next.some((item) => item.toLowerCase() === tag.toLowerCase())) next.push(tag);
    if (next.length !== value.length) onChange(next);
    setDraft(""); setActive(-1); setOpen(false);
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
      event.preventDefault(); setOpen(true);
      setActive((current) => event.key === "ArrowDown" ? (current + 1) % matches.length : (current <= 0 ? matches.length : current) - 1);
      return;
    }
    if (event.key === "Enter") {
      // Never submits the surrounding form: Enter belongs to the tag being typed.
      event.preventDefault();
      if (showing && active >= 0 && matches[active]) add(matches[active]!); else if (draft.trim()) add(draft);
      return;
    }
    if (event.key === "Tab" && draft.trim()) { event.preventDefault(); add(draft); return; }
    if (event.key === "Backspace" && !draft && value.length) { onChange(value.slice(0, -1)); return; }
    if (event.key === "Escape" && showing) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
  };
  return <div ref={box} className="tag-input" onClick={() => input.current?.focus()}>
    {value.map((tag) => <TagChip key={tag} tag={tag} onRemove={() => onChange(value.filter((item) => item !== tag))} />)}
    <input ref={input} className="tag-draft" value={draft} autoFocus={autoFocus} aria-label={label ?? t("Tags")} placeholder={value.length ? "" : placeholder ?? t("Type a tag, then Enter")}
      role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
      onChange={(event) => { const text = event.target.value; if (/[,，;；]/.test(text)) add(text); else { setDraft(text); setOpen(!!text.trim()); setActive(-1); } }}
      onBlur={() => { setOpen(false); if (draft.trim()) add(draft); }} onKeyDown={key}
      onPaste={(event) => { const text = event.clipboardData.getData("text/plain"); if (/[,，;；\n]/.test(text)) { event.preventDefault(); add(draft + text); } }} />
    {showing && <div ref={panel} {...TOP_LAYER_PROPS} className="tag-suggestions" role="listbox" id={listId} style={{ left: place!.left, top: place!.top, minWidth: Math.min(place!.width, 320) }}>
      {matches.map((tag, index) => <button key={tag} id={`${listId}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === active} className={index === active ? "active" : ""}
        onMouseDown={(event) => { event.preventDefault(); add(tag); }}><TagChip tag={tag} /></button>)}
    </div>}
  </div>;
}

/** Add tags to, or take tags off, every selected profile at once. */
export function TagBatchDialog({ profiles, suggestions, onClose, onDone }: {
  profiles: Array<{ id: string; tags?: string[] }>; suggestions: string[]; onClose(): void; onDone(changed: number): void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [add, setAdd] = useState<string[]>([]), [remove, setRemove] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const present = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of profiles) for (const tag of profile.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [profiles]);
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const adding = new Set(add.map((tag) => tag.toLowerCase()));
      const result = await updateProfileTags(profiles.map((profile) => profile.id), add, [...remove].filter((tag) => !adding.has(tag.toLowerCase())));
      if (result.ok === false) throw new Error(result.error || "Could not change the tags");
      onDone(result.changed ?? 0);
    } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); setBusy(false); }
  };
  return <dialog ref={dialog} className="modal tag-batch-modal" aria-labelledby="tag-batch-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-head"><span id="tag-batch-title">{t("Tags for {count} profiles", { count: profiles.length })}</span>
      <button className="modal-close" type="button" aria-label={t("Close")} onClick={onClose}><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </div>
    <div className="modal-body tag-batch">
      <div className="fld"><span>{t("Add")}</span>
        <TagInput value={add} onChange={setAdd} suggestions={suggestions} autoFocus label={t("Tags to add")} />
      </div>
      {present.length > 0 && <div className="fld"><span>{t("Remove")}</span>
        <div className="tag-batch-row">{present.map(([tag, count]) => <TagChip key={tag} tag={remove.has(tag) ? `${tag} · ${t("remove")}` : `${tag} · ${count}`} active={remove.has(tag)}
          title={t("{count} of the selected profiles have this tag", { count })}
          onClick={() => setRemove((current) => { const next = new Set(current); if (next.has(tag)) next.delete(tag); else next.add(tag); return next; })} />)}</div>
        <small>{t("Click a tag to take it off every selected profile.")}</small>
      </div>}
      {error && <p className="recording-error" role="alert">{error}</p>}
    </div>
    <div className="modal-foot">
      <button type="button" className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
      <button type="button" className="btn primary" disabled={busy || (!add.length && !remove.size)} onClick={() => void apply()}>{busy ? t("Saving…") : t("Apply")}</button>
    </div>
  </dialog>;
}

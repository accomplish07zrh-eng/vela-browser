import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchScripts, type UiProfile } from "./api.ts";
import { useTranslation } from "./i18n.tsx";

export interface SearchTarget { kind: "profile" | "group" | "proxy" | "script" | "command"; id: string }
interface SearchEntry extends SearchTarget { label: string; detail: string; words?: string; keys?: string }

function proxyAddress(proxy: string): string {
  const publicPart = proxy.replace(/\/\/[^/]*@/, "//");
  const match = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^:/]+):(\d+)/i.exec(publicPart);
  return match ? `${match[1]}:${match[2]}` : "";
}

/** An index into the existing workspace; selecting a script never runs it. */
export function CommandPalette({ profiles, groups, commands, onChoose }: {
  profiles: UiProfile[]; groups: string[]; commands: { id: string; label: string; keys?: string }[];
  onChoose(target: SearchTarget): void;
}) {
  const { t } = useTranslation(), listId = useId();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(0);
  const [scripts, setScripts] = useState<{ id: string; name: string }[]>([]), [loading, setLoading] = useState(false);
  const [scriptError, setScriptError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen((value) => !value);
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, []);
  useEffect(() => {
    if (!open) { dialog.current?.close(); return; }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(""); setActive(0); dialog.current?.showModal(); input.current?.focus();
    let live = true; setLoading(true); setScriptError(false);
    void fetchScripts().then((items) => { if (live) setScripts(items); }).catch(() => { if (live) { setScripts([]); setScriptError(true); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; dialog.current?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  const entries = useMemo<SearchEntry[]>(() => [
    ...commands.map((command) => ({ kind: "command" as const, id: command.id, label: command.label, detail: t("Command"), ...(command.keys ? { keys: command.keys } : {}) })),
    ...profiles.filter((profile) => !profile.lockedBy).map((profile) => ({ kind: "profile" as const, id: profile.id, label: profile.name, detail: `${profile.customNo || profile.serial || profile.id} · ${profile.running ? t("running") : t("Not started")}`, words: `${profile.id} ${profile.group} ${(profile.tags ?? []).join(" ")}` })),
    ...groups.map((name) => ({ kind: "group" as const, id: name, label: name, detail: t("Group") })),
    ...profiles.filter((profile) => profile.proxy).map((profile) => ({ kind: "proxy" as const, id: profile.id, label: proxyAddress(profile.proxy!) || t("Proxy"), detail: `${t("Proxy")} · ${profile.name}` })),
    ...scripts.map((script) => ({ kind: "script" as const, id: script.id, label: script.name, detail: t("Script") })),
  ], [profiles, groups, commands, scripts, t]);
  const results = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/);
    return entries.filter((entry) => words.every((word) => `${entry.label} ${entry.detail} ${entry.words ?? ""}`.toLocaleLowerCase().includes(word))).slice(0, 60);
  }, [entries, query]);
  useEffect(() => { setActive(0); }, [query]);
  const index = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => { dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [index, query]);
  const choose = (entry: SearchEntry) => { setOpen(false); onChoose(entry); };
  return <>
    <button className="iconbtn workspace-search" type="button" title={t("Search workspace · Ctrl+K")} aria-label={t("Search workspace · Ctrl+K")} onClick={() => setOpen(true)}>
      <svg viewBox="0 0 24 24" className="icon" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
    </button>
    <dialog ref={dialog} className="workspace-index" aria-label={t("Search workspace")} onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onPointerDown={(event) => { const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) setOpen(false); }}>
      <header><span>{t("Go somewhere")}</span><kbd>Esc</kbd></header>
      <input ref={input} type="search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${index}` : undefined}
        aria-label={t("Search environments, groups, proxies, scripts or commands")} placeholder={t("Search environments, groups, proxies, scripts or commands")} value={query}
        onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((old) => (old + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, results.length)) % Math.max(1, results.length)); }
          if (event.key === "Enter" && results[index]) { event.preventDefault(); choose(results[index]); }
        }} />
      <div id={listId} className="workspace-index-results" role="listbox" aria-label={t("Workspace results")}>
        {results.map((entry, order) => <button type="button" role="option" tabIndex={-1} id={`${listId}-${order}`} key={`${entry.kind}-${entry.id}`} aria-selected={order === index}
          onPointerMove={() => setActive(order)} onClick={() => choose(entry)}><span className="workspace-index-number">{String(order + 1).padStart(2, "0")}</span><span>{entry.label}</span><small>{entry.keys ? <kbd>{entry.keys}</kbd> : entry.detail}</small></button>)}
        {!results.length && <p className="workspace-index-empty">{t("Nothing here yet. Try another name.")}</p>}
        {loading && <div className="workspace-index-skeleton" aria-label={t("Loading scripts…")}><i /><i /></div>}
      </div>
      <footer><span>{scriptError ? t("Scripts could not be loaded. Other results are available.") : t("↑ ↓ to move · Enter to open")}</span><span>Ctrl K</span></footer>
    </dialog>
  </>;
}

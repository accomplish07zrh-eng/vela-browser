import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Select } from "./select.tsx";
import { flushSync } from "react-dom";
import { folderScope, folderTree, type FolderInfo } from "../src/folders.ts";
import { closeProfile, fetchScriptRun, moveProfiles, openProfile, raiseProfile, updateProfile, type UiProfile, type ScriptRun } from "./api.ts";
import { parsePastedProxy } from "./proxy-input.ts";
import type { WorkbenchInput, WorkbenchRefreshTier } from "../src/workbench-protocol.ts";
import { useTranslation } from "./i18n.tsx";
import { ViewportClient, type ViewportState } from "./workbench-client.ts";
import { VirtualCursor } from "./virtual-cursor.tsx";
import { RecordingDialog } from "./recording-dialog.tsx";
import { FirstRunGuide, firstRunDismissed } from "./first-run.tsx";
import { workbenchLayout, workbenchPosition, workbenchLocate, workbenchSnap, workbenchSpring, workbenchFocusBox, workbenchRefreshTier, viewportPoint, workbenchFollowerInput, type ViewportBox } from "./workbench-layout.ts";
import "./workbench.css";

type GlyphName = "expand" | "shrink" | "tabs" | "close" | "plus" | "left" | "right" | "refresh" | "play" | "pause" | "grid" | "ring" | "search" | "raise" | "master" | "link" | "code" | "proxy" | "eye" | "lanes" | "record" | "stop";
function Glyph({ name }: { name: GlyphName }) {
  const paths: Record<GlyphName, string> = {
    expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", shrink: "M3 8h5V3m8 0v5h5M8 21v-5H3m18 0h-5v5", tabs: "M8 4h12v13M4 8h12v12H4z", close: "m6 6 12 12M6 18 18 6", plus: "M12 5v14M5 12h14", left: "m14 6-6 6 6 6", right: "m10 6 6 6-6 6", refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5", play: "m9 5 11 7-11 7V5Z", pause: "M9 5v14M15 5v14",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", ring: "M22 12c0 4-4.5 7-10 7S2 16 2 12s4.5-7 10-7 10 3 10 7Zm-6-2 3 3 3-3", lanes: "M3 6.5h11M10 12h11M3 17.5h11M18 6.5h3M3 12h3M18 17.5h3", eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", search: "M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z", raise: "M14 3h7v7m0-7L10 14M10 5H3v16h16v-7", master: "M4 18.5h16M5 15.5 3.5 7l5 3.5L12 5l3.5 5.5 5-3.5L19 15.5Z",
    link: "m9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 1-1a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18", proxy: "M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z", record: "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-4a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", stop: "M7 7h10v10H7z",
  };
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function KernelIcon({ engine }: { engine: UiProfile["engine"] }) {
  return <svg className="viewport-kernel" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-label={engine === "firefox" ? "Firefox" : engine === "webkit" ? "WebKit" : "Chromium"} role="img">
    {engine === "firefox" ? <path d="M5 8 6 3l4 3c8-3 13 5 9 11S5 23 3 15c-1-3 0-5 2-7Zm2 2c-1 5 2 8 6 7 4-1 5-5 2-7" /> : engine === "webkit" ? <><circle cx="12" cy="12" r="9" /><path d="m15 8-2 6-5 2 2-6 5-2Z" /></> : <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="M12 8h8M8.5 14l-4-7m9.5 8-4 6" /></>}
  </svg>;
}
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => Number(event.altKey) + Number(event.ctrlKey) * 2 + Number(event.metaKey) * 4 + Number(event.shiftKey) * 8;
const numberOf = (profile: UiProfile) => profile.customNo || (profile.serial != null ? String(profile.serial).padStart(2, "0") : profile.id.slice(0, 4));
function groupColor(group: string): string {
  const palette = ["#9b9283", "#b5aa98", "#817b70", "#a69e90", "#b9b1a4", "#8f897d"];
  return group ? palette[[...group].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 0) % palette.length]! : "var(--line-strong)";
}
type ViewStatus = "running" | "loading" | "proxy-error" | "disconnected" | "idle" | "cooled";
function viewStatus(profile: UiProfile, state?: ViewportState): ViewStatus {
  if (!profile.running) return profile.cooled ? "cooled" : "idle";
  if (state?.status === "error" || state?.status === "ended") return "disconnected";
  if (profile.proxyError) return "proxy-error";
  return !state?.frame ? "loading" : "running";
}
interface ViewportHandle { element: HTMLElement; client: { current: ViewportClient | null }; state: { current: ViewportState } }

/**
 * A frame is decoded off the main thread and drawn only once it is ready, so the previous frame
 * stays on screen until the next replaces it. Swapping an <img> source instead can show a blank
 * (white) frame for an instant while the new image decodes: the wall's flicker.
 */
export function FrameCanvas({ data, className = "viewport-frame" }: { data: string; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const element = canvas.current;
        if (cancelled || latest.current !== data || !element) { bitmap.close(); return; }
        // Resizing clears a canvas; it happens in the same task as the draw, so it never shows.
        if (element.width !== bitmap.width || element.height !== bitmap.height) { element.width = bitmap.width; element.height = bitmap.height; }
        element.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [data]);
  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
interface SyncSession { master: string; generations: Map<string, string> }

const BrowserViewport = memo(function BrowserViewport({ profile, order, selected, focused, obscured, master, following, script, register, onState, onSelect, onFocus, onMaster, onAction, onInput, onHover }: {
  profile: UiProfile; order: number; selected: boolean; focused: boolean; obscured: boolean; master: boolean; following: boolean; script?: { progress: number; name: string };
  register(id: string, handle: ViewportHandle): () => void; onState(id: string, state: ViewportState): void;
  onSelect(id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void;
  onFocus(id: string): void; onMaster(id: string): void; onAction(action: "start" | "stop" | "raise", ids: string[]): void;
  onInput(id: string, input: WorkbenchInput): void; onHover(id: string | null): void;
}) {
  const { t, language } = useTranslation();
  const [state, setState] = useState<ViewportState>({ status: "connecting", generation: "", targetId: "", tabs: [] });
  const [tabsOpen, setTabsOpen] = useState(false), [retry, setRetry] = useState(0);
  const [recorded, setRecorded] = useState<{ source: string; steps: number } | null>(null);
  const recording = state.recording?.on === true;
  useEffect(() => { if (state.recording && !state.recording.on && state.recording.source) setRecorded({ source: state.recording.source, steps: state.recording.steps }); }, [state.recording]);
  const host = useRef<HTMLElement>(null), surface = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const client = useRef<ViewportClient | null>(null), snapshot = useRef(state), focusedRef = useRef(focused), inputRef = useRef(onInput);
  const keys = useRef(new Set<string>()), pointerButton = useRef<"left" | "middle" | "right">("left");
  snapshot.current = state; focusedRef.current = focused; inputRef.current = onInput;
  useLayoutEffect(() => host.current ? register(profile.id, { element: host.current, client, state: snapshot }) : undefined, [profile.id, register]);
  useEffect(() => {
    if (!profile.running) return;
    const connection = client.current = new ViewportClient(profile.id, (next) => { snapshot.current = next; setState(next); onState(profile.id, next); });
    return () => { connection.dispose(); client.current = null; };
  }, [profile.id, profile.running, retry, onState]);
  const sendInput = (value: WorkbenchInput) => inputRef.current(profile.id, value);
  const point = (x: number, y: number, clamp = false) => {
    const frame = snapshot.current.frame, rect = surface.current?.getBoundingClientRect();
    return frame && rect ? viewportPoint(x, y, rect, frame, clamp, focusedRef.current ? "contain" : "width") : null;
  };
  useEffect(() => {
    const element = surface.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!focusedRef.current) return;
      event.preventDefault(); event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const p = point(event.clientX, event.clientY);
      if (p) sendInput({ kind: "wheel", ...p, dx: Math.max(-20000, Math.min(20000, event.deltaX * unit)), dy: Math.max(-20000, Math.min(20000, event.deltaY * unit)), modifiers: modifiers(event) });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => { if (focused) input.current?.focus({ preventScroll: true }); else { keys.current.clear(); client.current?.release(); } }, [focused]);
  const key = (event: ReactKeyboardEvent<HTMLTextAreaElement>, phase: "down" | "up") => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Escape") return;
    if (phase === "up") { if (!keys.current.delete(event.code)) return; }
    else {
      if (event.key.length === 1 && (!event.ctrlKey && !event.metaKey && !event.altKey || event.getModifierState("AltGraph"))) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
      keys.current.add(event.code);
    }
    event.preventDefault(); event.stopPropagation();
    sendInput({ kind: "key", event: phase, key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event) });
  };
  const status = viewStatus(profile, state);
  const labels: Record<ViewStatus, string> = { running: t("running"), loading: t("Connecting…"), "proxy-error": t("Proxy error"), disconnected: t("Disconnected"), idle: t("Not started"), cooled: t("Cooled") };
  return <article ref={host} data-viewport={profile.id} data-status={status} className={`browser-viewport${selected ? " selected" : ""}${focused ? " expanded" : ""}${obscured ? " obscured" : ""}${master ? " master" : ""}${recording ? " recording" : ""}`}
    aria-label={t("Browser viewport: {name}", { name: profile.name })} aria-current={selected ? "true" : undefined} tabIndex={0}
    style={{ "--group-color": groupColor(profile.group), "--arrival-delay": `${Math.min(order, 12) * 24}ms`, viewTransitionName: `environment-${Array.from(profile.id).map((character) => character.codePointAt(0)!.toString(16)).join("-")}` } as CSSProperties}
    onClick={(event) => { if (!focused) onSelect(profile.id, event); }} onDoubleClick={() => { if (profile.running) onFocus(profile.id); else if (profile.cooled) onAction("start", [profile.id]); }}
    onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === " ") { event.preventDefault(); onSelect(profile.id, event); } if (event.key === "Enter" && profile.running) { event.preventDefault(); onFocus(profile.id); } }}
    onPointerEnter={() => onHover(profile.id)} onPointerLeave={() => onHover(null)}>
    <div className="viewport-surface" ref={surface} onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (!focused) return;
        event.stopPropagation(); const p = point(event.clientX, event.clientY); if (!p) return;
        event.preventDefault(); input.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
        pointerButton.current = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
        sendInput({ kind: "pointer", event: "down", ...p, button: pointerButton.current, buttons: event.buttons, clicks: Math.min(3, event.detail || 1), modifiers: modifiers(event) });
      }}
      onPointerMove={(event) => { if (!focused) return; const p = point(event.clientX, event.clientY, event.buttons > 0); if (p) sendInput({ kind: "pointer", event: "move", ...p, button: pointerButton.current, buttons: event.buttons, clicks: 0, modifiers: modifiers(event) }); }}
      onPointerUp={(event) => {
        if (!focused) return; const p = point(event.clientX, event.clientY, true);
        if (p) sendInput({ kind: "pointer", event: "up", ...p, button: pointerButton.current, buttons: event.buttons, clicks: Math.min(3, event.detail || 1), modifiers: modifiers(event) });
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => client.current?.release()}>
      {state.frame && <FrameCanvas data={state.frame.data} />}
      {state.generation && <VirtualCursor client={client} surface={surface} state={snapshot} focused={focusedRef} generation={state.generation} />}
    </div>
    {focused && <textarea ref={input} className="viewport-input" aria-label={t("Type in {name}", { name: profile.name })} autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={(event) => key(event, "down")} onKeyUp={(event) => key(event, "up")}
      onInput={(event) => { if ((event.nativeEvent as InputEvent).isComposing) return; const text = event.currentTarget.value; if (text) sendInput({ kind: "text", text }); event.currentTarget.value = ""; }}
      onCompositionEnd={(event) => { if (event.data) sendInput({ kind: "text", text: event.data }); event.currentTarget.value = ""; }}
      onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData("text/plain").slice(0, 65_536); if (text) sendInput({ kind: "text", text }); event.currentTarget.value = ""; }}
      onBlur={() => { keys.current.clear(); client.current?.release(); }} />}
    <div className="viewport-controls" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      {profile.running && <>
        <button type="button" aria-label={t("Bring browser to front")} title={t("Bring browser to front")} onClick={() => onAction("raise", [profile.id])}><Glyph name="raise" /></button>
        <button type="button" aria-label={t("Show or hide tabs")} title={t("Show or hide tabs")} aria-expanded={tabsOpen} onClick={() => setTabsOpen(!tabsOpen)}><Glyph name="tabs" /></button>
        {(focused || recording) && <button type="button" className={recording ? "viewport-record on" : "viewport-record"} aria-pressed={recording}
          aria-label={t(recording ? "Stop recording and make a script" : "Record what you do into a script")} title={t(recording ? "Stop recording and make a script" : "Record what you do into a script")}
          onClick={() => client.current?.command("record", { on: !recording, language })}><Glyph name={recording ? "stop" : "record"} /></button>}
        <button type="button" aria-label={t("Set as control browser")} title={t("Set as control browser")} aria-pressed={master} onClick={() => onMaster(profile.id)}><Glyph name="master" /></button>
        <button type="button" aria-label={t(focused ? "Collapse viewport" : "Expand viewport")} title={t(focused ? "Collapse viewport" : "Expand viewport")} onClick={() => onFocus(profile.id)}><Glyph name={focused ? "shrink" : "expand"} /></button>
        <button type="button" aria-label={t("Stop this environment")} title={t("Stop this environment")} onClick={() => onAction("stop", [profile.id])}><Glyph name="close" /></button>
      </>}
    </div>
    <div className={`viewport-tabs${tabsOpen ? " open" : ""}`} inert={!tabsOpen} aria-label={t("Browser tabs")} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <div role="tablist" aria-label={t("Browser tabs")}>{state.tabs.map((tab) => <div className={`viewport-tab${state.targetId === tab.id ? " active" : ""}`} key={tab.id}>
        <button type="button" role="tab" aria-selected={state.targetId === tab.id} title={tab.url} onClick={() => client.current?.command("select", { targetId: tab.id })}>{tab.title || t("New tab")}</button>
        <button type="button" title={t("Close tab: {name}", { name: tab.title })} aria-label={t("Close tab: {name}", { name: tab.title })} onClick={() => client.current?.command("close", { targetId: tab.id })}><Glyph name="close" /></button>
      </div>)}<button type="button" className="viewport-new-tab" aria-label={t("New tab")} title={t("New tab")} onClick={() => client.current?.command("new")}><Glyph name="plus" /></button></div>
    </div>
    {status === "cooled" && <div className="viewport-message cooled" role="status" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <span className="viewport-cooled-title">{t("Cooled to free memory")}</span>
      <small>{t("Its sign-ins and tabs are saved. Wake it to pick up where it left off.")}</small>
      <div className="viewport-cooled-actions">
        <button type="button" className="btn primary xs" onClick={() => onAction("start", [profile.id])}><Glyph name="play" />{t("Wake")}</button>
        <button type="button" className="btn ghost xs" title={t("Remove from workbench")} onClick={() => onAction("stop", [profile.id])}>{t("Remove")}</button>
      </div>
    </div>}
    {status !== "cooled" && (status === "idle" || !state.frame || status === "disconnected") && <div className="viewport-message" role="status" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
      <span>{status === "idle" ? t("Not started") : status === "disconnected" ? t("Disconnected · reconnect") : t(state.error ?? "Connecting to the browser…")}</span>
      {status === "loading" && <div className="viewport-skeleton" aria-hidden="true"><i /><i /><i /></div>}
      {status === "idle" ? <button type="button" className="btn primary xs" onClick={() => onAction("start", [profile.id])}><Glyph name="play" />{t("Start")}</button> : status === "disconnected" && <button type="button" className="btn ghost xs" onClick={() => setRetry((value) => value + 1)}><Glyph name="refresh" />{t("Reconnect")}</button>}
    </div>}
    <footer className="viewport-footer" title={`${profile.name} · #${numberOf(profile)} · ${labels[status]}`}>
      <span className={`status-dot viewport-dot ${status}`} aria-label={labels[status]} /><span className="viewport-name">{profile.name}</span><span className="viewport-number">#{numberOf(profile)}</span>
      {master ? <span className="viewport-role"><Glyph name="master" />{t("Control")}</span> : following ? <span title={t("Following the control browser")}><Glyph name="link" /></span> : null}<span className="spacer" />
      {recording && <span className="viewport-recording" role="status"><i aria-hidden="true" />{t("Recording · {count} steps", { count: state.recording?.steps ?? 0 })}</span>}
      {script && <span className="viewport-script" title={script.name}><Glyph name="code" />{script.progress}%</span>}
      <span className={`viewport-region${profile.proxyError ? " bad" : ""}`} title={profile.proxyError || (profile.proxy ? t("Proxy region has not been checked") : t("Direct connection"))}>{profile.proxy ? <Glyph name="proxy" /> : null}{profile.proxy ? t("Proxy") : t("Direct")}</span><KernelIcon engine={profile.engine} />
    </footer>
    {recorded && <RecordingDialog source={recorded.source} steps={recorded.steps} profileName={profile.name} onClose={() => setRecorded(null)} />}
  </article>;
});

export function WorkbenchPage({ profiles, groups, folders, group, onGroupChange, onOpenProfiles, onRefresh, onImport, locateId, locateRevision, covered = false }: {
  profiles: UiProfile[]; groups: string[]; folders: FolderInfo[]; group: string; onGroupChange(group: string): void;
  onOpenProfiles(): void; onRefresh(): Promise<unknown>; onImport?(): void; locateId?: string | null; locateRevision?: number;
  /** A sheet is open over the wall: keep the last frames, stop streaming and ignore keys. */
  covered?: boolean;
}) {
  const { t } = useTranslation();
  const [guideSkipped, setGuideSkipped] = useState(firstRunDismissed);
  const root = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), canvasId = useId();
  const records = useRef(new Map<string, ViewportHandle>()), dots = useRef(new Map<string, HTMLButtonElement>());
  const [size, setSize] = useState({ width: 1000, height: 600 }), [overview, setOverview] = useState(false), [showStopped, setShowStopped] = useState(false);
  const [focused, setFocused] = useState<string | null>(null), [selected, setSelected] = useState(new Set<string>()), [highlighted, setHighlighted] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [autoEnabled, setAutoEnabled] = useState(false), [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [morphing, setMorphing] = useState(false), [moving, setMoving] = useState(false), [filtering, setFiltering] = useState(false);
  const [health, setHealth] = useState<Record<string, ViewStatus>>({}), [sync, setSync] = useState<SyncSession | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<string | null>(null);
  const [batchMode, setBatchMode] = useState<"group" | "proxy" | null>(null), [batchValue, setBatchValue] = useState("");
  const batchEditor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!batchMode) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = batchEditor.current; if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
    const frame = requestAnimationFrame(() => controls()[0]?.focus());
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = controls(), first = elements[0], last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", trap, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [batchMode]);
  const [scriptRun, setScriptRun] = useState<ScriptRun | null>(null), [marquee, setMarquee] = useState<ViewportBox | null>(null);
  const focusedRef = useRef(focused), syncRef = useRef(sync), reducedRef = useRef(reducedMotion), profilesRef = useRef(profiles);
  const hovered = useRef(false), hoveredCard = useRef<string | null>(null), anchor = useRef<string | null>(null), ignoreClick = useRef(false), overviewRef = useRef(overview);
  const motion = useRef({ offset: 0, target: 0, velocity: 0, resumeAfter: 0, settleAt: 0, frozen: false, morphing: false });
  const drag = useRef<{ id: number; kind: "pan" | "rail" | "marquee"; startX: number; startY: number; lastX: number; lastAt: number; velocity: number; moved: boolean; scale: number; dotId?: string } | null>(null);
  const paintRef = useRef<() => void>(() => {}), morphTimer = useRef<ReturnType<typeof setTimeout> | null>(null), highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  focusedRef.current = focused; syncRef.current = sync; reducedRef.current = reducedMotion; profilesRef.current = profiles; overviewRef.current = overview;
  const coveredRef = useRef(covered); coveredRef.current = covered;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [activeRow, setActiveRow] = useState<number | null>(null), activeRowRef = useRef(activeRow); activeRowRef.current = activeRow;
  const scope = useMemo(() => folderScope(folders, group), [folders, group]);
  // Groups stay together so each one can become a lane; ungrouped environments come last.
  const groupOrder = useMemo(() => new Map(groups.map((name, index) => [name, index])), [groups]);
  const scoped = useMemo(() => profiles.filter((profile) => (profile.running || profile.cooled || showStopped) && profile.permission !== "view" && !profile.lockedBy
    && (group === "all" || group === "" && !profile.group || scope.has(profile.group) || profile.group === group))
    .sort((a, b) => (groupOrder.get(a.group) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(b.group) ?? Number.MAX_SAFE_INTEGER) || a.group.localeCompare(b.group)
      || (a.serial ?? Number.MAX_SAFE_INTEGER) - (b.serial ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)), [profiles, group, scope, showStopped, groupOrder]);
  const [displayed, setDisplayed] = useState(scoped), lastScope = useRef(group);
  const scopedRef = useRef(scoped), scopeRevision = useRef(0), scopePending = useRef(false), scopeTransition = useRef<ViewTransition | null>(null);
  scopedRef.current = scoped;
  useEffect(() => {
    if (lastScope.current === group) { if (!scopePending.current) setDisplayed(scoped); return; }
    lastScope.current = group;
    const revision = ++scopeRevision.current;
    scopePending.current = true;
    scopeTransition.current?.skipTransition();
    const change = (synchronous: boolean) => {
      if (revision !== scopeRevision.current) return;
      motion.current.offset = 0; motion.current.target = 0; motion.current.velocity = 0;
      for (const id of syncRef.current?.generations.keys() ?? []) records.current.get(id)?.client.current?.release();
      focusedRef.current = null; syncRef.current = null;
      const commit = () => { setDisplayed(scopedRef.current); setFocused(null); setSync(null); setSelected(new Set()); setFiltering(false); };
      if (synchronous) flushSync(commit); else commit();
      scopePending.current = false;
      paintRef.current();
    };
    if (!reducedRef.current && document.startViewTransition) {
      const transition = document.startViewTransition(() => change(true)); scopeTransition.current = transition;
      void transition.ready.catch(() => {});
      void transition.finished.catch(() => {}).finally(() => { if (scopeTransition.current === transition) scopeTransition.current = null; });
    } else change(false);
  }, [scoped, group]);
  useEffect(() => () => { scopeRevision.current++; scopeTransition.current?.skipTransition(); }, []);
  const lanes = useMemo(() => {
    const byGroup = new Map<string, string[]>();
    for (const profile of displayed) { const lane = byGroup.get(profile.group); if (lane) lane.push(profile.id); else byGroup.set(profile.group, [profile.id]); }
    return [...byGroup].map(([name, ids]) => ({ name, ids }));
  }, [displayed]);
  const layout = useMemo(() => workbenchLayout(displayed.map((profile) => profile.id), size.width, size.height, { overview, reducedMotion, lanes: lanes.map((lane) => lane.ids), active: activeRow }), [displayed, lanes, size, overview, reducedMotion, activeRow]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  // Lane labels exist only while every lane is one group.
  const laneLabels = layout.mode === "ring" && layout.rows === lanes.length && lanes.length > 1 && lanes.every((lane, row) => lane.ids.every((id) => layout.boxes.get(id)?.row === row)) ? lanes : null;
  // What paint last wrote to each card, so a frame only touches what changed.
  const painted = useRef(new WeakMap<HTMLElement, { x: number; transition: string; transform: string; width: number; height: number; dim: boolean; hidden: boolean | null; shown: boolean | null; dot: boolean | null; tier: string }>());
  const movingAttribute = useRef<boolean | null>(null);
  const idsRef = useRef(displayed.map((profile) => profile.id)); idsRef.current = displayed.map((profile) => profile.id);
  const flash = useCallback((id: string) => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlighted(id); highlightTimer.current = setTimeout(() => setHighlighted(null), 1100);
  }, []);
  const stopSync = useCallback(() => {
    for (const id of syncRef.current?.generations.keys() ?? []) records.current.get(id)?.client.current?.release();
    syncRef.current = null; setSync(null); paintRef.current();
  }, []);
  const paint = useCallback(() => {
    const current = motion.current, plan = layoutRef.current, container = scroller.current, focusId = focusedRef.current;
    if (!container) return;
    // Measure once, then only write: reading layout between writes would force a reflow per card, per frame.
    const frozen = current.frozen || current.morphing || document.hidden, scrollTop = container.scrollTop, viewWidth = container.clientWidth, viewHeight = container.clientHeight;
    const expanded = focusId ? workbenchFocusBox(viewWidth, viewHeight) : null, chosen = plan.mode === "ring" && activeRowRef.current != null && !focusId;
    for (const [id, record] of records.current) {
      const base = plan.boxes.get(id); if (!base) continue;
      let box = workbenchPosition(base, plan, current.offset);
      if (id === focusId && expanded) box = { ...expanded, y: expanded.y + scrollTop };
      let last = painted.current.get(record.element);
      if (!last) painted.current.set(record.element, last = { x: NaN, transition: "", transform: "", width: -1, height: -1, dim: false, hidden: null, shown: null, dot: null, tier: "" });
      // A card that crosses the seam while lanes resize must jump, not fly across the wall.
      const transition = current.morphing && !Number.isNaN(last.x) && Math.abs(box.x - last.x) > viewWidth * .6 ? "none" : "";
      last.x = box.x;
      if (transition !== last.transition) record.element.style.transition = last.transition = transition;
      // Whole pixels at rest keep text crisp; fractions in motion keep it smooth.
      const x = frozen ? Math.round(box.x * 100) / 100 : Math.round(box.x), transform = `translate3d(${x}px, ${Math.round(box.y)}px, 0)`;
      if (transform !== last.transform) record.element.style.transform = last.transform = transform;
      if (box.width !== last.width) { record.element.style.width = `${box.width}px`; last.width = box.width; }
      if (box.height !== last.height) { record.element.style.height = `${box.height}px`; last.height = box.height; }
      const dim = chosen && base.row !== plan.anchor;
      if (dim !== last.dim) { record.element.toggleAttribute("data-dim", dim); last.dim = dim; }
      let tier: WorkbenchRefreshTier = workbenchRefreshTier(box, viewWidth, viewHeight, scrollTop);
      const obscured = !!focusId && id !== focusId, visible = tier !== "hidden", hidden = !visible || obscured, shown = visible || current.morphing, dot = visible && !obscured;
      if (hidden !== last.hidden) { record.element.inert = hidden; record.element.setAttribute("aria-hidden", String(hidden)); last.hidden = hidden; }
      if (shown !== last.shown) { record.element.style.visibility = shown ? "visible" : "hidden"; last.shown = shown; }
      if (dot !== last.dot) { dots.current.get(id)?.setAttribute("data-visible", String(dot)); last.dot = dot; }
      if (obscured || document.hidden || coveredRef.current) tier = "hidden";
      else if (visible && (focusId === id || hoveredCard.current === id)) tier = "interactive";
      if (tier !== last.tier) record.element.dataset.refreshTier = last.tier = tier;
      record.client.current?.activity(tier, frozen, !!syncRef.current?.generations.has(id) && syncRef.current.master !== id, box.width * (window.devicePixelRatio || 1));
    }
    if (frozen !== movingAttribute.current) { root.current?.setAttribute("data-moving", String(frozen)); movingAttribute.current = frozen; }
  }, []);
  paintRef.current = paint;
  const register = useCallback((id: string, handle: ViewportHandle) => {
    records.current.set(id, handle); paintRef.current();
    return () => { if (records.current.get(id) === handle) records.current.delete(id); };
  }, []);
  const onState = useCallback((id: string, state: ViewportState) => {
    const profile = profilesRef.current.find((entry) => entry.id === id);
    if (profile) { const status = viewStatus(profile, state); setHealth((old) => old[id] === status ? old : { ...old, [id]: status }); }
    const session = syncRef.current;
    if (session?.generations.has(id) && (state.generation !== session.generations.get(id) || state.status === "ended" || state.status === "error")) stopSync();
    paintRef.current();
  }, [stopSync]);
  const beginMorph = useCallback(() => {
    if (morphTimer.current) clearTimeout(morphTimer.current);
    motion.current.morphing = !reducedRef.current; setMorphing(!reducedRef.current);
    morphTimer.current = setTimeout(() => { motion.current.morphing = false; setMorphing(false); paintRef.current(); }, reducedRef.current ? 0 : 420);
  }, []);
  const collapse = useCallback(() => {
    beginMorph(); focusedRef.current = null; setFocused(null); motion.current.resumeAfter = performance.now() + 1500; paintRef.current(); scroller.current?.focus({ preventScroll: true });
  }, [beginMorph]);
  const markMoving = useCallback((value: boolean) => {
    if (motion.current.frozen === value) return;
    motion.current.frozen = value; setMoving(value); paintRef.current();
  }, []);
  const turnTo = useCallback((target: number) => {
    if (focusedRef.current || layoutRef.current.mode !== "ring" || !Number.isFinite(target)) return;
    motion.current.resumeAfter = performance.now() + 1500; motion.current.target = target; motion.current.settleAt = 0;
    if (reducedRef.current) { motion.current.offset = target; motion.current.velocity = 0; markMoving(false); paintRef.current(); }
    else markMoving(true);
  }, [markMoving]);
  const step = useCallback((direction: number) => {
    const plan = layoutRef.current, row = plan.anchor;
    turnTo(motion.current.target + direction * (plan.strides[row] ?? 300) / (plan.speeds[row] ?? 1));
  }, [turnTo]);
  const locate = useCallback((id: string) => {
    const plan = layoutRef.current, box = plan.boxes.get(id); if (!box) return;
    if (plan.mode === "ring") turnTo(workbenchLocate(box, plan, motion.current.offset));
    else scroller.current?.scrollTo({ top: Math.max(0, box.y - (scroller.current.clientHeight - box.height) / 2), behavior: reducedRef.current ? "instant" : "smooth" });
    flash(id);
  }, [flash, turnTo]);
  const focus = useCallback((id: string) => {
    if (focusedRef.current === id) { collapse(); return; }
    if (!profilesRef.current.find((profile) => profile.id === id)?.running) return;
    motion.current.target = motion.current.offset; motion.current.velocity = 0; markMoving(false); beginMorph();
    focusedRef.current = id; setFocused(id); setSelected(new Set([id])); paintRef.current();
  }, [beginMorph, collapse, markMoving]);
  const pendingLocate = useRef<string | null>(null);
  const select = useCallback((id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (ignoreClick.current) return;
    setSelected((old) => {
      if (event.shiftKey && anchor.current) {
        const a = idsRef.current.indexOf(anchor.current), b = idsRef.current.indexOf(id);
        return new Set([...old, ...idsRef.current.slice(Math.min(a, b), Math.max(a, b) + 1)]);
      }
      anchor.current = id;
      if (event.ctrlKey || event.metaKey) { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }
      return new Set([id]);
    });
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const plan = layoutRef.current, row = plan.boxes.get(id)?.row;
      if (overviewRef.current) { setOverview(false); pendingLocate.current = id; }
      // Choosing a card brings its lane forward; locating waits for the resized lanes.
      else if (plan.mode === "ring" && plan.rows > 1 && row != null && row !== activeRowRef.current) { beginMorph(); pendingLocate.current = id; setActiveRow(row); }
      else locate(id);
    }
  }, [locate, beginMorph]);
  useLayoutEffect(() => {
    if (layout.mode === "grid") { motion.current.frozen = false; motion.current.target = motion.current.offset; motion.current.velocity = 0; motion.current.settleAt = 0; setMoving(false); }
    paint();
    if (pendingLocate.current) { const id = pendingLocate.current; pendingLocate.current = null; locate(id); }
  }, [layout, focused, sync, paint, locate]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => { reducedRef.current = preference.matches; setReducedMotion(preference.matches); if (preference.matches) { setAutoEnabled(false); motion.current.offset = motion.current.target; motion.current.velocity = 0; markMoving(false); paintRef.current(); } };
    preference.addEventListener("change", change);
    const visibility = () => { if (document.hidden) { motion.current.velocity = 0; motion.current.target = motion.current.offset; } paintRef.current(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { preference.removeEventListener("change", change); document.removeEventListener("visibilitychange", visibility); };
  }, [markMoving]);
  const autoRef = useRef(autoEnabled); autoRef.current = autoEnabled;
  useEffect(() => {
    let frame = 0, previous = 0;
    const tick = (now: number) => {
      const current = motion.current, elapsed = previous ? Math.max(0, Math.min(1000, now - previous)) : 0; previous = now;
      if (!document.hidden && !focusedRef.current && layoutRef.current.mode === "ring" && !current.morphing) {
        if (!drag.current && current.settleAt && now >= current.settleAt) {
          const plan = layoutRef.current, row = plan.anchor, stride = plan.strides[row]! / plan.speeds[row]!;
          current.target = workbenchSnap(current.target, current.velocity, stride, row % 2 ? stride / 2 : 0); current.settleAt = 0;
        }
        if (!drag.current && (current.offset !== current.target || current.velocity)) {
          const next = workbenchSpring(current.offset, current.velocity, current.target, elapsed / 1000);
          current.offset = next.offset; current.velocity = next.velocity;
          markMoving(true); paintRef.current(); if (next.settled && !current.settleAt) markMoving(false);
        } else if (!drag.current && !current.settleAt && autoRef.current && !reducedRef.current && !hovered.current && now >= current.resumeAfter) {
          current.offset += Math.min(48, elapsed) * .024; current.target = current.offset; current.velocity = 0; markMoving(true); paintRef.current();
        } else if (!drag.current && !current.settleAt && !current.morphing) markMoving(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [markMoving]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (focusedRef.current || layoutRef.current.mode !== "ring" || (event.target as Element).closest(".viewport-tabs")) return;
      event.preventDefault(); const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
      turnTo(motion.current.target + delta); motion.current.settleAt = performance.now() + 140;
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [turnTo]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || coveredRef.current) return;
      if (batchMode) { event.preventDefault(); setBatchMode(null); return; }
      if (focusedRef.current) { event.preventDefault(); event.stopPropagation(); collapse(); }
      else if (syncRef.current) stopSync();
      else { setSelected(new Set()); if (activeRowRef.current != null) { beginMorph(); setActiveRow(null); } }
    };
    window.addEventListener("keydown", escape, true); return () => window.removeEventListener("keydown", escape, true);
  }, [collapse, stopSync, batchMode, beginMorph]);
  // The chosen lane only means something while the same lanes are on the wall.
  useEffect(() => { setActiveRow(null); }, [group, overview, lanes.length]);
  useEffect(() => { if (covered && focusedRef.current) collapse(); paintRef.current(); }, [covered, collapse]);
  useEffect(() => {
    const allowed = new Set(displayed.map((profile) => profile.id));
    setSelected((old) => [...old].some((id) => !allowed.has(id)) ? new Set([...old].filter((id) => allowed.has(id))) : old);
    if (focused && !displayed.some((profile) => profile.id === focused && profile.running)) collapse();
    if (sync && [...sync.generations.keys()].some((id) => !displayed.some((profile) => profile.id === id && profile.running))) stopSync();
  }, [displayed, focused, sync, collapse, stopSync]);
  useEffect(() => {
    if (!locateId) return;
    const profile = profilesRef.current.find((entry) => entry.id === locateId); if (profile && !profile.running) setShowStopped(true);
    pendingLocate.current = locateId; setSelected(new Set([locateId])); setOverview(false);
    if (layoutRef.current.boxes.has(locateId)) { pendingLocate.current = null; locate(locateId); }
  }, [locateId, locateRevision, locate]);
  useEffect(() => {
    let active = true; const poll = () => { void fetchScriptRun().then((run) => { if (active) setScriptRun(run); }).catch(() => {}); };
    poll(); const timer = setInterval(poll, 2000); return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => () => { if (morphTimer.current) clearTimeout(morphTimer.current); if (highlightTimer.current) clearTimeout(highlightTimer.current); }, []);
  const hintSeen = useRef(false);
  useEffect(() => {
    if (layout.mode !== "ring" || reducedMotion || hintSeen.current) return;
    hintSeen.current = true;
    try { if (sessionStorage.getItem("vela.workbench.ringHint")) return; sessionStorage.setItem("vela.workbench.ringHint", "1"); } catch {}
    turnTo(32);
    const timer = setTimeout(() => { if (!drag.current && !hovered.current) turnTo(0); }, 220);
    return () => clearTimeout(timer);
  }, [layout.mode, reducedMotion, turnTo]);

  const broadcast = useCallback((id: string, value: WorkbenchInput) => {
    const record = records.current.get(id); record?.client.current?.input(value);
    const session = syncRef.current, source = record?.state.current.viewport;
    if (!session || session.master !== id || !source) return;
    for (const [follower, generation] of session.generations) {
      if (follower === id) continue;
      const target = records.current.get(follower), destination = target?.state.current.viewport;
      if (!target || !destination || target.state.current.generation !== generation) continue;
      const input = workbenchFollowerInput(value, source, destination); if (input) target.client.current?.input(input);
    }
  }, []);
  const setMaster = useCallback((id: string) => {
    stopSync();
    const chosen = selectedRef.current, candidates = chosen.size > 1 ? new Set([...chosen, id]) : new Set(idsRef.current), generations = new Map<string, string>();
    for (const candidate of candidates) {
      const state = records.current.get(candidate)?.state.current;
      if (state?.generation && state.viewport && state.status !== "error" && state.status !== "ended") generations.set(candidate, state.generation);
    }
    if (!generations.has(id) || generations.size < 2) { setError(t("Wait for at least two environments to connect before synchronizing.")); return; }
    const session = { master: id, generations }; syncRef.current = session; setSync(session); if (focusedRef.current !== id) focus(id); paintRef.current();
  }, [stopSync, focus, t]);
  const action = useCallback(async (kind: "start" | "stop" | "raise", ids: string[]) => {
    if (busy) return; setBusy(true); setError(null);
    if (kind === "stop" && syncRef.current && ids.some((id) => syncRef.current!.generations.has(id))) stopSync();
    try {
      const failures: string[] = [];
      for (let i = 0; i < ids.length; i += 3) await Promise.all(ids.slice(i, i + 3).map(async (id) => {
        try { const result = await (kind === "start" ? openProfile(id) : kind === "stop" ? closeProfile(id) : raiseProfile(id)); if (!result.ok) throw new Error(result.error || t("Operation failed")); }
        catch (cause) { failures.push(`${profilesRef.current.find((profile) => profile.id === id)?.name ?? id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }));
      await onRefresh(); if (failures.length) setError(failures.join(" · "));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }, [busy, onRefresh, stopSync, t]);
  const applyBatch = async () => {
    if (busy || !selected.size) return; setBusy(true); setError(null);
    try {
      const failures: string[] = [];
      if (batchMode === "group") {
        const result = await moveProfiles([...selected], batchValue); if (!result.ok || result.failed?.length) throw new Error(result.error || t("Some environments could not be moved."));
      } else {
        const proxy = parsePastedProxy(batchValue, "http");
        for (const id of selected) {
          const profile = profilesRef.current.find((entry) => entry.id === id);
          try {
            if (profile?.running) throw new Error(t("Stop the selected environments before replacing their proxy."));
            const address = `${proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host}:${proxy.port}${proxy.user ? `:${proxy.user}:${proxy.pass}` : ""}`;
            const result = await updateProfile(id, { proxyType: proxy.type, proxy: address }, profile?.version); if (!result.ok) throw new Error(result.error || t("Operation failed"));
          } catch (cause) { failures.push(`${profile?.name ?? id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      }
      await onRefresh(); if (failures.length) setError(failures.join(" · ")); else setBatchMode(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  // Stable handlers keep the memoised cards from re-rendering with every wall update.
  const actionRef = useRef(action); actionRef.current = action;
  const onAction = useCallback((kind: "start" | "stop" | "raise", ids: string[]) => { void actionRef.current(kind, ids); }, []);
  const onHover = useCallback((id: string | null) => { hoveredCard.current = id; paintRef.current(); }, []);
  const finishDrag = (element: HTMLElement, pointerId: number, cancelled = false) => {
    const current = drag.current; if (!current || current.id !== pointerId) return;
    drag.current = null; if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    if (current.moved) {
      ignoreClick.current = true; setTimeout(() => { ignoreClick.current = false; }, 0);
      if (current.kind !== "marquee" && !cancelled) {
        const plan = layoutRef.current, row = plan.anchor, stride = plan.strides[row]! / plan.speeds[row]!;
        turnTo(workbenchSnap(motion.current.offset, current.velocity, stride, row % 2 ? stride / 2 : 0));
      }
    }
    if (!current.moved && current.kind === "rail" && current.dotId && !cancelled) { locate(current.dotId); setSelected(new Set([current.dotId])); }
    setMarquee(null); if (!current.moved || cancelled) markMoving(false);
  };
  const finishDragRef = useRef(finishDrag); finishDragRef.current = finishDrag;
  useEffect(() => {
    const end = (event?: PointerEvent) => {
      const current = drag.current, container = scroller.current; if (!current || !container || event && event.pointerId !== current.id) return;
      const owner = [...(root.current?.querySelectorAll<HTMLElement>(".workbench-scroll,.workbench-ring") ?? [])].find((element) => element.hasPointerCapture(current.id)) ?? container;
      finishDragRef.current(owner, current.id, !event || event.type === "pointercancel");
    };
    const blur = () => end();
    window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", blur); };
  }, []);
  const startDrag = (event: React.PointerEvent<HTMLDivElement>, kind: "pan" | "rail" | "marquee", scale = 1) => {
    if (focusedRef.current || event.button !== 0 || (event.target as Element).closest("button,input,textarea,select,.viewport-controls,.viewport-tabs,.viewport-message")) return;
    if (kind === "pan" && layoutRef.current.mode !== "ring") return;
    const rect = scroller.current!.getBoundingClientRect();
    if (kind === "pan") {
      // The lane under the pointer follows the hand; the lanes beside it drift the other way.
      const plan = layoutRef.current, y = event.clientY - rect.top, row = plan.tracks.findIndex((track) => y < track.y + track.height + 8);
      const lane = row < 0 ? plan.rows - 1 : row;
      scale = 1 / (plan.wraps[lane] ? plan.speeds[lane]! : plan.speeds[plan.anchor]!);
    }
    drag.current = { id: event.pointerId, kind, startX: event.clientX - rect.left, startY: event.clientY - rect.top + scroller.current!.scrollTop, lastX: event.clientX, lastAt: performance.now(), velocity: 0, moved: false, scale };
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current; if (!current || current.id !== event.pointerId) return;
    const now = performance.now(), delta = (event.clientX - current.lastX) * current.scale;
    if (!current.moved && Math.abs(event.clientX - current.lastX) < 3 && current.kind !== "marquee") return;
    current.moved = true;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    if (current.kind === "marquee") {
      const rect = scroller.current!.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top + scroller.current!.scrollTop;
      const box = { x: Math.min(x, current.startX), y: Math.min(y, current.startY), width: Math.abs(x - current.startX), height: Math.abs(y - current.startY) }; setMarquee(box);
      const matches = new Set<string>();
      for (const [id, base] of layoutRef.current.boxes) { const tile = workbenchPosition(base, layoutRef.current, motion.current.offset); if (tile.x < box.x + box.width && tile.x + tile.width > box.x && tile.y < box.y + box.height && tile.y + tile.height > box.y) matches.add(id); }
      setSelected(matches);
    } else {
      const change = current.kind === "rail" ? delta : -delta;
      current.velocity = current.velocity * .35 + change / Math.max(8, now - current.lastAt) * 1000 * .65;
      motion.current.offset += change; motion.current.target = motion.current.offset; motion.current.velocity = 0; motion.current.settleAt = 0; motion.current.resumeAfter = now + 1500;
      markMoving(true); paintRef.current();
    }
    current.lastX = event.clientX; current.lastAt = now;
  };
  const matches = query.trim() ? displayed.filter((profile) => `${profile.name} ${numberOf(profile)} ${profile.group}`.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const cooledCount = displayed.filter((profile) => !profile.running && profile.cooled).length;
  const running = displayed.filter((profile) => profile.running).length, issues = displayed.filter((profile) => profile.proxyError || health[profile.id] === "disconnected").length;
  const scriptProgress = scriptRun ? Math.round(scriptRun.profiles.filter((profile) => ["succeeded", "failed", "cancelled"].includes(profile.status)).length / Math.max(1, scriptRun.profiles.length) * 100) : 0;
  const previewProfile = displayed.find((profile) => profile.id === preview), previewFrame = preview ? records.current.get(preview)?.state.current.frame : undefined;
  return <section ref={root} className={`workbench${morphing ? " morphing" : ""}${filtering ? " filtering" : ""}`} aria-label={t("Multi-view workbench")}
    onPointerEnter={(event) => { if (event.pointerType !== "touch") hovered.current = true; }}
    onPointerLeave={() => { hovered.current = false; hoveredCard.current = null; motion.current.resumeAfter = performance.now() + 900; paintRef.current(); }}>
    <div className="workbench-toolbar">
      <Select className="select" aria-label={t("Workbench group")} value={group} onChange={(event) => onGroupChange(event.target.value)}>
        <option value="all">{t("All groups")}</option><option value="">{t("Ungrouped")}</option>
        {folderTree<FolderInfo>(folders.length ? folders : groups.map((name) => ({ name }))).map((folder) => <option key={folder.name} value={folder.name}>{"　".repeat(folder.depth)}{folder.label ?? folder.name}</option>)}
      </Select>
      <div className="workbench-search">
        <Glyph name="search" /><input type="search" placeholder={t("Find an environment…")} aria-label={t("Find an environment…")} value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && matches[0]) { locate(matches[0].id); setSelected(new Set([matches[0].id])); setQuery(""); scroller.current?.focus(); } if (event.key === "Escape") setQuery(""); }} />
        {query.trim() && <div className="workbench-search-results">{matches.length ? matches.map((profile) => <button type="button" key={profile.id} onClick={() => { locate(profile.id); setSelected(new Set([profile.id])); setQuery(""); }}>{profile.name}<span>#{numberOf(profile)}</span></button>) : <p>{t("No matching environments")}</p>}</div>}
      </div>
      <span className="workbench-count" role="status">{t("{running} running · {issues} issues", { running, issues })}{cooledCount ? ` · ${t("{count} cooled", { count: cooledCount })}` : ""}</span><span className="spacer" />
      <button type="button" className={`iconbtn${showStopped ? " on" : ""}`} aria-pressed={showStopped} aria-label={t("Show stopped environments")} title={t("Show stopped environments")} onClick={() => setShowStopped(!showStopped)}><Glyph name="eye" /></button>
      <button type="button" className={`iconbtn${overview ? " on" : ""}`} aria-pressed={overview} aria-label={t(overview ? "Return to ring" : "Overview grid")} title={t(overview ? "Return to ring" : "Overview grid")} onClick={() => { if (focused) collapse(); setOverview(!overview); }}><Glyph name={overview ? "lanes" : "grid"} /></button>
      <span className="workbench-toolbar-divider" />
      <button type="button" className="iconbtn" aria-label={t(autoEnabled ? "Pause automatic scrolling" : "Start automatic scrolling")} title={t(reducedMotion ? "Automatic scrolling follows your reduced motion preference" : autoEnabled ? "Pause automatic scrolling" : "Start automatic scrolling")}
        aria-pressed={autoEnabled && !reducedMotion} disabled={!!focused || layout.mode !== "ring" || reducedMotion} onClick={() => setAutoEnabled(!autoEnabled)}><Glyph name={autoEnabled && !reducedMotion ? "pause" : "play"} /></button>
      <button type="button" className="iconbtn" aria-label={t("Scroll workbench left")} title={t("Scroll workbench left")} disabled={!!focused || layout.mode !== "ring"} onClick={() => step(-1)}><Glyph name="left" /></button>
      <button type="button" className="iconbtn" aria-label={t("Scroll workbench right")} title={t("Scroll workbench right")} disabled={!!focused || layout.mode !== "ring"} onClick={() => step(1)}><Glyph name="right" /></button>
    </div>
    {sync && <div className="workbench-sync" role="status"><Glyph name="link" /><span>{t("Synchronizing · control {number} · {count} followers", { number: numberOf(profiles.find((profile) => profile.id === sync.master)!), count: sync.generations.size - 1 })}</span><button type="button" className="btn ghost xs" onClick={stopSync}>{t("Stop synchronization")}</button></div>}
    {error && <div className="workbench-error" role="alert"><span>{error}</span><button type="button" title={t("Dismiss error")} aria-label={t("Dismiss error")} onClick={() => setError(null)}><Glyph name="close" /></button></div>}
    <div className="workbench-stage">
    <div className={`workbench-scroll ${layout.mode}${focused ? " focused" : ""}${moving ? " moving" : ""}`} ref={scroller} tabIndex={0} aria-label={t("Browser canvas")} onScroll={paint}
      onClickCapture={(event) => { if (ignoreClick.current) { event.preventDefault(); event.stopPropagation(); } }}
      onPointerDown={(event) => {
        const tile = (event.target as Element).closest("[data-viewport]");
        if (focusedRef.current) { if (!tile) collapse(); return; }
        startDrag(event, !tile && (overview || event.shiftKey) ? "marquee" : "pan");
      }} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finishDrag(event.currentTarget, event.pointerId, true)} onLostPointerCapture={(event) => finishDrag(event.currentTarget, event.pointerId, true)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || focused) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1); }
        if (event.key === "Enter" && selected.size === 1) focus([...selected][0]!);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(displayed.map((profile) => profile.id))); }
      }}>
      <div className="workbench-canvas" id={canvasId} style={{ height: layout.height }}>
        {displayed.map((profile, order) => <BrowserViewport key={profile.id} profile={profile} order={order} selected={selected.has(profile.id)} focused={focused === profile.id} obscured={!!focused && focused !== profile.id}
          master={sync?.master === profile.id} following={!!sync?.generations.has(profile.id) && sync.master !== profile.id}
          script={scriptRun?.profiles.some((entry) => entry.id === profile.id && entry.status === "running") ? { progress: scriptProgress, name: scriptRun.scriptName } : undefined}
          register={register} onState={onState} onSelect={select} onFocus={focus} onMaster={setMaster} onAction={onAction} onInput={broadcast}
          onHover={onHover} />)}
        {highlighted && <style>{`[data-viewport="${CSS.escape(highlighted)}"] { animation: viewport-locate 420ms var(--spring-control); }`}</style>}
        {marquee && <div className="workbench-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      </div>
      {!profiles.length && !guideSkipped && !covered && <FirstRunGuide onDone={() => { void onRefresh(); }} onSkip={() => setGuideSkipped(true)} onImport={() => onImport?.()} />}
      {!displayed.length && (profiles.length > 0 || guideSkipped) && <div className="workbench-empty"><Glyph name="lanes" /><h2>{t("Your browsers, together")}</h2><p>{t("Open environments in this group to bring their live pages into the workbench.")}</p><button type="button" className="btn primary" onClick={onOpenProfiles}>{t("Open environments")}</button></div>}
    </div>
    {laneLabels && !focused && <div className="workbench-lanes">
      {laneLabels.map((lane, row) => <button type="button" key={lane.name} className={`workbench-lane${activeRow === row ? " active" : ""}${layout.wraps[row] ? " wraps" : ""}`} style={{ top: layout.tracks[row]!.y, height: layout.tracks[row]!.height - 32 }}
        title={t("Show only {group}", { group: lane.name || t("Ungrouped") })} onClick={() => onGroupChange(lane.name)}>
        <span>{lane.name ? folders.find((folder) => folder.name === lane.name)?.label ?? lane.name : t("Ungrouped")}</span><small>{String(lane.ids.length).padStart(2, "0")}</small>
      </button>)}
    </div>}
    </div>

    {!!displayed.length && <div className="workbench-navigation">
      <span className="workbench-gesture">{t(layout.mode === "ring" ? "Drag or scroll to rotate · double-click to focus" : "Select to locate · double-click to focus")}</span>
      <div className={`workbench-ring${focused ? " inactive" : ""}`} role="group" aria-label={t("Environment ring")} aria-controls={canvasId}
        onPointerDown={(event) => {
          if (focused || layout.mode !== "ring" || event.button !== 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = { id: event.pointerId, kind: "rail", startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastAt: performance.now(), velocity: 0, moved: false, scale: Math.max(...layout.periods) / Math.max(80, rect.width), dotId: (event.target as Element).closest<HTMLElement>("[data-env]")?.dataset.env };
        }} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event.currentTarget, event.pointerId)} onPointerCancel={(event) => finishDrag(event.currentTarget, event.pointerId, true)}
        onLostPointerCapture={(event) => finishDrag(event.currentTarget, event.pointerId, true)}
        onClickCapture={(event) => { if (ignoreClick.current) { event.preventDefault(); event.stopPropagation(); } }}>
        {displayed.map((profile, index) => <button type="button" key={profile.id} data-env={profile.id} ref={(node) => { if (node) dots.current.set(profile.id, node); else dots.current.delete(profile.id); }}
          className={`workbench-ring-dot${index && displayed[index - 1]!.group !== profile.group ? " group-start" : ""}`} data-status={!profile.running && profile.cooled ? "cooled" : health[profile.id] ?? viewStatus(profile)} aria-label={t("Locate {name}", { name: profile.name })}
          aria-pressed={selected.has(profile.id)} title={profile.name} disabled={!!focused}
          onPointerEnter={() => setPreview(profile.id)} onPointerLeave={() => setPreview(null)} onFocus={() => setPreview(profile.id)} onBlur={() => setPreview(null)}
          onClick={() => { locate(profile.id); setSelected(new Set([profile.id])); }}><span /></button>)}
      </div>
      {previewProfile && <div className="workbench-ring-preview" role="tooltip">{previewFrame && <FrameCanvas data={previewFrame.data} className="workbench-ring-frame" />}<span>{previewProfile.name}<small>#{numberOf(previewProfile)}</small></span></div>}
    </div>}
    {selected.size > 0 && !focused && <div className="workbench-batch" aria-label={t("Selected environments")}>
      <span>{t("{count} selected", { count: selected.size })}</span>
      <button type="button" className="btn ghost xs" disabled={busy || !displayed.some((profile) => selected.has(profile.id) && !profile.running)} onClick={() => void action("start", displayed.filter((profile) => selected.has(profile.id) && !profile.running).map((profile) => profile.id))}><Glyph name="play" />{t("Start")}</button>
      <button type="button" className="btn ghost xs" disabled={busy || !displayed.some((profile) => selected.has(profile.id) && profile.running)} onClick={() => void action("stop", displayed.filter((profile) => selected.has(profile.id) && profile.running).map((profile) => profile.id))}><Glyph name="close" />{t("Stop")}</button>
      <button type="button" className="btn ghost xs" disabled={busy} onClick={() => { setBatchValue(""); setBatchMode("proxy"); }}>{t("Change proxy")}</button>
      <button type="button" className="btn ghost xs" disabled={busy} onClick={() => { setBatchValue(group === "all" ? "" : group); setBatchMode("group"); }}>{t("Move to group")}</button>
      <button type="button" className="iconbtn" title={t("Clear selection")} aria-label={t("Clear selection")} onClick={() => setSelected(new Set())}><Glyph name="close" /></button>
    </div>}
    {batchMode && <div className="workbench-batch-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setBatchMode(null); }}>
      <div ref={batchEditor} className="workbench-batch-editor" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t(batchMode === "group" ? "Move to group" : "Change proxy")}>
        <h2>{t(batchMode === "group" ? "Move to group" : "Change proxy")}</h2>
        {batchMode === "group" ? <Select className="select" autoFocus aria-label={t("Target group")} value={batchValue} onChange={(event) => setBatchValue(event.target.value)}><option value="">{t("Ungrouped")}</option>{groups.map((name) => <option key={name} value={name}>{name}</option>)}</Select> :
          <><input autoFocus type="text" aria-label={t("New proxy")} placeholder="http://host:port" value={batchValue} onChange={(event) => setBatchValue(event.target.value)} /><p>{t("Stop the selected environments before replacing their proxy.")}</p></>}
        <div><button type="button" className="btn ghost" onClick={() => setBatchMode(null)}>{t("Cancel")}</button><button type="button" className="btn primary" disabled={busy || batchMode === "proxy" && !batchValue.trim()} onClick={() => void applyBatch()}>{t(busy ? "Processing…" : "Apply")}</button></div>
      </div>
    </div>}
  </section>;
}

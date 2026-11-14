import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";
import { overlayHost, TOP_LAYER_PROPS, useTopLayer } from "./top-layer.ts";

/**
 * Vela Browser's own tooltips for every `title` in the app, in place of the system's square yellow
 * box. Pointing at or tabbing to an element that has a title moves the title to `data-vtip`, so the
 * system tooltip never opens, and shows it in the app's glass bubble. An icon button that had only
 * its title for a name keeps that name for screen readers. Nothing in the pages a profile browses is
 * touched: this runs in Vela Browser's own window only.
 */
const DELAY = 480;
const WARM = 90;      // a tooltip just closed: the next opens almost at once
const WARM_FOR = 600;
const GUTTER = 8;
const GAP = 8;

export function adoptTitle(element: Element): string | null {
  const title = element.getAttribute("title");
  if (title !== null) {
    element.removeAttribute("title");
    if (title.trim()) {
      element.setAttribute("data-vtip", title);
      const named = element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby");
      if (!named && !(element.textContent ?? "").trim()) element.setAttribute("aria-label", title);
    } else element.removeAttribute("data-vtip");
  }
  // `data-tip` is the app's own tooltip text, kept current by React; it wins over an adopted title.
  const tip = element.getAttribute("data-tip") ?? element.getAttribute("data-vtip");
  return tip && tip.trim() ? tip : null;
}

const TIPPED = "[title], [data-vtip], [data-tip]";

/** The control already shows these words, as the dock's active item does: a tooltip would repeat them. */
export function showsOwnLabel(element: Element, text: string): boolean {
  const want = text.trim();
  for (const node of [element, ...element.querySelectorAll("*")]) {
    if (![...node.childNodes].some((child) => child.nodeType === 3 && (child.textContent ?? "").trim())) continue;
    if ((node.textContent ?? "").trim() !== want) continue;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (rect.width >= 4 && rect.height >= 4 && style.visibility !== "hidden" && Number(style.opacity) > .5) return true;
  }
  return false;
}

export function placeTip(
  anchor: { left: number; top: number; width: number; height: number },
  bubble: { width: number; height: number },
  view: { width: number; height: number },
): { x: number; y: number; side: "top" | "bottom" } {
  const above = anchor.top - GAP - bubble.height;
  const side = above >= GUTTER || anchor.top + anchor.height + GAP + bubble.height > view.height - GUTTER ? "top" : "bottom";
  const y = side === "top" ? Math.max(GUTTER, above) : anchor.top + anchor.height + GAP;
  const centered = anchor.left + anchor.width / 2 - bubble.width / 2;
  const x = Math.min(Math.max(GUTTER, centered), Math.max(GUTTER, view.width - GUTTER - bubble.width));
  return { x: Math.round(x), y: Math.round(y), side };
}

interface Shown { text: string; anchor: Element; id: number }

export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  useTopLayer(bubble, !!shown);
  const timer = useRef<number | undefined>(undefined);
  const closedAt = useRef(0);
  const current = useRef<Element | null>(null);
  const ids = useRef(0);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) closedAt.current = Date.now();
      current.current = null;
      setShown(null);
      setPlace(null);
    };
    const arm = (element: Element) => {
      const text = adoptTitle(element);
      if (!text) return;
      if (current.current === element) return;
      window.clearTimeout(timer.current);
      const warm = current.current !== null || Date.now() - closedAt.current < WARM_FOR;
      current.current = element;
      setShown(null);
      timer.current = window.setTimeout(() => {
        if (current.current !== element || !element.isConnected) return;
        const tip = adoptTitle(element) ?? text;
        if (showsOwnLabel(element, tip)) return;
        setPlace(null);
        setShown({ text: tip, anchor: element, id: ++ids.current });
        // A label may still be unfolding (the dock's newly active item): once it shows, step aside.
        window.setTimeout(() => { if (current.current === element && showsOwnLabel(element, tip)) hide(); }, 480);
      }, warm ? WARM : DELAY);
    };
    const target = (node: EventTarget | null) => node instanceof Element ? node.closest(TIPPED) : null;
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const element = target(event.target);
      if (element) arm(element);
      else if (current.current) hide();
    };
    const out = (event: PointerEvent) => {
      const anchor = current.current;
      if (!anchor) return;
      const next = event.relatedTarget;
      if (next instanceof Node && anchor.contains(next)) return;
      if (target(next) === null) hide();
    };
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof Element ? target(event.target) : null;
      if (element && element === event.target && element.matches(":focus-visible")) arm(element);
    };
    const blur = (event: FocusEvent) => { if (event.target === current.current) hide(); };
    const key = (event: KeyboardEvent) => { if (event.key !== "Tab" && event.key !== "Shift") hide(); };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("scroll", hide, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!shown || !bubble.current) return;
    const rect = shown.anchor.getBoundingClientRect();
    const size = bubble.current.getBoundingClientRect();
    setPlace(placeTip(rect, size, { width: window.innerWidth, height: window.innerHeight }));
  }, [shown?.id]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={bubble}
      {...TOP_LAYER_PROPS}
      className={`vtip${place ? ` shown ${place.side}` : ""}`}
      role="tooltip"
      style={place ? { left: place.x, top: place.y } : undefined}
    >
      {shown.text}
    </div>,
    overlayHost(shown.anchor),
  );
}

import { useEffect, useRef } from "react";
import type { ViewportClient, ViewportState } from "./workbench-client.ts";

/** Where a point of the page lands on the card that shows it scaled. */
export function cardPoint(point: { x: number; y: number }, card: { width: number; height: number }, page: { width: number; height: number }, fit: "width" | "contain") {
  if (page.width <= 0 || page.height <= 0) return null;
  const scale = fit === "contain" ? Math.min(card.width / page.width, card.height / page.height) : card.width / page.width;
  const left = fit === "contain" ? (card.width - page.width * scale) / 2 : 0;
  const top = fit === "contain" ? (card.height - page.height * scale) / 2 : 0;
  return { x: left + point.x * scale, y: top + point.y * scale };
}

const PALETTE = ["#f0834a", "#1fb5a3", "#8b68f2", "#e9558f", "#3b8fe8", "#5fb847", "#e0a131", "#e5534b"];
const KNOWN: Record<string, string> = { "Claude Code": "#f0834a", Claude: "#f0834a", Codex: "#3b8fe8", OpenClaw: "#1fb5a3", Hermes: "#8b68f2", Cursor: "#5fb847", Gemini: "#e9558f" };

/** Each AI keeps one colour wherever it works: its pointer and its name are drawn in it. */
export function cursorColor(agent: string): string {
  if (KNOWN[agent]) return KNOWN[agent]!;
  let hash = 2166136261;
  for (const character of agent) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return PALETTE[(hash >>> 0) % PALETTE.length]!;
}

const IDLE_MS = 6000;
const GONE_MS = 9000;

interface Cursor { element: HTMLDivElement; at: { x: number; y: number }; target: { x: number; y: number }; placed: boolean; pressed: boolean; lastAt: number }

/**
 * The AI's human-like pointer, drawn over the card as a coloured arrow: each AI working in this
 * browser has its own, in its own colour.
 * It lives in Vela Browser's own view of the page; the page itself is never touched, so nothing
 * about it can be seen or measured by the site.
 */
export function VirtualCursor({ client, surface, state, focused, generation }: {
  client: { current: ViewportClient | null };
  surface: { current: HTMLElement | null };
  state: { current: ViewportState };
  focused: { current: boolean };
  generation: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const connection = client.current, root = layer.current;
    if (!connection || !root) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const cursors = new Map<string, Cursor>();
    let frame = 0;
    const locate = (point: { x: number; y: number }) => {
      const element = surface.current, page = state.current.frame;
      if (!element || !page) return null;
      return cardPoint(point, { width: element.clientWidth, height: element.clientHeight }, page, focused.current ? "contain" : "width");
    };
    const create = (agent: string): Cursor => {
      const element = document.createElement("div");
      element.className = "ai-cursor";
      element.style.setProperty("--c", cursorColor(agent));
      element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 2.6 20.2 9.4 12.6 12.1 9.7 19.6Z"/></svg>`;
      root.appendChild(element);
      return { element, at: { x: 0, y: 0 }, target: { x: 0, y: 0 }, placed: false, pressed: false, lastAt: 0 };
    };
    const draw = () => {
      frame = 0;
      const now = performance.now();
      let busy = false;
      for (const [agent, cursor] of cursors) {
        if (now - cursor.lastAt > GONE_MS) { cursor.element.remove(); cursors.delete(agent); continue; }
        const ease = reduced ? 1 : 0.34;
        cursor.at = cursor.placed ? { x: cursor.at.x + (cursor.target.x - cursor.at.x) * ease, y: cursor.at.y + (cursor.target.y - cursor.at.y) * ease } : { ...cursor.target };
        cursor.placed = true;
        cursor.element.style.transform = `translate3d(${cursor.at.x}px, ${cursor.at.y}px, 0)`;
        cursor.element.classList.toggle("pressed", cursor.pressed);
        cursor.element.classList.toggle("on", now - cursor.lastAt < IDLE_MS);
        if (Math.abs(cursor.target.x - cursor.at.x) + Math.abs(cursor.target.y - cursor.at.y) > .3) busy = true;
      }
      if (busy) frame = requestAnimationFrame(draw);
    };
    const ring = (point: { x: number; y: number }, agent: string) => {
      if (reduced) return;
      const element = document.createElement("span");
      element.className = "ai-cursor-ring";
      element.style.setProperty("--x", `${point.x}px`); element.style.setProperty("--y", `${point.y}px`);
      element.style.setProperty("--c", cursorColor(agent));
      root.appendChild(element);
      element.addEventListener("animationend", () => element.remove(), { once: true });
    };
    const listener = (pointer: { x: number; y: number; phase: "move" | "down" | "up"; agent?: string }) => {
      const point = locate(pointer);
      if (!point) return;
      const agent = pointer.agent || "AI";
      let cursor = cursors.get(agent);
      if (!cursor) { cursor = create(agent); cursors.set(agent, cursor); }
      cursor.target = point; cursor.lastAt = performance.now();
      if (pointer.phase === "down") { cursor.pressed = true; ring(point, agent); }
      if (pointer.phase === "up") cursor.pressed = false;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    connection.pointerListeners.add(listener);
    // Fades and removals happen on time even while no pointer moves.
    const idleCheck = setInterval(() => { if (!frame && cursors.size) frame = requestAnimationFrame(draw); }, 500);
    return () => {
      connection.pointerListeners.delete(listener); cancelAnimationFrame(frame); clearInterval(idleCheck);
      for (const cursor of cursors.values()) cursor.element.remove();
      cursors.clear();
    };
  }, [client, surface, state, focused, generation]);
  return <div ref={layer} className="ai-cursor-layer" aria-hidden="true" />;
}

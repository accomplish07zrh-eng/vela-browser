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

const TRAIL = [0.34, 0.24, 0.16, 0.1];
const IDLE_MS = 2600;

/**
 * The AI's human-like pointer, drawn over the card: a soft gold glow, a short comet trail and a
 * ring for each press. It lives in Vela Browser's own view of the page; the page itself is never
 * touched, so nothing about it can be seen or measured by the site.
 */
export function VirtualCursor({ client, surface, state, focused, generation }: {
  client: { current: ViewportClient | null };
  surface: { current: HTMLElement | null };
  state: { current: ViewportState };
  focused: { current: boolean };
  generation: string;
}) {
  const layer = useRef<HTMLDivElement>(null), cursor = useRef<HTMLDivElement>(null);
  const trail = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    const connection = client.current, root = layer.current, arrow = cursor.current;
    if (!connection || !root || !arrow) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let target: { x: number; y: number } | null = null, at = { x: 0, y: 0 }, lastAt = 0, frame = 0, pressed = false, placed = false;
    const ghosts = TRAIL.map(() => ({ x: 0, y: 0 }));
    const locate = (point: { x: number; y: number }) => {
      const element = surface.current, page = state.current.frame;
      if (!element || !page) return null;
      return cardPoint(point, { width: element.clientWidth, height: element.clientHeight }, page, focused.current ? "contain" : "width");
    };
    const draw = () => {
      frame = 0;
      if (!target) return;
      const ease = reduced ? 1 : 0.38;
      at = placed ? { x: at.x + (target.x - at.x) * ease, y: at.y + (target.y - at.y) * ease } : { ...target };
      if (!placed) for (const ghost of ghosts) Object.assign(ghost, target);
      placed = true;
      arrow.style.transform = `translate3d(${at.x}px, ${at.y}px, 0) scale(${pressed ? .86 : 1})`;
      let previous = at;
      ghosts.forEach((ghost, index) => {
        ghost.x += (previous.x - ghost.x) * TRAIL[index]!; ghost.y += (previous.y - ghost.y) * TRAIL[index]!;
        const element = trail.current[index];
        // Position and size in one transform: a separate scale would also scale the translation.
        if (element) element.style.transform = `translate3d(${ghost.x}px, ${ghost.y}px, 0) scale(${1 - index * .16})`;
        previous = ghost;
      });
      const idle = performance.now() - lastAt > IDLE_MS;
      root.classList.toggle("on", !idle);
      const moving = Math.abs(target.x - at.x) + Math.abs(target.y - at.y) + Math.abs(at.x - ghosts.at(-1)!.x) + Math.abs(at.y - ghosts.at(-1)!.y) > .4;
      if (moving || !idle) frame = requestAnimationFrame(draw);
    };
    const ring = (point: { x: number; y: number }) => {
      if (reduced) return;
      const element = document.createElement("span");
      element.className = "ai-cursor-ring";
      element.style.setProperty("--x", `${point.x}px`); element.style.setProperty("--y", `${point.y}px`);
      root.appendChild(element);
      element.addEventListener("animationend", () => element.remove(), { once: true });
    };
    const listener = (pointer: { x: number; y: number; phase: "move" | "down" | "up" }) => {
      const point = locate(pointer);
      if (!point) return;
      target = point; lastAt = performance.now();
      if (pointer.phase === "down") { pressed = true; ring(point); }
      if (pointer.phase === "up") pressed = false;
      if (!frame) frame = requestAnimationFrame(draw);
    };
    connection.pointerListeners.add(listener);
    // Fade out after a quiet spell even if no frame is pending.
    const idleCheck = setInterval(() => { if (!frame && target) frame = requestAnimationFrame(draw); }, 800);
    return () => { connection.pointerListeners.delete(listener); cancelAnimationFrame(frame); clearInterval(idleCheck); root.classList.remove("on"); };
  }, [client, surface, state, focused, generation]);
  return (
    <div ref={layer} className="ai-cursor-layer" aria-hidden="true">
      {TRAIL.map((_, index) => <span key={index} ref={(element) => { trail.current[index] = element; }} className="ai-cursor-trail" style={{ opacity: .55 - index * .12 }} />)}
      <div ref={cursor} className="ai-cursor">
        <span className="ai-cursor-halo" />
        <svg viewBox="0 0 22 26" width="22" height="26">
          <defs>
            <linearGradient id="ai-cursor-fill" x1="0" y1="0" x2="0.4" y2="1">
              <stop offset="0" stopColor="#fffdf7" /><stop offset="1" stopColor="#efdcae" />
            </linearGradient>
          </defs>
          <path d="M2.2 1.8v17.6l4.7-4.3 3.3 7.3 3.2-1.4-3.2-7.1h6.4Z" fill="url(#ai-cursor-fill)" stroke="#1a1814" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
        <span className="ai-cursor-tag">AI</span>
      </div>
    </div>
  );
}

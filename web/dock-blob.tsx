import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type Box = { x: number; w: number };

/** An underdamped spring, sampled once, so the browser can play it off the main thread. */
function springFrames(from: Box, to: Box): Keyframe[] {
  const frames: Keyframe[] = [];
  let x = from.x, w = from.w, vx = 0, vw = 0;
  const k = 520, c = 26, dt = 1 / 240;
  for (let step = 0; step < 240 * 1.4; step++) {
    vx += (k * (to.x - x) - c * vx) * dt; x += vx * dt;
    vw += (k * (to.w - w) - c * vw) * dt; w += vw * dt;
    if (step % 4 === 0) {
      // Speed stretches the jelly along its path and thins it; the overshoot squashes it on landing.
      const speed = Math.min(1, Math.abs(vx) / 2600);
      const stretch = 1 + speed * .22, thin = 1 - speed * .14;
      const visual = Math.max(1, w * stretch), left = x + (w - visual) / 2;
      frames.push({ transform: `translate3d(${left.toFixed(2)}px, 0, 0) scale(${(visual / Math.max(1, to.w)).toFixed(4)}, ${thin.toFixed(4)})` });
    }
    if (Math.abs(to.x - x) < .2 && Math.abs(to.w - w) < .2 && Math.abs(vx) < 3 && Math.abs(vw) < 3) break;
  }
  frames.push({ transform: `translate3d(${to.x}px, 0, 0) scale(1, 1)` });
  return frames;
}

const ITEM_SPRING = "linear(0, 0.02048, 0.07247, 0.14428, 0.22704, 0.31418, 0.40099, 0.48423, 0.56178, 0.63239, 0.69548, 0.75092, 0.79893, 0.83993, 0.8745, 0.90329, 0.92695, 0.94616, 0.96154, 0.97367, 0.98309, 0.99027, 0.99561, 0.99948, 1.00218, 1.00396, 1.00505, 1.0056, 1.00577, 1.00566, 1.00537, 1.00496, 1.00449, 1.00399, 1.00348, 1.003, 1.00255, 1.00214, 1.00178, 1.00145, 1)";

/**
 * The dock's active highlight as one piece of jelly. It starts sliding the moment an item is
 * pressed, before the new page has rendered, and plays on the compositor, so a page that takes a
 * while to build never makes it stutter. When the page arrives it settles from wherever it is onto
 * the item's exact place, and the icons that the opening label pushes aside glide there too.
 */
export function DockBlob({ nav, active }: { nav: RefObject<HTMLElement | null>; active: string }) {
  const blob = useRef<HTMLSpanElement>(null);
  const motion = useRef<Animation | null>(null);
  const lefts = useRef(new WeakMap<Element, number>());
  const reduced = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  /** Where the blob is drawn right now, mid-animation included. */
  const visual = (): Box | null => {
    const element = blob.current;
    if (!element || element.style.opacity === "0" || !element.style.width) return null;
    const transform = getComputedStyle(element).transform;
    const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
    return { x: matrix.m41, w: (parseFloat(element.style.width) || 0) * matrix.a };
  };
  const glide = (to: Box | null) => {
    const element = blob.current;
    if (!element) return;
    // Already heading exactly there (the press predicted it): let that motion run on undisturbed.
    const heading = element.style.opacity !== "0" && to && Math.abs(parseFloat(element.style.width) - to.w) < .5
      && Math.abs(new DOMMatrixReadOnly(element.style.transform || undefined).m41 - to.x) < .5;
    if (heading) return;
    const from = visual();
    motion.current?.cancel();
    if (!to) {
      if (from && !reduced()) motion.current = element.animate([{ opacity: 1, transform: `translate3d(${from.x}px,0,0) scale(1)` }, { opacity: 0, transform: `translate3d(${from.x}px,0,0) scale(.6)` }], { duration: 220, easing: "ease-out" });
      element.style.opacity = "0";
      return;
    }
    element.style.width = `${to.w}px`;
    element.style.transform = `translate3d(${to.x}px, 0, 0)`;
    element.style.opacity = "1";
    if (!from || reduced()) return;
    const frames = springFrames(from, to);
    motion.current = element.animate(frames, { duration: frames.length * (4000 / 240), easing: "linear" });
  };

  // The press: slide toward where the item will be once its label opens, before React re-renders.
  useEffect(() => {
    const container = blob.current?.parentElement ?? nav.current;
    if (!container) return;
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const item = (event.target as Element).closest<HTMLElement>(".navitem");
      if (!item || !container.contains(item) || item.classList.contains("active") || item.classList.contains("dock-groups")) return;
      const items = [...container.querySelectorAll<HTMLElement>(".navitem")];
      const label = (element: HTMLElement) => element.querySelector<HTMLElement>(".navlabel");
      const open = items.find((entry) => entry.classList.contains("active"));
      const opened = open ? (label(open)?.offsetWidth ?? 0) + 8 : 0;
      const grow = (label(item)?.scrollWidth ?? 0) + 8;
      const x = item.offsetLeft - (open && items.indexOf(open) < items.indexOf(item) ? opened : 0);
      glide({ x, w: item.offsetWidth + grow });
    };
    container.addEventListener("pointerdown", press, true);
    return () => container.removeEventListener("pointerdown", press, true);
  }, [nav]);

  // The page has arrived: settle on the exact place, and let displaced icons glide rather than jump.
  useLayoutEffect(() => {
    // The blob's own parent: on the first commit React has not yet attached the nav's ref.
    const container = blob.current?.parentElement ?? nav.current;
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>(".navitem")];
    for (const item of items) {
      const left = item.offsetLeft, before = lefts.current.get(item);
      lefts.current.set(item, left);
      if (before === undefined || Math.abs(before - left) < .5 || reduced()) continue;
      item.animate([{ transform: `translateX(${before - left}px)` }, { transform: "translateX(0)" }], { duration: 520, easing: ITEM_SPRING });
    }
    const target = items.find((item) => item.classList.contains("active"));
    glide(target ? { x: target.offsetLeft, w: target.offsetWidth } : null);
  }, [nav, active]);

  return <span ref={blob} className="dock-blob" aria-hidden="true" />;
}

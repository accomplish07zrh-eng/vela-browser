import { useLayoutEffect, type RefObject } from "react";

/**
 * Where the app's floating layers (dropdown lists, confirm dialogs, tooltips) go. A native modal
 * <dialog> sits in the browser's top layer and makes everything outside it inert, so a layer
 * opened from inside one, or while one is open, goes inside that dialog; otherwise into the app.
 */
export function overlayHost(from?: Element | null): Element {
  const own = from?.closest("dialog[open]");
  if (own) return own;
  const open = [...document.querySelectorAll("dialog[open]")];
  return open.at(-1) ?? document.querySelector(".app") ?? document.body;
}

/** Spread onto a floating layer's element so useTopLayer can lift it. */
export const TOP_LAYER_PROPS = { popover: "manual" } as Record<string, string>;

/**
 * Lifts a floating layer into the browser's top layer (the Popover API), above any open dialog and
 * free of its clipping. Where the API is missing the element stays where it is rendered.
 */
export function useTopLayer(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current as (HTMLElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!active || !element || typeof element.showPopover !== "function") return;
    try { if (!element.matches(":popover-open")) element.showPopover(); } catch { /* not connected yet */ }
    return () => { try { element.hidePopover?.(); } catch { /* already gone */ } };
  }, [ref, active]);
}

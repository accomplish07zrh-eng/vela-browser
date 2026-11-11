import type { KeyboardEvent } from "react";

/** Keep Tab inside desktop dialogs; native WebView2 otherwise visits the host between cycles. */
export function trapDialogTab(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const element = event.currentTarget;
  const items = [...element.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], summary, [tabindex]")]
    .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && item.getClientRects().length > 0 && !item.closest("[inert]"));
  const first = items[0], last = items.at(-1), active = document.activeElement;
  if (!first || !last) { event.preventDefault(); element.focus(); return; }
  if (event.shiftKey && active === first || !event.shiftKey && active === last || !active || !element.contains(active)) {
    event.preventDefault(); (event.shiftKey ? last : first).focus();
  }
}

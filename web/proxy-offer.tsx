import { createContext } from "react";

/**
 * Clean build: proxy-provider placements and the in-app proxy store are not
 * part of Vela Browser. The exports remain as no-op compatibility shims so the
 * rest of the local dashboard can share the same profile/proxy model.
 */
export const PROXY_SRC = [
  "sidebar-cart", "profile-dialog", "profile-dialog-check-failed", "import-no-proxy",
  "proxies-no-proxy", "proxies-check", "proxies-check-failed",
  "proxies-tab", "my-proxies-buy-more", "success-buy-more", "direct",
] as const;
export type ProxySrc = (typeof PROXY_SRC)[number];

export const ProxyStoreContext = createContext<((quantity: number, src: ProxySrc) => void) | null>(null);

export function proxyOfferUrl(_placement?: ProxySrc, _language?: string, _quantity = 0): string {
  return "#";
}

export function CartIcon({ className }: { className?: string }) {
  return <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true" />;
}

export function ProxyProviderOffer(_props: {
  placement: ProxySrc;
  replacement?: boolean;
  missing?: number;
}) {
  return null;
}

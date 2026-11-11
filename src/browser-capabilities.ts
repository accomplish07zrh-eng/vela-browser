export const WEBKIT_CAPABILITIES = ["webkit-native", "cookies", "navigation", "sessions", "workbench"] as const;
export function webkitPublicFields() {
  return { engine: "webkit" as const, experimental: true, capabilities: WEBKIT_CAPABILITIES };
}

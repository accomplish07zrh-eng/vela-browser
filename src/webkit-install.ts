import { ensurePinnedRuntime, type AliasmodeChromiumDeps, type PinnedRuntime } from "./aliasmode-chromium.ts";
import { WEBKIT_REVISION, webkitSupported } from "./webkit-config.ts";

export const WEBKIT_EXECUTABLE_SHA256 = "191e2f0cfade1d4cde1c7e5155bda956effafd201e7ec22c92edbfb0d0c4c8f0";
export const WEBKIT_ARCHIVE: PinnedRuntime = {
  label: "WebKit", runtime: "webkit", dir: `webkit-${WEBKIT_REVISION}-win64`,
  url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/${WEBKIT_REVISION}/webkit-win64.zip`,
  archiveSha256: "0b390661995316d8f90fe0f7a0498f3a88c451c097fc8e4047342e1fbd36548b",
  size: 65443702, archiveRoot: "", executable: "Playwright.exe", executableSha256: WEBKIT_EXECUTABLE_SHA256,
};

export function ensureWebKit(root: string, deps: AliasmodeChromiumDeps = {}, platform = process.platform, arch: string = process.arch): Promise<string> {
  if (!webkitSupported(platform, arch)) return Promise.reject(new Error("WebKit currently requires Windows x64"));
  return ensurePinnedRuntime(WEBKIT_ARCHIVE, root, deps, platform);
}

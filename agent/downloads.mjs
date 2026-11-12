// Firefox and WebKit run under Playwright, which takes every download into a temporary folder,
// names it with a random id and deletes it when the browser closes. Handing downloads back to
// Firefox would leave Playwright waiting on the click that started one, so instead each finished
// download is saved, under the name the site gave it, into the computer's own Downloads folder.
// Chromium keeps its own download handling (see the playwright-core patch) and needs none of this.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** Known folder id of Downloads; the user may have moved it to another drive. */
const WINDOWS_DOWNLOADS = "{374DE290-123F-4565-9164-39C4925E467B}";
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function systemDownloadsDir({ platform = process.platform, home = homedir(), run = execFileSync } = {}) {
  const fallback = join(home, "Downloads");
  try {
    if (platform === "win32") {
      const output = run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders", "/v", WINDOWS_DOWNLOADS],
        { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
      const found = /REG_SZ\s+(.+?)\s*$/m.exec(String(output))?.[1];
      if (found) return found;
    } else if (platform === "linux") {
      const found = String(run("xdg-user-dir", ["DOWNLOAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] })).trim();
      if (found && found !== home) return found;
    }
  } catch {}
  return fallback;
}

/** The site's file name, made safe to create on any of the three systems. */
export function safeFileName(name) {
  let clean = String(name ?? "").split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f<>:"|?*\u007f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!clean || clean === "." || clean === "..") clean = "download";
  const stem = clean.slice(0, clean.length - extname(clean).length);
  if (WINDOWS_RESERVED.test(stem)) clean = `_${clean}`;
  // Keep within common file-system limits, preserving the extension.
  if (clean.length > 180) {
    const ext = extname(clean).slice(0, 20);
    clean = clean.slice(0, 180 - ext.length) + ext;
  }
  return clean;
}

/** A path in dir for name that no existing file and no save in progress already uses: "a (1).pdf". */
export function uniquePath(dir, name, taken = new Set(), exists = existsSync) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    const key = candidate.toLowerCase();
    if (!taken.has(key) && !exists(candidate)) { taken.add(key); return candidate; }
  }
}

/**
 * Saves every download of this context into dir as it finishes. Returns a function that stops.
 * @param {any} context
 * @param {{ dir?: string, log?: (line: string) => void }} [options]
 */
export function keepDownloads(context, options = {}) {
  const { dir, log = () => {} } = options;
  const taken = new Set();
  const watched = new WeakSet();
  let folder;
  const save = async (download) => {
    let target;
    try {
      folder ??= dir ?? systemDownloadsDir();
      mkdirSync(folder, { recursive: true });
      target = uniquePath(folder, safeFileName(download.suggestedFilename()), taken);
      await download.saveAs(target);
      log(`download saved: ${target}`);
    } catch (error) {
      log(`download not saved${target ? ` to ${target}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (target) taken.delete(target.toLowerCase());
    }
  };
  const onDownload = (download) => { void save(download); };
  const watch = (page) => {
    if (watched.has(page)) return;
    watched.add(page);
    page.on("download", onDownload);
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  return () => {
    context.off?.("page", watch);
    for (const page of context.pages()) page.off?.("download", onDownload);
  };
}

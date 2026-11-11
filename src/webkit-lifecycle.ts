import { win32 } from "node:path";
import type { HostProcessSnapshot } from "./launcher.ts";
import { commandArgs, type FirefoxProcessIdentity } from "./firefox-lifecycle.ts";

/** WebKit helpers belong to an exact profile root, never merely to an executable name. */
export function matchWebKitProcesses(identity: FirefoxProcessIdentity & { browserPid?: number }, snapshot: HostProcessSnapshot): { browsers: number[]; owners: number[] } | null {
  if (snapshot.incomplete) return null;
  const path = (value: string) => win32.normalize(value).toLowerCase();
  const binary = path(identity.binaryPath), owner = path(identity.ownerBinaryPath), directory = path(identity.userDataDir);
  const helpers = new Set(["WebKitGPUProcess.exe", "WebKitNetworkProcess.exe", "WebKitWebProcess.exe"].map((name) => path(win32.join(win32.dirname(identity.binaryPath), name))));
  const consoleHost = path(win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "conhost.exe"));
  const browsers: number[] = [], owners: number[] = [];
  for (const record of snapshot.records) {
    const args = record.argv ?? commandArgs(record.commandLine ?? "");
    const profile = args.some((arg, index) => arg.startsWith("--user-data-dir=")
      ? path(arg.slice("--user-data-dir=".length)) === directory
      : arg === "--user-data-dir" && !!args[index + 1] && path(args[index + 1]!) === directory);
    const marker = args.includes(`--aliasmode-webkit-owner=${identity.generation}`);
    if (!profile && !marker) continue;
    if (!record.executablePath || record.executablePathExact === false) return null;
    if (profile) { if (path(record.executablePath) !== binary) return null; browsers.push(record.pid); }
    if (marker) { if (path(record.executablePath) !== owner) return null; owners.push(record.pid); }
  }
  const owned = new Set(browsers);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of snapshot.records) {
      if (owned.has(record.pid) || !record.parentPid || !owned.has(record.parentPid)) continue;
      // Windows creates a console host for each native WebKit helper. It closes
      // with that helper and is never a browser process we may terminate.
      if (record.executablePathExact !== false && record.executablePath && path(record.executablePath) === consoleHost) continue;
      if (!record.executablePath || record.executablePathExact === false || !helpers.has(path(record.executablePath))) return null;
      owned.add(record.pid); browsers.push(record.pid); changed = true;
    }
  }
  // A root disappearing before its helper is a wait condition, not permission to kill by an old PID.
  if (!owned.has(identity.browserPid ?? 0) && snapshot.records.some((record) => record.parentPid === identity.browserPid
    && record.executablePath && helpers.has(path(record.executablePath)))) return null;
  return { browsers, owners };
}

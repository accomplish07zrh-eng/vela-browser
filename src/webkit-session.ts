import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cookiesForEngine } from "./parse.ts";
import { parseCapturedSessionBundle } from "./session.ts";
import type { CookieRecord } from "./types.ts";

export const WEBKIT_SESSION_FILE = "aliasmode-webkit-session.json";

/** Only a graceful close's native session cookies supplement WebKit's own disk store. */
export function readWebKitSessionCookies(directory: string, profileId: string): CookieRecord[] | null {
  try {
    const file = join(directory, WEBKIT_SESSION_FILE);
    if (statSync(file).size > 4 * 1024 * 1024) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.version !== 1 || value.profileId !== profileId
      || typeof value.generation !== "string" || !/^\d+:\d+$/.test(value.generation)
      || !Array.isArray(value.cookies)) return null;
    const { cookies } = parseCapturedSessionBundle(JSON.stringify({ cookies: value.cookies, origins: [] }));
    return cookiesForEngine(cookies.filter((cookie) => cookie.expires === undefined || cookie.expires <= 0), "webkit");
  } catch { return null; }
}

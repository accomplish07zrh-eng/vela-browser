import type { NewProfileInput, UiProfile } from "./api.ts";

export type ProfileStatusFilter = "all" | "running" | "stopped" | "attention";
export type ProfileEngineFilter = "all" | UiProfile["engine"];
export interface ProfileFilters {
  query: string;
  group: string;
  sharedOnly: boolean;
  status: ProfileStatusFilter;
  engine: ProfileEngineFilter;
  tag: string;
}
export const EMPTY_PROFILE_FILTERS: ProfileFilters = { query: "", group: "all", sharedOnly: false, status: "all", engine: "all", tag: "" };
export interface SavedProfileView { id: string; name: string; filters: ProfileFilters }
export type ProfileTemplateSettings = Pick<NewProfileInput, "engine" | "chromiumRuntime" | "group" | "platform" | "screen" | "platformOs">;
export interface ProfileTemplate { id: string; name: string; settings: ProfileTemplateSettings }
export const MAX_SAVED_PROFILE_ITEMS = 24;
export const MAX_BATCH_CREATE = 100;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 256) => typeof value === "string" ? value.slice(0, max) : "";

export function managementStorageKey(kind: "views" | "templates", scope: string): string {
  return `vela.profiles.${kind}.v1:${encodeURIComponent(scope)}`;
}

export function profileNeedsAttention(profile: UiProfile): boolean {
  return !!(profile.proxyError || profile.fpVerdict?.verdict === "mismatch" || profile.parkedSession || profile.cloudUnsavedSince || profile.restartPending || profile.healthStatus === "suspended");
}

/** Group ancestry and shared permissions are resolved by the roster before this predicate. */
export function matchesProfileFilters(profile: UiProfile, filters: ProfileFilters, number: string): boolean {
  if (filters.status === "running" && !profile.running || filters.status === "stopped" && profile.running || filters.status === "attention" && !profileNeedsAttention(profile)) return false;
  if (filters.engine !== "all" && profile.engine !== filters.engine) return false;
  if (filters.tag && !(profile.tags ?? []).includes(filters.tag)) return false;
  const needle = filters.query.trim().toLocaleLowerCase();
  return !needle || [profile.id, profile.name, number, ...(profile.tags ?? [])].some((value) => value.toLocaleLowerCase().includes(needle));
}

function profileFilters(value: unknown): ProfileFilters {
  if (!record(value)) return { ...EMPTY_PROFILE_FILTERS };
  return {
    query: text(value.query), group: text(value.group) || "all", sharedOnly: value.sharedOnly === true,
    status: ["running", "stopped", "attention"].includes(String(value.status)) ? value.status as ProfileStatusFilter : "all",
    engine: ["chromium", "firefox", "webkit"].includes(String(value.engine)) ? value.engine as ProfileEngineFilter : "all",
    tag: text(value.tag),
  };
}

/** An allowlist keeps credentials, profile ids, cookies and seeds out of reusable templates. */
export function profileTemplateSettings(value: unknown): ProfileTemplateSettings {
  const input = record(value) ? value : {};
  const engine = input.engine === "firefox" || input.engine === "webkit" ? input.engine : "chromium";
  return {
    engine,
    ...(engine === "chromium" ? { chromiumRuntime: input.chromiumRuntime === "aliasmode" ? "aliasmode" : "cloakbrowser" } : {}),
    group: text(input.group), platform: text(input.platform), screen: text(input.screen, 64),
    ...(engine !== "webkit" && ["windows", "macos", "linux"].includes(String(input.platformOs)) ? { platformOs: input.platformOs as string } : {}),
  };
}

export function parseManagementItems(kind: "views", raw: string | null): SavedProfileView[];
export function parseManagementItems(kind: "templates", raw: string | null): ProfileTemplate[];
export function parseManagementItems(kind: "views" | "templates", raw: string | null): (SavedProfileView | ProfileTemplate)[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items)) return [];
    const seen = new Set<string>();
    return parsed.items.flatMap((item) => {
      if (!record(item)) return [];
      const id = text(item.id, 80), name = text(item.name, 64).trim();
      if (!id || !name || seen.has(id) || !record(kind === "views" ? item.filters : item.settings)) return [];
      seen.add(id);
      return [kind === "views" ? { id, name, filters: profileFilters(item.filters) } : { id, name, settings: profileTemplateSettings(item.settings) }];
    }).slice(0, MAX_SAVED_PROFILE_ITEMS);
  } catch { return []; }
}

export function serializeManagementItems(items: readonly (SavedProfileView | ProfileTemplate)[]): string {
  return JSON.stringify({ version: 1, items });
}

export function batchProfileNames(count: number, pattern: string, start: number): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_CREATE) throw new Error("Choose between 1 and 100 profiles.");
  if (!Number.isInteger(start) || start < 1 || start + count - 1 > 999999) throw new Error("The starting number must fit within 1–999999.");
  if (!pattern.trim() || pattern.length > 120 || !/\{n(?::[1-6])?\}/.test(pattern)) throw new Error("Include {n} or {n:2} in the naming rule.");
  return Array.from({ length: count }, (_, index) => pattern.trim().replace(/\{n(?::([1-6]))?\}/g, (_, width: string | undefined) => String(start + index).padStart(Number(width ?? 1), "0")));
}

export type BatchCreateState = "queued" | "creating" | "created" | "failed" | "uncertain";
export interface BatchCreateItem { input: NewProfileInput; state: BatchCreateState; id?: string; error?: string }
export interface CreateProfileResponse { ok: boolean; id?: string; error?: string; uncertain?: boolean }

/** Sequential creation makes stop deterministic. Only queued entries can be sent once. */
export async function runProfileCreation(
  items: readonly BatchCreateItem[],
  create: (input: NewProfileInput) => Promise<CreateProfileResponse>,
  changed: (items: BatchCreateItem[]) => void,
  stopped: () => boolean = () => false,
): Promise<BatchCreateItem[]> {
  const result = items.map((item) => ({ ...item }));
  if (result.some((item) => item.state === "uncertain" || item.state === "creating")) return result;
  for (const item of result) {
    if (stopped()) break;
    if (item.state !== "queued") continue;
    item.state = "creating"; changed(result.map((entry) => ({ ...entry })));
    try {
      const response = await create(item.input);
      if (response.ok && response.id) { item.state = "created"; item.id = response.id; delete item.error; }
      else {
        // A malformed success or a server-side post-create failure can have persisted already.
        item.state = response.uncertain || response.ok ? "uncertain" : "failed";
        item.error = response.error || "Creation could not be confirmed. Refresh the list before creating again.";
      }
    } catch {
      item.state = "uncertain";
      item.error = "Creation could not be confirmed. Refresh the list before creating again.";
    }
    changed(result.map((entry) => ({ ...entry })));
    // Preserve the remaining queue when the response is ambiguous; never duplicate by retrying.
    if (item.state === "uncertain") break;
  }
  return result;
}

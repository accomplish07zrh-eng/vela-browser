import { expect, test } from "bun:test";
import {
  EMPTY_PROFILE_FILTERS, MAX_SAVED_PROFILE_ITEMS, batchProfileNames, managementStorageKey,
  matchesProfileFilters, parseManagementItems, profileTemplateSettings, runProfileCreation, serializeManagementItems,
  type BatchCreateItem,
} from "./profile-management.ts";
import type { UiProfile } from "./api.ts";

const profile = (set: Partial<UiProfile> = {}): UiProfile => ({
  id: "profile-a", name: "Studio North", engine: "chromium", group: "Studio", platform: "", tags: ["Review"],
  proxy: null, timezone: "UTC", cookieCount: 0, seeded: false, screen: "1920x1080", has2fa: false, running: false, ...set,
});
const queue = (names = ["A", "B", "C"]): BatchCreateItem[] => names.map((name) => ({ input: { name, engine: "firefox" }, state: "queued" }));

test("profile filters intersect status, engine, exact tag, and the searchable identity", () => {
  const filters = { ...EMPTY_PROFILE_FILTERS, query: " north ", engine: "firefox" as const, status: "running" as const, tag: "Review" };
  expect(matchesProfileFilters(profile({ engine: "firefox", running: true }), filters, "04")).toBe(true);
  expect(matchesProfileFilters(profile({ running: true }), filters, "04")).toBe(false);
  expect(matchesProfileFilters(profile({ engine: "firefox" }), filters, "04")).toBe(false);
  expect(matchesProfileFilters(profile({ engine: "firefox", running: true, tags: ["review"] }), filters, "04")).toBe(false);
  for (const query of ["PROFILE-A", "04", "review"]) expect(matchesProfileFilters(profile(), { ...EMPTY_PROFILE_FILTERS, query }, "04")).toBe(true);
  expect(matchesProfileFilters(profile({ running: true }), { ...EMPTY_PROFILE_FILTERS, status: "stopped" }, "04")).toBe(false);
});

test("attention uses recorded problems without treating an unmeasured fingerprint as a failure", () => {
  const filters = { ...EMPTY_PROFILE_FILTERS, status: "attention" as const };
  expect(matchesProfileFilters(profile(), filters, "01")).toBe(false);
  expect(matchesProfileFilters(profile({ fpVerdict: { verdict: "match", differences: [] } }), filters, "01")).toBe(false);
  for (const problem of [{ proxyError: "unreachable" }, { restartPending: true }, { healthStatus: "suspended" as const }, { fpVerdict: { verdict: "mismatch" as const, differences: [] } }]) {
    expect(matchesProfileFilters(profile(problem), filters, "01")).toBe(true);
  }
});

test("saved views survive a round trip and are scoped to account and workspace", () => {
  const items = [{ id: "v1", name: "Running Firefox", filters: { ...EMPTY_PROFILE_FILTERS, status: "running" as const, engine: "firefox" as const, group: "North" } }];
  expect(parseManagementItems("views", serializeManagementItems(items))).toEqual(items);
  expect(managementStorageKey("views", "local")).not.toBe(managementStorageKey("templates", "local"));
  expect(managementStorageKey("views", JSON.stringify(["cloud", "u1", "w1"]))).not.toBe(managementStorageKey("views", JSON.stringify(["cloud", "u1", "w2"])));
  expect(managementStorageKey("views", JSON.stringify(["cloud", "u1", "w1"]))).not.toBe(managementStorageKey("views", JSON.stringify(["cloud", "u2", "w1"])));
});

test("malformed storage is bounded, de-duplicated and normalized", () => {
  for (const raw of [null, "bad", "null", "[]", '{"version":2,"items":[]}']) expect(parseManagementItems("views", raw)).toEqual([]);
  const raw = { version: 1, items: [null, { id: "", name: "", filters: {} }, { id: "one", name: " One ", filters: { status: "bogus", engine: "safari", query: 5, sharedOnly: "yes" } }, { id: "one", name: "duplicate", filters: {} }, ...Array.from({ length: 50 }, (_, n) => ({ id: `v${n}`, name: `View ${n}`, filters: {} }))] };
  const items = parseManagementItems("views", JSON.stringify(raw));
  expect(items).toHaveLength(MAX_SAVED_PROFILE_ITEMS);
  expect(items[0]).toEqual({ id: "one", name: "One", filters: EMPTY_PROFILE_FILTERS });
});

test("templates discard identity, session and credentials when saved or loaded", () => {
  const input = { engine: "firefox", group: "Studio", platform: "example.test", screen: "1920x1080", platformOs: "windows", id: "old-id", fingerprintSeed: 123, password: "secret", username: "account", proxy: { host: "private", pass: "secret" }, cookies: [{ value: "secret" }], customNo: "111", extensions: ["private"] };
  const safe = { engine: "firefox" as const, group: "Studio", platform: "example.test", screen: "1920x1080", platformOs: "windows" };
  expect(profileTemplateSettings(input)).toEqual(safe);
  const loaded = parseManagementItems("templates", JSON.stringify({ version: 1, items: [{ id: "t1", name: "Studio", settings: input }] }));
  expect(loaded).toEqual([{ id: "t1", name: "Studio", settings: safe }]);
  expect(serializeManagementItems(loaded)).not.toContain("secret");
  expect(profileTemplateSettings({ engine: "webkit", platformOs: "macos", chromiumRuntime: "aliasmode" })).toEqual({ engine: "webkit", group: "", platform: "", screen: "" });
});

test("batch names use explicit sequential tokens and reject unbounded or ambiguous plans", () => {
  expect(batchProfileNames(3, "Studio {n:2}", 9)).toEqual(["Studio 09", "Studio 10", "Studio 11"]);
  expect(batchProfileNames(2, "{n}-{n:3}", 1)).toEqual(["1-001", "2-002"]);
  for (const count of [0, -1, 101, 1.5, NaN]) expect(() => batchProfileNames(count, "Studio {n}", 1)).toThrow();
  for (const pattern of ["", "Studio", "{n:0}", "{n:7}", "x".repeat(121) + "{n}"]) expect(() => batchProfileNames(2, pattern, 1)).toThrow();
  expect(() => batchProfileNames(2, "{n}", 999999)).toThrow();
});

test("creation preserves partial results and resumes only entries still queued", async () => {
  let stop = false;
  const called: string[] = [];
  const input = queue();
  const paused = await runProfileCreation(input, async (entry) => { called.push(entry.name!); stop = true; return { ok: true, id: `id-${entry.name}` }; }, () => {}, () => stop);
  expect(paused.map((item) => item.state)).toEqual(["created", "queued", "queued"]);
  expect(input.map((item) => item.state)).toEqual(["queued", "queued", "queued"]);
  stop = false;
  const finished = await runProfileCreation(paused, async (entry) => { called.push(entry.name!); return { ok: true, id: `id-${entry.name}` }; }, () => {});
  expect(called).toEqual(["A", "B", "C"]);
  expect(finished.map((item) => item.id)).toEqual(["id-A", "id-B", "id-C"]);
});

test("ambiguous creation stops the queue and is never retried", async () => {
  const called: string[] = [];
  const result = await runProfileCreation(queue(), async (entry) => {
    called.push(entry.name!); if (entry.name === "B") throw new Error("connection lost after save"); return { ok: true, id: `id-${entry.name}` };
  }, () => {});
  expect(result.map((item) => item.state)).toEqual(["created", "uncertain", "queued"]);
  expect(called).toEqual(["A", "B"]);
  // Even a caller that resumes the helper cannot re-send the uncertain entry.
  await runProfileCreation(result, async (entry) => { called.push(entry.name!); return { ok: true, id: `id-${entry.name}` }; }, () => {});
  expect(called.filter((name) => name === "B")).toHaveLength(1);
});

test("a definitive rejection can be retried without re-creating successful entries", async () => {
  const result = await runProfileCreation(queue(["A", "B"]), async (entry) => entry.name === "A" ? { ok: true, id: "id-A" } : { ok: false, error: "invalid input", uncertain: false }, () => {});
  expect(result.map((item) => item.state)).toEqual(["created", "failed"]);
  const called: string[] = [];
  const retried = await runProfileCreation(result.map((item) => item.state === "failed" ? { input: item.input, state: "queued" } : item), async (entry) => { called.push(entry.name!); return { ok: true, id: "id-B" }; }, () => {});
  expect(called).toEqual(["B"]);
  expect(retried.map((item) => item.id)).toEqual(["id-A", "id-B"]);
});

test("a malformed success or explicit uncertain server response cannot become a retryable failure", async () => {
  for (const response of [{ ok: true }, { ok: false, uncertain: true, error: "Cloud response missing" }]) {
    const result = await runProfileCreation(queue(), async () => response, () => {});
    expect(result.map((item) => item.state)).toEqual(["uncertain", "queued", "queued"]);
  }
});

import { expect, test } from "bun:test";
import { assessProfile, sharedExits, type ExitInfo } from "./health.ts";
import type { Profile } from "./types.ts";

const base = {
  id: "p1", name: "Shop", group: "", platform: "", username: "", password: "", fakey: "", cookies: [], tags: [],
  proxy: { type: "http", host: "1.2.3.4", port: "8080", user: "", pass: "" },
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
  timezone: "America/New_York", locale: "en-US", platformOs: "windows", screenWidth: 1920, screenHeight: 1080,
  fpObserved: { capturedAt: new Date(Date.UTC(2026, 10, 10)).toISOString(), platform: "Win32", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", timezone: "America/New_York", languages: "en-US,en", screen: "1920*1080" },
} as unknown as Profile;
const exit: ExitInfo = { status: "ok", ip: "9.9.9.9", country: "US", timezone: "America/Detroit", checkedAt: 0, via: "proxy" };
const now = Date.UTC(2026, 10, 14);

test("a consistent profile scores 100, and an equivalent timezone of the exit is not a mismatch", () => {
  const report = assessProfile(base, exit, { now });
  expect(report.issues).toEqual([]);
  expect(report).toMatchObject({ score: 100, level: "good" });
});

test("disagreements cost points, the worst first", () => {
  const profile = { ...base, timezone: "Asia/Shanghai", locale: "ja-JP", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", fpObserved: { ...base.fpObserved!, timezone: "Europe/London", screen: "1366*768" } } as Profile;
  const report = assessProfile(profile, exit, { now, sharedExit: 2 });
  const ids = report.issues.map((issue) => issue.id);
  expect(ids).toEqual(expect.arrayContaining(["timezone-exit", "language-exit", "ua-system", "timezone-applied", "screen-applied", "language-applied", "exit-shared"]));
  expect(report.issues[0]!.severity).toBe("high");
  expect(report.level).toBe("poor");
  expect(report.score).toBe(0);
});

test("no proxy, a failed exit and a profile never opened are reported", () => {
  const direct = assessProfile({ ...base, proxy: undefined, fpObserved: undefined } as unknown as Profile, { status: "ok", checkedAt: 0, via: "direct" }, { now });
  expect(direct.issues.map((issue) => issue.id)).toEqual(["no-proxy", "never-measured"]);
  expect(assessProfile(base, { status: "failed", checkedAt: 0, via: "proxy" }, { now }).issues.map((issue) => issue.id)).toContain("exit-failed");
  expect(assessProfile(base, undefined, { now }).issues.map((issue) => issue.id)).toEqual(["exit-unchecked"]);
});

test("profiles sharing a proxied exit are counted; direct exits are not", () => {
  const shared = sharedExits(new Map<string, ExitInfo>([
    ["a", { status: "ok", ip: "1.1.1.1", checkedAt: 0, via: "pool" }],
    ["b", { status: "ok", ip: "1.1.1.1", checkedAt: 0, via: "proxy" }],
    ["c", { status: "ok", ip: "2.2.2.2", checkedAt: 0, via: "proxy" }],
    ["d", { status: "ok", ip: "1.1.1.1", checkedAt: 0, via: "direct" }],
  ]));
  expect(Object.fromEntries(shared)).toEqual({ a: 1, b: 1, c: 0 });
});

test("shared exits are grouped and riskier when their profiles use the same site; reused accounts are found and masked", async () => {
  const { associations, maskAccount } = await import("./health.ts");
  const profile = (id: string, platform: string, username = "") => ({ ...base, id, name: id, platform, username }) as Profile;
  const exits = new Map<string, ExitInfo>([
    ["a", { status: "ok", ip: "1.1.1.1", checkedAt: 0, via: "pool" }],
    ["b", { status: "ok", ip: "1.1.1.1", checkedAt: 0, via: "pool" }],
    ["c", { status: "ok", ip: "2.2.2.2", checkedAt: 0, via: "proxy" }],
    ["d", { status: "ok", ip: "2.2.2.2", checkedAt: 0, via: "proxy" }],
  ]);
  const result = associations([
    profile("a", "https://www.tiktok.com/", "alice@gmail.com"), profile("b", "tiktok.com"),
    profile("c", "facebook.com", "Alice@gmail.com"), profile("d", "x.com"), profile("e", "facebook.com", "alice@gmail.com"),
  ], exits);
  expect(result.exits.map((exit) => [exit.ip, exit.risk, exit.platforms])).toEqual([["1.1.1.1", "high", ["tiktok.com"]], ["2.2.2.2", "medium", []]]);
  expect(result.accounts).toEqual([{ account: "al***@gm***.com", platform: "facebook.com", profiles: expect.any(Array) }]);
  expect(result.accounts[0]!.profiles.map((item) => item.id)).toEqual(["c", "e"]);
  expect(result.unchecked).toBe(1);
  expect(maskAccount("bo")).toBe("b*");
});

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, auditCsv, scrubAudit } from "./audit.ts";

test("summaries never keep passwords, tokens, proxy logins or browser endpoints", () => {
  expect(scrubAudit("password=hunter2 token: abc.def")).toBe("password=*** token: ***");
  expect(scrubAudit("socks5://user:pa55@1.2.3.4:1080")).toBe("socks5://***@1.2.3.4:1080");
  expect(scrubAudit("ws://127.0.0.1:9222/devtools/browser/x")).toBe("CDP endpoint");
});

test("entries are kept by month, read newest first, filtered, and old months are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-audit-"));
  try {
    writeFileSync(join(dir, "2020-01.jsonl"), "{}\n");
    let now = Date.UTC(2026, 10, 14, 8);
    const log = new AuditLog(dir, () => now);
    log.record({ actor: { kind: "ai", name: "claude-code" }, action: "browser.open", profileId: "p1", profileName: "Shop 1", ok: true });
    now += 1000;
    log.record({ actor: { kind: "script", name: "Check in" }, action: "script.run", profileId: "p2", ok: false, error: "Timeout password=x" });
    expect(readdirSync(dir)).toEqual(["2026-11.jsonl"]);
    const all = log.query();
    expect(all.map((entry) => entry.action)).toEqual(["script.run", "browser.open"]);
    expect(all[0]!.error).toBe("Timeout password=***");
    expect(log.query({ actorKind: "ai" }).length).toBe(1);
    expect(log.query({ text: "shop" }).length).toBe(1);
    expect(log.actors()).toEqual([{ kind: "script", name: "Check in" }, { kind: "ai", name: "claude-code" }]);
    expect(auditCsv([{ at: 0, actor: { kind: "ai", name: "=cmd" }, action: "x", ok: true }])).toContain("'=cmd");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

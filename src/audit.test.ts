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

test("audit rotation keeps recent step receipts and surfaces write failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-audit-rotation-"));
  const now = () => Date.UTC(2026, 10, 18);
  const entry = { actor: { kind: "task" as const, name: "test-agent" }, action: "browserTask.run", ok: true,
    task: { runId: "b".repeat(32), stepId: "save", sequence: 1 } };
  const notices: string[] = [];
  try {
    const log = new AuditLog(dir, now, 300);
    for (let sequence = 1; sequence <= 5; sequence++) log.record({ ...entry, task: { ...entry.task, sequence } });
    expect(readdirSync(dir)).toHaveLength(2);
    const restored = new AuditLog(dir, now, 300);
    expect(restored.query().map(row => row.task?.sequence)).toEqual([5, 4]);
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "fixture");
    const unwritable = new AuditLog(blocked, now, 300, line => notices.push(line));
    unwritable.record(entry);
    expect(unwritable.status()).toEqual({ dropped: 1, lastFailureAt: now(), issue: "write_failed" });
    expect(notices).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

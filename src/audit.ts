import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A record of what AIs and scripts did: which agent or script, to which profile, and whether it
 * worked. Arguments are never written whole: they can hold passwords, cookies or typed text. What is
 * kept is the action, its target and a short, scrubbed summary.
 */
export type AuditActorKind = "ai" | "script" | "task" | "user";
export interface AuditActor { kind: AuditActorKind; name: string }
export interface AuditEntry {
  at: number;
  actor: AuditActor;
  action: string;
  profileId?: string;
  profileName?: string;
  detail?: string;
  task?: { runId: string; stepId: string; sequence: number };
  ok: boolean;
  error?: string;
}
export interface AuditQuery { since?: number; until?: number; actorKind?: AuditActorKind; actor?: string; profileId?: string; text?: string; limit?: number }

const MONTH_FILE = /^\d{4}-\d{2}(?:\.([1-9]\d*))?\.jsonl$/;
const KEEP_MONTHS = 6;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MONTH_FILES = 2;

export interface AuditStatus {
  dropped: number;
  lastFailureAt?: number;
  issue?: "write_failed" | "retention_failed";
}

/** Removes anything that looks like a secret or an address with credentials from a short summary. */
export function scrubAudit(text: string, max = 240): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1***@")
    .replace(/\b(password|passwd|pass|pwd|token|secret|cookie|authorization|api[_-]?key|otp|2fa|twofa)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2***")
    .replace(/wss?:\/\/\S+/gi, "CDP endpoint")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export class AuditLog {
  private health: AuditStatus = { dropped: 0 };
  private current?: { month: string; segment: number };

  constructor(private readonly dir: string, private readonly now: () => number = Date.now,
    private readonly maxFileBytes = MAX_FILE_BYTES, private readonly report?: (text: string) => void) {}

  status(): AuditStatus { return { ...this.health }; }

  private monthFor(at: number): string {
    const date = new Date(at);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  private markFailure(issue: NonNullable<AuditStatus["issue"]>, dropped = false) {
    if (this.health.issue !== issue) this.report?.(issue === "write_failed" ? "An audit entry could not be written" : "The activity record could not rotate files");
    this.health = { dropped: this.health.dropped + Number(dropped), issue, lastFailureAt: this.now() };
  }

  private fileFor(month: string, bytes: number): string {
    if (this.current?.month !== month) {
      const last = this.files().filter(name => name.slice(0, 7) === month).at(-1);
      this.current = { month, segment: Number(last && MONTH_FILE.exec(last)?.[1] || 0) };
    }
    const path = (segment: number) => join(this.dir, month + (segment ? `.${segment}` : "") + ".jsonl");
    const current = path(this.current.segment);
    if ((statSync(current, { throwIfNoEntry: false })?.size ?? 0) + bytes <= this.maxFileBytes) return current;
    return path(++this.current.segment);
  }

  record(entry: Omit<AuditEntry, "at"> & { at?: number }): void {
    try {
      const at = entry.at ?? this.now();
      const clean: AuditEntry = {
        at,
        actor: { kind: entry.actor.kind, name: scrubAudit(entry.actor.name || "unknown", 64) || "unknown" },
        action: scrubAudit(entry.action, 80),
        ...(entry.profileId ? { profileId: entry.profileId.slice(0, 64) } : {}),
        ...(entry.profileName ? { profileName: scrubAudit(entry.profileName, 80) } : {}),
        ...(entry.detail ? { detail: scrubAudit(entry.detail) } : {}),
        ...(entry.task && /^[0-9a-f]{32}$/.test(entry.task.runId) && Number.isSafeInteger(entry.task.sequence) && entry.task.sequence > 0
          ? { task: { ...entry.task, stepId: scrubAudit(entry.task.stepId, 120) } } : {}),
        ok: entry.ok,
        ...(entry.error ? { error: scrubAudit(entry.error, 300) } : {}),
      };
      mkdirSync(this.dir, { recursive: true });
      const line = JSON.stringify(clean) + "\n";
      if (Buffer.byteLength(line) > this.maxFileBytes) { this.markFailure("write_failed", true); return; }
      appendFileSync(this.fileFor(this.monthFor(at), Buffer.byteLength(line)), line, { encoding: "utf8", mode: 0o600 });
    } catch { this.markFailure("write_failed", true); return; }
    try { this.prune(entry.at ?? this.now()); }
    catch { this.markFailure("retention_failed"); }
  }

  private pruned = "";
  /** Keeps the last six months. */
  private prune(at: number): void {
    const month = this.monthFor(at), key = `${month}:${this.current?.segment ?? 0}`;
    if (this.pruned === key) return;
    const cutoff = new Date(this.now());
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - KEEP_MONTHS);
    const keepFrom = this.monthFor(cutoff.valueOf());
    const kept: Record<string, number> = {};
    for (const name of this.files().reverse()) {
      const fileMonth = name.slice(0, 7);
      kept[fileMonth] = (kept[fileMonth] ?? 0) + 1;
      if (fileMonth < keepFrom || kept[fileMonth]! > MAX_MONTH_FILES) rmSync(join(this.dir, name), { force: true });
    }
    this.pruned = key;
  }

  private files(): string[] {
    try {
      return readdirSync(this.dir).filter(name => MONTH_FILE.test(name)).sort((a, b) =>
        a.slice(0, 7).localeCompare(b.slice(0, 7)) || Number(MONTH_FILE.exec(a)?.[1] ?? 0) - Number(MONTH_FILE.exec(b)?.[1] ?? 0));
    } catch { return []; }
  }

  /** Newest first. */
  query(query: AuditQuery = {}): AuditEntry[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 5000);
    const text = query.text?.trim().toLowerCase();
    const out: AuditEntry[] = [];
    for (const name of this.files().reverse()) {
      let lines: string[];
      try { lines = readFileSync(join(this.dir, name), "utf8").split("\n"); } catch { continue; }
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index]!;
        if (!line) continue;
        let entry: AuditEntry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (query.since && entry.at < query.since) continue;
        if (query.until && entry.at > query.until) continue;
        if (query.actorKind && entry.actor?.kind !== query.actorKind) continue;
        if (query.actor && entry.actor?.name !== query.actor) continue;
        if (query.profileId && entry.profileId !== query.profileId) continue;
        if (text && ![entry.action, entry.actor?.name, entry.profileName, entry.detail, entry.error].some((value) => value?.toLowerCase().includes(text))) continue;
        out.push(entry);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** The agents and scripts that appear in the record, most recent first. */
  actors(): AuditActor[] {
    const seen = new Map<string, AuditActor>();
    for (const entry of this.query({ limit: 5000 })) {
      const key = `${entry.actor.kind}:${entry.actor.name}`;
      if (!seen.has(key)) seen.set(key, entry.actor);
    }
    return [...seen.values()];
  }
}

/** Spreadsheet-safe CSV of entries (a cell starting with = + - @ is quoted as text). */
export function auditCsv(entries: AuditEntry[]): string {
  const cell = (value: unknown) => {
    let text = value === undefined || value === null ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [["time", "actor_kind", "actor", "action", "profile_id", "profile", "detail", "ok", "error", "run_id", "step_id", "evidence"]];
  for (const entry of entries) rows.push([new Date(entry.at).toISOString(), entry.actor.kind, entry.actor.name, entry.action, entry.profileId ?? "", entry.profileName ?? "", entry.detail ?? "", entry.ok ? "yes" : "no", entry.error ?? "",
    entry.task?.runId ?? "", entry.task?.stepId ?? "", String(entry.task?.sequence ?? "")]);
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

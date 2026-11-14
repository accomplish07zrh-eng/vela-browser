import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  ok: boolean;
  error?: string;
}
export interface AuditQuery { since?: number; until?: number; actorKind?: AuditActorKind; actor?: string; profileId?: string; text?: string; limit?: number }

const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const KEEP_MONTHS = 6;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

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
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private fileFor(at: number): string {
    const date = new Date(at);
    return join(this.dir, `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
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
        ok: entry.ok,
        ...(entry.error ? { error: scrubAudit(entry.error, 300) } : {}),
      };
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(at);
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) return;
      appendFileSync(file, JSON.stringify(clean) + "\n", { encoding: "utf8", mode: 0o600 });
      this.prune(at);
    } catch { /* the record is best effort: never break the action it describes */ }
  }

  private pruned = "";
  /** Keeps the last six months. */
  private prune(at: number): void {
    const month = this.fileFor(at);
    if (this.pruned === month) return;
    this.pruned = month;
    const cutoff = new Date(at); cutoff.setUTCMonth(cutoff.getUTCMonth() - KEEP_MONTHS);
    const keepFrom = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
    for (const name of this.files()) if (name.slice(0, 7) < keepFrom) rmSync(join(this.dir, name), { force: true });
  }

  private files(): string[] {
    try { return readdirSync(this.dir).filter((name) => MONTH_FILE.test(name)).sort(); } catch { return []; }
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
  const rows = [["time", "actor_kind", "actor", "action", "profile_id", "profile", "detail", "ok", "error"]];
  for (const entry of entries) rows.push([new Date(entry.at).toISOString(), entry.actor.kind, entry.actor.name, entry.action, entry.profileId ?? "", entry.profileName ?? "", entry.detail ?? "", entry.ok ? "yes" : "no", entry.error ?? ""]);
  return rows.map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

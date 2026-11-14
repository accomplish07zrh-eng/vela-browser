/**
 * The proxy pool: proxies imported once and given to profiles later (docs/plans/2026-11-13-proxy-pool-design.md §4).
 *
 * A node is a proxy plus what the pool knows about it: a name, tags, how many profiles may share
 * it, and its last health check. Which profiles use a node is never stored. It is read from the
 * profiles themselves: a profile whose proxy is exactly the node's proxy (same protocol, host,
 * port and credentials) uses it. So an edit made anywhere (the profile form, the bulk tool, the
 * pool) can never leave the pool's picture out of date.
 *
 * Phase 1 holds HTTP, HTTPS and SOCKS5 proxies only. Subscription nodes (phase 2) add a kernel
 * outbound beside the same fields.
 */

import type { Database } from "bun:sqlite";
import { canonicalIp } from "./ip.ts";
import { parseProxySpec, normalizeProxySpec, proxyHostPort, proxyIdentityKey } from "./proxy.ts";
import { SecretBox, SecretUnavailableError } from "./secret-box.ts";
import type { ProxyCheckResult } from "./proxy-check.ts";
import { isNonPublicHostName, type NodeProtocol, type Outbound, type ParsedNode, type SubscriptionUsage } from "./subscription.ts";
import type { ProxySpec, ProxyType } from "./types.ts";

/** Keep at most this many switch-history entries per profile so the log never grows unbounded. */
export const PROXY_SWITCH_HISTORY_LIMIT = 100;
/** Allowed auto-refresh bounds (in hours) for subscriptions when scheduled updates are enabled. */
export const MIN_SUBSCRIPTION_REFRESH_HOURS = 1;
export const MAX_SUBSCRIPTION_REFRESH_HOURS = 720;
const SUBSCRIPTION_FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
const SUBSCRIPTION_FAILURE_BACKOFF_MAX_EXPONENT = 6;

/** "manual": added by hand (static residential, dedicated IP). "provider": from a subscription. */
export type PoolNodeKind = "manual" | "provider";

export interface PoolCheck {
  status: ProxyCheckResult["status"];
  reason?: string;
  ip?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  rotating?: boolean;
  /** Wall time of the whole check (three attempts in parallel), in milliseconds. */
  durationMs?: number;
  checkedAt: number;
}

export interface PoolNode {
  id: string;
  name: string;
  kind: PoolNodeKind;
  /**
   * What a profile using this node stores as its proxy. For HTTP, HTTPS and SOCKS5 the proxy
   * itself; for kernel protocols {type: "pool", host: <node id>}, which only the kernel can reach.
   */
  proxy: ProxySpec;
  protocol: NodeProtocol;
  /** The kernel outbound (kernel protocols only). Holds the node's credentials. */
  outbound?: Outbound;
  /** The subscription it came from, if any. */
  subscriptionId?: string;
  /** The provider asked to skip certificate checks to this node. */
  insecureTls?: boolean;
  /** Its subscription no longer lists it. Profiles using it keep it until someone chooses another. */
  removedFromSource?: boolean;
  tags: string[];
  /** How many profiles may use this node at once. null: no limit. */
  maxProfiles: number | null;
  disabled: boolean;
  /** Country read from the node's name (ISO 3166-1 alpha-2). A hint; the check's country is the fact. */
  regionHint?: string;
  check?: PoolCheck;
  createdAt: number;
}

/** What leaves the server about a node: never its credentials. */
export interface PoolNodeView {
  id: string;
  name: string;
  kind: PoolNodeKind;
  protocol: NodeProtocol;
  /** protocol://server:port, never credentials. */
  proxy: string;
  subscriptionId?: string;
  insecureTls?: boolean;
  removedFromSource?: boolean;
  hasAuth: boolean;
  tags: string[];
  maxProfiles: number | null;
  disabled: boolean;
  regionHint?: string;
  check?: PoolCheck;
  /** Profiles using this node now. */
  profiles: Array<{ id: string; name: string; group: string }>;
  /** Other nodes whose last check showed the same exit IP. */
  sameExitAs: string[];
  createdAt: number;
}

export interface PoolProfileRef {
  id: string;
  name: string;
  group: string;
  proxy: ProxySpec | null;
}

export class ProxyPoolError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Default sharing limit by where a node came from (§4.4). A provider's node is shared by many
 * people anyway; a node added by hand is usually one person's IP, where two accounts on it are
 * easily linked.
 */
export function defaultMaxProfiles(kind: PoolNodeKind): number | null {
  return kind === "manual" ? 1 : null;
}

const FLAG = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u;
/**
 * Common ways node names say where they are, checked in order. Place names match in any case;
 * two-letter codes only in capitals, so English words ("in", "ca", "id") are not read as codes.
 */
const REGION_WORDS: Array<[RegExp, string]> = [
  [/香港|hong\s*kong/i, "HK"],
  [/台湾|台灣|taiwan/i, "TW"],
  [/日本|东京|東京|大阪|japan|tokyo|osaka/i, "JP"],
  [/新加坡|狮城|singapore/i, "SG"],
  [/韩国|韓國|首尔|korea|seoul/i, "KR"],
  [/美国|美國|美西|美东|洛杉矶|圣何塞|纽约|西雅图|united\s*states|los\s*angeles|san\s*jose|new\s*york|seattle/i, "US"],
  [/英国|英國|伦敦|united\s*kingdom|london/i, "GB"],
  [/德国|德國|法兰克福|germany|frankfurt/i, "DE"],
  [/法国|法國|巴黎|france|paris/i, "FR"],
  [/荷兰|荷蘭|阿姆斯特丹|netherlands|amsterdam/i, "NL"],
  [/加拿大|canada/i, "CA"],
  [/澳大利亚|澳洲|悉尼|australia|sydney/i, "AU"],
  [/俄罗斯|俄羅斯|russia/i, "RU"],
  [/印度尼西亚|印尼|indonesia/i, "ID"],
  [/印度|india/i, "IN"],
  [/土耳其|turkey|türkiye/i, "TR"],
  [/马来西亚|malaysia/i, "MY"],
  [/泰国|thailand/i, "TH"],
  [/越南|vietnam/i, "VN"],
  [/菲律宾|philippines/i, "PH"],
  [/阿根廷|argentina/i, "AR"],
  [/巴西|brazil/i, "BR"],
];
const REGION_CODES = new Map<string, string>([
  ["HK", "HK"], ["TW", "TW"], ["JP", "JP"], ["SG", "SG"], ["KR", "KR"], ["US", "US"], ["USA", "US"],
  ["UK", "GB"], ["GB", "GB"], ["DE", "DE"], ["FR", "FR"], ["NL", "NL"], ["CA", "CA"], ["AU", "AU"],
  ["RU", "RU"], ["IN", "IN"], ["TR", "TR"], ["MY", "MY"], ["TH", "TH"], ["VN", "VN"], ["PH", "PH"],
  ["ID", "ID"], ["AR", "AR"], ["BR", "BR"],
]);

/** Country a node's name claims, from a flag emoji or a place name. */
export function regionHintFromName(name: string): string | undefined {
  const flag = FLAG.exec(name);
  if (flag) {
    const code = [flag[1]!, flag[2]!].map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1F1E6 + 65)).join("");
    return code === "UK" ? "GB" : code;
  }
  for (const [pattern, code] of REGION_WORDS) if (pattern.test(name)) return code;
  // Capital codes standing on their own: "HK-02", "US 01", "JP|IPLC".
  for (const token of name.split(/[^A-Za-z]+/)) {
    const code = REGION_CODES.get(token);
    if (code) return code;
  }
  return undefined;
}

function cleanTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new ProxyPoolError("tags must be a list of text");
  return [...new Set((tags as string[]).map((tag) => tag.trim()).filter(Boolean))].slice(0, 32);
}

function cleanLimit(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100_000) {
    throw new ProxyPoolError("the sharing limit must be a whole number from 1, or no limit");
  }
  return value as number;
}

export interface ImportResult {
  added: PoolNode[];
  /** Lines whose proxy the pool already holds, or that repeat an earlier line. */
  duplicates: number;
  invalid: Array<{ line: number; error: string }>;
}

export class ProxyPool {
  /**
   * `box` seals subscription links, node addresses and credentials, and keys the identity digests
   * (see secret-box.ts). The store passes the data directory's own box; the in-memory default is
   * only for tests.
   */
  constructor(private readonly db: Database, private readonly now: () => number = Date.now, private readonly box: SecretBox = SecretBox.ephemeral()) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_pool_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'manual',
        proxy_json TEXT NOT NULL,
        identity_key TEXT NOT NULL UNIQUE,
        tags_json TEXT NOT NULL DEFAULT '[]',
        max_profiles INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        region_hint TEXT NOT NULL DEFAULT '',
        check_json TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proxy_switch_history (
        profile_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        by_whom TEXT NOT NULL,
        from_label TEXT NOT NULL,
        to_label TEXT NOT NULL,
        outcome TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        exit_country TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS proxy_switch_history_profile ON proxy_switch_history (profile_id, at);
      CREATE TABLE IF NOT EXISTS proxy_subscriptions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        user_agent TEXT NOT NULL DEFAULT '',
        refresh_hours INTEGER,
        last_fetched_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        usage_json TEXT NOT NULL DEFAULT '',
        last_import_json TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    for (const column of [
      "protocol TEXT NOT NULL DEFAULT ''",
      "outbound_json TEXT NOT NULL DEFAULT ''",
      "subscription_id TEXT NOT NULL DEFAULT ''",
      "insecure_tls INTEGER NOT NULL DEFAULT 0",
      "removed_from_source INTEGER NOT NULL DEFAULT 0",
    ]) {
      try { db.exec(`ALTER TABLE proxy_pool_nodes ADD COLUMN ${column}`); } catch { /* already there */ }
    }
    for (const column of [
      "refresh_hours INTEGER",
      "retry_after INTEGER",
      "failure_count INTEGER NOT NULL DEFAULT 0",
    ]) {
      try { db.exec(`ALTER TABLE proxy_subscriptions ADD COLUMN ${column}`); } catch { /* already there */ }
    }
    this.sealOlderRows();
    this.pruneSwitchHistory();
  }

  private txDepth = 0;

  /** Explicit transaction wrapper (avoids bun:sqlite db.transaction() statement retention on Windows). */
  private transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args) => {
      const nested = this.db.inTransaction;
      const savepoint = `pool_tx_${++this.txDepth}`;
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN");
      try {
        const result = fn(...args);
        this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        if (this.db.inTransaction) this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        throw error;
      }
    };
  }

  /** Trim any legacy profiles that exceeded the per-profile switch-history limit before capping was enforced. */
  private pruneSwitchHistory(): void {
    const overLimit = this.db.query<{ profile_id: string }, [number]>(
      `SELECT profile_id FROM proxy_switch_history GROUP BY profile_id HAVING COUNT(*) > ?`,
    ).all(PROXY_SWITCH_HISTORY_LIMIT);
    if (!overLimit.length) return;
    this.transaction(() => {
      const prune = this.db.query(`
        DELETE FROM proxy_switch_history
        WHERE profile_id = ?
          AND rowid NOT IN (
            SELECT rowid FROM proxy_switch_history
            WHERE profile_id = ?
            ORDER BY at DESC, rowid DESC
            LIMIT ?
          )
      `);
      for (const row of overLimit) prune.run(row.profile_id, row.profile_id, PROXY_SWITCH_HISTORY_LIMIT);
    })();
  }

  /** Rows written before encryption: seal them in place, once. */
  private sealOlderRows(): void {
    if (!this.box.available) return;
    this.transaction(() => {
      for (const row of this.db.query<{ id: string; proxy_json: string; outbound_json: string; identity_key: string }, []>(
        `SELECT id, proxy_json, outbound_json, identity_key FROM proxy_pool_nodes`).all()) {
        const proxy = SecretBox.isSealed(row.proxy_json) ? row.proxy_json : this.box.seal(row.proxy_json);
        const outbound = !row.outbound_json || SecretBox.isSealed(row.outbound_json) ? row.outbound_json : this.box.seal(row.outbound_json);
        const key = SecretBox.isDigest(row.identity_key) ? row.identity_key : this.box.digest(row.identity_key);
        if (proxy !== row.proxy_json || outbound !== row.outbound_json || key !== row.identity_key) {
          this.db.query(`UPDATE proxy_pool_nodes SET proxy_json = ?, outbound_json = ?, identity_key = ? WHERE id = ?`).run(proxy, outbound, key, row.id);
        }
      }
      for (const row of this.db.query<{ id: string; url: string }, []>(`SELECT id, url FROM proxy_subscriptions`).all()) {
        if (!SecretBox.isSealed(row.url)) this.db.query(`UPDATE proxy_subscriptions SET url = ? WHERE id = ?`).run(this.box.seal(row.url), row.id);
      }
    })();
  }

  /** The stored stand-in for a node's identity (protocol, address, credentials). */
  private identity(key: string): string {
    return this.box.digest(key);
  }

  /** A node as stored, or null when its secrets cannot be read on this computer. */
  private readNode(row: any): PoolNode | null {
    try {
      return rowToNode({ ...row, proxy_json: this.box.open(row.proxy_json), outbound_json: row.outbound_json ? this.box.open(row.outbound_json) : "" });
    } catch (error) {
      if (error instanceof SecretUnavailableError) return null;
      throw error;
    }
  }

  private readSubscription(row: any): PoolSubscription {
    try {
      return rowToSubscription({ ...row, url: this.box.open(row.url) });
    } catch (error) {
      if (!(error instanceof SecretUnavailableError)) throw error;
      return { ...rowToSubscription({ ...row, url: "" }), unreadable: true };
    }
  }

  /** Remember a proxy change, retaining only the newest entries per profile. */
  recordSwitch(entry: import("./proxy-switch.ts").SwitchHistoryEntry): void {
    this.transaction(() => {
      this.db.query(`INSERT INTO proxy_switch_history (profile_id, at, by_whom, from_label, to_label, outcome, code, exit_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(entry.profileId, entry.at, entry.by.slice(0, 120), entry.from.slice(0, 300), entry.to.slice(0, 300), entry.outcome, entry.code ?? "", entry.exitCountry ?? "");
      this.db.query(`
        DELETE FROM proxy_switch_history
        WHERE profile_id = ?
          AND rowid NOT IN (
            SELECT rowid FROM proxy_switch_history
            WHERE profile_id = ?
            ORDER BY at DESC, rowid DESC
            LIMIT ?
          )
      `).run(entry.profileId, entry.profileId, PROXY_SWITCH_HISTORY_LIMIT);
    })();
  }

  /** A profile's proxy changes, newest first. */
  switchHistory(profileId: string, limit = 20): import("./proxy-switch.ts").SwitchHistoryEntry[] {
    return this.db.query<any, [string, number]>(`SELECT * FROM proxy_switch_history WHERE profile_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(profileId, limit)
      .map((row) => ({
        profileId: row.profile_id, at: Number(row.at), by: row.by_whom, from: row.from_label, to: row.to_label, outcome: row.outcome,
        ...(row.code ? { code: row.code } : {}), ...(row.exit_country ? { exitCountry: row.exit_country } : {}),
      }));
  }

  listSubscriptions(): PoolSubscription[] {
    return this.db.query<any, []>(`SELECT * FROM proxy_subscriptions ORDER BY created_at`).all().map((row) => this.readSubscription(row));
  }

  listDueSubscriptions(now = this.now()): PoolSubscription[] {
    return this.listSubscriptions().filter((sub) => {
      if (sub.unreadable || sub.refreshHours === null) return false;
      const intervalMs = sub.refreshHours * 3_600_000;
      if (sub.lastFetchedAt !== undefined && now < sub.lastFetchedAt) return true;
      if (sub.retryAfter !== undefined) {
        const maxBackoff = Math.min(intervalMs, SUBSCRIPTION_FAILURE_BACKOFF_BASE_MS * (2 ** SUBSCRIPTION_FAILURE_BACKOFF_MAX_EXPONENT));
        if (sub.retryAfter - now > maxBackoff + 60_000) return true;
        return now >= sub.retryAfter;
      }
      return sub.lastFetchedAt === undefined || now - sub.lastFetchedAt >= intervalMs;
    });
  }

  getSubscription(id: string): PoolSubscription | null {
    const row = this.db.query<any, [string]>(`SELECT * FROM proxy_subscriptions WHERE id = ?`).get(id);
    return row ? this.readSubscription(row) : null;
  }

  addSubscription(input: { url: string; name?: string; userAgent?: string; refreshHours?: unknown; allowPrivate?: boolean }): PoolSubscription {
    let url: URL;
    try { url = new URL(input.url.trim()); } catch { throw new ProxyPoolError("The subscription link is not a valid URL"); }
    if (url.protocol !== "https:") throw new ProxyPoolError("The subscription link must use https");
    if (!input.allowPrivate && isNonPublicHostName(url.hostname)) {
      throw new ProxyPoolError("The subscription link must use a public host");
    }
    if (this.listSubscriptions().some((sub) => sub.url === url.href)) throw new ProxyPoolError("This subscription is already added");
    const refreshHours = input.refreshHours === undefined ? null : parseRefreshHours(input.refreshHours);
    const sub: PoolSubscription = {
      id: crypto.randomUUID(), name: (input.name?.trim() || url.hostname).slice(0, 200), url: url.href,
      ...(input.userAgent?.trim() ? { userAgent: input.userAgent.trim().slice(0, 200) } : {}),
      refreshHours,
      createdAt: this.now(),
    };
    this.db.query(`INSERT INTO proxy_subscriptions (id, name, url, user_agent, refresh_hours, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sub.id, sub.name, this.box.seal(sub.url), sub.userAgent ?? "", sub.refreshHours, sub.createdAt);
    return sub;
  }

  renameSubscription(id: string, name: string): void {
    if (!name.trim()) throw new ProxyPoolError("The name cannot be empty");
    this.db.query(`UPDATE proxy_subscriptions SET name = ? WHERE id = ?`).run(name.trim().slice(0, 200), id);
  }

  updateSubscription(id: string, patch: { name?: unknown; refreshHours?: unknown }): PoolSubscription {
    const existing = this.getSubscription(id);
    if (!existing) throw new ProxyPoolError("This subscription is no longer here", 404);
    let nextName = existing.name;
    let nextRefreshHours = existing.refreshHours;
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) throw new ProxyPoolError("The name cannot be empty");
      nextName = patch.name.trim().slice(0, 200);
    }
    if (patch.refreshHours !== undefined) {
      nextRefreshHours = parseRefreshHours(patch.refreshHours);
    }
    this.db.query(`
      UPDATE proxy_subscriptions
      SET name = ?, refresh_hours = ?,
          retry_after = CASE WHEN ? THEN NULL ELSE retry_after END,
          failure_count = CASE WHEN ? THEN 0 ELSE failure_count END
      WHERE id = ?
    `).run(nextName, nextRefreshHours, patch.refreshHours !== undefined ? 1 : 0, patch.refreshHours !== undefined ? 1 : 0, id);
    return this.getSubscription(id)!;
  }

  recordSubscriptionFailure(id: string, error: string): void {
    const existing = this.db.query<{ refresh_hours: number | null; failure_count: number | null }, [string]>(
      `SELECT refresh_hours, failure_count FROM proxy_subscriptions WHERE id = ?`,
    ).get(id);
    if (!existing) return;
    const failures = Math.max(0, Number(existing.failure_count ?? 0)) + 1;
    const exp = Math.min(failures - 1, SUBSCRIPTION_FAILURE_BACKOFF_MAX_EXPONENT);
    const maxInterval = existing.refresh_hours ? Number(existing.refresh_hours) * 3_600_000 : 24 * 3_600_000;
    const retryAfter = this.now() + Math.min(maxInterval, SUBSCRIPTION_FAILURE_BACKOFF_BASE_MS * (2 ** exp));
    this.db.query(`UPDATE proxy_subscriptions SET last_error = ?, retry_after = ?, failure_count = ? WHERE id = ?`)
      .run(error.slice(0, 300), retryAfter, failures, id);
  }

  /**
   * Bring a subscription's nodes in line with what it lists now. A node it lists again keeps its
   * id (profiles stay on it); a new one is added; one it no longer lists is marked, never removed
   * while a profile may use it, so no profile moves to another exit without someone choosing it.
   */
  syncSubscription(id: string, nodes: ParsedNode[], report: { nonNodes: number; infoEntries: string[]; unsupported: Array<{ name: string; reason: string }>; usage?: SubscriptionUsage }): SubscriptionSyncResult {
    const sub = this.getSubscription(id);
    if (!sub) throw new ProxyPoolError("This subscription is no longer here", 404);
    const result: SubscriptionSyncResult = { added: 0, kept: 0, removed: 0 };
    const listed = new Set<string>();
    this.transaction(() => {
      for (const parsed of nodes) {
        const plain = parsed.protocol === "http" || parsed.protocol === "https" || parsed.protocol === "socks5";
        const plainProxy = plain ? normalizeProxySpec({
          type: parsed.protocol, host: parsed.server, port: String(parsed.port),
          user: String(parsed.outbound.username ?? ""), pass: String(parsed.outbound.password ?? ""),
        })! : null;
        const key = this.identity(plainProxy ? proxyIdentityKey(plainProxy) : `kernel:${parsed.key}`);
        listed.add(key);
        const existing = this.db.query<{ id: string }, [string]>(`SELECT id FROM proxy_pool_nodes WHERE identity_key = ?`).get(key);
        if (existing) {
          this.db.query(`UPDATE proxy_pool_nodes SET subscription_id = ?, removed_from_source = 0 WHERE id = ?`).run(id, existing.id);
          result.kept++;
          continue;
        }
        const nodeId = crypto.randomUUID();
        const proxy: ProxySpec = plainProxy ?? { type: "pool", host: nodeId, port: "0", user: "", pass: "" };
        this.db.query(`
          INSERT INTO proxy_pool_nodes (id, name, kind, proxy_json, identity_key, tags_json, max_profiles, disabled, region_hint, check_json, created_at,
            protocol, outbound_json, subscription_id, insecure_tls, removed_from_source)
          VALUES ($id, $name, 'provider', $proxy, $key, '[]', NULL, 0, $hint, '', $at, $protocol, $outbound, $sub, $insecure, 0)
        `).run({
          $id: nodeId, $name: (parsed.name || `${parsed.server}:${parsed.port}`).slice(0, 200), $proxy: this.box.seal(JSON.stringify(proxy)), $key: key,
          $hint: parsed.regionHint ?? "", $at: this.now() + result.added / 1000, $protocol: parsed.protocol,
          $outbound: plainProxy ? "" : this.box.seal(JSON.stringify(parsed.outbound)), $sub: id, $insecure: parsed.insecureTls ? 1 : 0,
        });
        result.added++;
      }
      for (const row of this.db.query<{ id: string; identity_key: string; removed_from_source: number }, [string]>(
        `SELECT id, identity_key, removed_from_source FROM proxy_pool_nodes WHERE subscription_id = ?`).all(id)) {
        if (listed.has(row.identity_key) || row.removed_from_source) continue;
        this.db.query(`UPDATE proxy_pool_nodes SET removed_from_source = 1 WHERE id = ?`).run(row.id);
        result.removed++;
      }
      this.db.query(`UPDATE proxy_subscriptions SET last_fetched_at = ?, last_error = '', retry_after = NULL, failure_count = 0, usage_json = ?, last_import_json = ? WHERE id = ?`).run(
        this.now(), report.usage ? JSON.stringify(report.usage) : "",
        JSON.stringify({ nodes: nodes.length, nonNodes: report.nonNodes, infoEntries: report.infoEntries.length, unsupported: report.unsupported.slice(0, 200), ...result }),
        id,
      );
    })();
    return result;
  }

  /**
   * Remove a subscription. Its nodes no profile uses go too; the ones a profile uses stay in the
   * pool (marked as no longer listed), so those profiles keep working until someone changes them.
   */
  removeSubscription(id: string, inUse: (node: PoolNode) => boolean): { removedNodes: number; keptNodes: number } {
    let removedNodes = 0, keptNodes = 0;
    this.transaction(() => {
      for (const node of this.list().filter((n) => n.subscriptionId === id)) {
        if (inUse(node)) {
          this.db.query(`UPDATE proxy_pool_nodes SET subscription_id = '', removed_from_source = 1 WHERE id = ?`).run(node.id);
          keptNodes++;
        } else {
          this.db.query(`DELETE FROM proxy_pool_nodes WHERE id = ?`).run(node.id);
          removedNodes++;
        }
      }
      this.db.query(`DELETE FROM proxy_subscriptions WHERE id = ?`).run(id);
    })();
    return { removedNodes, keptNodes };
  }

  list(): PoolNode[] {
    return this.db.query<any, []>(`SELECT * FROM proxy_pool_nodes ORDER BY created_at, rowid`).all()
      .map((row) => this.readNode(row)).filter((node): node is PoolNode => node !== null);
  }

  get(id: string): PoolNode | null {
    const row = this.db.query<any, [string]>(`SELECT * FROM proxy_pool_nodes WHERE id = ?`).get(id);
    return row ? this.readNode(row) : null;
  }

  /**
   * Add proxies pasted one per line: a URL (http://, https://, socks5://) or host:port[:user:pass]
   * with `type`. A line may end with "#name". A proxy the pool already holds is not added twice.
   */
  importText(text: string, opts: { type?: ProxyType; tags?: unknown; kind?: PoolNodeKind } = {}): ImportResult {
    if (typeof text !== "string" || !text.trim()) throw new ProxyPoolError("Paste at least one proxy");
    if (text.length > 2_000_000) throw new ProxyPoolError("Too much text at once");
    const tags = cleanTags(opts.tags);
    const kind = opts.kind ?? "manual";
    const known = new Set(this.db.query<{ identity_key: string }, []>(`SELECT identity_key FROM proxy_pool_nodes`).all().map((row) => row.identity_key));
    const result: ImportResult = { added: [], duplicates: 0, invalid: [] };
    const insert = this.db.query(`
      INSERT INTO proxy_pool_nodes (id, name, kind, proxy_json, identity_key, tags_json, max_profiles, disabled, region_hint, check_json, created_at, protocol)
      VALUES ($id, $name, $kind, $proxy, $key, $tags, $max, 0, $hint, '', $at, $protocol)
    `);
    const lines = text.split(/\r?\n/);
    this.transaction(() => {
      lines.forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith("//")) return;
        const hash = line.indexOf("#");
        const value = (hash >= 0 ? line.slice(0, hash) : line).trim();
        let name = hash >= 0 ? line.slice(hash + 1).trim() : "";
        try { name = decodeURIComponent(name); } catch { /* keep as typed */ }
        let proxy: ProxySpec | null;
        try {
          proxy = parseProxySpec(opts.type ?? "http", value);
        } catch (error) {
          result.invalid.push({ line: index + 1, error: error instanceof Error ? error.message : "invalid proxy" });
          return;
        }
        if (!proxy) return;
        if (proxy.type === "pool") {
          result.invalid.push({ line: index + 1, error: "not a proxy" });
          return;
        }
        const key = this.identity(proxyIdentityKey(proxy));
        if (known.has(key)) { result.duplicates++; return; }
        known.add(key);
        const node: PoolNode = {
          id: crypto.randomUUID(),
          name: (name || proxyHostPort(proxy)).slice(0, 200),
          kind,
          proxy,
          protocol: proxy.type as NodeProtocol,
          tags,
          maxProfiles: defaultMaxProfiles(kind),
          disabled: false,
          ...(regionHintFromName(name) ? { regionHint: regionHintFromName(name) } : {}),
          createdAt: this.now() + result.added.length / 1000,
        };
        insert.run({
          $id: node.id, $name: node.name, $kind: node.kind, $proxy: this.box.seal(JSON.stringify(node.proxy)), $key: key,
          $tags: JSON.stringify(node.tags), $max: node.maxProfiles, $hint: node.regionHint ?? "", $at: node.createdAt, $protocol: node.protocol,
        });
        result.added.push(node);
      });
    })();
    return result;
  }

  /**
   * Change what the pool says about a node. Its proxy itself (protocol, host, port, credentials)
   * never changes: that would move every profile using it to another exit without anyone choosing
   * it. A different proxy is a new node.
   */
  update(id: string, patch: Record<string, unknown>): PoolNode {
    const node = this.get(id);
    if (!node) throw new ProxyPoolError("This proxy is no longer in the pool", 404);
    const allowed = new Set(["name", "tags", "maxProfiles", "disabled"]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) throw new ProxyPoolError("Only the name, tags, sharing limit and disabled state can change");
    }
    const next: PoolNode = { ...node };
    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || !patch.name.trim()) throw new ProxyPoolError("The name cannot be empty");
      next.name = patch.name.trim().slice(0, 200);
      const hint = regionHintFromName(next.name);
      if (hint) next.regionHint = hint; else delete next.regionHint;
    }
    if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
    if (patch.maxProfiles !== undefined) next.maxProfiles = cleanLimit(patch.maxProfiles);
    if (patch.disabled !== undefined) {
      if (typeof patch.disabled !== "boolean") throw new ProxyPoolError("disabled must be true or false");
      next.disabled = patch.disabled;
    }
    this.db.query(`
      UPDATE proxy_pool_nodes SET name = $name, tags_json = $tags, max_profiles = $max, disabled = $disabled, region_hint = $hint WHERE id = $id
    `).run({
      $id: id, $name: next.name, $tags: JSON.stringify(next.tags), $max: next.maxProfiles,
      $disabled: next.disabled ? 1 : 0, $hint: next.regionHint ?? "",
    });
    return next;
  }

  /** Remove nodes from the pool. Profiles keep the proxy they have; it is just no longer in the pool. */
  remove(ids: string[]): number {
    let removed = 0;
    const del = this.db.query(`DELETE FROM proxy_pool_nodes WHERE id = ?`);
    this.transaction(() => { for (const id of ids) removed += del.run(id).changes; })();
    return removed;
  }

  recordCheck(id: string, check: PoolCheck): void {
    const existing = this.db.query<{ check_json: string }, [string]>(`SELECT check_json FROM proxy_pool_nodes WHERE id = ?`).get(id);
    if (!existing) return;
    if (existing.check_json) {
      try {
        const parsed = JSON.parse(existing.check_json) as { checkedAt?: unknown };
        if (typeof parsed.checkedAt === "number" && Number.isFinite(parsed.checkedAt) && parsed.checkedAt > check.checkedAt) {
          return;
        }
      } catch { /* replace corrupted JSON */ }
    }
    this.db.query(`UPDATE proxy_pool_nodes SET check_json = ? WHERE id = ?`).run(JSON.stringify(check), id);
  }
}

function rowToNode(row: any): PoolNode {
  const proxy = normalizeProxySpec(JSON.parse(row.proxy_json))!;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "provider" ? "provider" : "manual",
    proxy,
    protocol: (row.protocol || proxy.type) as NodeProtocol,
    ...(row.outbound_json ? { outbound: JSON.parse(row.outbound_json) as Outbound } : {}),
    ...(row.subscription_id ? { subscriptionId: row.subscription_id } : {}),
    ...(row.insecure_tls ? { insecureTls: true } : {}),
    ...(row.removed_from_source ? { removedFromSource: true } : {}),
    tags: JSON.parse(row.tags_json || "[]"),
    maxProfiles: row.max_profiles === null || row.max_profiles === undefined ? null : Number(row.max_profiles),
    disabled: !!row.disabled,
    ...(row.region_hint ? { regionHint: row.region_hint } : {}),
    ...(row.check_json ? { check: JSON.parse(row.check_json) } : {}),
    createdAt: Number(row.created_at),
  };
}

/** Profiles using each node now, read from the profiles' own proxies. */
export function poolUsage(nodes: PoolNode[], profiles: PoolProfileRef[]): Map<string, PoolProfileRef[]> {
  const byKey = new Map<string, PoolProfileRef[]>();
  for (const profile of profiles) {
    if (!profile.proxy) continue;
    const key = proxyIdentityKey(profile.proxy);
    const list = byKey.get(key) ?? [];
    list.push(profile);
    byKey.set(key, list);
  }
  return new Map(nodes.map((node) => [node.id, byKey.get(proxyIdentityKey(node.proxy)) ?? []]));
}

function normalizedExitIp(node: PoolNode): string | null {
  const raw = node.check?.ip;
  if (!raw) return null;
  return canonicalIp(raw) ?? (raw.trim() || null);
}

/** Nodes grouped by the exit IP their last check saw. Different nodes can leave through one IP. */
export function sameExitGroups(nodes: PoolNode[]): Map<string, string[]> {
  const byIp = new Map<string, string[]>();
  for (const node of nodes) {
    const ip = normalizedExitIp(node);
    if (!ip) continue;
    byIp.set(ip, [...(byIp.get(ip) ?? []), node.id]);
  }
  return byIp;
}

export function poolNodeViews(nodes: PoolNode[], profiles: PoolProfileRef[]): PoolNodeView[] {
  const usage = poolUsage(nodes, profiles);
  const exits = sameExitGroups(nodes);
  return nodes.map((node) => {
    const exitIp = normalizedExitIp(node);
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      protocol: node.protocol,
      proxy: node.outbound
        ? `${node.protocol}://${node.outbound.server.includes(":") ? `[${node.outbound.server}]` : node.outbound.server}:${node.outbound.server_port}`
        : `${node.proxy.type}://${proxyHostPort(node.proxy)}`,
      hasAuth: node.outbound ? true : !!node.proxy.user,
      ...(node.subscriptionId ? { subscriptionId: node.subscriptionId } : {}),
      ...(node.insecureTls ? { insecureTls: true } : {}),
      ...(node.removedFromSource ? { removedFromSource: true } : {}),
      tags: node.tags,
      maxProfiles: node.maxProfiles,
      disabled: node.disabled,
      ...(node.regionHint ? { regionHint: node.regionHint } : {}),
      ...(node.check ? { check: node.check } : {}),
      profiles: (usage.get(node.id) ?? []).map(({ id, name, group }) => ({ id, name, group })),
      sameExitAs: exitIp ? (exits.get(exitIp) ?? []).filter((id) => id !== node.id) : [],
      createdAt: node.createdAt,
    };
  });
}

export interface PoolSelection {
  /** Use only these nodes. Without it, every node that passes the filters is a candidate. */
  nodeIds?: string[];
  /** Country of the node's exit (its last check), or its name's hint when never checked. */
  country?: string;
  tag?: string;
  /** Only nodes whose last check worked. Default true. */
  onlyWorking?: boolean;
  /** Avoid assigning profiles to an exit IP already occupied by another profile. Default false. */
  distinctExitIp?: boolean;
}

export function parsePoolSelection(value: unknown): PoolSelection {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { throw new ProxyPoolError("Invalid pool selection"); }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProxyPoolError("Invalid pool selection");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["nodeIds", "country", "tag", "onlyWorking", "distinctExitIp"].includes(key)) throw new ProxyPoolError("Invalid pool selection");
  }
  const selection: PoolSelection = {};
  if (input.nodeIds !== undefined) {
    if (!Array.isArray(input.nodeIds) || input.nodeIds.some((id) => typeof id !== "string")) throw new ProxyPoolError("Invalid pool selection");
    selection.nodeIds = [...new Set(input.nodeIds as string[])];
  }
  if (input.country !== undefined) {
    if (typeof input.country !== "string" || !/^[A-Za-z]{2}$/.test(input.country)) throw new ProxyPoolError("Country must be a two-letter code");
    selection.country = input.country.toUpperCase();
  }
  if (input.tag !== undefined) {
    if (typeof input.tag !== "string" || !input.tag.trim()) throw new ProxyPoolError("Invalid tag");
    selection.tag = input.tag.trim();
  }
  if (input.onlyWorking !== undefined) {
    if (typeof input.onlyWorking !== "boolean") throw new ProxyPoolError("Invalid pool selection");
    selection.onlyWorking = input.onlyWorking;
  }
  if (input.distinctExitIp !== undefined) {
    if (typeof input.distinctExitIp !== "boolean") throw new ProxyPoolError("Invalid pool selection");
    selection.distinctExitIp = input.distinctExitIp;
  }
  return selection;
}

export function nodeCountry(node: PoolNode): string | undefined {
  return node.check?.country?.toUpperCase() ?? node.regionHint;
}

export interface PoolAssignment {
  profileId: string;
  node?: PoolNode;
  /** "unchanged": the profile already uses a node that fits. "pool_exhausted": no node has room. */
  code?: "unchanged" | "pool_exhausted";
}

/**
 * Give each profile a node. A profile that already uses a fitting node keeps it: a node is never
 * swapped for another one without a reason, since that moves the account to another exit. Others
 * get the least-used fitting node with room left under its limit (ties: the faster check, then
 * the name). When `distinctExitIp` is set, new assignments avoid nodes whose checked exit IP is
 * already occupied by another profile (nodes without a known exit IP are treated as unknown and
 * bounded only by `maxProfiles`). Nothing here changes a profile; the caller applies the result.
 */
export function planPoolAssignment(
  profiles: PoolProfileRef[],
  nodes: PoolNode[],
  allProfiles: PoolProfileRef[],
  selection: PoolSelection,
): PoolAssignment[] {
  const onlyWorking = selection.onlyWorking ?? true;
  const distinctExitIp = selection.distinctExitIp ?? false;
  const ids = selection.nodeIds ? new Set(selection.nodeIds) : null;
  const candidates = nodes.filter((node) =>
    !node.disabled
    && !node.removedFromSource
    && (!ids || ids.has(node.id))
    && (!selection.country || nodeCountry(node) === selection.country)
    && (!selection.tag || node.tags.includes(selection.tag))
    && (!onlyWorking || node.check?.status === "working"),
  );
  const usage = poolUsage(candidates, allProfiles);
  const used = new Map(candidates.map((node) => [node.id, (usage.get(node.id) ?? []).length]));
  const byKey = new Map(candidates.map((node) => [proxyIdentityKey(node.proxy), node]));
  const usedExitIps = new Set<string>();
  if (distinctExitIp) {
    const selectedIds = new Set(profiles.map((profile) => profile.id));
    const nodeByKey = new Map(nodes.map((node) => [proxyIdentityKey(node.proxy), node]));
    for (const profile of allProfiles) {
      if (selectedIds.has(profile.id) || !profile.proxy) continue;
      const node = nodeByKey.get(proxyIdentityKey(profile.proxy));
      const ip = node ? normalizedExitIp(node) : null;
      if (ip) usedExitIps.add(ip);
    }
  }
  const room = (node: PoolNode) => node.maxProfiles === null ? Infinity : node.maxProfiles - used.get(node.id)!;
  const result: PoolAssignment[] = [];
  const rest: PoolProfileRef[] = [];
  for (const profile of profiles) {
    const current = profile.proxy ? byKey.get(proxyIdentityKey(profile.proxy)) : undefined;
    if (current) {
      const ip = normalizedExitIp(current);
      if (distinctExitIp && ip) usedExitIps.add(ip);
      result.push({ profileId: profile.id, node: current, code: "unchanged" });
    } else {
      rest.push(profile);
    }
  }
  for (const profile of rest) {
    const choice = candidates
      .filter((node) => {
        if (room(node) <= 0) return false;
        if (!distinctExitIp) return true;
        const ip = normalizedExitIp(node);
        return !ip || !usedExitIps.has(ip);
      })
      .sort((a, b) => used.get(a.id)! - used.get(b.id)!
        || (a.check?.durationMs ?? Infinity) - (b.check?.durationMs ?? Infinity)
        || a.name.localeCompare(b.name))[0];
    if (!choice) { result.push({ profileId: profile.id, code: "pool_exhausted" }); continue; }
    used.set(choice.id, used.get(choice.id)! + 1);
    const ip = normalizedExitIp(choice);
    if (distinctExitIp && ip) usedExitIps.add(ip);
    result.push({ profileId: profile.id, node: choice });
  }
  const order = new Map(profiles.map((profile, index) => [profile.id, index]));
  return result.sort((a, b) => order.get(a.profileId)! - order.get(b.profileId)!);
}

/** Check nodes (four at a time), recording each result as it lands. */
export async function checkPoolNodes(
  pool: ProxyPool,
  nodes: PoolNode[],
  deps: {
    check: (proxy: ProxySpec, opts: { direct: import("./egress.ts").EgressInfo | null }, node?: PoolNode) => Promise<ProxyCheckResult>;
    direct: () => Promise<import("./egress.ts").EgressInfo | null>;
    onResult?: (node: PoolNode, check: PoolCheck) => void;
    cancelled?: () => boolean;
    now?: () => number;
    concurrency?: number;
  },
): Promise<void> {
  const now = deps.now ?? Date.now;
  const direct = nodes.length ? await deps.direct().catch(() => null) : null;
  let index = 0;
  const worker = async () => {
    while (index < nodes.length && !deps.cancelled?.()) {
      const node = nodes[index++]!;
      const started = now();
      let check: PoolCheck;
      try {
        const result = await deps.check(node.proxy, { direct }, node);
        check = {
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.ip ? { ip: result.ip } : {}),
          ...(result.country ? { country: result.country } : {}),
          ...(result.region ? { region: result.region } : {}),
          ...(result.city ? { city: result.city } : {}),
          ...(result.timezone ? { timezone: result.timezone } : {}),
          ...(result.rotating !== undefined ? { rotating: result.rotating } : {}),
          durationMs: now() - started,
          checkedAt: now(),
        };
      } catch {
        check = { status: "unavailable", reason: "check_unavailable", checkedAt: now() };
      }
      if (deps.cancelled?.()) break;
      pool.recordCheck(node.id, check);
      deps.onResult?.(node, check);
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 4, nodes.length) }, worker));
}

export function parseRefreshHours(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) throw new ProxyPoolError("Auto-refresh interval must be between 1 and 720 hours, or off");
    parsed = Number(trimmed);
  } else {
    throw new ProxyPoolError("Auto-refresh interval must be between 1 and 720 hours, or off");
  }
  if (!Number.isInteger(parsed) || parsed < MIN_SUBSCRIPTION_REFRESH_HOURS || parsed > MAX_SUBSCRIPTION_REFRESH_HOURS) {
    throw new ProxyPoolError("Auto-refresh interval must be between 1 and 720 hours, or off");
  }
  return parsed;
}

export interface PoolSubscription {
  id: string;
  name: string;
  /** The link is a credential: it never leaves the server, and is stored sealed. */
  url: string;
  /** Sealed under a key this computer's account cannot read (the data came from elsewhere): add it again. */
  unreadable?: true;
  userAgent?: string;
  /** Automatic refresh cadence in hours, or null when only updated manually. */
  refreshHours: number | null;
  /** Internal exponential backoff deadline after failed automatic refreshes. */
  retryAfter?: number;
  lastFetchedAt?: number;
  lastError?: string;
  usage?: SubscriptionUsage;
  lastImport?: { nodes: number; nonNodes: number; infoEntries: number; unsupported: Array<{ name: string; reason: string }>; added: number; kept: number; removed: number };
  createdAt: number;
}

export interface SubscriptionSyncResult {
  added: number;
  kept: number;
  removed: number;
}

/** What leaves the server about a subscription: its host, never the link. */
export interface PoolSubscriptionView extends Omit<PoolSubscription, "url" | "retryAfter"> {
  host: string;
}

export const UNREADABLE_SUBSCRIPTION = "This subscription link cannot be read on this computer. Remove it and add it again";

export function subscriptionView(sub: PoolSubscription): PoolSubscriptionView {
  const { url, retryAfter: _retryAfter, ...rest } = sub;
  if (sub.unreadable) return { ...rest, host: "", lastError: UNREADABLE_SUBSCRIPTION };
  let host = "";
  try { host = new URL(url).hostname; } catch { /* shown without a host */ }
  return { ...rest, host };
}

function rowToSubscription(row: any): PoolSubscription {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    refreshHours: row.refresh_hours !== null && row.refresh_hours !== undefined ? Number(row.refresh_hours) : null,
    ...(row.retry_after ? { retryAfter: Number(row.retry_after) } : {}),
    ...(row.last_fetched_at ? { lastFetchedAt: Number(row.last_fetched_at) } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.usage_json ? { usage: JSON.parse(row.usage_json) } : {}),
    ...(row.last_import_json ? { lastImport: JSON.parse(row.last_import_json) } : {}),
    createdAt: Number(row.created_at),
  };
}

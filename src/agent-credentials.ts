import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { agentKey } from "./ai-access.ts";

export const AGENT_CREDENTIALS_PATH = "/ui/api/agent-credentials";

type Registry = { requireCredentials: boolean; entries: ReadonlyMap<string, string | null> };
const EMPTY_REGISTRY: Registry = { requireCredentials: false, entries: new Map() };

export interface AgentCredentialSettings {
  requireCredentials: boolean;
  credentials: Array<{ name: string; revoked: boolean }>;
}

export class AgentCredentialError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function credentialName(value: unknown): string {
  if (typeof value === "string" && value.trim().length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)) {
    const key = agentKey(value);
    if (key !== "unknown") return key;
  }
  throw new AgentCredentialError("Enter a valid Agent name.", 400);
}

export class AgentCredentials {
  private cached?: { identity: string; registry: Registry };

  constructor(private readonly file: string) {}

  private read(): Registry {
    const stat = statSync(this.file, { throwIfNoEntry: false, bigint: true });
    if (!stat) {
      this.cached = undefined;
      return EMPTY_REGISTRY;
    }
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    if (this.cached?.identity === identity) return this.cached.registry;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_REGISTRY;
      throw new Error("Could not read the local Agent credential registry");
    }
    const data = record(raw);
    if (!data) throw new Error("Invalid Agent credential registry");
    const versioned = typeof data.schemaVersion === "number";
    const stored = versioned ? record(data.credentials) : data;
    if (!stored || (versioned && (data.schemaVersion !== 1 || typeof data.requireCredentials !== "boolean"))) {
      throw new Error("Invalid Agent credential registry");
    }
    const entries = new Map<string, string | null>();
    const digests = new Set<string>();
    for (const [name, digest] of Object.entries(stored)) {
      const key = agentKey(name);
      if (key === "unknown" || entries.has(key)) throw new Error("Invalid or duplicate Agent credential");
      if (versioned && digest === null) {
        entries.set(key, null);
        continue;
      }
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || digests.has(digest)) {
        throw new Error("Invalid or duplicate Agent credential");
      }
      entries.set(key, digest);
      digests.add(digest);
    }
    const registry = { requireCredentials: versioned && data.requireCredentials === true, entries };
    this.cached = { identity, registry };
    return registry;
  }

  private write(registry: Registry): void {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ schemaVersion: 1, requireCredentials: registry.requireCredentials, credentials: Object.fromEntries(registry.entries) }));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, this.file);
      this.cached = undefined;
    } finally { rmSync(temp, { force: true }); }
  }

  settings(): AgentCredentialSettings {
    const { requireCredentials, entries } = this.read();
    return { requireCredentials, credentials: [...entries.keys()].sort().map(name => ({ name, revoked: entries.get(name) === null })) };
  }

  names(): string[] { return this.settings().credentials.filter(item => !item.revoked).map(item => item.name); }

  permitsNameOnly(name: string): boolean {
    const { entries, requireCredentials } = this.read();
    return !requireCredentials && !entries.has(agentKey(name));
  }

  isActive(name: string): boolean { return typeof this.read().entries.get(agentKey(name)) === "string"; }

  resolve(token: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return;
    const digest = createHash("sha256").update(token).digest();
    for (const [name, hash] of this.read().entries) {
      if (hash && timingSafeEqual(digest, Buffer.from(hash, "hex"))) return name;
    }
    return undefined;
  }

  matches(name: string, token: string): boolean {
    const stored = this.read().entries.get(agentKey(name));
    return !!stored && timingSafeEqual(createHash("sha256").update(token).digest(), Buffer.from(stored, "hex"));
  }

  issue(value: unknown, rotate: boolean): { name: string; token: string } {
    const name = credentialName(value);
    const registry = this.read();
    if (rotate && !registry.entries.has(name)) throw new AgentCredentialError("Agent credential was not found.", 404);
    if (!rotate && registry.entries.has(name)) throw new AgentCredentialError("This Agent already has a credential entry.", 409);
    const token = randomBytes(32).toString("base64url");
    const entries = new Map(registry.entries);
    entries.set(name, createHash("sha256").update(token).digest("hex"));
    this.write({ ...registry, entries });
    return { name, token };
  }

  revoke(value: unknown): string {
    const name = credentialName(value);
    const registry = this.read();
    if (!registry.entries.has(name)) throw new AgentCredentialError("Agent credential was not found.", 404);
    if (registry.entries.get(name) !== null) {
      const entries = new Map(registry.entries);
      entries.set(name, null);
      this.write({ ...registry, entries });
    }
    return name;
  }

  setRequired(value: unknown): void {
    if (typeof value !== "boolean") throw new AgentCredentialError("Choose whether to require Agent credentials.", 400);
    const registry = this.read();
    if (registry.requireCredentials === value) return;
    this.write({ ...registry, requireCredentials: value });
  }
}

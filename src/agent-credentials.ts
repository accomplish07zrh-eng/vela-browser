import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { agentKey } from "./ai-access.ts";

export class AgentCredentials {
  constructor(private readonly file: string) {}

  private entries(): [string, string][] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Could not read the local Agent credential registry");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Agent credential registry");
    const entries = new Map<string, string>();
    const digests = new Set<string>();
    for (const [name, digest] of Object.entries(raw)) {
      const key = agentKey(name);
      if (key === "unknown" || entries.has(key) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || digests.has(digest)) {
        throw new Error("Invalid or duplicate Agent credential");
      }
      entries.set(key, digest);
      digests.add(digest);
    }
    return [...entries];
  }

  has(name: string): boolean {
    return this.entries().some(([key]) => key === agentKey(name));
  }

  resolve(token: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return;
    const digest = createHash("sha256").update(token).digest();
    return this.entries().find(([, hash]) => timingSafeEqual(digest, Buffer.from(hash, "hex")))?.[0];
  }
}

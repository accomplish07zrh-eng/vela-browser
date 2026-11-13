/**
 * Encryption at rest for the proxy pool's secrets: subscription links (whoever has one can fetch
 * every node), node addresses and credentials, and the keys that tell two nodes apart.
 *
 * Values are sealed with AES-256-GCM under one random key per data directory. On Windows that key
 * is stored protected by DPAPI for the current Windows account, so a copy of the data directory
 * (a backup, a synced folder, another account on the same computer) cannot read them. Elsewhere
 * the key file is readable only by its owner for now; the macOS Keychain and the Secret Service
 * are a follow-up.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SEALED = "vs1:";
const DIGEST = "vh1:";

/** A sealed value that this computer's account cannot open (or the key could not be read now). */
export class SecretUnavailableError extends Error {
  constructor(message = "This secret cannot be read on this computer") { super(message); }
}

export type KeyProtection = "dpapi" | "file" | "memory" | "unavailable";

export class SecretBox {
  private readonly sealKey: Buffer | null;
  private readonly digestKey: Buffer | null;

  constructor(key: Buffer | null, readonly protection: KeyProtection) {
    if (key && key.length !== 32) throw new Error("the secret key must be 32 bytes");
    this.sealKey = key ? Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "vela proxy pool seal", 32)) : null;
    this.digestKey = key ? Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "vela proxy pool digest", 32)) : null;
  }

  /** A box with a fresh key that lives only in memory (tests, in-memory databases). */
  static ephemeral(): SecretBox { return new SecretBox(randomBytes(32), "memory"); }

  get available(): boolean { return this.sealKey !== null; }

  static isSealed(value: string): boolean { return value.startsWith(SEALED); }
  static isDigest(value: string): boolean { return value.startsWith(DIGEST); }

  seal(plain: string): string {
    if (!this.sealKey) throw new SecretUnavailableError("Encrypted storage is unavailable right now");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return SEALED + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  /** The plain text of a sealed value. A value that was never sealed (older data) comes back as is. */
  open(value: string): string {
    if (!SecretBox.isSealed(value)) return value;
    if (!this.sealKey) throw new SecretUnavailableError();
    const raw = Buffer.from(value.slice(SEALED.length), "base64");
    if (raw.length < 28) throw new SecretUnavailableError();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.sealKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretUnavailableError();
    }
  }

  /** A keyed, stable stand-in for a secret, for finding equal values without storing them. */
  digest(plain: string): string {
    if (!this.digestKey) throw new SecretUnavailableError("Encrypted storage is unavailable right now");
    return DIGEST + createHmac("sha256", this.digestKey).update(plain, "utf8").digest("hex");
  }
}

/** Protects the key file's content for this account. Injectable for tests. */
export interface KeyProtector {
  kind: "dpapi" | "file";
  protect(key: Buffer): Buffer;
  /** The key, or "denied" when this account definitely cannot open it, or "error" when unsure. */
  unprotect(blob: Buffer): Buffer | "denied" | "error";
}

const DPAPI_ENTROPY = "VelaBrowser.proxy-pool.v1";
const DPAPI_SCRIPT = (verb: "Protect" | "Unprotect") => "Add-Type -AssemblyName System.Security;" +
  "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
  `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');` +
  `try{[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($in,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser))}` +
  "catch{if($_.Exception -is [Security.Cryptography.CryptographicException] -or $_.Exception.InnerException -is [Security.Cryptography.CryptographicException]){'DENIED'}else{'ERROR'}}";

function runDpapi(verb: "Protect" | "Unprotect", input: Buffer): string | null {
  try {
    const result = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT(verb)], {
      stdin: new Blob([input.toString("base64")]), stdout: "pipe", stderr: "ignore", timeout: 30_000,
    } as Parameters<typeof Bun.spawnSync>[1]);
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

export const dpapiProtector: KeyProtector = {
  kind: "dpapi",
  protect(key) {
    const out = runDpapi("Protect", key);
    if (!out || out === "DENIED" || out === "ERROR") throw new Error("DPAPI could not protect the key");
    return Buffer.from(out, "base64");
  },
  unprotect(blob) {
    const out = runDpapi("Unprotect", blob);
    if (out === "DENIED") return "denied";
    if (!out || out === "ERROR") return "error";
    const key = Buffer.from(out, "base64");
    return key.length === 32 ? key : "error";
  },
};

export const fileProtector: KeyProtector = {
  kind: "file",
  protect: (key) => Buffer.from(key),
  unprotect: (blob) => blob.length === 32 ? Buffer.from(blob) : "error",
};

export function defaultProtector(): KeyProtector {
  return process.platform === "win32" ? dpapiProtector : fileProtector;
}

interface KeyFile { v: 1; protection: "dpapi" | "file"; key: string }

/**
 * The secret box for a database. ":memory:" and other non-file databases get an ephemeral key.
 * A key this account can definitely not open (the data directory came from another account) is
 * set aside, not deleted, and a new one is made; the values sealed under the old one then read
 * as unavailable, and their subscriptions have to be added again. When unsure (PowerShell failed),
 * the box is unavailable for this run rather than replacing a key that may still be good.
 */
export function secretBoxForDatabase(dbPath: string, opts: { protector?: KeyProtector; log?: (message: string) => void } = {}): SecretBox {
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file::memory:")) return SecretBox.ephemeral();
  const protector = opts.protector ?? defaultProtector();
  const path = join(dirname(dbPath), "proxy-pool.key");
  if (existsSync(path)) {
    let file: KeyFile | null = null;
    try { file = JSON.parse(readFileSync(path, "utf8")) as KeyFile; } catch { file = null; }
    const usable = file && file.v === 1 && typeof file.key === "string";
    const reader = usable && file!.protection === "file" ? fileProtector : protector;
    const opened = usable && (file!.protection === "file" || file!.protection === protector.kind)
      ? reader.unprotect(Buffer.from(file!.key, "base64"))
      : "denied";
    if (opened instanceof Buffer) return new SecretBox(opened, file!.protection);
    if (opened === "error") {
      opts.log?.("[proxy-pool] the encryption key could not be read now; encrypted proxy pool entries are unavailable this run");
      return new SecretBox(null, "unavailable");
    }
    const aside = `${path}.unreadable-${Date.now()}`;
    try { renameSync(path, aside); } catch { return new SecretBox(null, "unavailable"); }
    opts.log?.("[proxy-pool] the encryption key belongs to another account or is damaged; set it aside and made a new one");
  }
  const key = randomBytes(32);
  let protection: "dpapi" | "file" = protector.kind;
  let blob: Buffer;
  try {
    blob = protector.protect(key);
  } catch {
    protection = "file";
    blob = fileProtector.protect(key);
    opts.log?.("[proxy-pool] the system could not protect the encryption key; it is kept in a file only this account can read");
  }
  mkdirSync(dirname(path), { recursive: true });
  const content: KeyFile = { v: 1, protection, key: blob.toString("base64") };
  writeFileSync(path, JSON.stringify(content), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows: the profile directory's own ACL applies */ }
  return new SecretBox(key, protection);
}

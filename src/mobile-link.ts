import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

/**
 * The Vela Browser phone app: paired once, then it can start and close browsers, run scripts and
 * tasks, answer approvals and use one browser by touch, from the same Wi-Fi only.
 *
 * Pairing. The computer has its own key pair; a phone pairs with a key of its own by elliptic-curve
 * Diffie-Hellman, so the key both keep is never sent. Scanning the QR code in Settings proves the
 * phone is next to this screen: the code carries this computer's key fingerprint (the phone checks
 * it, so nobody in between can pose as the computer) and a long one-time secret. Typing the PIN
 * instead works too, but then the person confirms on the computer that the six digits both screens
 * show are the same, which catches anyone in between.
 *
 * After pairing, everything travels over one WebSocket, sealed with AES-256-GCM under keys made
 * fresh for each connection from the pairing key and two random challenges; messages carry a
 * counter, so none can be replayed or reordered.
 */
export interface MobileProfileInfo { id: string; name: string; group: string; running: boolean; engine: string; tags: string[] }
export interface MobileWorkbench { generation: string; start(emit: (value: object) => void): Promise<void>; enqueue(message: unknown): Promise<void>; dispose(): void | Promise<void> }
export interface MobileControl {
  version: string;
  profiles(): MobileProfileInfo[];
  open(id: string): Promise<void>;
  close(id: string): Promise<void>;
  scripts(): Promise<Array<{ id: string; name: string; description: string; language: string }>>;
  runScript(scriptId: string, profileIds: string[], by: string): unknown;
  stopScript(): Promise<unknown>;
  scriptStatus(): { id: string; scriptName: string; status: string; profiles: Array<{ id: string; name: string; status: string; error?: string }> } | null;
  tasks(): { tasks: Array<{ id: string; name: string; enabled: boolean; nextRunAt: number | null; steps: unknown[] }>; history: Array<{ id: string; taskId: string; taskName: string; startedAt: number; finishedAt?: number; outcome: string; profiles: number }>; runningTaskId: string | null };
  runTask(id: string): void;
  approvals(): { proxy: Array<{ id: string; profileId: string; profileName: string; client: string; from: string; to: string; reopens: boolean; requestedAt: number; expiresAt: number }>; code: Array<{ id: string; kind: string; action: string; title: string; client: string; detail: string; files: Array<{ name: string; content: string }>; requestedAt: number; expiresAt: number }> };
  answer(kind: "proxy" | "code", id: string, allow: boolean): boolean;
  connect(id: string): Promise<MobileWorkbench>;
  /** Opens an address in a new tab of a profile's browser (starting it when closed). */
  visit?(id: string, url: string): Promise<void>;
  /** What the phone did, for the activity log. */
  record?(entry: { device: string; action: string; ok: boolean; profileId?: string; profileName?: string; detail?: string; error?: string }): void;
}

export interface PairedDevice { id: string; name: string; key: string; createdAt: number; lastSeenAt?: number }
interface StoredLink { identity: { privateKey: string; publicKey: string }; devices: PairedDevice[] }
export interface PendingPair { id: string; name: string; code: string; status: "waiting" | "allowed" | "denied"; expiresAt: number; deviceKey: Buffer; deviceId?: string }

const PAIR_WAIT_MS = 2 * 60_000;
const b64 = (value: Buffer | Uint8Array) => Buffer.from(value).toString("base64");
const unb64 = (value: unknown, max = 4096) => {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/=]*$/.test(value)) throw new Error("bad encoding");
  return Buffer.from(value, "base64");
};
const hkdf = (ikm: Buffer, salt: Buffer | string, info: Buffer | string, length = 32) => Buffer.from(hkdfSync("sha256", ikm, Buffer.from(salt), Buffer.from(info), length));
const hmac = (key: Buffer, ...parts: Array<Buffer | string>) => { const mac = createHmac("sha256", key); for (const part of parts) mac.update(Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8")); return mac.digest(); };
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** The six digits both screens show while a PIN pairing waits for a yes on the computer. */
export function pairCode(computerKey: Buffer, phoneKey: Buffer): string {
  const digest = createHash("sha256").update("vela-pair-code").update(computerKey).update(phoneKey).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

/** One direction of a sealed connection: AES-256-GCM, the IV is a counter that only goes up. */
export class SealedChannel {
  private sent = 0n;
  private received = 0n;
  constructor(private readonly sendKey: Buffer, private readonly receiveKey: Buffer) {}
  static forServer(deviceKey: Buffer, serverNonce: Buffer, clientNonce: Buffer): SealedChannel {
    const salt = Buffer.concat([serverNonce, clientNonce]);
    return new SealedChannel(hkdf(deviceKey, salt, "vela-s2c"), hkdf(deviceKey, salt, "vela-c2s"));
  }
  static forClient(deviceKey: Buffer, serverNonce: Buffer, clientNonce: Buffer): SealedChannel {
    const salt = Buffer.concat([serverNonce, clientNonce]);
    return new SealedChannel(hkdf(deviceKey, salt, "vela-c2s"), hkdf(deviceKey, salt, "vela-s2c"));
  }
  seal(plain: Buffer): Buffer {
    this.sent++;
    const iv = Buffer.alloc(12); iv.writeBigUInt64BE(this.sent, 4);
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, iv);
    return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
  /** The plaintext, or null for anything forged, replayed or out of order. */
  open(sealed: Buffer): Buffer | null {
    if (sealed.length < 28) return null;
    const iv = sealed.subarray(0, 12);
    if (iv.readUInt32BE(0) !== 0) return null;
    const counter = iv.readBigUInt64BE(4);
    if (counter <= this.received) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, iv);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
      this.received = counter;
      return plain;
    } catch { return null; }
  }
}

/** A JSON message, or a picture of a browser: a header (JSON) and the JPEG after it. */
export function encodeMessage(value: object): Buffer { return Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(value), "utf8")]); }
export function encodeFrame(header: object, jpeg: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const size = Buffer.alloc(2); size.writeUInt16BE(head.length);
  return Buffer.concat([Buffer.from([1]), size, head, jpeg]);
}

interface Socket { send(data: Uint8Array | string): unknown; close(code?: number, reason?: string): void; getBufferedAmount(): number }
interface Session {
  socket: Socket;
  serverNonce: Buffer;
  device?: PairedDevice;
  channel?: SealedChannel;
  watch?: { profileId: string; workbench: MobileWorkbench };
  authTimer?: ReturnType<typeof setTimeout>;
}

export class MobileLink {
  private data: StoredLink;
  private privateKey: KeyObject;
  readonly publicKey: Buffer;
  private secret = randomBytes(16).toString("hex");
  private pending = new Map<string, PendingPair>();
  private sessions = new Set<Session>();
  private watcher?: ReturnType<typeof setInterval>;
  private seen = { approvals: new Set<string>(), script: "" };

  constructor(private readonly control: MobileControl | undefined, private readonly file?: string, private readonly now: () => number = Date.now) {
    this.data = this.load();
    this.privateKey = createPrivateKey({ key: unb64(this.data.identity.privateKey), format: "der", type: "pkcs8" });
    this.publicKey = unb64(this.data.identity.publicKey);
  }

  get available(): boolean { return !!this.control; }
  /** Short form of this computer's key, carried by the QR code so the phone can check it. */
  get fingerprint(): string { return createHash("sha256").update(this.publicKey).digest("hex").slice(0, 32); }
  get computerName(): string { return hostname().slice(0, 64) || "Vela Browser"; }
  /** A new one-time secret for the QR code (after each pairing and each time the phone app is turned on). */
  rotateSecret(): void { this.secret = randomBytes(16).toString("hex"); }
  pairingSecret(): string { return this.secret; }
  devices(): Array<Omit<PairedDevice, "key">> { return this.data.devices.map(({ key: _key, ...device }) => device); }
  pendingPairs(): Array<{ id: string; name: string; code: string; expiresAt: number }> {
    this.expire();
    return [...this.pending.values()].filter((pair) => pair.status === "waiting").map(({ id, name, code, expiresAt }) => ({ id, name, code, expiresAt }));
  }

  private load(): StoredLink {
    try {
      if (this.file && existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StoredLink;
        if (parsed?.identity?.privateKey && parsed.identity.publicKey && Array.isArray(parsed.devices)) {
          return { identity: parsed.identity, devices: parsed.devices.filter((device) => typeof device?.id === "string" && typeof device.key === "string") };
        }
      }
    } catch { /* made again below */ }
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const fresh: StoredLink = {
      identity: { privateKey: b64(pair.privateKey.export({ format: "der", type: "pkcs8" })), publicKey: b64(pair.publicKey.export({ format: "der", type: "spki" })) },
      devices: [],
    };
    this.save(fresh);
    return fresh;
  }
  private save(data = this.data): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private expire(): void {
    for (const [id, pair] of this.pending) if (pair.expiresAt < this.now()) this.pending.delete(id);
  }

  /** Forget a phone: it has to pair again, and its open connection ends now. */
  revoke(id: string): boolean {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((device) => device.id !== id);
    if (this.data.devices.length === before) return false;
    this.save();
    for (const session of this.sessions) if (session.device?.id === id) session.socket.close(4401, "unpaired");
    return true;
  }

  /** The yes or no for a PIN pairing, given on the computer after comparing the digits. */
  decide(id: string, allow: boolean): boolean {
    this.expire();
    const pair = this.pending.get(id);
    if (!pair || pair.status !== "waiting") return false;
    if (!allow) { pair.status = "denied"; return true; }
    pair.deviceId = this.addDevice(pair.name, pair.deviceKey);
    pair.status = "allowed";
    return true;
  }

  private addDevice(name: string, key: Buffer): string {
    const id = randomBytes(12).toString("hex");
    this.data.devices.push({ id, name, key: b64(key), createdAt: this.now() });
    this.save();
    this.rotateSecret();
    return id;
  }

  /** What a phone needs before pairing by PIN (it finds the computer by a broadcast or a typed address). */
  hello(port: number | undefined): object {
    return { ok: true, app: "vela-browser", name: this.computerName, version: this.control?.version ?? "", key: b64(this.publicKey), fingerprint: this.fingerprint, port: port ?? null };
  }

  /**
   * A pairing request. checkPin says whether the PIN given is right (and counts a wrong one); the
   * QR secret is long enough that it needs no counting.
   */
  pair(body: Record<string, unknown>, checkPin: (pin: string) => boolean): { status: number; body: object } {
    if (!this.control) return { status: 503, body: { ok: false, error: "The phone app is unavailable here" } };
    let phoneKey: Buffer, proof: Buffer;
    try { phoneKey = unb64(body.key, 400); proof = unb64(body.proof, 100); } catch { return { status: 400, body: { ok: false, error: "Bad request" } }; }
    const name = String(body.name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 48) || "Phone";
    const via = body.via === "qr" ? "qr" : "pin";
    let shared: Buffer;
    try { shared = diffieHellman({ privateKey: this.privateKey, publicKey: createPublicKey({ key: phoneKey, format: "der", type: "spki" }) }); }
    catch { return { status: 400, body: { ok: false, error: "Bad key" } }; }
    const info = Buffer.concat([phoneKey, this.publicKey]);
    const pairKey = hkdf(shared, "vela-pair-v1", info);
    const deviceKey = hkdf(shared, "vela-device-v1", info);
    if (via === "qr") {
      if (!same(hmac(pairKey, "pair", "qr", this.secret), proof)) return { status: 401, body: { ok: false, error: "This QR code is out of date. Show it again in Vela Browser." } };
      const deviceId = this.addDevice(name, deviceKey);
      return { status: 200, body: { ok: true, status: "allowed", deviceId, name: this.computerName, mac: b64(hmac(deviceKey, "paired", deviceId)) } };
    }
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!/^\d{6}$/.test(pin) || !checkPin(pin) || !same(hmac(pairKey, "pair", "pin", pin), proof)) return { status: 401, body: { ok: false, error: "Wrong PIN" } };
    this.expire();
    if (this.pending.size >= 8) return { status: 429, body: { ok: false, error: "Too many phones are waiting. Try again in a minute." } };
    const id = randomBytes(16).toString("hex");
    const code = pairCode(this.publicKey, phoneKey);
    this.pending.set(id, { id, name, code, status: "waiting", expiresAt: this.now() + PAIR_WAIT_MS, deviceKey });
    return { status: 202, body: { ok: true, status: "waiting", pending: id, code } };
  }

  /** The phone asks whether its PIN pairing was allowed yet. */
  pairStatus(id: string): { status: number; body: object } {
    this.expire();
    const pair = this.pending.get(id);
    if (!pair) return { status: 404, body: { ok: false, status: "expired" } };
    if (pair.status === "waiting") return { status: 200, body: { ok: true, status: "waiting", code: pair.code } };
    this.pending.delete(id);
    if (pair.status === "denied") return { status: 200, body: { ok: true, status: "denied" } };
    return { status: 200, body: { ok: true, status: "allowed", deviceId: pair.deviceId, name: this.computerName, mac: b64(hmac(pair.deviceKey, "paired", pair.deviceId!)) } };
  }

  // ---- The sealed connection ----

  open(socket: Socket): Session {
    const session: Session = { socket, serverNonce: randomBytes(32) };
    this.sessions.add(session);
    socket.send(JSON.stringify({ t: "challenge", n: b64(session.serverNonce), name: this.computerName }));
    session.authTimer = setTimeout(() => { if (!session.channel) socket.close(4401, "no answer"); }, 10_000);
    this.ensureWatcher();
    return session;
  }

  close(session: Session): void {
    clearTimeout(session.authTimer);
    this.sessions.delete(session);
    void this.unwatch(session);
    if (!this.sessions.size) { clearInterval(this.watcher); this.watcher = undefined; }
  }

  closeAll(): void {
    for (const session of [...this.sessions]) { session.socket.close(1001, "stopped"); this.close(session); }
    this.pending.clear();
  }

  async message(session: Session, raw: string | Buffer): Promise<void> {
    if (!session.channel) {
      // The one unsealed reply: which phone, and proof it holds that phone's key.
      try {
        const hello = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
        const device = this.data.devices.find((item) => item.id === hello.d);
        const clientNonce = unb64(hello.n, 64);
        if (!device || clientNonce.length !== 32) throw new Error("unknown");
        const key = unb64(device.key);
        if (!same(hmac(key, "auth", session.serverNonce, clientNonce, device.id), unb64(hello.mac, 100))) throw new Error("bad proof");
        clearTimeout(session.authTimer);
        session.device = device;
        session.channel = SealedChannel.forServer(key, session.serverNonce, clientNonce);
        device.lastSeenAt = this.now(); this.save();
        this.send(session, { t: "ready", name: this.computerName, version: this.control?.version ?? "" });
      } catch { session.socket.close(4401, "not paired"); }
      return;
    }
    if (typeof raw === "string") { session.socket.close(1003, "sealed only"); return; }
    const plain = session.channel.open(raw);
    if (!plain || plain[0] !== 0) { session.socket.close(4400, "bad message"); return; }
    let message: Record<string, any>;
    try { message = JSON.parse(plain.subarray(1).toString("utf8")); } catch { session.socket.close(4400, "bad message"); return; }
    if (message.t === "wb") {
      if (session.watch && message.msg && typeof message.msg === "object") void session.watch.workbench.enqueue({ ...message.msg, generation: session.watch.workbench.generation });
      return;
    }
    if (message.t !== "call" || typeof message.m !== "string") return;
    const id = message.id;
    try {
      const data = await this.call(session, message.m, (message.p && typeof message.p === "object" ? message.p : {}) as Record<string, any>);
      this.send(session, { t: "res", id, ok: true, data });
    } catch (error) {
      this.send(session, { t: "res", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private send(session: Session, value: object): void {
    if (!session.channel) return;
    try { session.socket.send(session.channel.seal(encodeMessage(value))); } catch { /* closed */ }
  }

  private record(session: Session, action: string, ok: boolean, extra: { profileId?: string; detail?: string; error?: string } = {}): void {
    const profileName = extra.profileId ? this.control?.profiles().find((profile) => profile.id === extra.profileId)?.name : undefined;
    try { this.control?.record?.({ device: session.device?.name ?? "Phone", action, ok, ...extra, ...(profileName ? { profileName } : {}) }); } catch { /* the log is best effort */ }
  }

  private async call(session: Session, method: string, params: Record<string, any>): Promise<unknown> {
    const control = this.control!;
    const profileId = () => {
      const id = typeof params.id === "string" ? params.id : "";
      if (!control.profiles().some((profile) => profile.id === id)) throw new Error("No such profile");
      return id;
    };
    switch (method) {
      case "state": {
        const run = control.scriptStatus();
        const tasks = control.tasks();
        const approvals = control.approvals();
        const running = tasks.runningTaskId ? tasks.tasks.find((task) => task.id === tasks.runningTaskId) : undefined;
        return {
          name: this.computerName, at: this.now(), profiles: control.profiles(),
          script: run && run.status !== "finished" ? { name: run.scriptName, status: run.status, total: run.profiles.length, done: run.profiles.filter((item) => ["succeeded", "failed", "cancelled"].includes(item.status)).length, failed: run.profiles.filter((item) => item.status === "failed").length } : null,
          task: running ? { id: running.id, name: running.name } : null,
          approvals: approvals.proxy.length + approvals.code.length,
        };
      }
      case "profile.open": { const id = profileId(); try { await control.open(id); this.record(session, "browser.open", true, { profileId: id }); } catch (error) { this.record(session, "browser.open", false, { profileId: id, error: String((error as Error)?.message ?? error) }); throw error; } return { ok: true }; }
      case "profile.close": { const id = profileId(); if (session.watch?.profileId === id) await this.unwatch(session); await control.close(id); this.record(session, "browser.close", true, { profileId: id }); return { ok: true }; }
      case "scripts.list": return await control.scripts();
      case "script.status": return control.scriptStatus();
      case "script.run": {
        const ids = Array.isArray(params.profileIds) ? params.profileIds.filter((id: unknown) => typeof id === "string").slice(0, 500) : [];
        if (typeof params.scriptId !== "string" || !ids.length) throw new Error("Choose a script and at least one browser");
        const run = control.runScript(params.scriptId, ids, session.device?.name ?? "Phone");
        this.record(session, "script.run", true, { detail: `${ids.length} profile(s)` });
        return run;
      }
      case "script.stop": this.record(session, "script.stop", true); return await control.stopScript();
      case "tasks.list": return control.tasks();
      case "task.run": {
        if (typeof params.id !== "string" || !control.tasks().tasks.some((task) => task.id === params.id)) throw new Error("No such task");
        control.runTask(params.id); this.record(session, "task.run", true, { detail: control.tasks().tasks.find((task) => task.id === params.id)?.name });
        return { ok: true };
      }
      case "approvals.list": {
        const { proxy, code } = control.approvals();
        // Long scripts are cut for the phone; the whole text is on the computer.
        return { proxy, code: code.map((item) => ({ ...item, files: item.files.map((file) => ({ name: file.name, content: file.content.slice(0, 20_000), cut: file.content.length > 20_000 })) })) };
      }
      case "approval.answer": {
        const kind = params.kind === "code" ? "code" : "proxy";
        if (typeof params.id !== "string" || typeof params.allow !== "boolean") throw new Error("Bad request");
        const ok = control.answer(kind, params.id, params.allow);
        this.record(session, `approval.${params.allow ? "allow" : "deny"}`, ok, { detail: kind });
        if (!ok) throw new Error("This request was already answered or has expired");
        return { ok: true };
      }
      case "profile.visit": {
        const id = profileId();
        let url: URL;
        try { url = new URL(String(params.url ?? "")); } catch { throw new Error("Give an http or https address"); }
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Give an http or https address");
        if (!control.visit) throw new Error("Unavailable");
        await control.visit(id, url.toString());
        this.record(session, "browser.visit", true, { profileId: id, detail: url.hostname });
        return { ok: true };
      }
      case "watch": {
        const id = profileId();
        await this.unwatch(session);
        const workbench = await control.connect(id);
        session.watch = { profileId: id, workbench };
        await workbench.start((value) => this.forward(session, workbench, value as Record<string, any>));
        return { ok: true, generation: workbench.generation };
      }
      case "unwatch": await this.unwatch(session); return { ok: true };
      default: throw new Error("Unknown request");
    }
  }

  /** A browser's picture goes as bytes; everything else from the workbench as JSON. */
  private forward(session: Session, workbench: MobileWorkbench, value: Record<string, any>): void {
    if (!session.channel || session.watch?.workbench !== workbench) return;
    if (value.type === "frame" && typeof value.data === "string") {
      if (session.socket.getBufferedAmount() > 1024 * 1024) return;
      const { data, ...header } = value;
      try { session.socket.send(session.channel.seal(encodeFrame({ t: "frame", ...header }, Buffer.from(data, "base64")))); } catch { /* closed */ }
      return;
    }
    this.send(session, { t: "wb", ...value });
  }

  private async unwatch(session: Session): Promise<void> {
    const watch = session.watch;
    session.watch = undefined;
    try { await watch?.workbench.dispose(); } catch { /* already gone */ }
  }

  /** New approvals and the end of a script run reach every connected phone as notices. */
  private ensureWatcher(): void {
    if (this.watcher || !this.control) return;
    const tick = () => {
      try {
        const { proxy, code } = this.control!.approvals();
        const notices: object[] = [];
        const ids = new Set<string>();
        for (const item of proxy) { ids.add(item.id); if (!this.seen.approvals.has(item.id)) notices.push({ t: "notify", kind: "approval", approval: "proxy", id: item.id, client: item.client, title: item.profileName, detail: item.profileName }); }
        for (const item of code) { ids.add(item.id); if (!this.seen.approvals.has(item.id)) notices.push({ t: "notify", kind: "approval", approval: "code", id: item.id, client: item.client, title: item.title, detail: item.title }); }
        this.seen.approvals = ids;
        const run = this.control!.scriptStatus();
        const key = run ? `${run.id}:${run.status}` : "";
        if (run && run.status === "finished" && key !== this.seen.script && this.seen.script.startsWith(`${run.id}:`)) {
          const failed = run.profiles.filter((item) => item.status === "failed").length;
          notices.push({ t: "notify", kind: "script", name: run.scriptName, total: run.profiles.length, failed });
        }
        this.seen.script = key;
        for (const notice of notices) for (const session of this.sessions) this.send(session, notice);
      } catch { /* next tick */ }
    };
    tick();
    this.watcher = setInterval(tick, 1500);
    (this.watcher as any).unref?.();
  }
}

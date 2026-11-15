import { describe, expect, test } from "bun:test";
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileView } from "./mobile-view.ts";
import { SealedChannel, encodeMessage, pairCode, type MobileControl } from "./mobile-link.ts";

const hkdf = (ikm: Buffer, salt: string, info: Buffer) => Buffer.from(hkdfSync("sha256", ikm, Buffer.from(salt), info, 32));
const hmac = (key: Buffer, ...parts: Array<Buffer | string>) => { const mac = createHmac("sha256", key); for (const part of parts) mac.update(part); return mac.digest(); };

/** What the Android app does, in Node: a key pair, the shared keys, and the pairing proof. */
function phone(computerKey: Buffer) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey({ key: computerKey, format: "der", type: "spki" }) });
  const info = Buffer.concat([key, computerKey]);
  return { key, pairKey: hkdf(shared, "vela-pair-v1", info), deviceKey: hkdf(shared, "vela-device-v1", info) };
}

function control(overrides: Partial<MobileControl> = {}): MobileControl & { opened: string[]; answered: string[] } {
  const opened: string[] = [], answered: string[] = [];
  return {
    opened, answered, version: "9.9.9",
    profiles: () => [{ id: "p1", name: "Shop 1", group: "Shops", running: true, engine: "chromium", tags: [] }, { id: "p2", name: "Shop 2", group: "Shops", running: false, engine: "chromium", tags: [] }],
    open: async (id) => { opened.push(id); }, close: async () => {},
    visit: async (id, url) => { opened.push(`visit:${id}:${url}`); },
    viewMode: async (id, mode) => { opened.push(`mode:${id}:${mode}`); },
    scripts: async () => [{ id: "s1", name: "Check in", description: "", language: "javascript" }],
    runScript: (scriptId, ids) => ({ id: "run1", scriptId, ids }), stopScript: async () => null, scriptStatus: () => null,
    tasks: () => ({ tasks: [], history: [], runningTaskId: null }), runTask: () => {},
    approvals: () => ({ proxy: [{ id: "a1", profileId: "p1", profileName: "Shop 1", client: "Claude", from: "direct", to: "socks5://x", reopens: false, requestedAt: 1, expiresAt: 2 }], code: [] }),
    answer: (kind, id, allow) => { answered.push(`${kind}:${id}:${allow}`); return true; },
    connect: async () => ({
      generation: "g1",
      start: async (emit) => { emit({ type: "ready", targetId: "t1", tabs: [] }); emit({ type: "frame", targetId: "t1", data: Buffer.from("JPEGDATA").toString("base64"), width: 8, height: 4 }); },
      enqueue: async () => {}, dispose: () => {},
    }),
    ...overrides,
  };
}

async function connect(port: number, deviceId: string, deviceKey: Buffer) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app/ws`);
  ws.binaryType = "arraybuffer";
  const inbox: Array<{ json?: any; frame?: { header: any; jpeg: Buffer } }> = [];
  let channel: SealedChannel | undefined;
  let wake = () => {};
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const challenge = JSON.parse(event.data);
      const clientNonce = randomBytes(32), serverNonce = Buffer.from(challenge.n, "base64");
      channel = SealedChannel.forClient(deviceKey, serverNonce, clientNonce);
      ws.send(JSON.stringify({ d: deviceId, n: clientNonce.toString("base64"), mac: hmac(deviceKey, "auth", serverNonce, clientNonce, deviceId).toString("base64") }));
      return;
    }
    const plain = channel!.open(Buffer.from(event.data as ArrayBuffer))!;
    if (plain[0] === 0) inbox.push({ json: JSON.parse(plain.subarray(1).toString("utf8")) });
    else { const size = plain.readUInt16BE(1); inbox.push({ frame: { header: JSON.parse(plain.subarray(3, 3 + size).toString("utf8")), jpeg: plain.subarray(3 + size) } }); }
    wake();
  };
  const closed = new Promise<number>((resolve) => { ws.onclose = (event) => resolve(event.code); });
  const next = async (match: (item: (typeof inbox)[number]) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const index = inbox.findIndex(match);
      if (index >= 0) return inbox.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50); });
    }
    throw new Error("timed out");
  };
  let calls = 0;
  const call = async (m: string, p: object = {}) => {
    const id = ++calls;
    ws.send(channel!.seal(encodeMessage({ t: "call", id, m, p })));
    return (await next((item) => item.json?.t === "res" && item.json.id === id)).json;
  };
  await Promise.race([next((item) => item.json?.t === "ready"), closed.then((code) => { throw new Error(`closed ${code}`); })]);
  return { ws, call, next, closed, channel: () => channel! };
}

describe("phone app link", () => {
  test("pairs by QR, opens a sealed connection, answers calls and streams a browser", async () => {
    const root = mkdtempSync(join(tmpdir(), "vela-link-"));
    const ctl = control();
    const view = new MobileView({ profiles: () => [], snapshot: async () => null, activity: () => ({}) }, Date.now, { control: ctl, file: join(root, "mobile-devices.json") });
    view.start(0);
    try {
      const base = `http://127.0.0.1:${view.port}`;
      const hello = await (await fetch(`${base}/app/hello`)).json() as any;
      expect(hello.fingerprint).toBe(view.link!.fingerprint);
      const computerKey = Buffer.from(hello.key, "base64");
      const me = phone(computerKey);
      // A stale QR secret is refused.
      const stale = await fetch(`${base}/app/pair`, { method: "POST", body: JSON.stringify({ via: "qr", name: "Pixel", key: me.key.toString("base64"), proof: hmac(me.pairKey, "pair", "qr", "0".repeat(32)).toString("base64") }) });
      expect(stale.status).toBe(401);
      const secret = view.link!.pairingSecret();
      const paired = await (await fetch(`${base}/app/pair`, { method: "POST", body: JSON.stringify({ via: "qr", name: "Pixel", key: me.key.toString("base64"), proof: hmac(me.pairKey, "pair", "qr", secret).toString("base64") }) })).json() as any;
      expect(paired.status).toBe("allowed");
      expect(Buffer.from(paired.mac, "base64").equals(hmac(me.deviceKey, "paired", paired.deviceId))).toBe(true);
      // The QR secret is used up, and the key both sides keep is never written in the clear by the phone's side.
      expect(view.link!.pairingSecret()).not.toBe(secret);
      expect(readFileSync(join(root, "mobile-devices.json"), "utf8")).toContain(paired.deviceId);

      const link = await connect(view.port!, paired.deviceId, me.deviceKey);
      const state = await link.call("state");
      expect(state.ok).toBe(true);
      expect(state.data.profiles.map((profile: any) => profile.id)).toEqual(["p1", "p2"]);
      expect(state.data.approvals).toBe(1);
      expect((await link.call("profile.open", { id: "p2" })).ok).toBe(true);
      expect(ctl.opened).toEqual(["p2"]);
      expect((await link.call("profile.open", { id: "nope" })).ok).toBe(false);
      expect((await link.call("profile.visit", { id: "p1", url: "https://example.com/a" })).ok).toBe(true);
      expect(ctl.opened).toEqual(["p2", "visit:p1:https://example.com/a"]);
      expect((await link.call("profile.visit", { id: "p1", url: "file:///etc/passwd" })).ok).toBe(false);
      expect((await link.call("approval.answer", { kind: "proxy", id: "a1", allow: true })).ok).toBe(true);
      expect(ctl.answered).toEqual(["proxy:a1:true"]);
      expect((await link.call("watch", { id: "p1" })).data.generation).toBe("g1");
      const frame = await link.next((item) => !!item.frame);
      expect(frame.frame!.header).toMatchObject({ t: "frame", targetId: "t1", width: 8, height: 4 });
      expect(frame.frame!.jpeg.toString()).toBe("JPEGDATA");

      // Phone mode narrows the shown browser's window; leaving the browser gives the size back.
      expect((await link.call("view.mode", { mode: "phone" })).data.mode).toBe("phone");
      expect((await link.call("view.mode", { mode: "phone" })).ok).toBe(true);
      expect((await link.call("unwatch")).ok).toBe(true);
      expect(ctl.opened.filter((entry) => entry.startsWith("mode:"))).toEqual(["mode:p1:phone", "mode:p1:pc"]);
      expect((await link.call("view.mode", { mode: "phone" })).ok).toBe(false);
      expect((await link.call("watch", { id: "p1", mode: "phone" })).ok).toBe(true);
      expect(ctl.opened.at(-1)).toBe("mode:p1:phone");

      // A replayed message ends the connection.
      const sealed = link.channel().seal(encodeMessage({ t: "call", id: 99, m: "state" }));
      link.ws.send(sealed); await link.next((item) => item.json?.id === 99);
      link.ws.send(sealed);
      expect(await link.closed).toBe(4400);

      // Forgetting the phone ends its connection and refuses it afterwards.
      const again = await connect(view.port!, paired.deviceId, me.deviceKey);
      view.link!.revoke(paired.deviceId);
      expect(await again.closed).toBe(4401);
      await expect(connect(view.port!, paired.deviceId, me.deviceKey)).rejects.toThrow();
    } finally { view.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  test("pairing by PIN waits for a yes on the computer, with the same six digits on both screens", async () => {
    const view = new MobileView({ profiles: () => [], snapshot: async () => null, activity: () => ({}) }, Date.now, { control: control() });
    view.start(0);
    try {
      const base = `http://127.0.0.1:${view.port}`;
      const computerKey = Buffer.from(((await (await fetch(`${base}/app/hello`)).json()) as any).key, "base64");
      const me = phone(computerKey);
      const ask = (pin: string) => fetch(`${base}/app/pair`, { method: "POST", body: JSON.stringify({ via: "pin", pin, name: "Pixel", key: me.key.toString("base64"), proof: hmac(me.pairKey, "pair", "pin", pin).toString("base64") }) });
      const wrong = view.currentPin === "000000" ? "000001" : "000000";
      expect((await ask(wrong)).status).toBe(401);
      const waiting = await (await ask(view.currentPin)).json() as any;
      expect(waiting.status).toBe("waiting");
      expect(waiting.code).toBe(pairCode(computerKey, me.key));
      expect(view.link!.pendingPairs()).toEqual([expect.objectContaining({ id: waiting.pending, code: waiting.code, name: "Pixel" })]);
      expect((await (await fetch(`${base}/app/pair/${waiting.pending}`)).json() as any).status).toBe("waiting");
      expect(view.link!.decide(waiting.pending, true)).toBe(true);
      const allowed = await (await fetch(`${base}/app/pair/${waiting.pending}`)).json() as any;
      expect(allowed.status).toBe("allowed");
      expect(Buffer.from(allowed.mac, "base64").equals(hmac(me.deviceKey, "paired", allowed.deviceId))).toBe(true);
      expect(view.link!.devices().map((device) => device.name)).toEqual(["Pixel"]);
      // Five wrong PINs a minute from one address, then a pause.
      for (let i = 0; i < 5; i++) await ask(wrong);
      expect((await ask(view.currentPin)).status).toBe(429);
    } finally { view.stop(); }
  });

  test("a phone answers discovery broadcasts", async () => {
    const view = new MobileView({ profiles: () => [], snapshot: async () => null, activity: () => ({}) }, Date.now, { control: control() });
    view.start(0);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const reply = await new Promise<any>(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no reply")), 2000);
        // Another Vela Browser on this computer may answer too; wait for this one.
        const socket = await Bun.udpSocket({ socket: { data: (_sock, data) => {
          const reply = JSON.parse(Buffer.from(data).toString("utf8"));
          if (reply.fingerprint !== view.link!.fingerprint) return;
          clearTimeout(timer); socket.close(); resolve(reply);
        } } });
        socket.send("VELA?", 50481, "127.0.0.1");
      });
      expect(reply).toMatchObject({ app: "vela-browser", port: view.port, fingerprint: view.link!.fingerprint });
    } finally { view.stop(); }
  });
});

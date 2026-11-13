/**
 * Switching a running relay to another upstream. The browser keeps pointing at the same loopback
 * port; what changes is where the relay sends its traffic. At every moment a connection is either
 * carried by the old upstream, held without being forwarded, or carried by the new one. Nothing
 * is ever sent anywhere else.
 */
import { expect, test } from "bun:test";
import net from "node:net";
import { startProxyRelay, type UpstreamProxy } from "./proxy-relay.ts";

interface RecordingUpstream {
  port: number;
  /** Bytes received inside SOCKS tunnels, in order. */
  tunnelBytes: Buffer[];
  /** CONNECT / SOCKS targets this upstream was asked for, in order. */
  targets: string[];
  sockets: Set<net.Socket>;
  close(): void;
}

/** HTTP proxy that records every CONNECT target. `stall` leaves CONNECTs unanswered. */
function httpUpstream(name: string, stall = false): Promise<RecordingUpstream> {
  const tunnelBytes: Buffer[] = [];
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      sock.removeListener("data", onData);
      const first = buf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const match = first.match(/^CONNECT\s+(\S+)/i);
      if (!match) { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      targets.push(match[1]!);
      if (stall) { sock.resume(); return; }
      sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
      // Answer each tunnel write with this upstream's name, so a client sees which exit carried it.
      sock.on("data", () => sock.write(name));
    };
    sock.on("data", onData);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: (server.address() as net.AddressInfo).port,
    tunnelBytes,
    targets,
    sockets,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

/** No-auth SOCKS5 upstream that waits `replyDelayMs` before answering CONNECT. */
function socksUpstream(name: string, replyDelayMs = 0): Promise<RecordingUpstream> {
  const tunnelBytes: Buffer[] = [];
  const targets: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf = Buffer.alloc(0);
    let state: "greeting" | "connect" | "tunnel" = "greeting";
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (state === "greeting" && buf.length >= 3) {
        buf = buf.subarray(3);
        sock.write(Buffer.from([5, 0]));
        state = "connect";
      }
      if (state === "connect" && buf.length >= 5 && buf.length >= 7 + buf[4]!) {
        // ATYP 3: the relay must hand over the name, never an address it resolved itself.
        expect(buf[3]).toBe(3);
        const length = buf[4]!;
        targets.push(`${buf.subarray(5, 5 + length).toString("ascii")}:${buf.readUInt16BE(5 + length)}`);
        buf = Buffer.alloc(0);
        state = "tunnel";
        setTimeout(() => {
          if (sock.destroyed) return;
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
        }, replyDelayMs);
        return;
      }
      if (state === "tunnel" && buf.length) { tunnelBytes.push(buf); buf = Buffer.alloc(0); sock.write(name); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: (server.address() as net.AddressInfo).port,
    tunnelBytes,
    targets,
    sockets,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

function via(up: RecordingUpstream, type: UpstreamProxy["type"] = "http"): UpstreamProxy {
  return { type, host: "127.0.0.1", port: up.port, user: "", pass: "" };
}

interface Tunnel {
  socket: net.Socket;
  /** Resolves with everything received once the tunnel is established and `probe` answered. */
  established: Promise<string>;
  closed: Promise<void>;
}

/** Open a CONNECT tunnel through the relay and send `probe` once it is up. */
function openTunnel(relayPort: number, target: string, probe = "ping"): Tunnel {
  const socket = net.connect({ host: "127.0.0.1", port: relayPort });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const established = new Promise<string>((resolve, reject) => {
    let text = "";
    let sent = false;
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", (chunk) => {
      text += chunk.toString("latin1");
      if (!sent && text.includes("\r\n\r\n")) { sent = true; socket.write(probe); return; }
      if (sent && text.length > text.indexOf("\r\n\r\n") + 4) resolve(text.slice(text.indexOf("\r\n\r\n") + 4));
    });
    socket.once("close", () => reject(new Error(`tunnel closed before an answer: ${JSON.stringify(text)}`)));
  });
  established.catch(() => {});
  return { socket, established, closed };
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not happen within ${ms}ms`)), ms)),
  ]);
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("a switch closes every tunnel carried by the old upstream and sends new ones to the new upstream", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    const before = openTunnel(relay.port, "site.example:443");
    expect(await before.established).toBe("A");
    const generation = relay.generation;

    await relay.switchUpstream(via(b));

    expect(relay.generation).toBe(generation + 1);
    await within(before.closed, 1000, "old tunnel close");
    // Both ends of the old connection are gone, so nothing keeps talking through A.
    await within((async () => { while (a.sockets.size) await tick(10); })(), 1000, "old upstream socket close");

    const after = openTunnel(relay.port, "site.example:443");
    expect(await after.established).toBe("B");
    expect(a.targets).toEqual(["site.example:443"]);
    expect(b.targets).toEqual(["site.example:443"]);
    after.socket.destroy();
  } finally { relay.close(); a.close(); b.close(); }
});

test("connections that arrive during a switch are held, forwarded nowhere, then carried by the new upstream", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    let finishPrepare!: () => void;
    const switching = relay.switchUpstream(via(b), { prepare: () => new Promise<void>((resolve) => { finishPrepare = resolve; }) });
    await tick();
    const held = openTunnel(relay.port, "held.example:443");
    await tick(200);
    // While held, neither upstream saw the request.
    expect(a.targets).toEqual([]);
    expect(b.targets).toEqual([]);

    finishPrepare();
    await switching;
    expect(await within(held.established, 2000, "held tunnel")).toBe("B");
    expect(a.targets).toEqual([]);
    expect(b.targets).toEqual(["held.example:443"]);
    held.socket.destroy();
  } finally { relay.close(); a.close(); b.close(); }
});

test("a failed prepare leaves the old upstream in place, and held connections go back to it", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    const kept = openTunnel(relay.port, "kept.example:443");
    expect(await kept.established).toBe("A");
    const generation = relay.generation;

    let failPrepare!: (error: Error) => void;
    const switching = relay.switchUpstream(via(b), { prepare: () => new Promise<void>((_, reject) => { failPrepare = reject; }) });
    await tick();
    const held = openTunnel(relay.port, "held.example:443");
    await tick(100);
    failPrepare(new Error("new exit unreachable"));
    await expect(switching).rejects.toThrow("new exit unreachable");

    expect(relay.generation).toBe(generation);
    expect(await within(held.established, 2000, "held tunnel")).toBe("A");
    // A switch that did not happen must not cut the tunnels that were already running.
    expect(kept.socket.destroyed).toBe(false);
    expect(b.targets).toEqual([]);
    kept.socket.destroy();
    held.socket.destroy();
  } finally { relay.close(); a.close(); b.close(); }
});

test("a connection held longer than the hold limit is closed, never forwarded", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    let finishPrepare!: () => void;
    const switching = relay.switchUpstream(via(b), {
      holdMs: 150,
      prepare: () => new Promise<void>((resolve) => { finishPrepare = resolve; }),
    });
    await tick();
    const held = openTunnel(relay.port, "late.example:443");
    await within(held.closed, 2000, "held connection close");
    finishPrepare();
    await switching;
    expect(a.targets).toEqual([]);
    expect(b.targets).toEqual([]);
  } finally { relay.close(); a.close(); b.close(); }
});

test("a CONNECT still waiting for the old upstream's answer is cut by the switch", async () => {
  const a = await httpUpstream("A", true);
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    const pending = openTunnel(relay.port, "slow.example:443");
    await within((async () => { while (!a.targets.length) await tick(10); })(), 1000, "upstream A request");
    await relay.switchUpstream(via(b));
    await within(pending.closed, 1000, "pending tunnel close");
    await within((async () => { while (a.sockets.size) await tick(10); })(), 1000, "old upstream socket close");
  } finally { relay.close(); a.close(); b.close(); }
});

test("a SOCKS tunnel that the old upstream opens after the switch is destroyed, not handed to the browser", async () => {
  const a = await socksUpstream("A", 300);
  const b = await socksUpstream("B");
  const relay = await startProxyRelay(via(a, "socks5"));
  try {
    const pending = openTunnel(relay.port, "socks-slow.example:443");
    await within((async () => { while (!a.targets.length) await tick(10); })(), 1000, "upstream A request");
    await relay.switchUpstream(via(b, "socks5"));
    await within(pending.closed, 1000, "pending tunnel close");
    await tick(400); // A answers now; nothing may come of it
    const after = openTunnel(relay.port, "socks-slow.example:443");
    expect(await after.established).toBe("B");
    after.socket.destroy();
  } finally { relay.close(); a.close(); b.close(); }
});

test("invalid upstreams are refused before anything changes", async () => {
  const a = await httpUpstream("A");
  const relay = await startProxyRelay(via(a));
  try {
    const generation = relay.generation;
    for (const bad of [
      null,
      { type: "http", host: "", port: 8080, user: "", pass: "" },
      { type: "http", host: "127.0.0.1", port: 0, user: "", pass: "" },
      { type: "http", host: "127.0.0.1", port: 70000, user: "", pass: "" },
      { type: "direct", host: "127.0.0.1", port: 8080, user: "", pass: "" },
    ]) {
      await expect(relay.switchUpstream(bad as unknown as UpstreamProxy)).rejects.toThrow();
    }
    expect(relay.generation).toBe(generation);
    expect(await openTunnel(relay.port, "still.example:443").established).toBe("A");
  } finally { relay.close(); a.close(); }
});

test("only one switch runs at a time, and a closed relay refuses to switch", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    let finishPrepare!: () => void;
    const first = relay.switchUpstream(via(b), { prepare: () => new Promise<void>((resolve) => { finishPrepare = resolve; }) });
    await tick();
    await expect(relay.switchUpstream(via(a))).rejects.toThrow(/in progress/);
    finishPrepare();
    await first;
    relay.close();
    await expect(relay.switchUpstream(via(a))).rejects.toThrow(/closed/);
  } finally { relay.close(); a.close(); b.close(); }
});

test("closing the relay during a switch closes the held connections", async () => {
  const a = await httpUpstream("A");
  const b = await httpUpstream("B");
  const relay = await startProxyRelay(via(a));
  try {
    const switching = relay.switchUpstream(via(b), { prepare: () => new Promise<void>(() => {}) });
    switching.catch(() => {});
    await tick();
    const held = openTunnel(relay.port, "held.example:443");
    await tick(100);
    relay.close();
    await within(held.closed, 1000, "held connection close");
    expect(a.targets).toEqual([]);
    expect(b.targets).toEqual([]);
  } finally { relay.close(); a.close(); b.close(); }
});

test.each(["http", "socks5"] as const)("%s: the relay hands the upstream the name, before, during and after a switch", async (type) => {
  const make = type === "http" ? httpUpstream : socksUpstream;
  const a = await make("A");
  const b = await make("B");
  const relay = await startProxyRelay(via(a, type));
  const name = "leak-canary-relay.vela.test:443";
  try {
    expect(await openTunnel(relay.port, name).established).toBe("A");
    let finishPrepare!: () => void;
    const switching = relay.switchUpstream(via(b, type), { prepare: () => new Promise<void>((resolve) => { finishPrepare = resolve; }) });
    await tick();
    const held = openTunnel(relay.port, name);
    await tick(100);
    finishPrepare();
    await switching;
    expect(await held.established).toBe("B");
    expect(a.targets).toEqual([name]);
    expect(b.targets).toEqual([name]);
    held.socket.destroy();
  } finally { relay.close(); a.close(); b.close(); }
});

test("a request body that arrives while the upstream tunnel is still opening is delivered, not dropped", async () => {
  const a = await socksUpstream("A", 300);
  const relay = await startProxyRelay(via(a, "socks5"));
  const client = net.connect({ host: "127.0.0.1", port: relay.port });
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write("POST http://form.example/submit HTTP/1.1\r\nHost: form.example\r\nContent-Length: 11\r\n\r\n");
    await tick(100); // the relay is waiting for the SOCKS reply now
    client.write("hello=world");
    await within((async () => {
      while (!Buffer.concat(a.tunnelBytes).toString("latin1").includes("hello=world")) await tick(20);
    })(), 2000, "request body delivery");
    expect(Buffer.concat(a.tunnelBytes).toString("latin1")).toContain("POST /submit HTTP/1.1");
  } finally { client.destroy(); relay.close(); a.close(); }
});

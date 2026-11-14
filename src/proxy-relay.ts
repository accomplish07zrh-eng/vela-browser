/**
 * Local auth-injecting proxy relay.
 *
 * aliasmode launches the CloakBrowser binary as a raw process with `--proxy-server`, but Chromium
 * ignores credentials on that flag. The previous fix — a generated MV3 extension answering
 * `chrome.webRequest.onAuthRequired` — is unreliable: the service worker can't answer the proxy
 * challenge fast enough during a page-load burst, so some requests fail proxy auth
 * (ERR_INVALID_AUTH_CREDENTIALS) and a SPA like LinkedIn drops the session a few seconds after it
 * loads.
 *
 * Instead the browser points at this loopback HTTP relay with NO auth. For an HTTP upstream, the
 * relay injects `Proxy-Authorization` when credentials are configured. For SOCKS5, it performs RFC 1928/1929 itself and carries the
 * browser's HTTP/CONNECT traffic through that tunnel. The latter is important for packaged kernels
 * older than CloakBrowser 0.3.24, where inline SOCKS credentials are ignored by Chromium.
 */

import net from "node:net";
import tls from "node:tls";
import { openSocks5Tunnel } from "./geoip.ts";
import { upstreamDial } from "./egress-binding.ts";
import type { ProxySpec } from "./types.ts";

export interface UpstreamProxy {
  /** Omitted for backward-compatible HTTP relay callers. */
  type?: "http" | "https" | "socks5";
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface ProxyRelay {
  /** Loopback port the browser's `--proxy-server` points at. */
  port: number;
  /** Upstream generation. Starts at 1 and goes up by one with every completed switch. */
  readonly generation: number;
  /**
   * Send this relay's traffic to `next` from now on. The browser keeps its port.
   *
   * While `prepare` runs, connections that arrive are held: buffered, sent to no upstream. If
   * `prepare` throws, nothing changes and the held connections go to the current upstream. Once
   * it resolves, every connection of the current upstream is closed, both ends, including CONNECTs
   * still waiting for an answer, and only then does traffic go to `next`. A connection held longer
   * than `holdMs` (default 10 s) is closed. There is no state in which the relay sends anything
   * anywhere but an upstream proxy, and no state in which it resolves a destination itself.
   */
  switchUpstream(next: UpstreamProxy, opts?: SwitchOptions): Promise<void>;
  close(): void;
}

export interface SwitchOptions {
  /** Runs while new connections are held, before the old upstream's connections are cut. */
  prepare?: () => Promise<void>;
  holdMs?: number;
}

export interface RelayOptions {
  /** Bind to this exact loopback port (omitted/0 = ephemeral). Used to re-bind a survivor after a
   *  manager restart, since the running browser's `--proxy-server` still points at the old port. */
  port?: number;
  log?: (msg: string) => void;
}

const MAX_HEAD = 64 * 1024; // cap a request/response head so a never-terminating head can't grow unbounded
const DEFAULT_HOLD_MS = 10_000;
const UPSTREAM_TYPES = new Set(["http", "https", "socks5"]);

type TrackSocket = (socket: net.Socket) => net.Socket;

/**
 * One upstream and every socket that carries its traffic. A connection is bound to the generation
 * that was current when its request head arrived, and dies with it.
 */
interface Generation {
  id: number;
  up: UpstreamProxy;
  auth: string | null;
  log: (msg: string) => void;
  /** Registers a socket with this generation; a socket of a retired generation is destroyed at once. */
  track: TrackSocket;
  retired: boolean;
}

/** Validate before anything changes: a relay never runs without a real upstream proxy. */
function checkedUpstream(up: UpstreamProxy | null | undefined): UpstreamProxy {
  if (!up || typeof up !== "object") throw new Error("proxy relay needs an upstream proxy");
  const type = up.type ?? "http";
  if (!UPSTREAM_TYPES.has(type)) throw new Error(`unsupported relay upstream type: ${String(up.type)}`);
  if (typeof up.host !== "string" || !up.host.trim()) throw new Error("relay upstream host is empty");
  if (!Number.isInteger(up.port) || up.port < 1 || up.port > 65535) throw new Error("relay upstream port is invalid");
  return { type, host: up.host, port: up.port, user: String(up.user ?? ""), pass: String(up.pass ?? "") };
}

/** Start a loopback relay that forwards to `up`, injecting its credentials. Resolves once listening. */
export function startProxyRelay(up: UpstreamProxy, opts: RelayOptions = {}): Promise<ProxyRelay> {
  const log = opts.log ?? (() => {});
  // server.close() only stops accepting new clients; it deliberately waits for
  // existing sockets and does not destroy them. Track both sides of every relay
  // connection so closing a profile cannot leave a stalled CONNECT/upstream
  // socket keeping the Bun process and its buffers alive indefinitely.
  const sockets = new Set<net.Socket>();
  const trackAll: TrackSocket = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  let closed = false;
  const makeGeneration = (id: number, next: UpstreamProxy): Generation => {
    const own = new Set<net.Socket>();
    const generation: Generation = {
      id,
      up: next,
      auth: next.user ? "Basic " + Buffer.from(`${next.user}:${next.pass}`).toString("base64") : null,
      log,
      retired: false,
      track: (socket) => {
        trackAll(socket);
        if (generation.retired || closed) {
          socket.destroy();
          return socket;
        }
        own.add(socket);
        socket.once("close", () => own.delete(socket));
        return socket;
      },
    };
    retirers.set(generation, () => {
      generation.retired = true;
      for (const socket of own) socket.destroy();
      own.clear();
    });
    return generation;
  };
  const retirers = new Map<Generation, () => void>();
  const retire = (generation: Generation) => {
    retirers.get(generation)?.();
    retirers.delete(generation);
  };
  let current: Generation;
  try {
    current = makeGeneration(1, checkedUpstream(up));
  } catch (error) {
    return Promise.reject(error);
  }

  // Connections whose head arrived while a switch is preparing. They wait here, forwarded nowhere.
  let holding = false;
  let holdMs = DEFAULT_HOLD_MS;
  const held = new Set<() => void>();
  const releaseHeld = () => {
    holding = false;
    const waiting = [...held];
    held.clear();
    for (const dispatch of waiting) dispatch();
  };
  /** Dispatch now, or once the switch in progress has settled. */
  const whenOpen = (client: net.Socket, dispatch: () => void) => {
    if (!holding) { dispatch(); return; }
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (client.destroyed || closed) { client.destroy(); return; }
      dispatch();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      held.delete(run);
      log("proxy relay: a connection waited too long for a proxy switch; closed");
      client.destroy();
    }, holdMs);
    held.add(run);
    client.once("close", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      held.delete(run);
    });
  };

  let switching = false;
  const server = net.createServer((client) => handleClient(trackAll(client), () => current, whenOpen));
  server.on("error", (e) => log(`proxy relay server error: ${e.message}`));
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    server.once("error", onErr);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        get generation() { return current.id; },
        switchUpstream: async (nextUp, switchOpts = {}) => {
          if (closed) throw new Error("proxy relay is closed");
          if (switching) throw new Error("a proxy switch is already in progress");
          const next = checkedUpstream(nextUp);
          switching = true;
          holding = true;
          holdMs = switchOpts.holdMs ?? DEFAULT_HOLD_MS;
          try {
            try {
              await switchOpts.prepare?.();
            } catch (error) {
              // Nothing changed: the held connections go to the upstream they would have had.
              releaseHeld();
              throw error;
            }
            if (closed) throw new Error("proxy relay is closed");
            const old = current;
            const replacement = makeGeneration(old.id + 1, next);
            // Cut the old upstream's connections before any byte can reach the new one, so no
            // page ever has requests on both exits at once.
            retire(old);
            current = replacement;
            log(`proxy relay switched to upstream generation ${replacement.id}`);
            releaseHeld();
          } finally {
            switching = false;
            holding = false;
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          holding = false;
          held.clear();
          for (const generation of [...retirers.keys()]) retire(generation);
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}

function handleClient(
  client: net.Socket,
  currentGeneration: () => Generation,
  whenOpen: (client: net.Socket, dispatch: () => void) => void,
): void {
  client.on("error", () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const headEnd = buf.indexOf("\r\n\r\n");
    if (headEnd === -1) {
      if (buf.length > MAX_HEAD) client.destroy();
      return;
    }
    client.removeListener("data", onData);
    const head = buf.subarray(0, headEnd + 4).toString("latin1");
    let rest = buf.subarray(headEnd + 4); // bytes already past the head (a plain-HTTP body, usually empty)
    // Until the upstream is connected and piped, every byte the browser sends is kept here: while
    // the connection is held for a switch, and while the upstream connects. A flowing socket with
    // no listener would drop them (a POST body that arrives after its head, for instance).
    const keep = (more: Buffer) => { rest = Buffer.concat([rest, more]); };
    client.on("data", keep);
    const takeRest = () => {
      client.removeListener("data", keep);
      const kept = rest;
      rest = Buffer.alloc(0);
      return kept;
    };
    whenOpen(client, () => {
      const generation = currentGeneration();
      generation.track(client);
      if (client.destroyed) return;
      const firstLine = head.split("\r\n")[0] ?? "";
      if (/^CONNECT\s/i.test(firstLine)) connectTunnel(client, generation, firstLine, takeRest);
      else plainHttp(client, generation, head, takeRest);
    });
  };
  client.on("data", onData);
}

/** HTTPS: open the upstream tunnel with auth, then pipe raw bytes (TLS is opaque). */
function connectTunnel(
  client: net.Socket,
  generation: Generation,
  firstLine: string,
  takeRest: () => Buffer,
): void {
  const { up, auth, log, track } = generation;
  const target = firstLine.split(/\s+/)[1] ?? ""; // "host:port"
  if (up.type === "socks5") {
    void connectSocksTunnel(client, generation, target, takeRest);
    return;
  }
  const upSock = track(up.type === "https"
    ? tls.connect({ host: up.host, port: up.port, ...(net.isIP(up.host) ? {} : { servername: up.host }), ...upstreamDial(up.host) })
    : net.connect({ host: up.host, port: up.port, ...upstreamDial(up.host) }));
  upSock.on("error", (e) => { log(`upstream CONNECT error for ${target}: ${e.message}`); client.destroy(); });
  client.on("error", () => upSock.destroy());
  // In particular, cover a browser abandoning CONNECT before the upstream has
  // replied: the streams are not piped yet, so normal pipe end-propagation does
  // not exist and the upstream socket otherwise survives the client.
  client.once("close", () => upSock.destroy());
  upSock.once(up.type === "https" ? "secureConnect" : "connect", () => {
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
      "",
      "",
    ];
    upSock.write(headers.join("\r\n"));
  });
  let rbuf = Buffer.alloc(0);
  const onUpData = (chunk: Buffer) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    const end = rbuf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (rbuf.length > MAX_HEAD) { client.destroy(); upSock.destroy(); }
      return;
    }
    upSock.removeListener("data", onUpData);
    const status = (rbuf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "");
    if (!/\s2\d\d\s/.test(status)) { // not 2xx (e.g. 407) → auth/connect failed
      log(`upstream refused CONNECT ${target}: ${status}`);
      client.destroy();
      upSock.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const extra = rbuf.subarray(end + 4); // any tunnel bytes that arrived with the response
    if (extra.length) client.write(extra);
    const rest = takeRest();
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  };
  upSock.on("data", onUpData);
  upSock.on("close", () => client.destroy());
}

function parseAuthority(raw: string, defaultPort: number): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    throw new Error("invalid proxy target authority");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password) {
    throw new Error("invalid proxy target authority");
  }
  return { host, port };
}

function socksSpec(up: UpstreamProxy): ProxySpec {
  return {
    type: "socks5",
    host: up.host,
    port: String(up.port),
    user: up.user,
    pass: up.pass,
  };
}

async function connectSocksTunnel(
  client: net.Socket,
  generation: Generation,
  target: string,
  takeRest: () => Buffer,
): Promise<void> {
  const { up, log, track } = generation;
  let upSock: net.Socket | undefined;
  try {
    const destination = parseAuthority(target, 443);
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    upSock = await openSocks5Tunnel(
      socksSpec(up),
      destination.host,
      destination.port,
      10_000,
      (socket) => { upSock = track(socket); },
    );
    // The tunnel may finish opening after a switch retired its upstream: it is never used.
    if (client.destroyed || generation.retired) {
      upSock.destroy();
      client.destroy();
      return;
    }
    upSock.on("error", (error) => {
      log(`SOCKS5 tunnel error for ${target}: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const rest = takeRest();
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 CONNECT failed for ${target}: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}

function isUpgrade(lines: string[]): boolean {
  return lines.some(line => /^upgrade\s*:\s*\S/i.test(line))
    && lines.some(line => /^connection\s*:/i.test(line) && line.slice(line.indexOf(":") + 1).split(",").some(token => token.trim().toLowerCase() === "upgrade"));
}

/** After an upgrade request, waits for the answer. 101 turns the connection into a duplex tunnel.
 *  Anything else is the only response this connection carries: it goes back marked
 *  Connection: close and later bytes from the browser are dropped, so the browser can never
 *  reuse a connection that is still bound to the first request's destination. */
function bridgeUpgrade(client: net.Socket, upSock: net.Socket): void {
  client.pause();
  let buffered = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buffered.length > MAX_HEAD) { upSock.destroy(); client.destroy(); }
      return;
    }
    upSock.removeListener("data", onData);
    upSock.pause();
    const [status = "", ...headers] = buffered.subarray(0, end).toString("latin1").split("\r\n");
    const body = buffered.subarray(end + 4);
    if (/^HTTP\/\d(?:\.\d)?\s+101(?:\s|$)/i.test(status)) {
      client.write(buffered);
      upSock.pipe(client);
      client.pipe(upSock);
      return;
    }
    const kept = headers.filter((line) => line !== "" && !/^(connection|keep-alive|proxy-connection)\s*:/i.test(line));
    client.write([status, ...kept, "Connection: close", "Proxy-Connection: close", "", ""].join("\r\n"));
    if (body.length) client.write(body);
    upSock.pipe(client);
    client.on("data", () => {});
    client.resume();
  };
  upSock.on("data", onData);
  // The SOCKS handshake leaves its socket paused; a data listener alone would not resume it.
  upSock.resume();
}

/** Plain HTTP reinjects auth per request. An HTTP upgrade keeps its duplex tunnel,
 *  so proxied WebSocket traffic uses the same upstream instead of losing its handshake. */
function plainHttp(
  client: net.Socket,
  generation: Generation,
  head: string,
  takeRest: () => Buffer,
): void {
  const { up, auth, log, track } = generation;
  if (up.type === "socks5") {
    void plainHttpViaSocks(client, generation, head, takeRest);
    return;
  }
  const lines = head.split("\r\n");
  const upgrading = isUpgrade(lines);
  const reqLine = lines[0] ?? "";
  const headers = lines
    .slice(1)
    .filter((l) => l !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(l));
  const rebuilt = [
    reqLine,
    ...headers,
    ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
    upgrading ? "Connection: Upgrade" : "Connection: close",
    ...(upgrading ? [] : ["Proxy-Connection: close"]),
    "",
    "",
  ].join("\r\n");

  const upSock = track(up.type === "https"
    ? tls.connect({ host: up.host, port: up.port, ...(net.isIP(up.host) ? {} : { servername: up.host }), ...upstreamDial(up.host) })
    : net.connect({ host: up.host, port: up.port, ...upstreamDial(up.host) }));
  upSock.on("error", (e) => { log(`upstream HTTP error: ${e.message}`); client.destroy(); });
  client.on("error", () => upSock.destroy());
  client.once("close", () => upSock.destroy());
  upSock.once(up.type === "https" ? "secureConnect" : "connect", () => {
    upSock.write(rebuilt);
    const rest = takeRest();
    if (rest.length) upSock.write(rest);
    if (upgrading) { bridgeUpgrade(client, upSock); return; }
    upSock.pipe(client);
    client.pipe(upSock);
  });
  upSock.on("close", () => client.destroy());
}

async function plainHttpViaSocks(
  client: net.Socket,
  generation: Generation,
  head: string,
  takeRest: () => Buffer,
): Promise<void> {
  const { up, log, track } = generation;
  let upSock: net.Socket | undefined;
  try {
    const lines = head.split("\r\n");
    const upgrading = isUpgrade(lines);
    const match = (lines[0] ?? "").match(/^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/i);
    if (!match) throw new Error("invalid HTTP proxy request line");
    const [, method, requestTarget, version] = match;
    const hostHeader = lines.slice(1).find((line) => /^host\s*:/i.test(line))?.replace(/^host\s*:\s*/i, "") ?? "";
    let destination: { host: string; port: number };
    let originTarget = requestTarget!;
    if (/^(?:http|ws):\/\//i.test(requestTarget!)) {
      const url = new URL(requestTarget!);
      destination = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
      originTarget = `${url.pathname || "/"}${url.search}`;
    } else {
      destination = parseAuthority(hostHeader, 80);
    }
    const headers = lines
      .slice(1)
      .filter((line) => line !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(line));
    const rebuilt = [
      `${method} ${originTarget} ${version}`,
      ...headers,
      upgrading ? "Connection: Upgrade" : "Connection: close",
      "",
      "",
    ].join("\r\n");
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    upSock = await openSocks5Tunnel(
      socksSpec(up),
      destination.host,
      destination.port,
      10_000,
      (socket) => { upSock = track(socket); },
    );
    // The tunnel may finish opening after a switch retired its upstream: it is never used.
    if (client.destroyed || generation.retired) {
      upSock.destroy();
      client.destroy();
      return;
    }
    upSock.on("error", (error) => {
      log(`SOCKS5 HTTP tunnel error: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    upSock.write(rebuilt);
    const rest = takeRest();
    if (rest.length) upSock.write(rest);
    if (upgrading) { bridgeUpgrade(client, upSock); return; }
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 HTTP request failed: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}

import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BLOCK = 64 * 1024;

function writeAll(fd, buffer, offset) {
  for (let sent = 0; sent < buffer.length;) {
    const count = writeSync(fd, buffer, sent, buffer.length - sent, offset + sent);
    if (!count) throw new Error("Capture file stopped accepting bytes");
    sent += count;
  }
}

// Metadata cursors are file offsets, so even a busy capture needs no growing in-memory index.
export class DevtoolsJournal {
  constructor(settings) {
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.settings = settings;
    this.directory = mkdtempSync(join(tmpdir(), "vela-devtools-"));
    try {
      this.records = openSync(join(this.directory, "events"), "wx+", 0o600);
      this.payloads = openSync(join(this.directory, "payloads"), "wx+", 0o600);
    } catch (error) { this.dispose(); throw error; }
    this.cursor = 0;
    this.size = 0;
    this.dropped = 0;
    this.waiters = new Set();
    this.live = true;
    this.native = new Map();
    this.fetches = new Map();
  }

  accepts(entry) {
    return (!this.settings.pageId || entry.pageId === this.settings.pageId)
      && (!this.settings.urlIncludes || !entry.url || entry.url.includes(this.settings.urlIncludes));
  }

  append(entry, payload) {
    if (!this.live || !this.accepts(entry)) return;
    try {
      if (payload !== undefined) {
        writeAll(this.payloads, payload, this.size);
        if (entry.kind === "websocket-sent" || entry.kind === "websocket-received") {
          const { text, base64, ...metadata } = entry;
          entry = metadata;
        }
        entry = { ...entry, payload: { offset: this.size, totalBytes: payload.length } };
        this.size += payload.length;
      }
      const buffer = Buffer.from(JSON.stringify({ ...entry, capturedAt: new Date().toISOString() }) + "\n");
      writeAll(this.records, buffer, this.cursor);
      this.cursor += buffer.length;
    } catch (error) {
      this.dropped++;
      this.error = error.message;
      this.stop();
    }
    for (const wake of this.waiters) wake();
  }

  async read(since, limit, waitMs) {
    if (since > this.cursor) throw new Error("Unknown capture cursor");
    if (since && since !== this.cursor) {
      const previous = Buffer.alloc(1);
      readSync(this.records, previous, 0, 1, since - 1);
      if (previous[0] !== 10) throw new Error("Use a nextCursor returned by this capture");
    }
    if (this.live && since === this.cursor && waitMs) await new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, waitMs);
      this.waiters.add(wake);
    });
    if (this.disposed) throw new Error("Capture was discarded");
    let position = since;
    let pending = Buffer.alloc(0);
    const records = [];
    const buffer = Buffer.alloc(BLOCK);
    while (position < this.cursor && records.length < limit) {
      const length = readSync(this.records, buffer, 0, Math.min(BLOCK, this.cursor - position), position);
      if (!length) break;
      const available = buffer.subarray(0, length);
      let start = 0;
      while (records.length < limit) {
        const end = available.indexOf(10, start);
        if (end < 0) break;
        records.push(JSON.parse(Buffer.concat([pending, available.subarray(start, end)]).toString("utf8")));
        pending = Buffer.alloc(0);
        start = end + 1;
      }
      if (records.length === limit) { position += start; break; }
      pending = Buffer.concat([pending, available.subarray(start)]);
      position += length;
    }
    return { ...this.info(), records, nextCursor: position, hasMore: position < this.cursor };
  }

  bytes(offset, length) {
    if (offset > this.size || offset + length > this.size) throw new Error("Only captured payload bytes can be read");
    const result = Buffer.alloc(length);
    for (let received = 0; received < length;) {
      const count = readSync(this.payloads, result, received, length - received, offset + received);
      if (!count) throw new Error("Capture ended before its expected bytes");
      received += count;
    }
    return result;
  }

  info() {
    return { captureId: this.id, startedAt: this.startedAt, active: this.live, capturedBytes: this.size,
      nativeTargets: this.native.size, dropped: this.dropped, ...(this.error ? { error: this.error } : {}) };
  }

  stop() {
    if (!this.live) return;
    this.live = false;
    for (const pending of this.native.values()) void pending.then(session => session?.detach()).catch(() => {});
    this.native.clear();
    for (const abort of this.fetches.values()) void abort();
    this.fetches.clear();
    for (const wake of this.waiters) wake();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.records !== undefined) closeSync(this.records);
    if (this.payloads !== undefined) closeSync(this.payloads);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export async function captureNativeNetwork(context, target, capture, scope) {
  const session = await context.newCDPSession(target);
  if (!capture.live) { await session.detach(); return; }
  const requests = new Map();
  const sockets = new Map();
  const sessionId = randomUUID();
  let counter = 0;
  const record = (kind, data, bytes) => capture.append({ ...scope, kind, transport: "cdp", ...data }, bytes);
  const bytes = value => value ? Buffer.from(value, "base64") : undefined;
  const data = (item, value) => {
    const chunk = bytes(value);
    if (chunk?.length) record("http-data", item, chunk);
  };
  session.on("Network.requestWillBeSent", event => {
    const previous = requests.get(event.requestId);
    if (previous && event.redirectResponse) record("http-redirect", { ...previous.identity, status: event.redirectResponse.status, headers: event.redirectResponse.headers });
    const identity = { requestId: `${sessionId}:${++counter}`, nativeRequestId: event.requestId,
      method: event.request.method, url: event.request.url, nativeFrameId: event.frameId, redirectedFrom: previous?.identity.requestId };
    if (!capture.accepts({ ...scope, ...identity })) { requests.delete(event.requestId); return; }
    requests.set(event.requestId, { identity });
    record("http-request", { ...identity, headers: event.request.headers, initiator: event.initiator });
  });
  session.on("Network.responseReceived", event => {
    let item = requests.get(event.requestId);
    if (!item) {
      const identity = { requestId: `${sessionId}:${++counter}`, nativeRequestId: event.requestId, nativeFrameId: event.frameId, url: event.response.url };
      if (!capture.accepts({ ...scope, ...identity })) return;
      item = { identity }; requests.set(event.requestId, item);
    }
    const { identity } = item;
    record("http-response", { ...identity, status: event.response.status, mimeType: event.response.mimeType,
      headers: event.response.headers, resourceType: event.type, protocol: event.response.protocol });
    item.pending = [];
    void session.send("Network.streamResourceContent", { requestId: event.requestId }).then(({ bufferedData }) => {
      data(identity, bufferedData);
      for (const value of item.pending) data(identity, value);
    }, error => record("http-stream-unavailable", { ...identity, error: error.message })).finally(() => {
      item.pending = undefined;
      if (item.end) record(item.end.kind, { ...identity, ...item.end.attributes });
    });
  });
  session.on("Network.dataReceived", event => {
    const item = requests.get(event.requestId);
    if (!item || !event.data) return;
    if (item.pending) item.pending.push(event.data);
    else data(item.identity, event.data);
  });
  for (const [event, kind] of [["Network.loadingFinished", "http-finished"], ["Network.loadingFailed", "http-failed"]]) {
    session.on(event, value => {
      const item = requests.get(value.requestId);
      if (!item) return;
      requests.delete(value.requestId);
      const attributes = { encodedDataLength: value.encodedDataLength, error: value.errorText, canceled: value.canceled };
      if (item.pending) item.end = { kind, attributes };
      else record(kind, { ...item.identity, ...attributes });
    });
  }
  session.on("Network.eventSourceMessageReceived", event => {
    const item = requests.get(event.requestId);
    if (item) record("sse-message", { ...item.identity, eventName: event.eventName, eventId: event.eventId }, Buffer.from(event.data, "utf8"));
  });
  session.on("Network.webSocketCreated", event => sockets.set(event.requestId, event.url));
  session.on("Network.webSocketClosed", event => sockets.delete(event.requestId));
  for (const [event, kind] of [["Network.webSocketFrameSent", "ws-protocol-sent"], ["Network.webSocketFrameReceived", "ws-protocol-received"]]) {
    session.on(event, ({ requestId, response }) => {
      const { opcode, mask, payloadData } = response;
      record(kind, { socketId: `${sessionId}:${requestId}`, url: sockets.get(requestId), opcode, mask },
        Buffer.from(payloadData, opcode === 1 ? "utf8" : "base64"));
    });
  }
  try { await session.send("Network.enable"); }
  catch (error) { await session.detach().catch(() => {}); throw error; }
  if (!capture.live) { await session.detach(); return; }
  return session;
}

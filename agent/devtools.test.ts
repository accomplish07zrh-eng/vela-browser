import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrowserDevtools, DEVTOOLS_TOOLS } from "./devtools.mjs";

class Frame {
  constructor(readonly owner: Page, readonly address = "https://fixture.test/") {}
  page() { return this.owner; }
  url() { return this.address; }
  name() { return ""; }
  parentFrame(): Frame | null { return null; }
  isDetached() { return false; }
  async evaluate(expression: string | Function, argument: unknown) {
    return typeof expression === "function" ? await expression(argument) : (0, eval)(expression);
  }
}
class Page extends EventEmitter {
  frame = new Frame(this);
  closed = false;
  url() { return this.frame.url(); }
  async title() { return "Fixture"; }
  frames() { return [this.frame]; }
  mainFrame() { return this.frame; }
  workers() { return []; }
  isClosed() { return this.closed; }
}
class Context extends EventEmitter {
  page = new Page();
  cookieJar: any[] = [];
  closes = 0;
  cdpConnections = 0;
  cdpCalls: any[] = [];
  cdpDetaches = 0;
  pages() { return [this.page]; }
  serviceWorkers() { return []; }
  async cookies(urls?: string[]) {
    if (!urls) return this.cookieJar;
    const hosts = urls.map(url => new URL(url).hostname);
    return this.cookieJar.filter(cookie => hosts.some(host => host === cookie.domain.replace(/^\./, "") || host.endsWith(cookie.domain)));
  }
  async addCookies(cookies: any[]) { this.cookieJar.push(...cookies); }
  async clearCookies(filter?: any) {
    this.cookieJar = filter ? this.cookieJar.filter(cookie => !Object.entries(filter).every(([k, v]) => cookie[k] === v)) : [];
  }
  async newCDPSession(page: Page) {
    expect(page).toBe(this.page);
    this.cdpConnections++;
    await Promise.resolve();
    return { send: async (method: string, params: any) => { this.cdpCalls.push({ method, params }); return { done: true }; },
      detach: async () => { this.cdpDetaches++; } };
  }
  async close() { this.closes++; }
}
function setup(options = {}) {
  const context = new Context();
  const observer = new BrowserDevtools(context as any, options);
  const call = async (name: string, args: any = {}) => (await observer.call(`browser_devtools_${name}`, args)).structuredContent as any;
  return { context, observer, call };
}
function consoleMessage(type: string, text: string, page: Page) {
  return { type: () => type, text: () => text, page: () => page, location: () => ({ url: page.url(), lineNumber: 7, columnNumber: 2 }),
    args: () => { throw new Error("Observation must not evaluate console argument getters"); } };
}
function requestFixture(context: Context, bytes = Buffer.from([0, 255, 1, 128, 10]), status = 200) {
  let bodyReads = 0;
  const req: any = { frame: () => context.page.frame, url: () => "https://fixture.test/data", method: () => "POST",
    resourceType: () => "fetch", headers: () => ({ "content-type": "application/octet-stream" }),
    allHeaders: async () => req.headers(), headersArray: async () => [{ name: "Content-Type", value: "application/octet-stream" }],
    redirectedFrom: () => null, postDataBuffer: () => bytes, timing: () => ({ startTime: 1, responseEnd: 10 }),
    sizes: async () => ({ responseBodySize: bytes.length }), failure: () => null };
  const response: any = { request: () => req, status: () => status, statusText: () => "OK",
    headers: () => ({ "content-type": "application/octet-stream" }), allHeaders: async () => response.headers(),
    headersArray: async () => [{ name: "Set-Cookie", value: "a=1" }, { name: "Set-Cookie", value: "b=2" }],
    fromServiceWorker: () => false, serverAddr: async () => null, securityDetails: async () => null,
    body: async () => { bodyReads++; return bytes; } };
  return { req, response, bodyReads: () => bodyReads };
}

test("developer observation leaves browser configuration, page execution and modal handling alone", async () => {
  const context = new Context();
  for (const method of ["addInitScript", "route", "setExtraHTTPHeaders", "grantPermissions", "setDefaultTimeout", "clearCookies"]) {
    (context as any)[method] = () => { throw new Error(`Observer changed ${method}`); };
  }
  context.page.frame.evaluate = async () => { throw new Error("Observer executed page code"); };
  const observer = new BrowserDevtools(context as any);
  expect(context.page.listenerCount("dialog")).toBe(0);
  await observer.call("browser_devtools_summary");
  observer.dispose();
  expect(context.eventNames()).toEqual([]);
  expect(context.page.eventNames()).toEqual([]);
  expect(context.closes).toBe(0);
});

test("HAR keeps redirect hops and timing without reading or exporting private request data", async () => {
  const { context, observer, call } = setup({ engine: "firefox" });
  try {
    const first = requestFixture(context, Buffer.from("private-body"), 302), second = requestFixture(context, Buffer.from("private-reply"), 503);
    first.req.url = () => "https://private-user:private-pass@private-host.test/private-path?auth=private-query#private-fragment";
    first.req.headers = () => ({ "authorization": "private-auth", "cookie": "private-cookie" });
    first.response.headers = () => ({ "Set-Cookie": "private-set-cookie", location: "https://private-other.test/private-dest" });
    second.req.url = () => "https://private-other.test/private-dest";
    second.req.redirectedFrom = () => first.req;
    second.req.timing = () => ({ startTime: 1_700_000_000_000, domainLookupStart: 1, domainLookupEnd: 2,
      connectStart: 2, secureConnectionStart: 3, connectEnd: 5, requestStart: 5, responseStart: 7, responseEnd: 10 });
    for (const hop of [first, second]) {
      context.emit("request", hop.req); context.emit("response", hop.response); context.emit("requestfinished", hop.req);
    }
    const { har, hasMore } = await call("har");
    const [entry, redirected] = har.log.entries;
    expect(har.log.version).toBe("1.2");
    expect(hasMore).toBe(false);
    expect(entry.response.redirectURL).toBe(redirected.request.url);
    expect(redirected._vela.redirectedFrom).toBe(entry._vela.hop);
    expect(redirected.response.status).toBe(503);
    expect(redirected.time).toBe(10);
    expect(redirected.timings.ssl).toBe(2);
    expect(JSON.stringify(har)).not.toContain("private-");
    expect(first.bodyReads() + second.bodyReads()).toBe(0);
    const firstPage = await call("har", { limit: 1 });
    expect(firstPage.hasMore).toBe(true);
    const more = await call("har", { since: firstPage.nextCursor });
    expect(more.har.log.entries).toHaveLength(1);
  } finally { observer.dispose(); }
});

test("disk capture wakes a waiting reader and returns exact oversized socket payloads across cursor pages", async () => {
  const { observer, context, call } = setup();
  try {
    const { captureId } = await call("stream", { action: "start" });
    const waiting = call("stream", { action: "read", captureId, limit: 1, waitMs: 1000 });
    const socket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/live" });
    const bytes = Buffer.alloc(180_007, 173);
    context.page.emit("websocket", socket);
    socket.emit("framereceived", { payload: bytes });
    const opened = await waiting;
    expect(opened.records[0].kind).toBe("websocket-open");
    expect(opened.hasMore).toBe(true);
    const frame = await call("stream", { action: "read", captureId, since: opened.nextCursor });
    expect(frame.records[0].payload.totalBytes).toBe(bytes.length);
    const roundTrip = await call("stream", { action: "bytes", captureId, offset: frame.records[0].payload.offset, bytes: bytes.length });
    expect(Buffer.from(roundTrip.base64, "base64")).toEqual(bytes);
    const afterStop = call("stream", { action: "read", captureId, since: frame.nextCursor, waitMs: 1000 });
    await call("stream", { action: "stop", captureId });
    expect((await afterStop).active).toBe(false);
  } finally { observer.dispose(); }
});

test("Chromium capture orders the buffered prefix before live chunks and keeps SSE messages readable before completion", async () => {
  const { observer, context, call } = setup({ engine: "chromium" });
  const prefix = Promise.withResolvers<{ bufferedData: string }>();
  const session = Object.assign(new EventEmitter(), {
    async send(method: string) { return method === "Network.streamResourceContent" ? await prefix.promise : {}; }, async detach() {},
  });
  (context as any).newCDPSession = async () => session;
  try {
    const { captureId } = await call("stream", { action: "start" });
    const requestId = "native-stream", url = "https://fixture.test/live";
    session.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET", headers: {} } });
    session.emit("Network.responseReceived", { requestId, response: { url, status: 200, mimeType: "text/event-stream" } });
    session.emit("Network.dataReceived", { requestId, data: Buffer.from("tail").toString("base64") });
    session.emit("Network.eventSourceMessageReceived", { requestId, eventName: "draft", eventId: "42", data: "value" });
    prefix.resolve({ bufferedData: Buffer.from("prefix-").toString("base64") });
    await Bun.sleep(0);
    const { records } = await call("stream", { action: "read", captureId });
    expect(records.some((item: any) => item.kind === "http-finished")).toBe(false);
    expect(records.find((item: any) => item.kind === "sse-message").eventId).toBe("42");
    const buffers = await Promise.all(records.filter((item: any) => item.kind === "http-data").map(async (item: any) =>
      Buffer.from((await call("stream", { action: "bytes", captureId, offset: item.payload.offset, bytes: item.payload.totalBytes })).base64, "base64")));
    expect(Buffer.concat(buffers).toString()).toBe("prefix-tail");
  } finally { observer.dispose(); }
});

test("fresh response evidence is attached before clicking and ignores an earlier in-flight request", async () => {
  const { observer, context, call } = setup();
  const old = requestFixture(context), next = requestFixture(context);
  context.emit("request", old.req);
  (context.page.frame as any).getByRole = () => ({ count: async () => 1,
    click: async () => {
      context.emit("response", old.response);
      context.emit("request", next.req);
      context.emit("response", next.response);
    } });
  try {
    const clicked = await call("action", { action: "click", target: { role: "button", name: "Apply" }, verify: { response: { urlIncludes: "/data", method: "POST" } } });
    const records = clicked.evidence.records.filter((record: any) => record.kind === "request-response");
    expect(records).toHaveLength(2);
    expect(clicked.verification.match.requestId).toBe(records[1].requestId);
  } finally { observer.dispose(); }
});

test("developer JSON keeps shared locator scopes while marking actual cycles", async () => {
  const { observer, call } = setup();
  try {
    const output = await call("program", { code: `async () => {
      const within = { role: "form", name: "Draft" };
      const value = { candidates: [{ selector: "#old", within }, { text: "Save", within }] };
      value.self = value;
      return value;
    }` });
    expect(output.value.candidates[1].within).toEqual({ role: "form", name: "Draft" });
    expect(output.value.self).toEqual({ circularReference: "$.value" });
  } finally { observer.dispose(); }
});

test("a durable program binds the exact nested frame after CDP discovers it", async () => {
  const { context, observer } = setup();
  const frame = new Frame(context.page, "https://embedded.test/deep");
  frame.parentFrame = () => context.page.frame;
  const frames = [context.page.frame];
  context.page.frames = () => [...frames];
  const arriving = setTimeout(() => frames.push(frame), 15);
  try {
    const captured = await observer.runTaskProgram({ code: "async ({ frame }) => frame.url()", argument: null, screenshots: false,
      pageUrl: context.page.url(), frameUrl: frame.url(), timeoutMs: 1500 });
    expect(captured).toMatchObject({ completed: true, invoked: true, value: frame.url() });
  } finally { clearTimeout(arriving); observer.dispose(); }
});

test("console captures every severity and exception stack once; cursors do not consume history", async () => {
  const { context, observer, call } = setup();
  for (const type of ["debug", "log", "info", "warning", "error", "trace", "assert", "startGroup"]) {
    const message = consoleMessage(type, `fixture-${type}`, context.page);
    context.page.emit("console", message); context.emit("console", message);
  }
  const error = new Error("uncaught-fixture"); context.page.emit("pageerror", error);
  const first = await call("console", { limit: 3 });
  expect(first.records.map((r: any) => r.type)).toEqual(["debug", "log", "info"]);
  expect(first.hasMore).toBe(true);
  expect(await call("console", { limit: 3 })).toEqual(first);
  const rest = await call("console", { since: first.nextCursor });
  expect(rest.records).toHaveLength(6);
  expect(rest.records.at(-1).stack).toContain("uncaught-fixture");
  expect((await call("console", { level: "error" })).records).toHaveLength(3);
  expect((await call("console", { text: "fixture-debug" })).records).toHaveLength(1);
  observer.dispose();
});

test("history evictions and oversized websocket payloads are explicit and bounded", async () => {
  const { context, observer, call } = setup({ maxEvents: 3, maxRequests: 2 });
  const socket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/socket" });
  context.page.emit("websocket", socket);
  socket.emit("framereceived", { payload: Buffer.alloc(100_000, 17) });
  const ws = (await call("events", { kind: "websocket-received" })).records[0];
  expect(ws.binary).toBe(true);
  expect(ws.totalBytes).toBe(100_000);
  expect(ws.returnedBytes).toBe(65536);
  expect(ws.truncated).toBe(true);
  expect(Buffer.from(ws.base64, "base64")).toEqual(Buffer.alloc(65536, 17));
  for (let i = 0; i < 5; i++) context.page.emit("console", consoleMessage("log", String(i), context.page));
  expect((await call("console")).records.map((r: any) => r.text)).toEqual(["2", "3", "4"]);
  expect((await call("console")).dropped).toBe(5);
  const old = requestFixture(context); context.emit("request", old.req);
  for (let i = 0; i < 3; i++) context.emit("request", requestFixture(context).req);
  // A late response to an evicted request must not recreate it or raise an unhandled error.
  context.emit("response", old.response); context.emit("requestfinished", old.req);
  expect((await call("network")).retained).toBe(2);
  expect((await call("network")).dropped).toBe(2);
  context.page.closed = true; context.page.emit("close");
  expect(socket.eventNames()).toEqual([]);
  observer.dispose();
});

test("request status changes advance cursors; binary bodies and repeated headers retain exact bytes", async () => {
  const { context, observer, call } = setup();
  const fixture = requestFixture(context);
  context.emit("request", fixture.req);
  const pending = await call("network");
  const id = pending.records[0].requestId;
  expect(pending.records[0].state).toBe("pending");
  context.emit("response", fixture.response);
  const streaming = await call("request", { requestId: id, responseBody: true });
  expect(streaming.responseBody.available).toBe(false);
  expect(fixture.bodyReads()).toBe(0);
  context.emit("requestfinished", fixture.req);
  const finished = await call("network", { since: pending.nextCursor });
  expect(finished.records[0]).toMatchObject({ requestId: id, state: "finished", status: 200 });
  const parts: Buffer[] = [];
  let offset = 0;
  do {
    const detail = await call("request", { requestId: id, responseBody: true, offset, bytes: 2 });
    expect(detail.responseHeadersArray).toHaveLength(2);
    parts.push(Buffer.from(detail.responseBody.base64, "base64"));
    offset = detail.responseBody.nextOffset;
    if (!detail.responseBody.hasMore) break;
  } while (offset < 20);
  expect(Buffer.concat(parts)).toEqual(fixture.req.postDataBuffer());
  observer.dispose();
});

test("requests without a page are captured, including failed worker requests", async () => {
  const { context, observer, call } = setup();
  const fixture = requestFixture(context, Buffer.from("missing"), 404);
  fixture.req.frame = () => { throw new Error("service worker has no frame"); };
  fixture.req.failure = () => ({ errorText: "net::ERR_CONNECTION_REFUSED" });
  context.emit("request", fixture.req); context.emit("requestfailed", fixture.req);
  const failed = (await call("network", { failedOnly: true })).records;
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ state: "failed", failure: "net::ERR_CONNECTION_REFUSED" });
  expect(failed[0].pageId).toBeUndefined();
  observer.dispose();
});

test("live response inspection never waits for engine metadata that resolves at end of stream", async () => {
  const { context, observer, call } = setup();
  const fixture = requestFixture(context);
  for (const target of [fixture.req, fixture.response]) {
    target.allHeaders = target.headersArray = target.serverAddr = target.securityDetails = target.sizes = () => { throw new Error("Metadata is not complete until the stream finishes"); };
  }
  try {
    context.emit("request", fixture.req); context.emit("response", fixture.response);
    const id = (await call("network")).records[0].requestId;
    const detail = await call("request", { requestId: id, responseBody: true });
    expect(detail.headerDetailsPending).toBe(true);
    expect(detail.responseBody.available).toBe(false);
    expect(detail.serverAddress).toBeNull();
    expect(fixture.bodyReads()).toBe(0);
  } finally { observer.dispose(); }
});

test("profile ids cannot target another context's page, frame, request or worker", async () => {
  const a = setup(), b = setup();
  try {
    const worker = Object.assign(new EventEmitter(), { url: () => "https://fixture.test/worker.js", evaluate: async () => "worker" });
    a.context.page.emit("worker", worker);
    a.context.emit("request", requestFixture(a.context).req);
    const listing = await a.call("pages");
    const pageId = listing.pages[0].pageId, frameId = listing.pages[0].frames[0].frameId, workerId = listing.workers[0].workerId;
    const requestId = (await a.call("network")).records[0].requestId;
    for (const args of [{ pageId }, { frameId }, { workerId }]) {
      await expect(b.call("evaluate", { ...args, expression: "() => 1" })).rejects.toThrow(/profile/);
    }
    await expect(b.call("request", { requestId })).rejects.toThrow(/profile/);
    expect((await b.call("console")).records).toEqual([]);
    await a.call("storage_edit", { storage: "cookies", action: "set", cookies: [{ name: "a", value: "private", domain: "fixture.test", path: "/" }] });
    expect(b.context.cookieJar).toEqual([]);
    expect((await a.call("evaluate", { workerId, expression: "() => 1" })).value).toBe("worker");
  } finally { a.observer.dispose(); b.observer.dispose(); }
});

test("arbitrary JavaScript and native protocol changes work by default without an enable step", async () => {
  const { context, observer, call } = setup();
  try {
    expect((await call("evaluate", { expression: "({ value }) => ({ changed: value + 1, bigint: 123n })", argument: { value: 41 } })).value)
      .toEqual({ changed: 42, bigint: { type: "bigint", value: "123" } });
    await Promise.all([call("protocol", { method: "DOM.setAttributeValue", params: { nodeId: 1, name: "title", value: "changed" } }),
      call("protocol", { method: "Runtime.evaluate", params: { expression: "document.title = 'changed'" } })]);
    expect(context.cdpConnections).toBe(1);
    expect(context.cdpCalls.map(c => c.method)).toEqual(["DOM.setAttributeValue", "Runtime.evaluate"]);
    const names = new Set(DEVTOOLS_TOOLS.map(tool => tool.name));
    expect(names.size).toBe(DEVTOOLS_TOOLS.length);
    expect(names.has("browser_devtools_fetch")).toBe(true);
    expect(names.has("browser_devtools_storage_edit")).toBe(true);
    expect(names.has("browser_devtools_page_inspect")).toBe(true);
    expect(names.has("browser_devtools_action")).toBe(true);
  } finally { observer.dispose(); }
  await Promise.resolve(); await Promise.resolve();
  expect(context.cdpDetaches).toBe(1);
  expect(context.closes).toBe(0);
});

test("developer source is compiled for the browser without executing it in the MCP host", async () => {
  const { context, observer, call } = setup();
  const marker = `__vela_developer_host_${Date.now()}`;
  let browserFunction: any;
  context.page.frame.evaluate = async (fn: any, argument: unknown) => { browserFunction = fn; expect(argument).toEqual({ input: 7 }); return "browser-result"; };
  try {
    const output = await call("evaluate", { expression: `(() => { globalThis[${JSON.stringify(marker)}] = true; return 42; })()`, argument: { input: 7 } });
    expect(output.value).toBe("browser-result");
    expect((globalThis as any)[marker]).toBeUndefined();
    expect(typeof browserFunction).toBe("function");
  } finally { observer.dispose(); }
});

test("Firefox developer execution uses its native page-world channel and keeps arguments intact", async () => {
  const { context, observer, call } = setup({ engine: "firefox" });
  let sent: any;
  context.page.frame.evaluate = async (source: any) => { sent = source; return (0, eval)(source.slice(3)); };
  try {
    const argument = { text: "引号 ' \" 反引号 ` ${literal} 换行\n" };
    expect((await call("evaluate", { expression: "input => input.text", argument })).value).toBe(argument.text);
    expect(sent.startsWith("mw:")).toBe(true);
  } finally { observer.dispose(); }
});

test("an expression typed with a trailing semicolon still returns its value", async () => {
  const { observer, call } = setup();
  try {
    expect((await call("evaluate", { expression: "20 + 22;" })).value).toBe(42);
    expect((await call("evaluate", { expression: "  'title' ;; " })).value).toBe("title");
    // Several statements still run as a body; it returns what it returns.
    expect((await call("evaluate", { expression: "const a = 1; return a + 1;" })).value).toBe(2);
  } finally { observer.dispose(); }
});

test("text websocket frames are kept exactly without a base64 copy", async () => {
  const { context, observer, call } = setup();
  try {
    const socket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/socket" });
    context.page.emit("websocket", socket);
    socket.emit("framesent", { payload: "你好 frame" });
    socket.emit("framereceived", { payload: "x".repeat(70_000) });
    const [sent] = (await call("events", { kind: "websocket-sent" })).records;
    expect(sent).toMatchObject({ binary: false, encoding: "text", text: "你好 frame", totalBytes: Buffer.byteLength("你好 frame"), truncated: false, hasMore: false });
    expect(sent.base64).toBeUndefined();
    const [long] = (await call("events", { kind: "websocket-received" })).records;
    expect(long.text).toHaveLength(65536);
    expect(long).toMatchObject({ totalCharacters: 70_000, truncated: true, hasMore: true });
  } finally { observer.dispose(); }
});

test("a busy websocket gives up its own oldest frames before console history", async () => {
  const { context, observer, call } = setup({ maxEvents: 10 });
  try {
    context.page.emit("console", consoleMessage("error", "the error that matters", context.page));
    const socket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/socket" });
    context.page.emit("websocket", socket);
    for (let i = 0; i < 50; i++) socket.emit("framereceived", { payload: `tick ${i}` });
    expect((await call("console")).records.map((r: any) => r.text)).toEqual(["the error that matters"]);
    const frames = (await call("events", { kind: "websocket-received" })).records.map((r: any) => r.text);
    expect(frames.at(-1)).toBe("tick 49");
    expect(frames.length).toBeGreaterThanOrEqual(5);
    // With few frames, a new one is still kept instead of evicting itself.
    const quiet = setup({ maxEvents: 4 });
    for (let i = 0; i < 4; i++) quiet.context.page.emit("console", consoleMessage("log", String(i), quiet.context.page));
    const quietSocket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/quiet" });
    quiet.context.page.emit("websocket", quietSocket);
    quietSocket.emit("framereceived", { payload: "rare frame" });
    expect((await quiet.call("events", { kind: "websocket-received" })).records.map((r: any) => r.text)).toEqual(["rare frame"]);
    quiet.observer.dispose();
  } finally { observer.dispose(); }
});

test("cookies default to the selected page's site; other sites and the whole profile are explicit", async () => {
  const { context, observer, call } = setup();
  try {
    // The page-side storage read runs in the browser; here it only needs to answer.
    context.page.frame.evaluate = async () => ({ origin: "https://fixture.test", localStorage: { value: {} }, sessionStorage: { value: {} } });
    context.cookieJar.push({ name: "here", value: "1", domain: "fixture.test", path: "/" },
      { name: "elsewhere", value: "2", domain: "other.test", path: "/" });
    const own = await call("storage");
    expect(own.cookieScope).toBe("frame");
    expect(own.cookies.map((c: any) => c.name)).toEqual(["here"]);
    expect((await call("storage", { urls: ["https://other.test/"] })).cookies.map((c: any) => c.name)).toEqual(["elsewhere"]);
    const all = await call("storage", { allCookies: true });
    expect(all.cookieScope).toBe("profile");
    expect(all.cookies.map((c: any) => c.name)).toEqual(["here", "elsewhere"]);
    await expect(call("storage", { urls: "https://other.test/" })).rejects.toThrow(/urls/);
  } finally { observer.dispose(); }
});

test("page inspection can address a deep frame and page through its accessibility and DOM results", async () => {
  const { call, context } = setup();
  const top = context.page.frame;
  const frames = [top];
  for (let depth = 1; depth <= 4; depth++) {
    const parent = frames.at(-1)!;
    const frame = new Frame(context.page, `https://frame-${depth}.test/`);
    frame.parentFrame = () => parent;
    frames.push(frame);
  }
  context.page.frames = () => frames;
  const deepest = frames.at(-1)! as any;
  const snapshot = '- main:\n  - button "Save"';
  const dom = { nodes: [{ index: 1, parentIndex: 0, tag: "main" }], offset: 1, total: 3, nextOffset: 2, hasMore: true };
  const hidden = { nodes: [{ index: 2, parentIndex: 1, tag: "input", value: "fixture" }], offset: 0, total: 1, nextOffset: 1, hasMore: false };
  deepest.locator = (selector: string) => {
    expect(selector).toBe(":root");
    return {
      evaluate: async (_evaluate: Function, options: object) => {
        expect(options).toEqual({ wholeDocument: true, domOffset: 1, hiddenOffset: 0, nodeLimit: 1, textOffset: 0, characters: 7 });
        return { title: "Last frame", dom, hidden };
      },
      ariaSnapshot: async () => snapshot,
    };
  };
  const { pages: [page] } = await call("pages");
  const target = page.frames.at(-1);
  expect(target).toMatchObject({ url: "https://frame-4.test/", depth: 4, parentFrameId: page.frames[3].frameId });
  expect(await call("page_inspect", { frameId: target.frameId, domOffset: 1, nodeLimit: 1, offset: 2, characters: 7 })).toMatchObject({
    pageId: page.pageId, frameId: target.frameId, depth: 4, title: "Last frame", accessibility: snapshot.slice(2, 9),
    nextOffset: 9, totalCharacters: snapshot.length, hasMore: true, dom, hidden,
  });
  await expect(call("page_inspect", { frameId: target.frameId, pageId: "other-profile-page" })).rejects.toThrow("Unknown or detached frameId");
});

test("semantic actions require an explicit ambiguous match and report verification separately", async () => {
  const { call, context } = setup();
  const frame = context.page.frame as any;
  const clicks: number[] = [];
  const waitFor = async () => {
    expect(clicks).toEqual([1]);
    throw new Error("Expected text never appeared");
  };
  frame.getByRole = (role: string, options: object) => {
    expect(role).toBe("button");
    expect(options).toEqual({ name: "Save", exact: true });
    return {
      count: async () => 2,
      nth: (index: number) => ({ click: async () => { clicks.push(index); } }),
    };
  };
  frame.getByText = (text: string) => {
    expect(text).toBe("Draft saved");
    return { filter: (options: object) => {
      expect(options).toEqual({ visible: true });
      return { first: () => ({ waitFor }) };
    } };
  };
  const target = { role: "button", name: "Save" };
  await expect(call("action", { action: "click", target })).rejects.toThrow("matched multiple elements");
  await expect(call("action", { action: "click", target: { ...target, index: 1 }, verify: { text: "Saved", urlIncludes: "/done" } })).rejects.toThrow("requires one");
  expect(clicks).toEqual([]);
  const result = await call("action", { action: "click", target: { ...target, index: 1 }, verify: { text: "Draft saved", timeoutMs: 20 } });
  expect(result).toMatchObject({ action: "click", actionCompleted: true, verification: { passed: false, error: "Expected text never appeared" } });
  expect(clicks).toEqual([1]);
});

test("compact controls act and verify in one call and expire on same-URL navigation", async () => {
  const { call, context, observer } = setup();
  const frame = context.page.frame as any;
  const identity = { tag: "button", name: "", type: "", testId: "", label: "", text: "Save" };
  let matches = 1, clicks = 0;
  frame.locator = () => ({ evaluate: async () => ({ headings: ["Draft"], controls: [
    { role: "button", name: "Save", identity, candidates: [{ role: "button", name: "Save" }] },
  ] }) });
  frame.getByRole = () => ({ count: async () => matches, evaluate: async () => identity, click: async () => { clicks++; } });
  frame.getByText = () => ({ filter: () => ({ first: () => ({ waitFor: async () => {} }) }) });
  try {
    const original = await call("observe", { compact: true });
    const ref = original.controls[0].ref;
    expect(ref).toBeTruthy();
    expect(original.controls[0].anchor).toBeUndefined();
    matches = 2;
    await expect(call("action", { action: "click", ref })).rejects.toThrow("unique element");
    matches = 1;
    const reply = await call("action", { action: "click", ref, verify: { text: "Saved" }, observe: true });
    expect(reply).toMatchObject({ actionCompleted: true, verification: { passed: true }, observation: { headings: ["Draft"] } });
    expect(reply.observation.controls[0].ref).not.toBe(ref);
    context.page.emit("framenavigated", frame);
    await expect(call("action", { action: "click", ref })).rejects.toThrow("unique element");
    expect(clicks).toBe(1);
  } finally { observer.dispose(); }
});

test("unusual rendered glyphs attach a screenshot of the inspected viewport region", async () => {
  const { context, observer } = setup();
  const page = context.page as any;
  page.viewportSize = () => ({ width: 1200, height: 800 });
  page.screenshot = async (options: any) => {
    expect(options.clip).toEqual({ x: 30, y: 10, width: 300, height: 120 });
    return Buffer.from("fixture");
  };
  page.frame.locator = () => ({
    evaluate: async () => ({ readableText: { text: "\uE000", unusualGlyphs: 1 } }),
    ariaSnapshot: async () => "- paragraph: \uE000",
    boundingBox: async () => ({ x: 30, y: 10, width: 300, height: 120 }),
  });
  try {
    const reply = await observer.call("browser_devtools_page_inspect");
    expect(reply.structuredContent).toMatchObject({ visualEvidence: { scope: "current viewport" } });
    expect(reply.content[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: Buffer.from("fixture").toString("base64") });
  } finally { observer.dispose(); }
});

test("browser programs operate on captured bytes and correlate network, websocket and page errors", async () => {
  const { context, observer, call } = setup();
  const socket = Object.assign(new EventEmitter(), { url: () => "wss://fixture.test/events" });
  const encoded = Buffer.from([...Buffer.from("Decoded draft")].map(byte => byte ^ 99));
  const fixture = requestFixture(context, encoded);
  const prior = consoleMessage("info", "before the program", context.page);
  context.page.emit("console", prior);
  (context.page.frame as any).trigger = async (message: string) => {
    context.emit("request", fixture.req);
    context.emit("response", fixture.response);
    context.emit("requestfinished", fixture.req);
    context.page.emit("websocket", socket);
    socket.emit("framereceived", { payload: Buffer.from([0, 255, 10]) });
    context.page.emit("console", consoleMessage("info", message, context.page));
    context.page.emit("pageerror", new Error("script failure fixture"));
  };
  try {
    const output = await call("program", {
      argument: "during the program",
      code: `async ({ frame, devtools, argument }) => {
        const capture = await devtools.capture(() => frame.trigger(argument));
        const requestId = capture.network.records[0].requestId;
        const bytes = await devtools.bytes(requestId);
        const post = await devtools.bytes(requestId, "request");
        console.info("decoded", bytes.length);
        return {
          decoded: Buffer.from(bytes.map(byte => byte ^ 99)).toString("utf8"),
          post: post.toString("hex"),
          events: capture.events.records,
          status: capture.network.records[0].status,
        };
      }`,
    });
    expect(output).toMatchObject({ completed: true, logs: [{ level: "info", text: "decoded 13" }], value: { decoded: "Decoded draft", post: encoded.toString("hex"), status: 200 } });
    expect(output.value.events.map((event: any) => event.kind)).toEqual(["websocket-open", "websocket-received", "console", "exception"]);
    expect(output.value.events[1].base64).toBe(Buffer.from([0, 255, 10]).toString("base64"));
    expect(output.value.events[2].text).toBe("during the program");
    expect(output.value.events[3].stack).toContain("script failure fixture");
    const failure = await call("program", { code: `async ({ devtools }) => devtools.capture(() => { throw new Error("capture failed"); })` });
    expect(failure.value).toMatchObject({ completed: false, error: "capture failed", network: { records: [] } });
    expect(fixture.bodyReads()).toBe(1);
  } finally { observer.dispose(); }
});

test("the network wait settles on idle, matches a finished request, and the new tools are listed", async () => {
  const names = DEVTOOLS_TOOLS.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["browser_devtools_performance", "browser_devtools_block", "browser_devtools_wait"]));
  const context = new Context();
  const devtools = new BrowserDevtools(context as any);
  const idle = (await devtools.call("browser_devtools_wait", { idleMs: 100, timeoutMs: 2000 })).structuredContent as any;
  expect(idle.idle).toBe(true);
  // A request that starts after the call and finishes is the one waited for.
  const page = context.page;
  const request = { url: () => "https://fixture.test/api/save", method: () => "POST", resourceType: () => "fetch", headers: () => ({}), frame: () => page.frame, redirectedFrom: () => null, timing: () => ({}) };
  setTimeout(() => { context.emit("request", request); context.emit("requestfinished", request); }, 150);
  const matched = (await devtools.call("browser_devtools_wait", { urlIncludes: "/api/save", method: "post", timeoutMs: 2000 })).structuredContent as any;
  expect(matched.request.url).toBe("https://fixture.test/api/save");
  await expect(devtools.call("browser_devtools_block", { action: "set" })).rejects.toThrow("resourceTypes or urlPatterns");
  devtools.dispose();
});

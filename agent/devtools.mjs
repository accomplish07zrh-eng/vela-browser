// One observer per persistent browser context. Nothing is injected into a page, and no browser
// option, preference, permission, route, fingerprint, cache or storage value is changed to observe it.
import { randomUUID } from "node:crypto";

const string = { type: "string" };
const pageId = { type: "string", description: "Stable page id from browser_devtools_pages. Required to choose a page when several are open." };
const cursor = { type: "integer", minimum: 0, description: "Return records updated after this cursor. Reading does not consume records." };
const limit = { type: "integer", minimum: 1, maximum: 500, default: 100 };
const filters = { pageId, since: cursor, limit, text: string };
const schema = (properties, required = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const tool = (name, description, properties = {}, required = [], readOnly = true) => ({
  name, description, inputSchema: schema(properties, required),
  annotations: { title: name.replace(/^browser_devtools_/, "Browser ").replaceAll("_", " "), readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly },
});

export const DEVTOOLS_TOOLS = [
  tool("browser_devtools_summary", "Inspect this profile's automatically recorded developer diagnostics: pages, console errors, failed requests, downloads and workers. Includes capture time and buffer eviction counts; no enable step is needed."),
  tool("browser_devtools_pages", "List this profile's pages, frames, dedicated workers and service workers with stable ids. Ids belong only to this browser session; use them to target developer tools."),
  tool("browser_devtools_console", "Read console output and uncaught exceptions across this profile's tabs, including severity, source location and exception stacks. Includes log/debug, groups, traces, assertions and errors. Captured automatically, preserved across navigation; cursor pagination never consumes messages.", {
    ...filters, level: { type: "string", enum: ["all", "debug", "info", "warning", "error"], default: "all" },
  }),
  tool("browser_devtools_network", "List HTTP requests in this profile: method, URL, resource type, status, failure, timing and redirect ids. Includes static assets by default. Use requestId with browser_devtools_request for headers and bodies; cursor pagination includes later status updates.", {
    ...filters, failedOnly: { type: "boolean" }, resourceType: string, status: { type: "integer", minimum: 0, maximum: 599 },
  }),
  tool("browser_devtools_request", "Inspect a recorded request's complete request/response headers, POST data, response body, timing and transfer sizes without resending it or changing browser caching. Bodies are read on demand in byte chunks; nextOffset retrieves the rest. Binary chunks use base64.", {
    requestId: string, requestBody: { type: "boolean", default: true }, responseBody: { type: "boolean", default: false },
    offset: { type: "integer", minimum: 0, default: 0 }, bytes: { type: "integer", minimum: 1, maximum: 1048576, default: 65536 },
  }, ["requestId"]),
  tool("browser_devtools_events", "Read developer events from this profile: WebSocket sent/received frames, socket errors, page lifecycle, downloads and workers. Console output and page exceptions are also available. Frame payloads include encoding, byte counts and explicit truncation metadata.", {
    ...filters, kind: string,
  }),
  tool("browser_devtools_evaluate", "Execute JavaScript in a specific page, iframe, dedicated worker or service worker of this profile, like the DevTools Console execution-context selector. expression may be a JavaScript expression or a function; argument is passed to a function. Returns the value and context ids. Existing browser identity and context are used.", {
    pageId, frameId: string, workerId: string, expression: string, argument: {},
  }, ["expression"], false),
  tool("browser_devtools_element", "Inspect a DOM element in a page or iframe: markup, text, attributes, bounding rectangle and requested computed CSS properties, without changing the DOM.", {
    pageId, frameId: string, selector: string, index: { type: "integer", minimum: 0, default: 0 },
    styles: { type: "array", items: string }, offset: { type: "integer", minimum: 0, default: 0 },
    characters: { type: "integer", minimum: 1, maximum: 1048576, default: 65536 },
  }, ["selector"]),
  tool("browser_devtools_storage", "Read this profile's cookies and the selected page/frame's localStorage, sessionStorage, IndexedDB database names and Cache Storage keys. Opens no helper pages and changes no storage, permissions or browser identity.", { pageId, frameId: string }),
  tool("browser_devtools_storage_edit", "Write, remove or clear cookies, localStorage or sessionStorage in the selected existing profile. Cookie writes accept Playwright cookie objects (url or domain/path, httpOnly, secure, sameSite, expires); name/domain/path filter cookie removal. Page storage writes take string-valued entries, removals take keys. JavaScript evaluation can edit IndexedDB and Cache Storage.", {
    pageId, frameId: string, storage: { type: "string", enum: ["cookies", "localStorage", "sessionStorage"] },
    action: { type: "string", enum: ["set", "remove", "clear"] },
    entries: { type: "object", additionalProperties: { type: "string" } }, keys: { type: "array", items: string },
    cookies: { type: "array", items: { type: "object", additionalProperties: true } }, name: string, domain: string, path: string,
  }, ["storage", "action"], false),
  tool("browser_devtools_fetch", "Send or replay an HTTP request through the selected page/frame's real browser network stack, profile cookies and proxy. Supports method, headers and text/base64 POST body. Returns response headers and a byte-exact body chunk; captured network requests let you read the remainder without replaying. The browser's normal Fetch/CORS rules apply; no Node HTTP client is used.", {
    pageId, frameId: string, url: string, method: string, headers: { type: "object", additionalProperties: { type: "string" } },
    body: string, bodyBase64: string, credentials: { type: "string", enum: ["omit", "same-origin", "include"], default: "include" },
    offset: { type: "integer", minimum: 0, default: 0 }, bytes: { type: "integer", minimum: 1, maximum: 1048576, default: 65536 },
  }, ["url"], false),
  tool("browser_devtools_protocol", "Send a native Chrome DevTools Protocol command to a page in this existing Chromium profile and return its result. All commands supported by the engine are available, including developer changes. Firefox/WebKit use the cross-engine developer tools and JavaScript evaluation instead of CDP.", {
    pageId, method: string, params: { type: "object", additionalProperties: true },
  }, ["method"], false),
];
export const DEVTOOLS_TOOL_NAMES = new Set(DEVTOOLS_TOOLS.map(t => t.name));

function integer(value, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  return value;
}
function json(value, seen = new WeakMap(), path = "$") {
  if (typeof value === "bigint") return { type: "bigint", value: String(value) };
  if (typeof value === "number" && !Number.isFinite(value)) return { type: "number", value: String(value) };
  if (value === undefined) return null;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return { circularReference: seen.get(value) };
  seen.set(value, path);
  if (value instanceof Date) return { type: "date", value: value.toISOString() };
  if (value instanceof RegExp) return { type: "regexp", value: String(value) };
  if (value instanceof Map) return { type: "map", entries: [...value].map(([k, v], i) => [json(k, seen, `${path}.${i}.key`), json(v, seen, `${path}.${i}.value`)]) };
  if (value instanceof Set) return { type: "set", values: [...value].map((v, i) => json(v, seen, `${path}.${i}`)) };
  if (Array.isArray(value)) return value.map((v, i) => json(v, seen, `${path}[${i}]`));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, seen, `${path}.${k}`)]));
}
function result(value) {
  const normalized = json(value);
  return { content: [{ type: "text", text: JSON.stringify(normalized) }], structuredContent: normalized };
}
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function evaluate(target, compiled, argument, mainWorld) {
  // Firefox's native main-world channel preserves the normal isolated automation world.
  // Only this explicit developer operation runs in the page's own execution context.
  return mainWorld ? target.evaluate(`mw:(${compiled.toString()})(${JSON.stringify(argument) ?? "undefined"})`)
    : target.evaluate(compiled, argument);
}
function evaluateSource(target, expression, argument, mainWorld = false) {
  // Playwright treats a string containing an arrow/function as a value, not a call.
  // Compile a function for Playwright to serialize and run in the selected browser context.
  // Compilation here never executes the user's JavaScript in the Node process, and the
  // browser needs no eval(), injected helper, or CSP change.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let compiled;
  try { compiled = new AsyncFunction("argument", `const value = (${expression}\n); return typeof value === 'function' ? value(argument) : value;`); }
  catch { compiled = new AsyncFunction("argument", expression); }
  return evaluate(target, compiled, argument, mainWorld);
}
function chunk(buffer, options, contentType = "") {
  const offset = integer(options.offset, 0, 0), bytes = integer(options.bytes, 65536, 1, 1048576);
  const part = buffer.subarray(offset, offset + bytes);
  // Base64 preserves byte boundaries, also in the middle of multibyte text. Every body can be
  // reconstructed exactly; the convenient decoded text is additional, never the authoritative data.
  return { totalBytes: buffer.length, offset, returnedBytes: part.length, base64: part.toString("base64"),
    ...(/text|json|javascript|xml|form-urlencoded|svg/i.test(contentType) ? { text: part.toString("utf8") } : {}),
    hasMore: offset + part.length < buffer.length, nextOffset: offset + part.length };
}

export class BrowserDevtools {
  constructor(context, { engine, maxEvents = 2000, maxRequests = 1000, maxEventBytes = 8 * 1024 * 1024 } = {}) {
    this.context = context;
    this.mainWorld = engine === "firefox";
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.sequence = 0;
    this.maxEvents = maxEvents;
    this.maxRequests = maxRequests;
    this.maxEventBytes = maxEventBytes;
    this.events = [];
    this.eventBytes = 0;
    this.droppedEvents = 0;
    this.droppedRequests = 0;
    this.pages = new Map();
    this.pageIds = new WeakMap();
    this.frames = new Map();
    this.frameIds = new WeakMap();
    this.workers = new Map();
    this.workerIds = new WeakMap();
    this.requests = new Map();
    this.requestIds = new WeakMap();
    this.counters = { page: 0, frame: 0, worker: 0, request: 0, socket: 0 };
    this.listeners = new Map();
    this.emitterPages = new WeakMap();
    this.protocolSessions = new Map();
    this.closed = false;
    for (const page of context.pages()) this.watchPage(page);
    this.listen(context, "page", page => this.watchPage(page));
    const pageFor = request => {
      try { const page = request.frame().page(); this.watchPage(page); return page; } catch { return undefined; }
    };
    this.listen(context, "request", request => this.watchRequest(request, pageFor(request)));
    this.listen(context, "response", response => {
      const item = this.watchRequest(response.request(), pageFor(response.request()));
      if (!item) return;
      item.response = response; item.data.status = response.status(); item.data.statusText = response.statusText();
      item.data.responseHeaders = response.headers(); item.data.fromServiceWorker = response.fromServiceWorker?.() ?? false;
      item.data.sequence = ++this.sequence;
    });
    this.listen(context, "requestfinished", request => this.finishRequest(request, pageFor(request)));
    this.listen(context, "requestfailed", request => this.finishRequest(request, pageFor(request), request.failure()?.errorText ?? "Request failed"));
    this.listen(context, "console", message => {
      if (!message.page?.()) this.log("console", undefined, { type: message.type(), text: message.text(), location: message.location() });
    });
    this.listen(context, "weberror", event => {
      if (!event.page()) { const error = event.error(); this.log("exception", undefined, { type: "error", name: error.name, text: error.message, stack: error.stack }); }
    });
    this.listen(context, "serviceworker", worker => this.watchWorker(worker, undefined, "serviceworker"));
    for (const worker of context.serviceWorkers?.() ?? []) this.watchWorker(worker, undefined, "serviceworker");
    this.listen(context, "close", () => this.dispose());
  }

  listen(emitter, name, callback) {
    const listener = (...args) => { if (!this.closed) { try { callback(...args); } catch {} } };
    emitter.on?.(name, listener);
    const listeners = this.listeners.get(emitter) ?? [];
    listeners.push([name, listener]);
    this.listeners.set(emitter, listeners);
  }
  unlisten(emitter) {
    for (const [name, callback] of this.listeners.get(emitter) ?? []) emitter.off?.(name, callback);
    this.listeners.delete(emitter);
  }
  log(kind, page, value = {}) {
    const entry = { id: `${this.id}-event-${++this.sequence}`, sequence: this.sequence, timestamp: new Date().toISOString(), kind,
      ...(page ? { pageId: this.pageIds.get(page), pageUrl: page.url() } : {}), ...value };
    // Bounded, explicit history; payloads cannot turn a long-running AI connection into an
    // unbounded memory queue. Eviction is reported with every query, never hidden as an empty log.
    for (const key of ["text", "stack"]) if (typeof entry[key] === "string" && entry[key].length > 65536) {
      entry[`${key}TotalCharacters`] = entry[key].length;
      entry[key] = entry[key].slice(0, 65536);
      entry.truncated = true;
    }
    const size = Buffer.byteLength(JSON.stringify(entry));
    this.events.push({ entry, size }); this.eventBytes += size;
    while (this.events.length > this.maxEvents || this.eventBytes > this.maxEventBytes) {
      const removed = this.events.shift(); this.eventBytes -= removed.size; this.droppedEvents++;
    }
    return entry;
  }
  frameId(frame, page) {
    let id = this.frameIds.get(frame);
    if (!id) { id = `${this.id}-frame-${++this.counters.frame}`; this.frameIds.set(frame, id); }
    this.frames.set(id, { frame, page });
    return id;
  }
  watchWorker(worker, page, type) {
    if (this.workerIds.has(worker)) return;
    const id = `${this.id}-worker-${++this.counters.worker}`;
    this.workerIds.set(worker, id); this.workers.set(id, { worker, page, type });
    if (page) this.emitterPages.set(worker, page);
    this.log("worker-created", page, { workerId: id, workerType: type, url: worker.url() });
    this.listen(worker, "close", () => {
      this.workers.delete(id); this.log("worker-closed", page, { workerId: id }); this.unlisten(worker);
    });
  }
  watchPage(page) {
    if (this.pageIds.has(page)) return;
    const id = `${this.id}-page-${++this.counters.page}`;
    this.pageIds.set(page, id); this.pages.set(id, page);
    for (const frame of page.frames?.() ?? []) this.frameId(frame, page);
    this.listen(page, "frameattached", frame => this.frameId(frame, page));
    this.listen(page, "framedetached", frame => this.frames.delete(this.frameIds.get(frame)));
    this.listen(page, "framenavigated", frame => this.log("navigation", page, { frameId: this.frameId(frame, page), url: frame.url() }));
    this.listen(page, "console", message => this.log("console", page, { type: message.type(), text: message.text(), location: message.location() }));
    this.listen(page, "pageerror", error => this.log("exception", page, { type: "error", name: error.name, text: error.message, stack: error.stack }));
    this.listen(page, "crash", () => this.log("crash", page, { type: "error", text: "Page renderer crashed" }));
    this.listen(page, "websocket", socket => {
      this.emitterPages.set(socket, page);
      const socketId = `${this.id}-socket-${++this.counters.socket}`;
      this.log("websocket-open", page, { socketId, url: socket.url() });
      for (const [event, kind] of [["framesent", "websocket-sent"], ["framereceived", "websocket-received"]]) this.listen(socket, event, frame => {
        const buffer = Buffer.isBuffer(frame.payload) ? frame.payload : Buffer.from(String(frame.payload));
        this.log(kind, page, { socketId, url: socket.url(), binary: Buffer.isBuffer(frame.payload), ...chunk(buffer, {}, Buffer.isBuffer(frame.payload) ? "" : "text/plain"), truncated: buffer.length > 65536 });
      });
      this.listen(socket, "socketerror", text => this.log("websocket-error", page, { socketId, text }));
      this.listen(socket, "close", () => { this.log("websocket-close", page, { socketId }); this.unlisten(socket); });
    });
    // A dialog listener changes Playwright's automatic-dismiss behavior. Do not install one:
    // the official MCP handler remains the only owner of modal dialogs.
    this.listen(page, "download", download => this.log("download", page, { url: download.url(), suggestedFilename: download.suggestedFilename() }));
    this.listen(page, "worker", worker => this.watchWorker(worker, page, "worker"));
    for (const worker of page.workers?.() ?? []) this.watchWorker(worker, page, "worker");
    this.listen(page, "close", () => {
      this.log("page-closed", page); this.pages.delete(id);
      for (const [frameId, item] of this.frames) if (item.page === page) this.frames.delete(frameId);
      for (const [workerId, item] of this.workers) if (item.page === page) this.workers.delete(workerId);
      const protocol = this.protocolSessions.get(page);
      if (protocol) void protocol.then(session => session.detach()).catch(() => {});
      this.protocolSessions.delete(page);
      for (const emitter of [...this.listeners.keys()]) if (this.emitterPages.get(emitter) === page) this.unlisten(emitter);
      this.unlisten(page);
    });
    this.log("page-opened", page);
  }
  watchRequest(request, page) {
    const knownId = this.requestIds.get(request);
    if (knownId) return this.requests.get(knownId);
    const id = `${this.id}-request-${++this.counters.request}`;
    this.requestIds.set(request, id);
    let frameId;
    try { frameId = this.frameId(request.frame(), page); } catch {} // service worker requests have no frame
    const previous = request.redirectedFrom?.();
    const item = { request, data: { requestId: id, sequence: ++this.sequence, timestamp: new Date().toISOString(),
      ...(page ? { pageId: this.pageIds.get(page) } : {}), ...(frameId ? { frameId } : {}), url: request.url(), method: request.method(),
      resourceType: request.resourceType(), requestHeaders: request.headers(), state: "pending",
      ...(previous && this.requestIds.has(previous) ? { redirectedFrom: this.requestIds.get(previous) } : {}) } };
    this.requests.set(id, item);
    while (this.requests.size > this.maxRequests) { this.requests.delete(this.requests.keys().next().value); this.droppedRequests++; }
    return item;
  }
  finishRequest(request, page, failure) {
    const item = this.watchRequest(request, page);
    if (!item) return; // an old request may finish after its history entry was evicted
    Object.assign(item.data, { sequence: ++this.sequence, state: failure ? "failed" : "finished", finishedAt: new Date().toISOString(),
      ...(failure ? { failure } : {}), timing: request.timing() });
  }
  query(entries, args, dropped) {
    const since = integer(args.since, 0, 0), count = integer(args.limit, 100, 1, 500);
    const text = args.text?.toLowerCase();
    const matches = entries.filter(e => e.sequence > since && (!args.pageId || e.pageId === args.pageId)
      && (!text || JSON.stringify(e).toLowerCase().includes(text))).sort((a, b) => a.sequence - b.sequence);
    const records = matches.slice(0, count);
    return { captureStartedAt: this.startedAt, records, nextCursor: matches.length > count ? records.at(-1).sequence : this.sequence,
      hasMore: matches.length > count, oldestAvailableCursor: entries.length ? Math.min(...entries.map(e => e.sequence)) : this.sequence,
      dropped, retained: entries.length };
  }
  selectPage(id) {
    if (id) {
      const page = this.pages.get(id);
      if (!page || page.isClosed?.()) throw new Error("Unknown or closed pageId in this profile");
      return page;
    }
    const pages = [...this.pages.values()].filter(page => !page.isClosed?.());
    if (pages.length !== 1) throw new Error("Choose pageId from browser_devtools_pages for this profile");
    return pages[0];
  }
  selectFrame(args) {
    if (args.frameId) {
      const target = this.frames.get(args.frameId);
      if (!target || target.frame.isDetached?.() || target.page.isClosed?.()
        || (args.pageId && this.pageIds.get(target.page) !== args.pageId)) throw new Error("Unknown or detached frameId in this page/profile");
      return { page: target.page, frame: target.frame };
    }
    const page = this.selectPage(args.pageId);
    return { page, frame: page.mainFrame() };
  }
  async pageList() {
    return { captureStartedAt: this.startedAt, pages: await Promise.all([...this.pages].map(async ([id, page]) => ({
      pageId: id, url: page.url(), title: await page.title().catch(() => ""),
      frames: (page.frames?.() ?? []).map(frame => ({ frameId: this.frameId(frame, page), url: frame.url(), name: frame.name(), main: frame === page.mainFrame(),
        parentFrameId: frame.parentFrame() ? this.frameId(frame.parentFrame(), page) : null })),
    }))), workers: [...this.workers].map(([id, item]) => ({ workerId: id, type: item.type, url: item.worker.url(), ...(item.page ? { pageId: this.pageIds.get(item.page) } : {}) })) };
  }
  async requestDetail(args) {
    const item = this.requests.get(args.requestId);
    if (!item) throw new Error("Unknown or evicted requestId in this profile");
    const { request } = item;
    const response = item.response;
    const finished = ["finished", "failed"].includes(item.data.state);
    // WebKit resolves full raw headers, TLS metadata and server address only when the
    // response finishes. Reading a live SSE/stream must not occupy the profile's action lane.
    const requestHeaders = finished ? await request.allHeaders() : request.headers();
    const value = { ...item.data, requestHeaders, requestHeadersArray: finished ? await request.headersArray()
      : Object.entries(requestHeaders).map(([name, value]) => ({ name, value })), headerDetailsPending: !finished, timing: request.timing() };
    if (args.requestBody !== false) {
      const body = request.postDataBuffer();
      value.requestBody = body ? chunk(body, args, value.requestHeaders["content-type"]) : null;
    }
    if (response) {
      const responseHeaders = finished ? await response.allHeaders() : response.headers();
      Object.assign(value, { status: response.status(), statusText: response.statusText(), responseHeaders, responseHeadersArray: finished ? await response.headersArray()
        : Object.entries(responseHeaders).map(([name, value]) => ({ name, value })),
        serverAddress: finished ? await response.serverAddr().catch(() => null) : null, securityDetails: finished ? await response.securityDetails().catch(() => null) : null });
      if (args.responseBody) {
        if (!finished) value.responseBody = { available: false, reason: "Response is still streaming; read again after requestfinished" };
        else {
          try { value.responseBody = { available: true, ...chunk(await response.body(), args, value.responseHeaders["content-type"]) }; }
          catch (error) { value.responseBody = { available: false, reason: errorText(error) }; }
        }
      }
      value.sizes = finished ? await request.sizes().catch(() => null) : null;
    } else value.responseBody = { available: false, reason: item.data.failure ?? "No response received" };
    return value;
  }
  async call(name, args = {}) {
    if (this.closed) throw new Error("This browser's developer session has closed");
    if (name === "browser_devtools_pages") return result(await this.pageList());
    if (name === "browser_devtools_summary") return result({ captureStartedAt: this.startedAt, ...(await this.pageList()),
      console: { retained: this.events.filter(e => ["console", "exception", "crash"].includes(e.entry.kind)).length,
        errors: this.events.filter(e => ["exception", "crash"].includes(e.entry.kind) || ["error", "assert"].includes(e.entry.type)).length },
      network: { retained: this.requests.size, failed: [...this.requests.values()].filter(e => e.data.failure || e.data.status >= 400).length },
      history: { cursor: this.sequence, droppedEvents: this.droppedEvents, droppedRequests: this.droppedRequests } });
    if (name === "browser_devtools_console") {
      const rank = { debug: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3, assert: 3 };
      if (args.level && !["all", "debug", "info", "warning", "error"].includes(args.level)) throw new Error("Unknown console severity");
      const minimum = !args.level || args.level === "all" ? -1 : rank[args.level];
      return result(this.query(this.events.map(e => e.entry).filter(e => ["console", "exception", "crash"].includes(e.kind)
        && (rank[e.type] ?? 1) >= minimum), args, this.droppedEvents));
    }
    if (name === "browser_devtools_events") return result(this.query(this.events.map(e => e.entry).filter(e => !args.kind || e.kind === args.kind), args, this.droppedEvents));
    if (name === "browser_devtools_network") return result(this.query([...this.requests.values()].map(e => e.data).filter(e =>
      (!args.failedOnly || e.failure || e.status >= 400) && (!args.resourceType || e.resourceType === args.resourceType)
      && (args.status === undefined || e.status === args.status)), args, this.droppedRequests));
    if (name === "browser_devtools_request") return result(await this.requestDetail(args));
    if (name === "browser_devtools_evaluate") {
      if (typeof args.expression !== "string" || !args.expression.trim()) throw new Error("expression must be non-empty JavaScript");
      if (args.workerId) {
        if (args.frameId) throw new Error("Choose either workerId or frameId");
        const target = this.workers.get(args.workerId);
        if (!target || (args.pageId && this.pageIds.get(target.page) !== args.pageId)) throw new Error("Unknown workerId in this page/profile");
        return result({ workerId: args.workerId, value: await evaluateSource(target.worker, args.expression, args.argument) });
      }
      const { page, frame } = this.selectFrame(args);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), value: await evaluateSource(frame, args.expression, args.argument, this.mainWorld) });
    }
    if (name === "browser_devtools_element") {
      if (typeof args.selector !== "string" || !args.selector) throw new Error("selector is required");
      const { page, frame } = this.selectFrame(args);
      const locator = frame.locator(args.selector), index = integer(args.index, 0, 0), count = await locator.count();
      if (index >= count) throw new Error(`Selector matched ${count} elements; index ${index} is unavailable`);
      const value = await locator.nth(index).evaluate((element, input) => {
        const rect = element.getBoundingClientRect(), computed = getComputedStyle(element), markup = element.outerHTML, text = element.textContent ?? "";
        return { tagName: element.tagName, attributes: Object.fromEntries([...element.attributes].map(a => [a.name, a.value])),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles: Object.fromEntries(input.styles.map(k => [k, computed.getPropertyValue(k)])),
          markup: markup.slice(input.offset, input.offset + input.characters), text: text.slice(input.offset, input.offset + input.characters),
          totalMarkupCharacters: markup.length, totalTextCharacters: text.length,
          nextOffset: input.offset + input.characters, hasMore: Math.max(markup.length, text.length) > input.offset + input.characters };
      }, { offset: integer(args.offset, 0, 0), characters: integer(args.characters, 65536, 1, 1048576), styles: args.styles ?? ["display", "visibility", "color", "font-family", "font-size"] });
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), count, index, ...value });
    }
    if (name === "browser_devtools_storage") {
      const { page, frame } = this.selectFrame(args);
      const value = await evaluate(frame, async () => {
        const read = fn => { try { return { value: fn() }; } catch (error) { return { error: error.message }; } };
        const readAsync = async fn => { try { return { value: await fn() }; } catch (error) { return { error: error.message }; } };
        return { origin: location.origin, localStorage: read(() => Object.fromEntries(Object.entries(localStorage))),
          sessionStorage: read(() => Object.fromEntries(Object.entries(sessionStorage))),
          indexedDB: await readAsync(() => indexedDB.databases()), caches: await readAsync(() => caches.keys()) };
      }, undefined, this.mainWorld);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), ...value, cookies: await this.context.cookies() });
    }
    if (name === "browser_devtools_storage_edit") {
      if (!["set", "remove", "clear"].includes(args.action)) throw new Error("Unknown storage action");
      if (args.storage === "cookies") {
        if (args.action === "set") {
          if (!Array.isArray(args.cookies)) throw new Error("cookies must be an array");
          await this.context.addCookies(args.cookies);
        } else if (args.action === "clear") await this.context.clearCookies();
        else await this.context.clearCookies(Object.fromEntries(["name", "domain", "path"].filter(key => args[key] !== undefined).map(key => [key, args[key]])));
        return result({ storage: "cookies", action: args.action, cookies: await this.context.cookies() });
      }
      if (!["localStorage", "sessionStorage"].includes(args.storage)) throw new Error("Unknown storage kind");
      if (args.action === "set" && (!args.entries || typeof args.entries !== "object" || Array.isArray(args.entries) || Object.values(args.entries).some(v => typeof v !== "string"))) throw new Error("entries must contain string values");
      if (args.action === "remove" && (!Array.isArray(args.keys) || args.keys.some(key => typeof key !== "string"))) throw new Error("keys must be an array of strings");
      const { page, frame } = this.selectFrame(args);
      const value = await evaluate(frame, input => {
        const storage = input.storage === "localStorage" ? localStorage : sessionStorage;
        if (input.action === "set") for (const [key, value] of Object.entries(input.entries)) storage.setItem(key, value);
        if (input.action === "remove") for (const key of input.keys) storage.removeItem(key);
        if (input.action === "clear") storage.clear();
        return Object.fromEntries(Object.entries(storage));
      }, { storage: args.storage, action: args.action, entries: args.entries, keys: args.keys }, this.mainWorld);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), storage: args.storage, action: args.action, value });
    }
    if (name === "browser_devtools_fetch") {
      if (typeof args.url !== "string" || !args.url) throw new Error("url is required");
      const { page, frame } = this.selectFrame(args), before = this.sequence;
      const value = await evaluate(frame, async input => {
        const response = await fetch(input.url, { method: input.method, headers: input.headers, credentials: input.credentials,
          ...(input.bodyBase64 !== undefined ? { body: Uint8Array.from(atob(input.bodyBase64), c => c.charCodeAt(0)) }
            : input.body !== undefined ? { body: input.body } : {}) });
        const body = new Uint8Array(await response.arrayBuffer()), part = body.subarray(input.offset, input.offset + input.bytes);
        let binary = ""; for (const byte of part) binary += String.fromCharCode(byte);
        return { url: response.url, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers),
          body: { base64: btoa(binary), totalBytes: body.length, offset: input.offset, returnedBytes: part.length, nextOffset: input.offset + part.length, hasMore: input.offset + part.length < body.length } };
      }, { url: args.url, method: args.method ?? "GET", headers: args.headers, body: args.body, bodyBase64: args.bodyBase64,
        credentials: args.credentials ?? "include", offset: integer(args.offset, 0, 0), bytes: integer(args.bytes, 65536, 1, 1048576) }, this.mainWorld);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), networkCursorBefore: before,
        requestIds: [...this.requests.values()].filter(item => item.data.sequence > before && item.data.pageId === this.pageIds.get(page)).map(item => item.data.requestId), ...value });
    }
    if (name === "browser_devtools_protocol") {
      if (typeof args.method !== "string" || !args.method) throw new Error("method is required");
      const page = this.selectPage(args.pageId);
      let pending = this.protocolSessions.get(page);
      if (!pending) {
        pending = this.context.newCDPSession(page);
        this.protocolSessions.set(page, pending);
        void pending.catch(() => { if (this.protocolSessions.get(page) === pending) this.protocolSessions.delete(page); });
      }
      const session = await pending;
      if (this.closed || page.isClosed()) throw new Error("This page's developer session has closed");
      return result({ pageId: this.pageIds.get(page), method: args.method, value: await session.send(args.method, args.params ?? {}) });
    }
    throw new Error(`Unknown developer tool: ${name}`);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const emitter of [...this.listeners.keys()]) this.unlisten(emitter);
    for (const pending of this.protocolSessions.values()) void pending.then(session => session.detach()).catch(() => {});
    this.protocolSessions.clear();
    this.events.length = 0; this.requests.clear(); this.pages.clear(); this.frames.clear(); this.workers.clear();
  }
}

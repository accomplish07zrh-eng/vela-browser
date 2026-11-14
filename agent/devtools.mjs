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
  tool("browser_devtools_storage", "Read the selected page/frame's cookies, localStorage, sessionStorage, IndexedDB database names and Cache Storage keys. Cookies default to those that page or frame would send, like the DevTools Application panel; pass urls for other sites or allCookies for every cookie in the profile. Opens no helper pages and changes no storage, permissions or browser identity.", {
    pageId, frameId: string, urls: { type: "array", items: string, description: "Return the cookies these URLs would send instead of the selected page's." },
    allCookies: { type: "boolean", default: false, description: "Return every cookie in this profile, across all sites." },
  }),
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
  tool("browser_devtools_performance", "Measure how the selected page loaded and runs, like a DevTools performance insight: time to first byte, first and largest contentful paint, layout shift, main-thread long tasks, DOM size, and the slowest and largest resources. Returns the numbers and plain findings such as 'LCP 3.4 s is slow'. Reads the page's own performance records; nothing is changed.", {
    pageId, frameId: string, top: { type: "integer", minimum: 1, maximum: 20, default: 5 },
  }),
  tool("browser_devtools_block", "Block requests in this profile by resource type (image, media, font, stylesheet…) or URL pattern (glob such as **/*.mp4 or *://ads.example.com/*), for example to save proxy traffic or speed up a run. action 'set' replaces the rules, 'clear' removes them, 'list' shows them and how many requests were blocked. Rules last until cleared or the browser is detached. Blocked requests fail like an offline resource; pages may notice missing images.", {
    action: { type: "string", enum: ["set", "clear", "list"] },
    resourceTypes: { type: "array", items: { type: "string", enum: ["image", "media", "font", "stylesheet", "script", "xhr", "fetch", "websocket", "other"] } },
    urlPatterns: { type: "array", items: string, maxItems: 50 },
  }, ["action"], false),
  tool("browser_devtools_wait", "Wait for the page instead of a fixed delay: until any of several texts appears on the page (text), until a request whose URL contains urlIncludes finishes (optionally with a given method or status), or, with neither, until the page's network has been idle for idleMs. Requests count only when they start after the call unless since is given. Returns what matched and how long it took.", {
    pageId, text: { type: "array", items: string, maxItems: 20 }, visibleOnly: { type: "boolean", default: true },
    urlIncludes: string, method: string, status: { type: "integer", minimum: 100, maximum: 599 }, since: cursor,
    idleMs: { type: "integer", minimum: 100, maximum: 10000, default: 500 }, timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 15000 },
  }),
  tool("browser_devtools_mock", "Answer requests in this profile yourself, like DevTools network overrides: each rule gives a URL glob (and optionally a method) and the status, content type, headers and text body to return instead of going to the network. Useful to skip a slow or broken script, or to test how a page reacts. action 'set' replaces the rules, 'clear' removes them, 'list' shows them with how often each answered. Rules last until cleared or the browser is detached.", {
    action: { type: "string", enum: ["set", "clear", "list"] },
    rules: { type: "array", maxItems: 50, items: { type: "object", properties: {
      urlPattern: string, method: string, status: { type: "integer", minimum: 100, maximum: 599 }, contentType: string, body: string,
      headers: { type: "object", additionalProperties: { type: "string" } },
    }, required: ["urlPattern"], additionalProperties: false } },
  }, ["action"], false),
  tool("browser_devtools_memory", "How much memory the selected page uses: JavaScript heap, DOM elements, event listeners, documents and frames, with plain findings such as a page that keeps growing. Use it when a profile gets slow or the computer runs short of memory.", {
    pageId, frameId: string,
  }),
  tool("browser_devtools_css", "The full CSS cascade of an element in a Chromium page, like the Styles panel: inline style, every matched rule with its selector, origin, media and line, from the winning rule down. Use browser_devtools_element for computed values in any engine.", {
    pageId, selector: string, index: { type: "integer", minimum: 0, default: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  }, ["selector"]),
  tool("browser_devtools_webauthn", "A virtual passkey authenticator for the selected Chromium page, like the DevTools WebAuthn panel: 'add' one (platform by default, with user verification), 'list' it with the credentials sites registered on it, 'remove' it. Sites can then register and sign in with passkeys without a phone or security key. The credentials live only while the authenticator exists.", {
    pageId, action: { type: "string", enum: ["add", "remove", "list"] },
    protocol: { type: "string", enum: ["ctap2", "u2f"], default: "ctap2" }, transport: { type: "string", enum: ["internal", "usb", "nfc", "ble", "hybrid"], default: "internal" },
    hasResidentKey: { type: "boolean", default: true }, hasUserVerification: { type: "boolean", default: true }, isUserVerified: { type: "boolean", default: true },
  }, ["action"], false),
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
/** A URL glob as DevTools writes them: ** crosses slashes, * stays within one part, ? is one character. */
function globToRegExp(glob) {
  return new RegExp("^" + glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".") + "$", "i");
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
  // A single expression typed the way the Console accepts it, `document.title;`, still returns its value.
  const single = expression.trim().replace(/;+$/, "");
  try { compiled = new AsyncFunction("argument", `const value = (${single}\n); return typeof value === 'function' ? value(argument) : value;`); }
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
    this.authenticators = new Map();
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
    // A busy socket can send thousands of frames a minute. Once frames hold half the history,
    // their oldest leave first, so they never push out the console errors and exceptions a
    // developer came to read; below that share, the oldest record of any kind leaves.
    while (this.events.length > this.maxEvents || this.eventBytes > this.maxEventBytes) {
      let frames = 0, frameBytes = 0, oldestFrame = -1;
      this.events.forEach((e, index) => {
        if (e.entry.kind !== "websocket-sent" && e.entry.kind !== "websocket-received") return;
        frames++; frameBytes += e.size; if (oldestFrame < 0) oldestFrame = index;
      });
      const crowding = oldestFrame >= 0 && (frames * 2 >= this.events.length || frameBytes * 2 >= this.eventBytes);
      const [removed] = this.events.splice(crowding ? oldestFrame : 0, 1);
      this.eventBytes -= removed.size; this.droppedEvents++;
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
        if (Buffer.isBuffer(frame.payload)) {
          this.log(kind, page, { socketId, url: socket.url(), binary: true, ...chunk(frame.payload, {}), truncated: frame.payload.length > 65536 });
          return;
        }
        // A text frame arrives as a string. Cutting it by characters keeps it exact, so it needs
        // no base64 copy; that halves what each frame costs in the shared history.
        const text = String(frame.payload), kept = text.slice(0, 65536), returnedBytes = Buffer.byteLength(kept), totalBytes = Buffer.byteLength(text);
        this.log(kind, page, { socketId, url: socket.url(), binary: false, encoding: "text", text: kept, totalBytes, totalCharacters: text.length,
          returnedBytes, hasMore: kept.length < text.length, truncated: kept.length < text.length });
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
  /** One DevTools protocol session per page, shared by the tools that need one. */
  async cdp(page) {
    let pending = this.protocolSessions.get(page);
    if (!pending) {
      pending = this.context.newCDPSession(page);
      this.protocolSessions.set(page, pending);
      void pending.catch(() => { if (this.protocolSessions.get(page) === pending) this.protocolSessions.delete(page); });
    }
    return await pending;
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
      // Like the DevTools Application panel, cookies default to those the selected page or frame
      // would send. A whole profile's cookies cover every account signed in there, so they are
      // returned only when asked for by name.
      if (args.urls !== undefined && (!Array.isArray(args.urls) || args.urls.some(url => typeof url !== "string"))) throw new Error("urls must be an array of URLs");
      const frameUrl = frame.url();
      const scope = args.allCookies === true ? "profile" : args.urls?.length ? "urls" : /^https?:/i.test(frameUrl) ? "frame" : "profile";
      const cookies = scope === "profile" ? await this.context.cookies() : await this.context.cookies(scope === "urls" ? args.urls : [frameUrl]);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), ...value, cookieScope: scope,
        ...(scope === "frame" ? { cookieUrl: frameUrl } : {}), cookies });
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
      const session = await this.cdp(page);
      if (this.closed || page.isClosed()) throw new Error("This page's developer session has closed");
      return result({ pageId: this.pageIds.get(page), method: args.method, value: await session.send(args.method, args.params ?? {}) });
    }
    if (name === "browser_devtools_performance") {
      const { page, frame } = this.selectFrame(args);
      const top = integer(args.top, 5, 1, 20);
      const value = await evaluate(frame, async (input) => {
        const supported = (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes) || [];
        // Buffered observers hand back what already happened; they are disconnected right away.
        const collect = (type) => new Promise((resolve) => {
          if (!supported.includes(type)) { resolve(null); return; }
          const entries = [];
          try {
            const observer = new PerformanceObserver((list) => { entries.push(...list.getEntries()); });
            observer.observe({ type, buffered: true });
            setTimeout(() => { try { entries.push(...observer.takeRecords()); observer.disconnect(); } catch {} resolve(entries); }, 60);
          } catch { resolve(null); }
        });
        const [lcp, shifts, longTasks] = await Promise.all([collect("largest-contentful-paint"), collect("layout-shift"), collect("longtask")]);
        const navigation = performance.getEntriesByType("navigation")[0];
        const paints = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]));
        const resources = performance.getEntriesByType("resource").map((entry) => ({
          url: entry.name.slice(0, 300), type: entry.initiatorType, ms: Math.round(entry.duration), bytes: entry.transferSize || 0,
          thirdParty: (() => { try { return new URL(entry.name).hostname !== location.hostname; } catch { return false; } })(),
        }));
        // Layout shifts right after input do not count, as in the Core Web Vitals definition.
        const cls = shifts ? Math.round(shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + entry.value, 0) * 1000) / 1000 : null;
        const blocking = longTasks ? longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0) : null;
        const last = lcp && lcp.length ? lcp[lcp.length - 1] : null;
        return {
          url: location.href,
          navigation: navigation ? { ttfb: Math.round(navigation.responseStart - navigation.startTime), domContentLoaded: Math.round(navigation.domContentLoadedEventEnd), load: Math.round(navigation.loadEventEnd), transferBytes: navigation.transferSize, protocol: navigation.nextHopProtocol, type: navigation.type } : null,
          firstContentfulPaint: paints["first-contentful-paint"] ?? null,
          largestContentfulPaint: last ? { ms: Math.round(last.startTime), element: last.element ? `${last.element.tagName.toLowerCase()}${last.element.id ? "#" + last.element.id : ""}` : null, url: last.url ? last.url.slice(0, 300) : null } : null,
          cumulativeLayoutShift: cls,
          longTasks: longTasks ? { count: longTasks.length, blockingMs: Math.round(blocking) } : null,
          domNodes: document.getElementsByTagName("*").length,
          memory: performance.memory ? { usedJsHeapMb: Math.round(performance.memory.usedJSHeapSize / 1048576) } : null,
          resources: { count: resources.length, bytes: resources.reduce((sum, item) => sum + item.bytes, 0), thirdPartyCount: resources.filter((item) => item.thirdParty).length,
            slowest: [...resources].sort((a, b) => b.ms - a.ms).slice(0, input.top), largest: [...resources].sort((a, b) => b.bytes - a.bytes).slice(0, input.top).filter((item) => item.bytes > 0) },
        };
      }, { top }, this.mainWorld);
      // Plain findings against the Core Web Vitals thresholds.
      const findings = [];
      const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
      if (value.largestContentfulPaint) findings.push(value.largestContentfulPaint.ms > 4000 ? `LCP ${seconds(value.largestContentfulPaint.ms)} is poor (good is 2.5 s or less)` : value.largestContentfulPaint.ms > 2500 ? `LCP ${seconds(value.largestContentfulPaint.ms)} needs improvement (good is 2.5 s or less)` : `LCP ${seconds(value.largestContentfulPaint.ms)} is good`);
      if (value.cumulativeLayoutShift !== null) findings.push(value.cumulativeLayoutShift > 0.25 ? `Layout shift ${value.cumulativeLayoutShift} is poor (good is 0.1 or less)` : value.cumulativeLayoutShift > 0.1 ? `Layout shift ${value.cumulativeLayoutShift} needs improvement` : `Layout shift ${value.cumulativeLayoutShift} is good`);
      if (value.longTasks && value.longTasks.blockingMs > 200) findings.push(`The main thread was blocked for ${value.longTasks.blockingMs} ms by ${value.longTasks.count} long tasks`);
      if (value.navigation && value.navigation.ttfb > 800) findings.push(`The server took ${value.navigation.ttfb} ms to answer (good is 800 ms or less)`);
      if (value.domNodes > 1500) findings.push(`The page has ${value.domNodes} DOM elements, which slows layout`);
      if (value.resources.bytes > 5 * 1048576) findings.push(`The page downloaded ${(value.resources.bytes / 1048576).toFixed(1)} MB`);
      const slow = value.resources.slowest[0];
      if (slow && slow.ms > 2000) findings.push(`The slowest resource took ${seconds(slow.ms)}: ${slow.url}`);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), findings, ...value });
    }
    if (name === "browser_devtools_block" || name === "browser_devtools_mock") {
      if (!["set", "clear", "list"].includes(args.action)) throw new Error("action must be set, clear or list");
      const routing = this.routing ??= { types: new Set(), patterns: [], expressions: [], mocks: [], blocked: 0, mocked: 0 };
      if (name === "browser_devtools_block" && args.action === "set") {
        const types = Array.isArray(args.resourceTypes) ? args.resourceTypes.filter((type) => typeof type === "string") : [];
        const patterns = Array.isArray(args.urlPatterns) ? args.urlPatterns.filter((pattern) => typeof pattern === "string" && pattern.trim()).slice(0, 50) : [];
        if (!types.length && !patterns.length) throw new Error("Give resourceTypes or urlPatterns to block, or use action clear");
        Object.assign(routing, { types: new Set(types), patterns, expressions: patterns.map(globToRegExp) });
      }
      if (name === "browser_devtools_mock" && args.action === "set") {
        if (!Array.isArray(args.rules) || !args.rules.length || args.rules.length > 50) throw new Error("rules must list 1 to 50 rules");
        routing.mocks = args.rules.map((rule, index) => {
          if (!rule || typeof rule.urlPattern !== "string" || !rule.urlPattern.trim()) throw new Error(`rule ${index + 1}: urlPattern is required`);
          const status = rule.status === undefined ? 200 : integer(rule.status, 200, 100, 599);
          if (rule.body !== undefined && typeof rule.body !== "string") throw new Error(`rule ${index + 1}: body must be text`);
          if (rule.body !== undefined && rule.body.length > 2 * 1048576) throw new Error(`rule ${index + 1}: body is larger than 2 MB`);
          const headers = rule.headers && typeof rule.headers === "object" && !Array.isArray(rule.headers)
            ? Object.fromEntries(Object.entries(rule.headers).filter(([, value]) => typeof value === "string")) : {};
          return { urlPattern: rule.urlPattern.trim(), expression: globToRegExp(rule.urlPattern), method: typeof rule.method === "string" ? rule.method.toUpperCase() : undefined,
            status, body: rule.body ?? "", contentType: typeof rule.contentType === "string" ? rule.contentType : "text/plain; charset=utf-8", headers, hits: 0 };
        });
      }
      if (args.action === "clear") {
        if (name === "browser_devtools_block") Object.assign(routing, { types: new Set(), patterns: [], expressions: [] });
        else routing.mocks = [];
      }
      const wanted = routing.types.size || routing.patterns.length || routing.mocks.length;
      if (wanted && !this.routeHandler) {
        // One handler for both: a mocked answer first, then blocking, otherwise the request goes on untouched.
        this.routeHandler = async (route) => {
          const rules = this.routing, request = route.request(), url = request.url();
          const mock = rules?.mocks.find((rule) => rule.expression.test(url) && (!rule.method || rule.method === request.method()));
          if (mock) {
            mock.hits++; rules.mocked++;
            await route.fulfill({ status: mock.status, contentType: mock.contentType, headers: mock.headers, body: mock.body }).catch(() => {});
          } else if (rules && (rules.types.has(request.resourceType()) || rules.expressions.some((expression) => expression.test(url)))) {
            rules.blocked++;
            await route.abort("blockedbyclient").catch(() => {});
          } else await route.fallback().catch(() => {});
        };
        await this.context.route("**/*", this.routeHandler);
      } else if (!wanted && this.routeHandler) {
        await this.context.unroute("**/*", this.routeHandler).catch(() => {});
        this.routeHandler = undefined;
      }
      return result(name === "browser_devtools_block"
        ? { active: !!(routing.types.size || routing.patterns.length), resourceTypes: [...routing.types], urlPatterns: routing.patterns, blocked: routing.blocked }
        : { active: routing.mocks.length > 0, rules: routing.mocks.map(({ urlPattern, method, status, contentType, hits, body }) => ({ urlPattern, ...(method ? { method } : {}), status, contentType, bodyBytes: Buffer.byteLength(body), hits })), answered: routing.mocked });
    }
    if (name === "browser_devtools_memory") {
      const { page, frame } = this.selectFrame(args);
      const value = await evaluate(frame, () => ({
        domNodes: document.getElementsByTagName("*").length,
        iframes: document.getElementsByTagName("iframe").length,
        jsHeapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        jsHeapLimitMb: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
      }), undefined, this.mainWorld);
      let counters = null, metrics = null;
      if (!this.mainWorld && typeof this.context.newCDPSession === "function") {
        try {
          const session = await this.cdp(page);
          counters = await session.send("Memory.getDOMCounters").catch(() => null);
          await session.send("Performance.enable").catch(() => {});
          const raw = await session.send("Performance.getMetrics").catch(() => null);
          await session.send("Performance.disable").catch(() => {});
          if (raw?.metrics) {
            const pick = (key) => raw.metrics.find((metric) => metric.name === key)?.value;
            metrics = { jsHeapUsedMb: Math.round((pick("JSHeapUsedSize") ?? 0) / 1048576), jsHeapTotalMb: Math.round((pick("JSHeapTotalSize") ?? 0) / 1048576),
              frames: pick("Frames"), documents: pick("Documents"), eventListeners: pick("JSEventListeners"), layoutCount: pick("LayoutCount"), scriptDurationS: Math.round((pick("ScriptDuration") ?? 0) * 10) / 10 };
          }
        } catch { /* Firefox and WebKit report what the page itself can see */ }
      }
      const heap = metrics?.jsHeapUsedMb ?? value.jsHeapMb;
      const listeners = metrics?.eventListeners ?? counters?.jsEventListeners;
      const findings = [];
      if (heap !== null && heap !== undefined) findings.push(heap > 500 ? `JavaScript uses ${heap} MB: this page is heavy; reload it or close the tab when done` : heap > 200 ? `JavaScript uses ${heap} MB` : `JavaScript uses ${heap} MB, which is light`);
      if (value.domNodes > 3000) findings.push(`${value.domNodes} DOM elements: a long feed or table; scrolling it further keeps growing memory`);
      if (listeners > 10000) findings.push(`${listeners} event listeners: something keeps adding them`);
      if ((counters?.documents ?? 0) > 20) findings.push(`${counters.documents} documents are alive, often from iframes or pages left open`);
      return result({ pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), findings, page: value, ...(counters ? { counters } : {}), ...(metrics ? { metrics } : {}) });
    }
    if (name === "browser_devtools_css") {
      if (this.mainWorld || typeof this.context.newCDPSession !== "function") throw new Error("The full CSS cascade is read through Chromium's DevTools protocol; in Firefox and WebKit use browser_devtools_element with styles");
      if (typeof args.selector !== "string" || !args.selector) throw new Error("selector is required");
      const page = this.selectPage(args.pageId);
      const session = await this.cdp(page);
      await session.send("DOM.enable"); await session.send("CSS.enable");
      try {
        const { root } = await session.send("DOM.getDocument", { depth: 0 });
        const { nodeIds } = await session.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: args.selector });
        const index = integer(args.index, 0, 0);
        if (index >= nodeIds.length) throw new Error(`Selector matched ${nodeIds.length} elements in the main frame; index ${index} is unavailable`);
        const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId: nodeIds[index] });
        // What was written in the stylesheet when there is a source (not the longhands it expands to);
        // for the browser's own rules, every explicit property. Each declaration once.
        const declarations = (style) => {
          const properties = style?.cssProperties ?? [];
          const written = properties.filter((property) => property.text);
          const seen = new Set();
          return (written.length ? written : properties.filter((property) => !property.implicit && property.value)).flatMap((property) => {
            const value = String(property.value ?? "").replace(/\s*!important\s*$/i, "");
            const line = `${property.name}: ${value}${property.important || /!important\s*$/i.test(String(property.value)) ? " !important" : ""}${property.disabled ? " /* disabled */" : ""}`;
            if (seen.has(line)) return [];
            seen.add(line);
            return [line];
          });
        };
        const rules = (matched.matchedCSSRules ?? []).map((entry) => ({
          selector: entry.rule.selectorList?.text, origin: entry.rule.origin,
          ...(entry.rule.media?.length ? { media: entry.rule.media.map((media) => media.text) } : {}),
          ...(entry.rule.style?.range ? { line: entry.rule.style.range.startLine + 1 } : {}),
          ...(entry.rule.styleSheetId ? { styleSheetId: entry.rule.styleSheetId } : {}),
          declarations: declarations(entry.rule.style),
        })).reverse();
        const limit = integer(args.limit, 20, 1, 100);
        return result({ pageId: this.pageIds.get(page), selector: args.selector, matches: nodeIds.length, index,
          inline: declarations(matched.inlineStyle), attributes: declarations(matched.attributesStyle),
          rules: rules.slice(0, limit), totalRules: rules.length, inheritedFrom: (matched.inherited ?? []).filter((entry) => entry.matchedCSSRules?.length).length,
          note: "Rules are listed from the one that wins to the one that loses: for a property set in several rules, the first one listed applies (an !important declaration beats the others)." });
      } finally {
        await session.send("CSS.disable").catch(() => {}); await session.send("DOM.disable").catch(() => {});
      }
    }
    if (name === "browser_devtools_webauthn") {
      if (this.mainWorld || typeof this.context.newCDPSession !== "function") throw new Error("Virtual authenticators come from Chromium's DevTools protocol");
      if (!["add", "remove", "list"].includes(args.action)) throw new Error("action must be add, remove or list");
      const page = this.selectPage(args.pageId);
      const session = await this.cdp(page);
      const authenticators = this.authenticators.get(page) ?? [];
      if (args.action === "add") {
        await session.send("WebAuthn.enable", { enableUI: false });
        const u2f = args.protocol === "u2f";
        const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", { options: {
          protocol: u2f ? "u2f" : "ctap2", transport: ["internal", "usb", "nfc", "ble", "hybrid"].includes(args.transport) ? args.transport : "internal",
          hasResidentKey: u2f ? false : args.hasResidentKey !== false, hasUserVerification: u2f ? false : args.hasUserVerification !== false,
          isUserVerified: u2f ? false : args.isUserVerified !== false, automaticPresenceSimulation: true,
        } });
        authenticators.push(authenticatorId);
        this.authenticators.set(page, authenticators);
      } else if (args.action === "remove") {
        for (const id of authenticators) await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id }).catch(() => {});
        this.authenticators.delete(page);
        await session.send("WebAuthn.disable").catch(() => {});
        return result({ pageId: this.pageIds.get(page), authenticators: [] });
      }
      const list = [];
      for (const id of this.authenticators.get(page) ?? []) {
        const { credentials } = await session.send("WebAuthn.getCredentials", { authenticatorId: id }).catch(() => ({ credentials: [] }));
        // The private keys stay in the browser; only what identifies each credential is shown.
        list.push({ authenticatorId: id, credentials: credentials.map((credential) => ({ credentialId: credential.credentialId, rpId: credential.rpId, userHandle: credential.userHandle, signCount: credential.signCount, isResidentCredential: credential.isResidentCredential })) });
      }
      return result({ pageId: this.pageIds.get(page), authenticators: list });
    }
    if (name === "browser_devtools_wait") {
      const timeout = integer(args.timeoutMs, 15000, 500, 120000), idle = integer(args.idleMs, 500, 100, 10000);
      const since = args.since === undefined ? this.sequence : integer(args.since, 0, 0);
      const pageId = args.pageId ? this.pageIds.get(this.selectPage(args.pageId)) : undefined;
      const started = Date.now();
      const records = () => [...this.requests.values()].map((item) => item.data).filter((data) => (!pageId || data.pageId === pageId));
      // Streams and sockets never finish; a request pending for half a minute is treated the same way.
      const lingering = (data) => ["websocket", "eventsource"].includes(data.resourceType) || Date.now() - Date.parse(data.timestamp) > 30000;
      let quietSince = Date.now();
      const texts = Array.isArray(args.text) ? args.text.filter((item) => typeof item === "string" && item) : [];
      const target = texts.length ? this.selectPage(args.pageId) : undefined;
      while (Date.now() - started < timeout) {
        if (this.closed) throw new Error("This browser's developer session has closed");
        if (texts.length) {
          // Visible text by default, as a person would see it; hidden text only when asked.
          const found = await evaluate(target.mainFrame(), (input) => {
            const body = document.body;
            const text = body ? (input.visibleOnly ? body.innerText : body.textContent) : "";
            return input.texts.find((item) => text.includes(item)) ?? null;
          }, { texts, visibleOnly: args.visibleOnly !== false }, this.mainWorld).catch(() => null);
          if (found) return result({ matched: true, text: found, waitedMs: Date.now() - started, pageId: this.pageIds.get(target), cursor: this.sequence });
        } else if (args.urlIncludes) {
          const match = records().find((data) => data.sequence > since && ["finished", "failed"].includes(data.state) && data.url.includes(args.urlIncludes)
            && (!args.method || data.method === String(args.method).toUpperCase()) && (args.status === undefined || data.status === args.status));
          if (match) return result({ matched: true, waitedMs: Date.now() - started, request: match, cursor: this.sequence });
        } else {
          const busy = records().filter((data) => data.state === "pending" && !lingering(data)).length;
          if (busy) quietSince = Date.now();
          else if (Date.now() - quietSince >= idle) return result({ idle: true, waitedMs: Date.now() - started, cursor: this.sequence });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const pending = records().filter((data) => data.state === "pending" && !lingering(data)).slice(0, 10).map((data) => ({ requestId: data.requestId, url: data.url, resourceType: data.resourceType }));
      if (texts.length) throw new Error(`None of ${texts.map((item) => JSON.stringify(item)).join(", ")} appeared within ${timeout} ms`);
      throw new Error(args.urlIncludes
        ? `No request containing "${args.urlIncludes}" finished within ${timeout} ms`
        : `The network did not go quiet within ${timeout} ms; still loading: ${pending.map((item) => item.url).join(", ").slice(0, 600) || "nothing visible"}`);
    }
    throw new Error(`Unknown developer tool: ${name}`);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const emitter of [...this.listeners.keys()]) this.unlisten(emitter);
    if (this.routeHandler) { void this.context.unroute("**/*", this.routeHandler).catch(() => {}); this.routeHandler = undefined; }
    // Virtual authenticators belong to this session; the page's real ones come back.
    for (const [page, ids] of this.authenticators) void this.protocolSessions.get(page)?.then((session) => Promise.all(ids.map((id) => session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id }).catch(() => {})))).catch(() => {});
    this.authenticators.clear();
    for (const pending of this.protocolSessions.values()) void pending.then(session => session.detach()).catch(() => {});
    this.protocolSessions.clear();
    this.events.length = 0; this.requests.clear(); this.pages.clear(); this.frames.clear(); this.workers.clear();
  }
}

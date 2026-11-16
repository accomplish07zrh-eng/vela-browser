// One observer per persistent browser context. Nothing is injected into a page, and no browser
// option, preference, permission, route, fingerprint, cache or storage value is changed to observe it.
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { formatWithOptions } from "node:util";
import { runInNewContext } from "node:vm";
import { DevtoolsJournal, captureNativeNetwork } from "./devtools-live.mjs";
import { TRACE_PREFIX, addTracepoint, observeRuntimeSources, sourceMapData, sourceMapReference, originalPosition, generatedPosition } from "./devtools-sources.mjs";
import { compareSnapshots, domSnapshot } from "./devtools-dom.mjs";

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

const timeoutMs = { type: "integer", minimum: 1, maximum: 20000, default: 5000 };
const locatorPattern = schema({
  selector: string, role: string, name: { ...string, description: "Accessible name when using role." },
  label: string, text: string, testId: string,
  exact: { type: "boolean", default: true, description: "Use exact name, label or text matching." },
  index: { type: "integer", minimum: 0, description: "Zero-based match to use when a locator matches multiple elements." },
});
const elementTarget = schema({ ...locatorPattern.properties, within: locatorPattern, near: { ...string, description: "Text that must appear in the within container." } });
const elementStates = ["visible", "hidden", "attached", "detached"];
const locatorActions = {
  click: (locator, options) => locator.click(options),
  double_click: (locator, options) => locator.dblclick(options),
  fill: (locator, options, value) => locator.fill(value, options),
  press: (locator, options, value) => locator.press(value, options),
  check: (locator, options) => locator.check(options),
  uncheck: (locator, options) => locator.uncheck(options),
  select_option: (locator, options, value) => locator.selectOption(value, options),
  focus: (locator, options) => locator.focus(options),
  hover: (locator, options) => locator.hover(options),
  scroll_into_view: (locator, options) => locator.scrollIntoViewIfNeeded(options),
};

export const DEVTOOLS_TOOLS = [
  tool("browser_devtools_summary", "Inspect this profile's automatically recorded developer diagnostics: pages, console errors, failed requests, downloads and workers. Includes capture time and buffer eviction counts; no enable step is needed."),
  tool("browser_devtools_pages", "List this profile's pages, frames at every nesting depth, dedicated workers and service workers with stable ids. Each frame shows its depth and parent frame id. Use its frameId directly with developer tools, including for cross-origin frames."),
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
  tool("browser_devtools_stream", "Record live developer events and full WebSocket payloads to a disk journal. Chromium additionally observes passive SSE messages and streamed response bytes where CDP supplies them. In any engine fetch starts a streamed request through the selected frame with its real cookies, proxy and CORS rules. Read by nextCursor and retrieve any payload range by offset. Stop retains the recording, discard removes it.", {
    action: { type: "string", enum: ["start", "list", "read", "bytes", "fetch", "mark", "stop", "discard"] },
    pageId, frameId: string, captureId: string, urlIncludes: string, since: cursor, limit, waitMs: { type: "integer", minimum: 0, maximum: 20000 },
    offset: { type: "integer", minimum: 0 }, bytes: { type: "integer", minimum: 0, maximum: 1048576 },
    url: string, method: string, headers: { type: "object", additionalProperties: { type: "string" } },
    body: string, bodyBase64: string, credentials: { type: "string", enum: ["omit", "same-origin", "include"] },
    label: string, value: {}, screenshot: { type: "boolean" },
  }, ["action"], false),
  tool("browser_devtools_sources", "Index scripts, workers and matching requests in the selected page or frame. On Chromium index runtime-loaded code including eval, blobs and Wasm, read compiled source and source maps, and add non-pausing tracepoints in generated or original code. Trace values appear in developer events and the live journal. On other engines read loaded script tags and captured script or worker responses.", {
    action: { type: "string", enum: ["list", "read", "map", "trace_add", "trace_remove", "close"] },
    pageId, frameId: string, workerId: string, sourceId: string, traceId: string, urlIncludes: string,
    offset: { type: "integer", minimum: 0 }, limit, characters: { type: "integer", minimum: 1, maximum: 1048576 },
    line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 }, originalSource: string, expression: string,
  }, ["action"], false),
  tool("browser_devtools_evaluate", "Execute JavaScript in a specific page, iframe, dedicated worker or service worker of this profile, like the DevTools Console execution-context selector. expression may be a JavaScript expression or a function; argument is passed to a function. Returns the value and context ids. Existing browser identity and context are used.", {
    pageId, frameId: string, workerId: string, expression: string, argument: {},
  }, ["expression"], false),
  tool("browser_devtools_element", "Inspect a DOM element in a page or iframe: markup, text, attributes, bounding rectangle and requested computed CSS properties, without changing the DOM.", {
    pageId, frameId: string, selector: string, index: { type: "integer", minimum: 0, default: 0 },
    styles: { type: "array", items: string }, offset: { type: "integer", minimum: 0, default: 0 },
    characters: { type: "integer", minimum: 1, maximum: 1048576, default: 65536 },
  }, ["selector"]),
  tool("browser_devtools_page_inspect", "Read a page or iframe's accessibility tree, forms, child frames and DOM tree. Includes hidden nodes and field values, element attributes, comments, templates and open shadow roots by default. Readable text filters invisible fragments and flags unusual glyphs for visual comparison. The DOM tree gives each node an index and parent index. Pass frameId to inspect a deeply nested frame directly, or selector to narrow the inspection to a region.", {
    pageId, frameId: string, selector: string, offset: { type: "integer", minimum: 0, default: 0 },
    characters: { type: "integer", minimum: 1, maximum: 65536, default: 16000 }, timeoutMs,
    domOffset: { type: "integer", minimum: 0, default: 0, description: "Continue the DOM tree from dom.nextOffset." },
    hiddenOffset: { type: "integer", minimum: 0, default: 0, description: "Continue the hidden and data attribute index from hidden.nextOffset." },
    textOffset: { type: "integer", minimum: 0, default: 0, description: "Continue readable text from readableText.nextOffset." },
    nodeLimit: { type: "integer", minimum: 1, maximum: 100, default: 40, description: "Maximum entries per DOM or hidden result page." },
  }),
  tool("browser_devtools_anchor", "Capture a portable semantic locator and its complete iframe ancestry from the current DOM. Use the returned anchor with browser_devtools_action after a rerender, frame replacement, or reconnect. Ambiguous replacements require a narrower locator.", {
    pageId, frameId: string, target: elementTarget, timeoutMs,
  }, ["target"]),
  tool("browser_devtools_dom_delta", "Capture a scoped DOM snapshot or compare it with baselineId. Includes hidden nodes, form values, comments, templates and open shadow roots. Read a frozen result by snapshotId and offset to page through changes while the live DOM keeps rendering.", {
    action: { type: "string", enum: ["take", "read", "discard"] },
    pageId, frameId: string, selector: string, baselineId: string, snapshotId: string,
    offset: { type: "integer", minimum: 0 }, limit, timeoutMs,
  }, ["action"]),
  tool("browser_devtools_action", "Operate a uniquely located element by semantics, selector or a portable anchor. Verify a fresh response, popup, navigation, visible text or an element state. Event observers are registered before the action. Action completion and verification have separate results, with correlated evidence.", {
    pageId, frameId: string, action: { type: "string", enum: Object.keys(locatorActions) }, target: elementTarget, anchor: { type: "object", additionalProperties: true },
    value: { description: "Text for fill, a key for press, or one or more option values for select_option.", oneOf: [string, { type: "array", items: string }] },
    timeoutMs,
    verify: schema({
      text: { ...string, description: "Visible text to wait for in the action's frame." },
      urlIncludes: { ...string, description: "Substring of the top-level page URL to wait for." },
      target: elementTarget, state: { type: "string", enum: elementStates }, timeoutMs,
      response: schema({ urlIncludes: string, method: string, status: { type: "integer" } }, ["urlIncludes"]),
      popup: schema({ urlIncludes: string }),
      navigation: schema({ urlIncludes: string, scope: { type: "string", enum: ["frame", "page"] } }, ["urlIncludes"]),
    }),
  }, ["action"], false),
  tool("browser_devtools_program", "Run an async JavaScript function with the selected profile's native Playwright page, frame, context or worker. The function receives {page, frame, context, worker, devtools, argument}. Use devtools.call for existing tools, devtools.capture(async () => ...) for correlated HTTP, WebSocket and console records, and devtools.bytes(requestId, part) for recorded binary bodies. Use standard JavaScript, Buffer, Web Crypto and compression streams to decode or transform captured data and act on the same page. Function results and program console logs are returned.", {
    pageId, frameId: string, workerId: string,
    code: { ...string, description: "An async function such as async ({ frame, argument }) => await frame.locator(argument).textContent()." },
    argument: {},
  }, ["code"], false),
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
  try {
    if (value instanceof Date) return { type: "date", value: value.toISOString() };
    if (value instanceof RegExp) return { type: "regexp", value: String(value) };
    if (value instanceof Map) return { type: "map", entries: [...value].map(([k, v], i) => [json(k, seen, `${path}.${i}.key`), json(v, seen, `${path}.${i}.value`)]) };
    if (value instanceof Set) return { type: "set", values: [...value].map((v, i) => json(v, seen, `${path}.${i}`)) };
    if (Array.isArray(value)) return value.map((v, i) => json(v, seen, `${path}[${i}]`));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, seen, `${path}.${k}`)]));
  } finally { seen.delete(value); }
}
/** A URL glob as DevTools writes them: ** crosses slashes, * stays within one part, ? is one character. */
function globToRegExp(glob) {
  return new RegExp("^" + glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".") + "$", "i");
}
function result(value) {
  const normalized = json(value);
  return { content: [{ type: "text", text: JSON.stringify(normalized) }], structuredContent: normalized };
}
function errorText(error) { return typeof error?.message === "string" ? error.message : String(error); }

function elementLocator(frame, target) {
  const keys = ["selector", "role", "label", "text", "testId"].filter(key => target?.[key] !== undefined);
  const key = keys[0], value = target?.[key];
  if (keys.length !== 1 || typeof value !== "string" || !value.trim()) {
    throw new Error("Choose one non-empty locator: selector, role, label, text or testId");
  }
  if (target.name !== undefined && (key !== "role" || typeof target.name !== "string")) {
    throw new Error("An accessible name is only supported with role");
  }
  let root = frame;
  if (target.within) {
    root = elementLocator(frame, target.within);
    if (target.within.index !== undefined) root = root.nth(integer(target.within.index, 0, 0));
    if (target.near !== undefined) root = root.filter({ hasText: target.near });
  } else if (target.near !== undefined) throw new Error("near requires a within locator");
  const exact = target.exact !== false;
  switch (key) {
    case "selector": return root.locator(value);
    case "role": return root.getByRole(value, { ...(target.name === undefined ? {} : { name: target.name }), exact });
    case "label": return root.getByLabel(value, { exact });
    case "text": return root.getByText(value, { exact });
    case "testId": return root.getByTestId(value);
  }
}

function urlPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.href.split("#", 1)[0] : parsed.origin + parsed.pathname;
  } catch { return url; }
}

function elementIdentity(element) {
  const text = value => (value || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const form = element.form ?? element.closest("form");
  return {
    tag: element.localName, type: element.getAttribute("type") || "", name: element.getAttribute("name") || "",
    testId: element.getAttribute("data-testid") || "", text: text(element.textContent),
    label: text(element.getAttribute("aria-label")) || text(Array.from(element.labels || [], label => label.textContent).join(" ")),
    formLabel: form?.getAttribute("aria-label") || "", formName: form?.getAttribute("name") || "",
  };
}

function stableCandidate(expected, current, candidate) {
  if (expected.tag !== current.tag || expected.type !== current.type) return false;
  if (expected.formLabel && expected.formLabel !== current.formLabel || expected.formName && expected.formName !== current.formName) return false;
  if (candidate.testId !== undefined) return true;
  return (!expected.name || expected.name === current.name) && (!expected.label || expected.label === current.label)
    && (!expected.text || expected.text === current.text);
}

function verifyAction(page, frame, verify) {
  if (verify === undefined) return undefined;
  if (!verify || typeof verify !== "object" || Array.isArray(verify)
    || [verify.text, verify.urlIncludes, verify.target, verify.response, verify.popup, verify.navigation].filter(value => value !== undefined).length !== 1) {
    throw new Error("Verification requires one condition");
  }
  const timeout = integer(verify.timeoutMs, 5000, 1, 20000);
  if (verify.target !== undefined) {
    const state = verify.state ?? "visible";
    if (!elementStates.includes(state)) throw new Error("Unknown verification state");
    const locator = elementLocator(frame, verify.target);
    const target = verify.target.index === undefined ? locator : locator.nth(integer(verify.target.index, 0, 0));
    return () => target.waitFor({ state, timeout });
  }
  if (verify.state !== undefined) throw new Error("Verification state requires a target");
  if (verify.response !== undefined || verify.popup !== undefined || verify.navigation !== undefined) return undefined;
  if (verify.urlIncludes !== undefined) {
    if (typeof verify.urlIncludes !== "string" || !verify.urlIncludes.trim()) throw new Error("urlIncludes must be non-empty");
    return () => page.waitForURL(url => url.href.includes(verify.urlIncludes), { waitUntil: "commit", timeout });
  }
  if (typeof verify.text !== "string" || !verify.text.trim()) throw new Error("Verification text must be non-empty");
  return () => frame.getByText(verify.text).filter({ visible: true }).first().waitFor({ state: "visible", timeout });
}

/** Serialized by Playwright to the selected frame. */
function pageOutline(element, { wholeDocument, domOffset, hiddenOffset, nodeLimit, textOffset, characters }) {
  const doc = element.ownerDocument;
  const text = value => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const visible = item => item.getClientRects().length > 0
    && doc.defaultView.getComputedStyle(item).visibility === "visible"
    && !item.closest('[aria-hidden="true"]');
  const labelOf = item => {
    const labelledBy = item.getAttribute("aria-labelledby")?.trim();
    const root = item.getRootNode();
    const referenced = labelledBy?.split(/\s+/).map(id => root.getElementById?.(id)?.textContent).filter(Boolean).join(" ");
    return text(referenced || item.getAttribute("aria-label") || Array.from(item.labels ?? [], label => label.textContent).join(" "));
  };
  const dom = [], hidden = [], forms = [];
  const range = doc.createRange();
  const view = doc.defaultView;
  let readable = "", readableLength = 0, formatControls = 0, unusualGlyphs = 0;
  const addReadable = node => {
    const parent = node.parentElement ?? node.parentNode?.host;
    if (!node.nodeValue?.trim() || !parent) return;
    const style = view.getComputedStyle(parent);
    if (style.fontSize === "0px" || (style.color === "rgba(0, 0, 0, 0)" && style.textShadow === "none" && style.backgroundClip !== "text")) return;
    if ((style.clip ?? "").replace(/\s/g, "") === "rect(0px,0px,0px,0px)" || /^inset\(50%\)$/.test(style.clipPath)) return;
    range.selectNodeContents(node);
    if (!Array.from(range.getClientRects?.() ?? []).some(rect => rect.width >= 0.5 && rect.height >= 0.5
      && rect.right + view.scrollX > 0 && rect.bottom + view.scrollY > 0)) return;

    const raw = node.nodeValue;
    const formatted = raw.replace(/[\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu, "");
    formatControls += raw.length - formatted.length;
    unusualGlyphs += (formatted.match(/[\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu) ?? []).length;
    const clean = formatted.normalize("NFC").replace(/\s+/gu, " ").trim();
    if (!clean) return;
    const segment = readableLength ? `\n${clean}` : clean;
    const next = readableLength + segment.length;
    if (next > textOffset && readable.length < characters) {
      readable += segment.slice(Math.max(0, textOffset - readableLength), textOffset + characters - readableLength);
    }
    readableLength = next;
  };
  let domIndex = 0, hiddenIndex = 0;
  const pending = [{ node: wholeDocument ? doc : element, parentIndex: null, depth: 0, inherited: null }];
  while (pending.length) {
    const { node, parentIndex, depth, inherited } = pending.pop();
    const index = domIndex++;
    const isElement = node.nodeType === 1;
    const tag = isElement ? node.localName : node.host ? "#shadow-root" : node.nodeName;
    const attrs = isElement ? Array.from(node.attributes) : [];
    const isHiddenInput = tag === "input" && node.type === "hidden";
    let hiddenBy = inherited;
    if (!hiddenBy && isElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (isHiddenInput) hiddenBy = "hidden input";
      else if (node.hasAttribute("hidden")) hiddenBy = "hidden attribute";
      else if (node.getAttribute("aria-hidden") === "true") hiddenBy = "aria-hidden";
      else if (node.hasAttribute("inert")) hiddenBy = "inert";
      else if (style.display === "none") hiddenBy = "display: none";
      else if (style.visibility === "hidden" || style.visibility === "collapse") hiddenBy = `visibility: ${style.visibility}`;
      else if (style.contentVisibility === "hidden") hiddenBy = "content-visibility: hidden";
      else if (style.opacity === "0") hiddenBy = "opacity: 0";
    }
    if (tag === "form" && !hiddenBy && visible(node)) forms.push(node);
    if (node.nodeType === 3 && !hiddenBy) addReadable(node);
    const hasData = attrs.some(attr => attr.name.startsWith("data-"));
    const dataScript = tag === "script" && /json|importmap/i.test(node.type);
    const namedHidden = hiddenBy && isElement && !["head", "script", "style", "link"].includes(tag)
      && (node.id || node.hasAttribute("hidden") || node.hasAttribute("aria-hidden") || node.hasAttribute("inert")
        || Array.from(node.childNodes).some(child => child.nodeType === 3 && child.nodeValue?.trim()));
    const notable = hasData || (hiddenBy && (isHiddenInput || tag === "meta" || dataScript || namedHidden));
    const inDomPage = index >= domOffset && dom.length < nodeLimit;
    const inHiddenPage = notable && hiddenIndex++ >= hiddenOffset && hidden.length < nodeLimit;
    if (inDomPage || inHiddenPage) {
      const description = { index, parentIndex, depth, tag, nodeType: node.nodeType, ...(hiddenBy ? { hiddenBy } : {}) };
      if (attrs.length) {
        description.attributes = Object.fromEntries(attrs.slice(0, 24).map(attr => [attr.name, attr.value.slice(0, 256)]));
        description.attributesTruncated = attrs.length > 24 || attrs.some(attr => attr.value.length > 256);
      }
      const rawText = node.nodeValue;
      if (rawText) {
        description.text = rawText.slice(0, 1024);
        description.textCharacters = rawText.length;
      }
      if (["input", "textarea", "select"].includes(tag) && typeof node.value === "string") {
        description.value = node.value.slice(0, 1024);
        description.valueCharacters = node.value.length;
        if (tag === "input" && ["radio", "checkbox"].includes(node.type)) description.checked = node.checked;
        if (tag === "select" && node.multiple) {
          description.selectedValues = Array.from(node.selectedOptions).slice(0, 32).map(option => option.value.slice(0, 256));
          description.selectedCount = node.selectedOptions.length;
        }
      }
      if (inDomPage) dom.push(description);
      if (inHiddenPage) {
        const content = isElement && hiddenBy ? node.textContent : null;
        hidden.push({ ...description,
          ...(description.attributes ? { attributes: { ...description.attributes } } : {}),
          ...(description.selectedValues ? { selectedValues: [...description.selectedValues] } : {}),
          ...(content ? { text: content.slice(0, 1024), textCharacters: content.length } : {}),
          ...(hasData ? { dataAttributes: Object.fromEntries(attrs.filter(attr => attr.name.startsWith("data-")).slice(0, 12).map(attr => [attr.name, attr.value.slice(0, 256)])) } : {}),
        });
      }
    }
    const children = Array.from(node.childNodes);
    if (isElement && node.shadowRoot) children.push(node.shadowRoot);
    if (tag === "template" && node.content) children.push(node.content);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      // CSS visibility can be overridden by a descendant. The other hidden states affect the subtree.
      const collapsed = tag === "details" && !node.open && child.localName !== "summary";
      const childHidden = tag === "template" ? "template" : collapsed ? "collapsed details" : hiddenBy?.startsWith("visibility:") ? null : hiddenBy;
      pending.push({ node: child, parentIndex: index, depth: depth + 1, inherited: childHidden });
    }
  }
  const nodePage = (nodes, offset, total) => ({ nodes, offset, total, nextOffset: offset + nodes.length, hasMore: offset + nodes.length < total });
  return {
    title: doc.title, language: doc.documentElement.lang, readyState: doc.readyState,
    dom: nodePage(dom, domOffset, domIndex), hidden: nodePage(hidden, hiddenOffset, hiddenIndex),
    readableText: { text: readable, offset: textOffset, nextOffset: textOffset + readable.length, totalCharacters: readableLength,
      hasMore: textOffset + readable.length < readableLength, formatControls, unusualGlyphs },
    formCount: forms.length,
    forms: forms.slice(0, 8).map(form => {
      const fields = Array.from(form.elements).filter(item => item.matches('input:not([type="hidden"]), select, textarea, button') && visible(item));
      return {
        label: labelOf(form), name: text(form.name), method: form.method, fieldCount: fields.length,
        fields: fields.slice(0, 20).map(field => ({
          label: labelOf(field), name: text(field.name), type: field.type, placeholder: text(field.getAttribute("placeholder")),
          required: !!field.required || field.getAttribute("aria-required") === "true",
          disabled: field.matches(":disabled") || !!field.closest('[aria-disabled="true"]'),
          readOnly: !!field.readOnly || field.getAttribute("aria-readonly") === "true",
          invalid: field.validity?.valid === false || (field.hasAttribute("aria-invalid") && field.getAttribute("aria-invalid") !== "false"),
        })),
      };
    }),
  };
}

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
  /** @param {{ engine?: "chromium" | "firefox" | "webkit", maxEvents?: number, maxRequests?: number, maxEventBytes?: number }} [options] */
  constructor(context, options = {}) {
    const { engine, maxEvents = 2000, maxRequests = 1000, maxEventBytes = 8 * 1024 * 1024 } = options;
    this.context = context;
    this.engine = engine ?? context.browser?.()?.browserType?.().name();
    this.mainWorld = engine === "firefox";
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.captures = new Map();
    this.observers = new Set();
    this.popupOpeners = new WeakMap();
    this.runtimeSources = new Map();
    this.sourceSessions = new Map();
    this.tracepoints = new Map();
    this.domSnapshots = new Map();
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
      this.publish({ kind: "request-response", ...item.data });
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
  publish(entry, payload) {
    for (const observe of this.observers) observe(entry);
    for (const capture of this.captures.values()) capture.append(entry, payload);
  }
  log(kind, page, value = {}, payload) {
    const entry = { id: `${this.id}-event-${++this.sequence}`, sequence: this.sequence, timestamp: new Date().toISOString(), kind,
      ...(page ? { pageId: this.pageIds.get(page), pageUrl: page.url() } : {}), ...value };
    this.publish(entry, payload);
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
    this.listen(page, "popup", popup => {
      this.watchPage(popup);
      this.popupOpeners.set(popup, page);
      this.log("popup-opened", page, { popupPageId: this.pageIds.get(popup), url: popup.url() });
    });
    this.listen(page, "framedetached", frame => {
      this.frames.delete(this.frameIds.get(frame));
      this.closeTargetSource(frame);
      for (const capture of this.captures.values()) {
        const pending = capture.native.get(frame);
        capture.native.delete(frame);
        void pending?.then(session => session?.detach()).catch(() => {});
      }
    });
    this.listen(page, "framenavigated", frame => {
      const frameId = this.frameId(frame, page);
      const opener = this.popupOpeners.get(page);
      this.log("navigation", page, { frameId, url: frame.url(), ...(opener && frame === page.mainFrame() ? { openerPageId: this.pageIds.get(opener), popupPageId: this.pageIds.get(page) } : {}) });
      if (frame !== page.mainFrame()) for (const capture of this.captures.values()) void this.attachNative(capture, page, frame);
    });
    this.listen(page, "console", message => {
      const text = message.text(), location = message.location();
      if (text.startsWith(TRACE_PREFIX)) {
        const separator = text.indexOf(" ");
        const traceId = text.slice(TRACE_PREFIX.length, separator < 0 ? undefined : separator);
        const trace = this.tracepoints.get(traceId);
        if (trace) {
          const raw = separator < 0 ? "undefined" : text.slice(separator + 1);
          let value;
          try { value = JSON.parse(raw); } catch { value = raw; }
          this.log("source-trace", page, { traceId, sourceId: trace.sourceId, text: raw, location, value });
        }
      }
      this.log("console", page, { type: message.type(), text, location });
    });
    this.listen(page, "pageerror", error => this.log("exception", page, { type: "error", name: error.name, text: error.message, stack: error.stack }));
    this.listen(page, "crash", () => this.log("crash", page, { type: "error", text: "Page renderer crashed" }));
    this.listen(page, "websocket", socket => {
      this.emitterPages.set(socket, page);
      const socketId = `${this.id}-socket-${++this.counters.socket}`;
      this.log("websocket-open", page, { socketId, url: socket.url() });
      for (const [event, kind] of [["framesent", "websocket-sent"], ["framereceived", "websocket-received"]]) this.listen(socket, event, frame => {
        if (Buffer.isBuffer(frame.payload)) {
          const preview = chunk(frame.payload, {});
          this.log(kind, page, { socketId, url: socket.url(), binary: true, ...preview, truncated: frame.payload.length > 65536 }, frame.payload);
          return;
        }
        // A text frame arrives as a string. Cutting it by characters keeps it exact, so it needs
        // no base64 copy; that halves what each frame costs in the shared history.
        const text = String(frame.payload), kept = text.slice(0, 65536), returnedBytes = Buffer.byteLength(kept), totalBytes = Buffer.byteLength(text);
        this.log(kind, page, { socketId, url: socket.url(), binary: false, encoding: "text", text: kept, totalBytes, totalCharacters: text.length,
          returnedBytes, hasMore: kept.length < text.length, truncated: kept.length < text.length }, this.captures.size ? Buffer.from(text, "utf8") : undefined);
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
      for (const [frameId, item] of this.frames) if (item.page === page) {
        this.frames.delete(frameId); this.closeTargetSource(item.frame);
      }
      this.closeTargetSource(page);
      for (const [workerId, item] of this.workers) if (item.page === page) this.workers.delete(workerId);
      const protocol = this.protocolSessions.get(page);
      if (protocol) void protocol.then(session => session.detach()).catch(() => {});
      this.protocolSessions.delete(page);
      for (const emitter of [...this.listeners.keys()]) if (this.emitterPages.get(emitter) === page) this.unlisten(emitter);
      this.unlisten(page);
      for (const capture of this.captures.values()) {
        for (const [target, pending] of capture.native) {
          if (target !== page && target.page?.() !== page) continue;
          capture.native.delete(target);
          void pending.then(session => session?.detach()).catch(() => {});
        }
      }
    });
    this.log("page-opened", page);
    for (const capture of this.captures.values()) void this.attachNative(capture, page);
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
    item.data.startedSequence = item.data.sequence;
    this.requests.set(id, item);
    this.publish({ kind: "request-started", ...item.data });
    if ([...this.captures.values()].some(capture => capture.live && capture.accepts(item.data))) {
      const body = request.postDataBuffer();
      if (body?.length) this.publish({ kind: "request-upload", ...item.data }, body);
    }
    while (this.requests.size > this.maxRequests) { this.requests.delete(this.requests.keys().next().value); this.droppedRequests++; }
    return item;
  }
  finishRequest(request, page, failure) {
    const item = this.watchRequest(request, page);
    if (!item) return; // an old request may finish after its history entry was evicted
    Object.assign(item.data, { sequence: ++this.sequence, state: failure ? "failed" : "finished", finishedAt: new Date().toISOString(),
      ...(failure ? { failure } : {}), timing: request.timing() });
    this.publish({ kind: failure ? "request-failed" : "request-finished", ...item.data });
    const captures = [...this.captures.values()].filter(capture => capture.live && capture.accepts(item.data));
    if (!failure && item.response && captures.length) void item.response.body().then(body => {
      for (const capture of captures) capture.append({ kind: "response-body", ...item.data }, body);
    }, error => {
      for (const capture of captures) capture.append({ kind: "response-body-unavailable", ...item.data, error: errorText(error) });
    });
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
  describeFrame(frame, page) {
    const parent = frame.parentFrame();
    let depth = 0;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parentFrame()) depth++;
    return { frameId: this.frameId(frame, page), url: frame.url(), name: frame.name(), main: frame === page.mainFrame(),
      parentFrameId: parent ? this.frameId(parent, page) : null, depth };
  }
  async pageList() {
    return { captureStartedAt: this.startedAt, pages: await Promise.all([...this.pages].map(async ([id, page]) => ({
      pageId: id, url: page.url(), title: await page.title().catch(() => ""),
      frames: (page.frames?.() ?? []).map(frame => this.describeFrame(frame, page)),
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


  closeTargetSource(target) {
    const pending = this.sourceSessions.get(target);
    this.sourceSessions.delete(target);
    void pending?.then(holder => holder?.close()).catch(() => {});
  }
  observeSources(page, frame) {
    const target = frame ?? page;
    if (this.sourceSessions.has(target)) return this.sourceSessions.get(target);
    const scope = { pageId: this.pageIds.get(page), frameId: this.frameId(frame ?? page.mainFrame(), page) };
    const pending = observeRuntimeSources(this.context, target, scope, this.runtimeSources, this.tracepoints).catch(error => {
      this.sourceSessions.delete(target);
      if (!frame) return { error: errorText(error) };
    });
    this.sourceSessions.set(target, pending);
    return pending;
  }
  sourceRequests(url) {
    return [...this.requests.values()].filter(item => item.data.url === url);
  }
  async loadedResource(frame, url) {
    const entries = this.sourceRequests(url);
    for (const entry of entries.reverse()) {
      if (entry.data.state !== "finished" || !entry.response) continue;
      try {
        return { content: (await entry.response.body()).toString("utf8"), requestId: entry.data.requestId };
      } catch {}
    }
    if (!frame || frame.isDetached?.()) throw new Error("This resource was not captured and its source frame is unavailable");
    const content = await evaluate(frame, async url => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error(`Resource returned HTTP ${response.status}`);
      return response.text();
    }, url, this.mainWorld);
    return { content, fetched: true };
  }
  async sourceContent(record) {
    if (record.script) {
      const value = await record.holder.session.send("Debugger.getScriptSource", { scriptId: record.script.scriptId });
      return { content: value.bytecode ?? value.scriptSource, encoding: value.bytecode === undefined ? "text" : "base64" };
    }
    if (record.transport === "dom" && !record.external) {
      const tag = record.frame.locator("script").nth(record.index);
      const script = await tag.evaluate(element => ({ text: element.textContent, id: element.id, external: element.hasAttribute("src") }));
      const text = script.text ?? "";
      if (record.frame.url() !== record.documentUrl || script.external || script.id !== record.elementId || text.length !== record.length
        || text.slice(0, 96) !== record.head || text.slice(-96) !== record.tail) throw new Error("The script changed; refresh the source index");
      return { content: text, encoding: "text" };
    }
    return { ...(await this.loadedResource(record.frame, record.url)), encoding: "text" };
  }
  async sourceMap(record) {
    const source = record.script?.sourceMapURL ? undefined : await this.sourceContent(record);
    const reference = record.script?.sourceMapURL || sourceMapReference(source.content);
    if (!reference) return null;
    if (reference.startsWith("data:")) return { content: sourceMapData(reference), inline: true };
    const frame = record.frame ?? record.holder?.target.mainFrame?.() ?? record.holder?.target;
    const url = new URL(reference, record.url || record.script?.url || frame.url()).href;
    return { ...(await this.loadedResource(frame, url)), url };
  }
  async sources(args) {
    if (args.action === "close") {
      for (const target of this.sourceSessions.keys()) {
        const page = target.page?.() ?? target;
        if (!args.pageId || args.pageId === this.pageIds.get(page)) this.closeTargetSource(target);
      }
      for (const [id, record] of this.runtimeSources) if (!record.script && (!args.pageId || args.pageId === record.pageId)) this.runtimeSources.delete(id);
      return { closed: true };
    }
    if (args.action === "trace_remove") {
      const point = this.tracepoints.get(args.traceId);
      if (!point) throw new Error("Unknown traceId in this profile");
      await point.holder.session.send("Debugger.removeBreakpoint", { breakpointId: point.breakpointId });
      this.tracepoints.delete(args.traceId);
      return { traceId: args.traceId, removed: true };
    }
    if (args.action === "list") {
      const worker = args.workerId ? this.workers.get(args.workerId) : undefined;
      if (args.workerId && !worker) throw new Error("Unknown workerId in this profile");
      const selected = worker ? { page: worker.page, frame: worker.page?.mainFrame() } : this.selectFrame(args);
      const { page, frame } = selected;
      const pageId = page && this.pageIds.get(page), native = [];
      const frames = worker ? [] : args.frameId ? [frame] : page.frames();
      if (this.engine === "chromium" && !worker) {
        const sessions = await Promise.all([this.observeSources(page), ...frames.filter(frame => frame !== page.mainFrame()).map(frame => this.observeSources(page, frame))]);
        for (const session of sessions) if (session?.error) native.push(session.error);
      }
      for (const [id, record] of this.runtimeSources) {
        if (record.transport === "network" && !this.requests.has(id.slice("request-".length))) this.runtimeSources.delete(id);
        if (record.workerId && !this.workers.has(record.workerId)) this.runtimeSources.delete(id);
        if (!record.script && record.pageId === pageId && !record.workerId && frames.includes(record.frame)) this.runtimeSources.delete(id);
      }
      for (const owner of frames) {
        const frameId = this.frameId(owner, page), documentUrl = owner.url();
        const scripts = await owner.locator("script").evaluateAll(elements => elements.map((element, index) => {
          const text = element.textContent ?? "", external = element.hasAttribute("src");
          return { index, elementId: element.id, type: element.type, external, url: external ? element.src : "",
            length: text.length, head: text.slice(0, 96), tail: text.slice(-96) };
        })).catch(() => []);
        for (const script of scripts) {
          const sourceId = createHash("sha256").update(JSON.stringify([frameId, documentUrl, script])).digest("hex");
          this.runtimeSources.set(sourceId, { ...script, sourceId, pageId, frameId, transport: "dom", frame: owner, documentUrl,
            url: script.url || documentUrl });
        }
      }
      const workers = [...this.workers.entries()].filter(([id, item]) => worker ? id === args.workerId : item.page === page || !item.page);
      const workerUrls = new Map();
      for (const [workerId, item] of workers) {
        const url = item.worker.url(), ownerId = item.page && this.pageIds.get(item.page);
        const sourceId = "worker-" + workerId;
        workerUrls.set(url, workerId);
        this.runtimeSources.set(sourceId, { sourceId, pageId: ownerId, workerId, url, transport: item.type, frame });
      }
      for (const item of this.requests.values()) {
        const data = item.data;
        if (worker ? data.url !== worker.worker.url() : data.pageId !== pageId || !(data.resourceType === "script" || workerUrls.has(data.url))) continue;
        const sourceId = "request-" + data.requestId;
        this.runtimeSources.set(sourceId, { sourceId, pageId: data.pageId, frameId: data.frameId, workerId: workerUrls.get(data.url), url: data.url,
          transport: "network", frame: this.frames.get(data.frameId)?.frame ?? frame });
      }
      const matches = [...this.runtimeSources.values()].filter(record => {
        if (worker ? record.workerId !== args.workerId : record.pageId !== pageId && record.transport !== "serviceworker") return false;
        if (args.frameId && record.frameId !== args.frameId && record.script?.executionContextAuxData?.isDefault === false) return false;
        if (args.frameId && !record.script && record.frameId !== args.frameId) return false;
        return !args.urlIncludes || (record.url ?? record.script?.url ?? "").includes(args.urlIncludes);
      });
      const offset = integer(args.offset, 0, 0);
      const records = matches.slice(offset, offset + integer(args.limit, 100, 1, 500)).map(record => ({
        sourceId: record.sourceId, pageId: record.pageId, frameId: record.frameId, workerId: record.workerId,
        transport: record.transport, url: record.url ?? record.script?.url ?? "", inline: record.transport === "dom" ? !record.external : undefined,
        type: record.type, ...(record.script ? { executionContextId: record.script.executionContextId, hash: record.script.hash,
          nativeFrameId: record.script.executionContextAuxData?.frameId, startLine: record.script.startLine + 1, startColumn: record.script.startColumn + 1,
          hasSourceMap: !!record.script.sourceMapURL, language: record.script.scriptLanguage } : {}),
        requestIds: this.sourceRequests(record.url ?? record.script?.url).filter(item => !record.pageId || item.data.pageId === record.pageId).map(item => item.data.requestId),
      }));
      return { records, nextOffset: offset + records.length, total: matches.length, hasMore: offset + records.length < matches.length, nativeErrors: native };
    }
    const record = this.runtimeSources.get(args.sourceId);
    if (!record) throw new Error("Unknown or expired sourceId; refresh browser_devtools_sources list");
    const offset = integer(args.offset, 0, 0), size = integer(args.characters, 65536, 1, 1048576);
    const lines = (content, extra) => ({ sourceId: args.sourceId, ...extra, text: content.slice(offset, offset + size), offset,
      nextOffset: Math.min(content.length, offset + size), totalCharacters: content.length, hasMore: offset + size < content.length });
    if (args.action === "read") {
      const { content, ...meta } = await this.sourceContent(record);
      return lines(content ?? "", meta);
    }
    if (args.action === "map") {
      const map = await this.sourceMap(record);
      if (!map) return { sourceId: args.sourceId, map: null };
      const { content, ...meta } = map;
      const startLine = record.script?.startLine ?? 0, startColumn = record.script?.startColumn ?? 0;
      const line = integer(args.line, undefined, 1);
      const column = integer(args.column, 1, 1);
      return lines(content, { ...meta, ...(line === undefined ? {} : { original: originalPosition(JSON.parse(content), line - startLine, column - (line === startLine + 1 ? startColumn : 0)) }) });
    }
    if (args.action === "trace_add") {
      if (!record.script) throw new Error("Runtime tracepoints require a Chromium CDP source");
      if (typeof args.expression !== "string" || !args.expression.trim()) throw new Error("trace_add requires an expression");
      let line = integer(args.line, 0, 1), column = integer(args.column, 1, 1);
      if (!line) throw new Error("trace_add requires a line");
      if (args.originalSource !== undefined) {
        const map = await this.sourceMap(record);
        if (!map) throw new Error("The source has no usable source map");
        const position = generatedPosition(JSON.parse(map.content), args.originalSource, line, column);
        if (!position) throw new Error("No compiled location matched the original position");
        line = position.generatedLine + record.script.startLine;
        column = position.generatedColumn + (position.generatedLine === 1 ? record.script.startColumn : 0);
      }
      const point = await addTracepoint(record, line, column, args.expression);
      this.tracepoints.set(point.id, { ...point, sourceId: args.sourceId });
      return { traceId: point.id, sourceId: args.sourceId, line: point.actualLocation.lineNumber + 1, column: point.actualLocation.columnNumber + 1 };
    }
    throw new Error("Unknown source operation");
  }
  getCapture(id) {
    const capture = this.captures.get(id);
    if (!capture) throw new Error("Unknown captureId in this profile");
    return capture;
  }
  attachNative(capture, page, frame) {
    if (this.engine !== "chromium" || !capture.live || (capture.settings.pageId && this.pageIds.get(page) !== capture.settings.pageId)) return;
    const target = frame ?? page;
    if (capture.native.has(target)) return capture.native.get(target);
    const scope = { pageId: this.pageIds.get(page), ...(frame ? { frameId: this.frameId(frame, page) } : {}) };
    const pending = captureNativeNetwork(this.context, target, capture, scope).catch(error => {
      capture.native.delete(target);
      // Same-process frames share the parent session, which already captures their requests.
      if (!frame) capture.append({ ...scope, kind: "native-capture-unavailable", error: errorText(error) });
    });
    capture.native.set(target, pending);
    return pending;
  }
  async *watchCapture(id, options = {}) {
    const capture = this.getCapture(id);
    let since = integer(options.since, 0, 0);
    const limit = integer(options.limit, 100, 1, 500), waitMs = integer(options.waitMs, 1000, 1, 20000);
    for (;;) {
      if (options.signal?.aborted) return;
      const update = await capture.read(since, limit, waitMs, options.signal);
      if (options.signal?.aborted) return;
      since = update.nextCursor;
      yield* update.records;
      if (!update.active && !update.hasMore) return;
    }
  }
  async captureFetch(capture, args) {
    if (!capture.live) throw new Error("Start an active capture before fetching");
    if (typeof args.url !== "string" || !args.url) throw new Error("url is required");
    const { page, frame } = this.selectFrame(args);
    const pageId = this.pageIds.get(page);
    if (capture.settings.pageId && capture.settings.pageId !== pageId) throw new Error("Choose a frame in the captured page");
    const scope = { pageId, frameId: this.frameId(frame, page), fetchId: randomUUID(), url: new URL(args.url, frame.url()).href, transport: "fetch" };
    const method = args.method ?? "GET", key = "__vela_stream_" + scope.fetchId;
    if (!capture.accepts(scope)) throw new Error("The request URL does not match this capture's filter");
    const abort = () => evaluate(frame, id => {
      globalThis[id]?.controller.abort();
      delete globalThis[id];
    }, key, this.mainWorld).catch(() => {});
    capture.fetches.set(scope.fetchId, abort);
    void (async () => {
      try {
        capture.append({ ...scope, kind: "fetch-started", method });
        const response = await evaluate(frame, async input => {
          const controller = new AbortController();
          const state = { controller, reader: null, pending: null };
          globalThis[input.key] = state;
          const response = await fetch(input.url, { method: input.method, headers: input.headers, credentials: input.credentials, signal: controller.signal,
            ...(input.bodyBase64 !== undefined ? { body: Uint8Array.from(atob(input.bodyBase64), c => c.charCodeAt(0)) }
              : input.body !== undefined ? { body: input.body } : {}) });
          state.reader = response.body?.getReader();
          return { responseUrl: response.url, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers) };
        }, { key, url: args.url, method, headers: args.headers, credentials: args.credentials ?? "include", body: args.body, bodyBase64: args.bodyBase64 }, this.mainWorld);
        capture.append({ ...scope, kind: "fetch-response", ...response });
        while (capture.live) {
          const data = await evaluate(frame, async id => {
            const state = globalThis[id];
            if (!state?.reader) return null;
            if (!state.pending?.length) {
              const { done, value } = await state.reader.read();
              if (done) return null;
              state.pending = value;
            }
            const part = state.pending.subarray(0, 32768);
            state.pending = state.pending.subarray(part.length);
            return btoa(String.fromCharCode(...part));
          }, key, this.mainWorld);
          if (data === null) { capture.append({ ...scope, kind: "fetch-finished" }); break; }
          if (data) capture.append({ ...scope, kind: "fetch-data" }, Buffer.from(data, "base64"));
        }
      } catch (error) { capture.append({ ...scope, kind: "fetch-failed", error: errorText(error) }); }
      finally { capture.fetches.delete(scope.fetchId); await abort(); }
    })();
    return { ...capture.info(), ...scope };
  }
  async captureStream(args) {
    if (args.action === "list") return { captures: [...this.captures.values()].map(capture => capture.info()) };
    if (args.action === "start") {
      const page = args.pageId ? this.selectPage(args.pageId) : undefined;
      const capture = new DevtoolsJournal({ pageId: args.pageId, urlIncludes: args.urlIncludes });
      this.captures.set(capture.id, capture);
      const pages = page ? [page] : [...this.pages.values()];
      await Promise.all(pages.flatMap(current => [this.attachNative(capture, current),
        ...(current.frames?.() ?? []).filter(frame => frame !== current.mainFrame()).map(frame => this.attachNative(capture, current, frame))]));
      return { ...capture.info(), chromiumNative: this.engine === "chromium" };
    }
    const capture = this.getCapture(args.captureId);
    switch (args.action) {
      case "read": return capture.read(integer(args.since, 0, 0), integer(args.limit, 100, 1, 500), integer(args.waitMs, 0, 0, 20000));
      case "bytes": {
        const offset = integer(args.offset, 0, 0), length = integer(args.bytes, Math.min(65536, Math.max(0, capture.size - offset)), 0, 1048576);
        return { ...capture.info(), offset, returnedBytes: length, nextOffset: offset + length, base64: capture.bytes(offset, length).toString("base64") };
      }
      case "fetch": return this.captureFetch(capture, args);
      case "mark": {
        const page = args.pageId || args.screenshot ? this.selectPage(args.pageId ?? capture.settings.pageId) : null;
        if (capture.settings.pageId && page && this.pageIds.get(page) !== capture.settings.pageId) throw new Error("Choose the captured page");
        const entry = { kind: "mark", pageId: page ? this.pageIds.get(page) : capture.settings.pageId, label: args.label, value: json(args.value) };
        const image = args.screenshot ? await page.screenshot({ type: "jpeg", quality: 55, timeout: 2500 }) : undefined;
        capture.append({ ...entry, ...(image ? { mediaType: "image/jpeg" } : {}) }, image);
        return capture.info();
      }
      case "stop": capture.stop(); return capture.info();
      case "discard": capture.dispose(); this.captures.delete(capture.id); return { captureId: capture.id, discarded: true };
      default: throw new Error("Unknown capture action");
    }
  }
  async capturedBytes(requestId, part = "response") {
    const item = this.requests.get(requestId);
    if (!item) throw new Error("Unknown or evicted requestId in this profile");
    if (part === "request") return Buffer.from(item.request.postDataBuffer() ?? []);
    if (part !== "response") throw new Error("Choose request or response bytes");
    if (!item.response) throw new Error("No response was received for this request");
    if (!["finished", "failed"].includes(item.data.state)) throw new Error("The response is still streaming");
    return Buffer.from(await item.response.body());
  }
  async captureProgramWork(work, options = {}) {
    if (typeof work !== "function") throw new Error("Capture expects a function to run");
    const since = this.sequence;
    const limit = integer(options.limit, 100, 1, 500);
    const outcome = await Promise.resolve().then(work).then(value => ({ completed: true, value }), error => ({ completed: false, error: errorText(error) }));
    const query = { since, limit, pageId: options.pageId };
    const records = structuredClone({
      network: this.query([...this.requests.values()].map(entry => entry.data), query, this.droppedRequests),
      events: this.query(this.events.map(entry => entry.entry), query, this.droppedEvents),
    });
    return {
      ...outcome, since, until: this.sequence, ...records,
    };
  }
  async taskTarget({ pageUrl, frameUrl, timeoutMs }) {
    if (!pageUrl && !frameUrl) return {};
    const deadline = Date.now() + Math.max(1, (timeoutMs ?? 120_000) - 1000);
    let ambiguous = false;
    do {
      const pages = this.context.pages().filter(page => !page.isClosed() && (!pageUrl || page.url() === pageUrl));
      const matches = pages.flatMap(page => (frameUrl ? page.frames().filter(frame => frame.url() === frameUrl && !frame.isDetached()) : [page.mainFrame()])
        .map(frame => ({ page, frame })));
      if (matches.length === 1) {
        const { page, frame } = matches[0];
        this.watchPage(page);
        return { pageId: this.pageIds.get(page), frameId: this.frameId(frame, page) };
      }
      ambiguous = matches.length > 1;
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    } while (!this.closed && Date.now() < deadline);
    throw new Error(ambiguous ? "More than one browsing context matched the task URLs" : "The task page or frame URL did not become available");
  }
  async runTaskProgram({ code, argument, screenshots, pageUrl, frameUrl, timeoutMs }) {
    let invoked = false;
    const record = await this.captureProgramWork(async () => {
      const target = await this.taskTarget({ pageUrl, frameUrl, timeoutMs });
      invoked = true;
      return (await this.runProgram({ code, argument, ...target }, { task: !target.frameId })).structuredContent;
    }, { limit: 30 });
    const { value, error, network, events, since, until } = record;
    const receipt = { ...(value ?? { completed: false, error }), invoked, network, events, since, until };
    if (screenshots) {
      try {
        const page = this.selectPage(value?.pageId);
        const image = await page.screenshot({ type: "jpeg", quality: 55, timeout: 2500 });
        receipt.screenshot = { mediaType: "image/jpeg", base64: image.toString("base64"), url: page.url() };
      } catch (error) { receipt.screenshotError = errorText(error); }
    }
    return receipt;
  }
  async createAnchor(args) {
    const { page, frame } = this.selectFrame(args);
    const timeout = integer(args.timeoutMs, 5000, 1, 20000), target = elementLocator(frame, args.target);
    const index = integer(args.target.index, undefined, 0);
    const locator = index === undefined ? target : target.nth(index);
    if (index === undefined && await locator.count() > 1) throw new Error("The anchor target is ambiguous");
    const identity = await locator.evaluate(elementIdentity, undefined, { timeout });
    const { index: _index, ...original } = args.target;
    const scope = original.within ? { within: original.within, ...(original.near === undefined ? {} : { near: original.near }) } : {};
    const candidates = [
      ...(identity.testId ? [{ ...scope, testId: identity.testId }] : []),
      original,
      ...(identity.label ? [{ ...scope, label: identity.label }] : []),
      ...(identity.name ? [{ ...scope, selector: `[name=${JSON.stringify(identity.name)}]` }] : []),
      ...(identity.text ? [{ ...scope, text: identity.text }] : []),
    ];
    const frames = [];
    for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
      frames.unshift({ name: current.name(), path: urlPath(current.url()) });
    }
    return { version: 1, page: { id: this.pageIds.get(page), path: urlPath(page.url()) }, frames, identity, candidates };
  }
  async snapshotDOM(args) {
    if (args.action === "discard") return { discarded: this.domSnapshots.delete(args.snapshotId) };
    let snapshotId = args.snapshotId;
    if (args.action === "take") {
      const baseline = args.baselineId ? this.domSnapshots.get(args.baselineId) : undefined;
      if (args.baselineId && !baseline) throw new Error("Unknown baselineId in this profile");
      const { page, frame } = this.selectFrame({
        pageId: args.pageId ?? baseline?.pageId, frameId: args.frameId ?? baseline?.frameId,
      });
      const selector = args.selector ?? baseline?.selector ?? ":root";
      if (baseline && (baseline.pageId !== this.pageIds.get(page) || baseline.selector !== selector || baseline.framePath !== urlPath(frame.url()))) {
        throw new Error("Use a baseline from the same page, frame URL and selector");
      }
      const rows = await frame.locator(selector).evaluate(domSnapshot, undefined, { timeout: integer(args.timeoutMs, 5000, 1, 20000) });
      snapshotId = randomUUID();
      this.domSnapshots.set(snapshotId, {
        rows, records: baseline ? compareSnapshots(baseline.rows, rows) : rows, baselineId: args.baselineId,
        capturedAt: new Date().toISOString(), pageId: this.pageIds.get(page), frameId: this.frameId(frame, page),
        framePath: urlPath(frame.url()), selector,
      });
    } else if (args.action !== "read") throw new Error("Unknown DOM snapshot operation");
    const snapshot = this.domSnapshots.get(snapshotId);
    if (!snapshot) throw new Error("Unknown snapshotId in this profile");
    const { rows, records, framePath, ...scope } = snapshot;
    const offset = integer(args.offset, 0, 0), entries = records.slice(offset, offset + integer(args.limit, 100, 1, 500));
    return { snapshotId, ...scope, totalNodes: rows.length, totalRecords: records.length, records: entries,
      nextOffset: offset + entries.length, hasMore: offset + entries.length < records.length };
  }
  async resolveAnchor(args, deadline) {
    const { anchor } = args;
    if (anchor?.version !== 1 || !Array.isArray(anchor.frames) || !Array.isArray(anchor.candidates) || !anchor.candidates.length
      || !anchor.page?.path || !anchor.identity?.tag) throw new Error("Use an anchor returned by browser_devtools_anchor");
    let reason = "The anchor no longer matches the current document";
    do {
      const live = [...this.pages.values()].filter(page => !page.isClosed?.());
      const explicit = args.pageId ? this.selectPage(args.pageId) : this.pages.get(anchor.page.id);
      const pages = explicit && !explicit.isClosed?.() && urlPath(explicit.url()) === anchor.page.path
        ? [explicit] : live.filter(page => urlPath(page.url()) === anchor.page.path);
      if (pages.length === 1) {
        const page = pages[0];
        let frame = page.mainFrame();
        for (const segment of anchor.frames) {
          const children = page.frames().filter(candidate => candidate.parentFrame() === frame && !candidate.isDetached?.());
          const exact = children.filter(candidate => urlPath(candidate.url()) === segment.path && (!segment.name || candidate.name() === segment.name));
          const named = segment.name ? children.filter(candidate => candidate.name() === segment.name) : [];
          const matches = exact.length ? exact : named;
          if (matches.length !== 1) {
            if (matches.length > 1) reason = "The anchor matched multiple frames";
            frame = null; break;
          }
          frame = matches[0];
        }
        if (frame && (!args.frameId || this.frameId(frame, page) === args.frameId)) {
          for (const candidate of anchor.candidates) {
            const locator = elementLocator(frame, candidate);
            const count = await locator.count().catch(() => 0);
            if (count > 1) reason = "The anchor matched multiple elements";
            if (count !== 1) continue;
            const identity = await locator.evaluate(elementIdentity, undefined, { timeout: Math.max(1, deadline - Date.now()) }).catch(() => undefined);
            if (identity && stableCandidate(anchor.identity, identity, candidate)) return { page, frame, locator, candidate };
          }
        }
      } else if (pages.length > 1) reason = "The anchor matched multiple pages; choose pageId";
      if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(60, Math.max(0, deadline - Date.now()))));
    } while (!this.closed && Date.now() < deadline);
    throw new Error(reason);
  }
  observeAction(page, frame, verify) {
    const since = this.sequence, pageId = this.pageIds.get(page), frameId = this.frameId(frame, page);
    const entries = [];
    const { response, popup, navigation } = verify ?? {};
    for (const spec of [response, popup, navigation]) {
      if (spec !== undefined && (!spec || typeof spec !== "object" || Array.isArray(spec)
        || (spec === popup && spec.urlIncludes === undefined ? false : typeof spec.urlIncludes !== "string" || !spec.urlIncludes))) {
        throw new Error("Event verification requires a non-empty urlIncludes");
      }
    }
    let match, complete;
    const observe = entry => {
      const inPage = entry.pageId === pageId || entry.openerPageId === pageId;
      if (!inPage) return;
      const data = { ...Object.fromEntries(["id", "sequence", "kind", "requestId", "popupPageId", "pageId", "frameId", "url", "method", "status"]
        .filter(key => entry[key] !== undefined).map(key => [key, entry[key]])) };
      if (entries.length < 40 && ["request-started", "request-response", "request-failed", "navigation", "popup-opened", "download", "exception"].includes(entry.kind)) entries.push(data);
      if (match) return;
      const hit = response && entry.kind === "request-response" && entry.startedSequence > since && entry.frameId === frameId
        && entry.url.includes(response.urlIncludes) && (!response.method || entry.method === response.method.toUpperCase())
        && (response.status === undefined || entry.status === response.status)
        || popup && entry.popupPageId && (!popup.urlIncludes || entry.url.includes(popup.urlIncludes))
        || navigation && entry.pageId === pageId && entry.kind === "navigation"
        && entry.frameId === (navigation.scope === "page" ? this.frameId(page.mainFrame(), page) : frameId) && entry.url.includes(navigation.urlIncludes);
      if (hit) { match = data; complete?.({ passed: true, match }); }
    };
    if (response?.method !== undefined && typeof response.method !== "string") throw new Error("Verification method must be a string");
    this.observers.add(observe);
    return {
      since, entries,
      wait: response || popup || navigation ? () => new Promise(resolve => {
        if (match) { resolve({ passed: true, match }); return; }
        const timer = setTimeout(() => resolve({ passed: false, error: "No matching event followed the action" }), integer(verify.timeoutMs, 5000, 1, 20000));
        complete = value => { clearTimeout(timer); resolve(value); };
      }) : undefined,
      close: () => this.observers.delete(observe),
    };
  }
  async runProgram(args, { task = false } = {}) {
    if (typeof args.code !== "string" || !args.code.trim()) throw new Error("code must contain a JavaScript function");
    let page, frame, worker;
    if (args.workerId) {
      if (args.frameId) throw new Error("Choose either workerId or frameId");
      const selected = this.workers.get(args.workerId);
      if (!selected || (args.pageId && this.pageIds.get(selected.page) !== args.pageId)) throw new Error("Unknown workerId in this page/profile");
      ({ page, worker } = selected);
      frame = page?.mainFrame();
    } else if (task) {
      page = this.context.pages().at(-1) ?? await this.context.newPage();
      frame = page.mainFrame();
    } else {
      ({ page, frame } = this.selectFrame(args));
    }
    const frameTarget = page && frame ? { pageId: this.pageIds.get(page), frameId: this.frameId(frame, page) } : {};
    const devtools = Object.freeze({
      call: async (tool, options = {}) => {
        const shortName = String(tool);
        const name = shortName.startsWith("browser_devtools_") ? shortName : `browser_devtools_${shortName}`;
        if (!DEVTOOLS_TOOL_NAMES.has(name) || name === "browser_devtools_program") throw new Error(`Unknown program developer operation: ${shortName}`);
        const target = worker && name === "browser_devtools_evaluate" ? { workerId: args.workerId } : frameTarget;
        const explicitTarget = ["pageId", "frameId", "workerId", "anchor"].some(key => Object.hasOwn(options, key));
        const reply = await this.call(name, explicitTarget ? options : { ...target, ...options });
        if (reply.isError) throw new Error(reply.structuredContent?.error || reply.content?.[0]?.text || "Developer operation failed");
        return reply.structuredContent;
      },
      bytes: (requestId, part) => this.capturedBytes(requestId, part),
      capture: (work, options) => this.captureProgramWork(work, options),
      watch: (captureId, options) => this.watchCapture(captureId, options),
      payload: (captureId, range) => this.getCapture(captureId).bytes(range.offset, range.totalBytes),
    });
    const logs = [];
    let droppedLogs = 0;
    const console = Object.fromEntries(["log", "debug", "info", "warn", "error"].map(level => [level, (...values) => {
      if (logs.length >= 500) { droppedLogs++; return; }
      const text = formatWithOptions({ depth: 3, maxArrayLength: 30, maxStringLength: 4096 }, ...values);
      logs.push({ level, text: text.slice(0, 4096) });
    }]));
    const runtime = {
      vela: Object.freeze({ page, frame, worker, context: this.context, devtools, argument: args.argument }),
      Buffer, TextDecoder, TextEncoder, URL, URLSearchParams, Blob, Response, AbortController,
      CompressionStream, DecompressionStream, crypto: webcrypto, console,
    };
    const scope = { ...frameTarget, ...(worker ? { workerId: args.workerId } : {}) };
    // Like the Playwright code tool, this executes a caller's snippet on the selected connection.
    try {
      const value = await runInNewContext(`(${args.code}\n)(vela)`, runtime, { filename: "vela-browser-program.js" });
      return result({ ...scope, completed: true, value, logs, droppedLogs });
    } catch (error) {
      return { ...result({ ...scope, completed: false, error: errorText(error), logs, droppedLogs }), isError: true };
    }
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
  /** @returns {Promise<{content: Array<object>, structuredContent: any, isError?: boolean}>} */
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
    if (name === "browser_devtools_stream") return result(await this.captureStream(args));
    if (name === "browser_devtools_sources") return result(await this.sources(args));
    if (name === "browser_devtools_dom_delta") return result(await this.snapshotDOM(args));
    if (name === "browser_devtools_network") return result(this.query([...this.requests.values()].map(e => e.data).filter(e =>
      (!args.failedOnly || e.failure || e.status >= 400) && (!args.resourceType || e.resourceType === args.resourceType)
      && (args.status === undefined || e.status === args.status)), args, this.droppedRequests));
    if (name === "browser_devtools_request") return result(await this.requestDetail(args));
    if (name === "browser_devtools_program") return this.runProgram(args);
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
    if (name === "browser_devtools_page_inspect") {
      const { page, frame } = this.selectFrame(args);
      const timeout = integer(args.timeoutMs, 5000, 1, 20000);
      const offset = integer(args.offset, 0, 0);
      const characters = integer(args.characters, 16000, 1, 65536);
      const locator = frame.locator(args.selector ?? ":root");
      const outline = await locator.evaluate(pageOutline, {
        wholeDocument: args.selector === undefined,
        domOffset: integer(args.domOffset, 0, 0), hiddenOffset: integer(args.hiddenOffset, 0, 0), nodeLimit: integer(args.nodeLimit, 40, 1, 100),
        textOffset: integer(args.textOffset, 0, 0), characters,
      }, { timeout });
      let snapshot = "", accessibilityError;
      try { snapshot = await locator.ariaSnapshot({ timeout }); }
      catch (error) { accessibilityError = errorText(error); }
      const accessibility = snapshot.slice(offset, offset + characters);
      const nextOffset = offset + accessibility.length;
      const childFrames = (page.frames?.() ?? []).filter(child => child.parentFrame() === frame).map(child => this.describeFrame(child, page));
      let screenshot, visualEvidence;
      if (outline.readableText?.unusualGlyphs) {
        try {
          const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          const bounds = await locator.boundingBox({ timeout });
          const x = Math.max(0, Math.floor(bounds?.x ?? 0));
          const y = Math.max(0, Math.floor(bounds?.y ?? 0));
          const right = Math.min(viewport.width, Math.ceil(bounds ? bounds.x + bounds.width : viewport.width));
          const bottom = Math.min(viewport.height, Math.ceil(bounds ? bounds.y + bounds.height : viewport.height));
          if (right <= x || bottom <= y) throw new Error("The inspected area is outside the current viewport");
          const clip = { x, y, width: Math.min(1600, right - x), height: Math.min(1000, bottom - y) };
          screenshot = await page.screenshot({ type: "jpeg", quality: 72, scale: "css", clip, timeout });
          visualEvidence = { scope: "current viewport", clip };
        } catch (error) { visualEvidence = { error: errorText(error) }; }
      }
      const reply = result({ pageId: this.pageIds.get(page), ...this.describeFrame(frame, page), childFrames, ...outline,
        ...(visualEvidence ? { visualEvidence } : {}),
        accessibility, ...(accessibilityError ? { accessibilityError } : {}),
        offset, nextOffset, totalCharacters: snapshot.length, hasMore: nextOffset < snapshot.length });
      if (screenshot) return { ...reply, content: [...reply.content, { type: "image", data: screenshot.toString("base64"), mimeType: "image/jpeg" }] };
      return reply;
    }
    if (name === "browser_devtools_anchor") return result(await this.createAnchor(args));
    if (name === "browser_devtools_action") {
      if (!Object.hasOwn(locatorActions, args.action)) throw new Error("Unknown developer action");
      if ((args.action === "fill" || args.action === "press") && typeof args.value !== "string") throw new Error("This action requires a string value");
      if (args.action === "select_option" && typeof args.value !== "string"
        && !(Array.isArray(args.value) && args.value.length && args.value.every(value => typeof value === "string"))) {
        throw new Error("Select an option with a value or an array of values");
      }
      const timeout = integer(args.timeoutMs, 5000, 1, 20000);
      const deadline = Date.now() + timeout;
      if ((args.target === undefined) === (args.anchor === undefined)) throw new Error("Choose either target or anchor");
      const { page, frame, locator: anchored, candidate } = args.anchor ? await this.resolveAnchor(args, deadline) : this.selectFrame(args);
      const verify = verifyAction(page, frame, args.verify);
      const locator = anchored ?? elementLocator(frame, args.target);
      const index = integer(args.target?.index, undefined, 0);
      const target = index === undefined ? locator : locator.nth(index);
      if (index === undefined && await locator.count() > 1) throw new Error("The action target matched multiple elements. Narrow the target or provide an index.");
      const scope = { pageId: this.pageIds.get(page), frameId: this.frameId(frame, page), action: args.action };
      const evidence = this.observeAction(page, frame, args.verify);
      try {
        let actionError, verification = null;
        try { await locatorActions[args.action](target, { timeout: Math.max(1, deadline - Date.now()) }, args.value); }
        catch (error) { actionError = errorText(error); }
        if (evidence.wait) verification = await evidence.wait();
        else if (verify && !actionError) {
          try { await verify(); verification = { passed: true }; }
          catch (error) { verification = { passed: false, error: errorText(error) }; }
        }
        const reply = result({ ...scope, actionCompleted: actionError === undefined, verification, url: frame.url(),
          ...(candidate ? { resolvedBy: candidate } : {}), ...(actionError === undefined ? {} : { error: actionError }),
          evidence: { since: evidence.since, until: this.sequence, records: evidence.entries } });
        return actionError === undefined ? reply : { ...reply, isError: true };
      } finally {
        evidence.close();
      }
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
    for (const target of this.sourceSessions.keys()) this.closeTargetSource(target);
    this.runtimeSources.clear(); this.tracepoints.clear();
    this.domSnapshots.clear();
    for (const capture of this.captures.values()) capture.dispose();
    this.captures.clear();
    this.events.length = 0; this.requests.clear(); this.pages.clear(); this.frames.clear(); this.workers.clear();
  }
}

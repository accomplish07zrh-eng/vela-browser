# MCP developer tools

The developer tools are listed by default alongside the existing Playwright tools. They can read and change the selected browser, or a browser addressed explicitly by `profileId`. No enable command, approval step, or read-only mode is required.

Each environment uses its persistent context, process, cookies, proxy, and native fingerprint configuration. Background observation uses browser events. Explicit requests such as live native capture, runtime source indexing, JavaScript execution, storage edits, and protocol commands act in the chosen context.

| Tool | Capability |
| --- | --- |
| `browser_devtools_summary` | Pages, retained console errors and failed requests, capture start, cursors and history eviction counts |
| `browser_devtools_pages` | Page, iframe, dedicated worker and supported service-worker execution context IDs |
| `browser_devtools_console` | All console severities and native uncaught exception stacks, across navigation, with filtering and repeatable pagination |
| `browser_devtools_network` | Requests including static resources, response status, failures, timing and redirect relationships |
| `browser_devtools_request` | Full request and response headers including duplicate headers, POST data, response bytes, TLS details and transfer sizes |
| `browser_devtools_events` | WebSocket frames, socket errors, downloads, navigation, crashes and page/worker lifecycle |
| `browser_devtools_stream` | Disk-backed live event cursor and full binary payload ranges, including WebSocket messages and streamed HTTP |
| `browser_devtools_sources` | Script, source map, worker, and request provenance. Chromium also supports runtime-loaded code and tracepoints |
| `browser_devtools_evaluate` | JavaScript expressions, function source or statements, with an argument, in a selected page, iframe or worker |
| `browser_devtools_element` | Element markup, text, attributes, rectangle and computed CSS |
| `browser_devtools_page_inspect` | Accessibility tree, paginated DOM, form state, and an index of hidden nodes and data attributes |
| `browser_devtools_anchor` | Capture a reusable locator with scope and iframe ancestry |
| `browser_devtools_dom_delta` | Preserve a DOM snapshot and page through additions, removals, changes, and sibling ordering |
| `browser_devtools_action` | Act by role and name, label, text, test ID, selector or anchor, with optional event or state verification |
| `browser_devtools_program` | Run a custom Playwright and JavaScript program with binary HTTP bodies, correlated traffic and logs, and the developer tools API |
| `browser_devtools_storage` | The cookies the selected page or frame would send (other sites with `urls`, the whole profile with `allCookies`), its local/session storage, IndexedDB database names and Cache Storage keys |
| `browser_devtools_storage_edit` | Set, remove and clear cookies or local/session storage; JavaScript can modify IndexedDB and Cache Storage |
| `browser_devtools_fetch` | HTTP requests through the actual page/frame's browser network stack, including text or binary POST data |
| `browser_devtools_protocol` | Any native CDP command supported by the existing Chromium engine, including commands that change the page |
| `browser_devtools_performance` | Load and runtime insight: time to first byte, first and largest contentful paint, layout shift, long tasks, DOM size, slowest and largest resources, with plain findings against the Core Web Vitals thresholds |
| `browser_devtools_block` | Block requests by resource type or URL glob for the whole profile (for example images and media to save proxy traffic); set, list with a blocked count, clear |
| `browser_devtools_wait` | Wait until any of several texts appears on the page, a request containing a URL part finishes (optionally by method and status), or the page's network has been idle for a given time |
| `browser_devtools_mock` | Answer matching requests yourself (URL glob, optional method) with a status, content type, headers and text body, like DevTools network overrides; set, list with hit counts, clear |
| `browser_devtools_memory` | JavaScript heap, DOM elements, event listeners, documents and frames of a page, with plain findings about pages that grow |
| `browser_devtools_css` | The full CSS cascade of an element in Chromium: inline style and every matched rule with selector, origin, media and line, winning rule first |
| `browser_devtools_webauthn` | A virtual passkey authenticator for a Chromium page: add, list the credentials sites registered, remove |

Chromium attaches to the profile's existing CDP context. Firefox and WebKit run tools inside their existing native context owner. Firefox developer page operations use its native `mw:` execution channel, so page variables and typed arrays are accessible while ordinary automation retains its isolated world. Worker evaluation uses the worker's own context. CDP is Chromium-specific; Firefox and WebKit use the cross-engine developer tools and JavaScript. Engine support for service workers, TLS metadata and other browser APIs remains native; WebKit retains its experimental status and existing platform capabilities.

## Targeting and editing

First call `browser_devtools_pages`, then use its `pageId`, `frameId` or `workerId`. All tools also accept `profileId`; omitting it uses the selected profile. When multiple pages are open, choose a page explicitly. IDs are unique to a browser session and cannot select an object in another environment. Calls within one profile are serialized; calls to different profiles can run concurrently.

Frames include `depth` and `parentFrameId`. The top-level document has depth zero. Use the deepest relevant `frameId` directly, including for a loaded cross-origin frame. `browser_devtools_page_inspect` reports the selected frame and its child frames.

Page inspection includes hidden fields, collapsed content, comments, templates, attributes, live input values and open shadow roots by default. Each DOM node has an `index` and `parentIndex`. Continue a long accessibility snapshot using `nextOffset`, the DOM tree using `dom.nextOffset`, and the hidden and data-attribute index using `hidden.nextOffset`. Node text, values and attributes have bounded previews. Use `browser_devtools_element` or `browser_devtools_evaluate` in the same frame for raw detail. DOM indexes describe the current traversal and can change as the page updates.

`readableText` uses the rendered layout and normalizes formatting characters while the DOM tree preserves the source text. Continue it using `textOffset` and `readableText.nextOffset`. If visible text contains private-use or replacement glyphs, the tool can include a current-viewport image for comparison with the DOM. Programs can take a dedicated screenshot of any region using Playwright.

To click a named button in a nested frame and wait for the resulting text, call `browser_devtools_action` with the frame and target.

```json
{
  "profileId": "my-profile",
  "frameId": "id-from-browser_devtools_pages",
  "action": "click",
  "target": { "role": "button", "name": "Save draft" },
  "verify": { "text": "Draft saved" }
}
```

`actionCompleted` and `verification.passed` report distinct outcomes. A click can complete while its expected result times out. Examine the resulting page before retrying an operation with side effects.

Use `target.within` to scope repeated controls to a named form, dialog or other container. `target.near` can match text inside that container. For reusable targeting, pass the same target to `browser_devtools_anchor` and keep its returned object as `action.anchor`. Resolution follows the page and its named or URL-matched frame ancestry, then tries semantic candidates whose identity matches the original. Ambiguous frames or controls need a narrower target. For fresh evidence use `verify.response` with a URL substring and optional method/status, `verify.popup`, or `verify.navigation`. The result includes the evidence window and matching request, frame or popup ID.

Use `dom_delta` with `action: "take"` for a baseline, then take a second snapshot with `baselineId`. Its result is frozen while the live page keeps updating. Read further pages by `snapshotId` and `nextOffset`. Discard snapshots when finished.

## Durable browser tasks

`vela_browser_task` with `operation: "start"` accepts a `profileId`, an optional `idempotencyKey` and `argument`, and ordered `steps` with an `id` and a JavaScript `run` function. It returns a `runId` after storing the plan. The desktop runs the steps after the MCP client disconnects. If the desktop restarts, `operation: "resume"` continues from the saved checkpoint. Resending the same plan and `idempotencyKey` retrieves the same run after a lost start reply.

Each function gets the browser program API and an `argument` with `input`, `runId`, `stepId`, a stable `actionKey`, the current `attempt`, and `previous` step receipts keyed by step ID. A step's optional `pageUrl` and `frameUrl` wait for one exact matching browse context at any depth before executing or verifying the step. Use a reusable anchor for controls that may be redrawn. Where a site supports idempotency keys, send `argument.actionKey` with the write.

Add a `verify` function to a step that writes. It can read a receipt endpoint or another authoritative site state and return `{state: "applied", value: receipt}`, `{state: "absent"}`, or `{state: "unknown"}`. An absent result means the effect is absent and the earlier request can no longer commit. After an uncertain write, the task checks this verifier before reissuing the action. An unknown result holds the task in `needs_verification`. Resume can supply a new verifier for that attempt. Completed step values remain available to later steps.

`operation: "status"` returns each checkpoint. `pause` and `cancel` take effect at a step boundary. `evidence` returns step and attempt metadata by `sequence`, plus paged result, network, console, events, and optional screenshots. The **Browser tasks** tab on the Scripts page shows the same evidence locally. Set `screenshots: true` in the plan to capture step screenshots.

## Live streams and source tracing

Start a `browser_devtools_stream` journal, then open the target request or socket. Use `read` with `nextCursor` for incremental records and `bytes` for the ranges in `record.payload`. A browser program can use `for await (const record of devtools.watch(captureId))` and `devtools.payload(captureId, record.payload)` to read a complete payload as a Buffer. Use `mark` to associate a result, decoded value or current screenshot with that sequence of events. `stop` finishes capture and preserves the journal until discard or the developer connection ends.

Chromium records passive SSE messages and response chunks for attached CDP targets. The native Network domain exposes browser response content, including its buffered prefix when streaming starts. Firefox and WebKit record WebSocket messages and completed response bodies exposed by the engine. `stream.fetch` opens a streamed request in the chosen frame on any engine and yields its response bytes while the connection remains open.

`browser_devtools_sources` links native and DOM script records to captured request IDs. Select a source to read its body or map a generated position to its original source. On Chromium, `trace_add` evaluates an expression at a compiled line or a line mapped from an original source using `originalSource`. The matching `source-trace` event contains the same `traceId`, `sourceId` and the evaluated value. Remove that tracepoint with `trace_remove` or detach the source session with `close`. Decoders can use loaded sources, captured bytes, and trace values together in browser programs.

## Programmable browser operations

`browser_devtools_program` calls an async JavaScript function with `{ page, frame, worker, context, devtools, argument }`. Use the native Playwright objects for multi-step interactions, response waits, routing, request interception, or WebSocket event handlers. `pageId`, `frameId`, and `workerId` select the starting context. `devtools.call` can invoke the other developer tools by short name, with the selected target as its default.

`devtools.capture(fn)` returns the function's result with the HTTP requests and browser events recorded during its execution. Events include WebSocket messages, console output and uncaught exceptions. A failed callback still returns its capture. Use the same cursors as the network and event tools to continue reading retained history. Program `console.log`, `console.warn` and other console calls appear in the program's `logs`.

`devtools.bytes(requestId)` returns a finished response body as a Buffer. Pass `"request"` for the HTTP request body. The program can use JavaScript, `Buffer`, encoding and compression streams, and Web Crypto to decode, unpack, analyze or decrypt those bytes using the material available to it. For example, this follows a response and interprets its Base64 envelope before continuing:

```javascript
async ({ page, frame, devtools }) => {
  return devtools.capture(async () => {
    const [reply] = await Promise.all([
      page.waitForResponse(response => response.url().includes("/draft")),
      frame.getByRole("button", { name: "Load draft" }).click(),
    ]);
    const text = Buffer.from(await reply.text(), "base64").toString("utf8");
    await frame.getByLabel("Message").fill(text);
    return { decodedLength: text.length };
  });
}
```

For example, call `browser_devtools_evaluate` with:

```json
{
  "profileId": "my-profile",
  "pageId": "id-from-browser_devtools_pages",
  "expression": "({ title, selector }) => { document.title = title; return document.querySelector(selector).textContent; }",
  "argument": { "title": "Development preview", "selector": "main" }
}
```

Storage changes affect that profile immediately. Cookie objects support `httpOnly`, `secure`, `sameSite`, expiration, and either `url` or `domain`/`path`. A browser fetch uses the selected environment's cookies, proxy and native TLS/network behavior. It follows the browser's own Fetch/CORS semantics. It never substitutes a Node HTTP client or a fresh unconfigured browser.

## History and response bytes

Firefox and WebKit observers start with their native owner; Chromium capture starts when MCP attaches. Earlier messages are not reconstructed. Queries do not consume records. Use `nextCursor` as `since` to continue; network records get a new sequence when their status changes. History retains up to 2,000 events, 1,000 requests and 8 MiB of event data. Capture time, eviction counts and payload truncation are reported explicitly.

Response bodies are read on demand from the original request, without replaying it or altering caching. Byte chunks default to 64 KiB and can be up to 1 MiB per call. Append the decoded `base64` chunks, advancing `offset` to `nextOffset`, until `hasMore` is false. Text is a convenience field; base64 preserves exact byte boundaries. Live streaming responses report that their bodies are not finished rather than blocking subsequent diagnostics. WebSocket frames retain the first 64 KiB with original byte count and truncation metadata: binary frames as base64, text frames as their exact text (the first 65,536 characters). Once frames hold half of the history, their own oldest records are evicted first, so a busy socket cannot push console errors and exceptions out. A JavaScript expression with a trailing semicolon, as typed in the Console, returns its value.

Plugins add their own tools next to these, in every engine; see [plugins.md](plugins.md). JavaScript scripts can read the same developer record through `devtools.call(...)`.

The existing navigation, snapshots, screenshots, input, file upload, arbitrary evaluation/run-code, tracing and lifecycle tools remain available. Lifecycle actions still go through Vela so session persistence, profile ownership and idle cooling continue to work.

## Proxies from the pool

Three tools let an AI work with the proxy pool the user set up in Vela Browser (Proxies → Proxy pool). They never return credentials or subscription links, and they accept only proxies already in the pool: an AI cannot add a proxy or a subscription, so a page cannot talk it into routing a profile through an address of its choosing.

| Tool | Capability |
| --- | --- |
| `vela_proxy_pool_list` | Pool proxies with `nodeId`, name, protocol, exit country and city, status, check time, and how many profiles use each of how many may; filter by `country`, `tag`, `status` or `available` |
| `vela_proxy_pool_check` | Check up to 50 proxies now (exit IP and country). Sends a few requests to an IP lookup service through each |
| `vela_browser_set_proxy` | Give a profile a pool proxy by `nodeId` |

Unlike the developer tools, changing a profile's proxy needs the user's consent, because the profile's sites see its IP change. Under Proxies → Proxy pool → AI proxy changes the user chooses:

- **Ask me each time** (default): Vela Browser shows a card naming the AI client, the profile, and the old and new proxy, with Allow and Deny. The call waits; without an answer within 60 seconds it fails with `approval_timeout` and nothing changes.
- **Allow pool proxies without asking.**
- **Never allow**: the call fails with `approval_denied`.

`vela_profiles_list` and `vela_browser_status` say which proxy each profile uses: `proxyNodeId` for a pool proxy, with `proxyNodeName` and `proxyCountry` when known (a name that contains an address or a credential is left out), or only `proxyType` for any other proxy.

The setting applies to every MCP client; the client's name, as it introduces itself, is shown on the card and kept in the profile's proxy history (`mcp:<name>`).

After approval the change is the same as one made in the dashboard. The new proxy is checked first and nothing changes if the check fails (`switch_check_failed`). A closed profile uses the proxy from its next start (`"applied": "next_launch"`). An open browser saves its session, closes, and reopens on the new exit with its tabs, timezone and WebRTC address following the new exit (`"applied": "reopened"`); the MCP connection reattaches to it. If the reopened browser's exit turns out to be this computer's own address, it is closed (`exit_is_direct`). One profile can change at most once every 30 seconds (`rate_limited`). Other errors: `node_unavailable`, `pool_exhausted`, `profile_busy`, `teardown_unconfirmed`, `reopen_failed`.

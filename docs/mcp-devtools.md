# MCP developer tools in 0.1.3

The developer tools are listed by default alongside the existing Playwright tools. They can read and change the selected browser, or a browser addressed explicitly by `profileId`. No enable command, approval step, or read-only mode is required.

Each environment keeps its existing persistent context, process, cookies, proxy, and native fingerprint configuration. The developer observer uses browser events; it does not wrap `console`, inject initialization scripts, alter network routes, enable the Debugger domain, or change browser identity. Explicit JavaScript, storage edits, requests, and protocol commands perform the changes requested by the caller.

| Tool | Capability |
| --- | --- |
| `browser_devtools_summary` | Pages, retained console errors and failed requests, capture start, cursors and history eviction counts |
| `browser_devtools_pages` | Page, iframe, dedicated worker and supported service-worker execution context IDs |
| `browser_devtools_console` | All console severities and native uncaught exception stacks, across navigation, with filtering and repeatable pagination |
| `browser_devtools_network` | Requests including static resources, response status, failures, timing and redirect relationships |
| `browser_devtools_request` | Full request and response headers including duplicate headers, POST data, response bytes, TLS details and transfer sizes |
| `browser_devtools_events` | WebSocket frames, socket errors, downloads, navigation, crashes and page/worker lifecycle |
| `browser_devtools_evaluate` | JavaScript expressions, function source or statements, with an argument, in a selected page, iframe or worker |
| `browser_devtools_element` | Element markup, text, attributes, rectangle and computed CSS |
| `browser_devtools_storage` | The cookies the selected page or frame would send (other sites with `urls`, the whole profile with `allCookies`), its local/session storage, IndexedDB database names and Cache Storage keys |
| `browser_devtools_storage_edit` | Set, remove and clear cookies or local/session storage; JavaScript can modify IndexedDB and Cache Storage |
| `browser_devtools_fetch` | HTTP requests through the actual page/frame's browser network stack, including text or binary POST data |
| `browser_devtools_protocol` | Any native CDP command supported by the existing Chromium engine, including commands that change the page |

Chromium attaches to the profile's existing CDP context. Firefox and WebKit run tools inside their existing native context owner. Firefox developer page operations use its native `mw:` execution channel, so page variables and typed arrays are accessible while ordinary automation retains its isolated world. Worker evaluation uses the worker's own context. CDP is Chromium-specific; Firefox and WebKit use the cross-engine developer tools and JavaScript. Engine support for service workers, TLS metadata and other browser APIs remains native; WebKit retains its experimental status and existing platform capabilities.

## Targeting and editing

First call `browser_devtools_pages`, then use its `pageId`, `frameId` or `workerId`. All tools also accept `profileId`; omitting it uses the selected profile. When multiple pages are open, choose a page explicitly. IDs are unique to a browser session and cannot select an object in another environment. Calls within one profile are serialized; calls to different profiles can run concurrently.

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

The existing navigation, snapshots, screenshots, input, file upload, arbitrary evaluation/run-code, tracing and lifecycle tools remain available. Lifecycle actions still go through Vela so session persistence, profile ownership and idle cooling continue to work.

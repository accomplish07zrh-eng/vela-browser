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

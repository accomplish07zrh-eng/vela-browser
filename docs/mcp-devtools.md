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
| `browser_devtools_form_workflow` | Inspect visible form controls and generate a script draft with explicit completion checks |
| `browser_devtools_visual_match` | Locate a same-scale reference image in a visible viewport region |
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

Use `browser_devtools_observe` for a short list of visible controls, headings, alerts and dialogs in one frame. Set `selector` to narrow the scope and `limit` to choose up to 40 controls. Each actionable control can include a portable `anchor` for `browser_devtools_action`. Resolution checks the element's identity again after rerendering. Duplicate targets need a narrower scope. Observations omit input values and hidden controls.

For an interactive loop, set `compact: true` on the first observation and pass the selected control's `ref` to `browser_devtools_action`. Set `observe: true` on the action to get verification and the next compact observation in the same call. A ref is scoped to its browser session, page and frame for up to 60 seconds. Navigation invalidates the ref, including a reload at the same URL. An ambiguous reference asks the Agent to observe again.

On the Windows fixture, Chromium, Firefox and WebKit all completed the same verified action in two tool calls. The standard observation and action sequence used three calls. Structured response data fell from roughly 1,774 bytes to 878 bytes per sequence.

## Form workflows

Use `browser_devtools_form_workflow` with `action: "inspect"` in an open profile. Pass `pageId`, `frameId` or `selector` to narrow the view. The tool reads control labels and attributes and omits filled values. It recognizes common account fields, confirmation passwords, one-time codes, checkboxes, selects and step buttons. Each form can include a `suggestedStage`. Review unbound or ambiguous controls before adding them to the stage.

Call the same tool with `action: "draft"` and the reviewed `stages`. For a stage that clicks `submit`, supply a `verify` condition with an exact destination URL or a uniquely visible selector. A selector can include expected text. Drafts match pages and frames by origin and path and require a unique tab and frame. Run inputs supply the values. Select `action: "type"` for a field that needs individual key events. `exampleInputs: true` produces separate synthetic values for rehearsal.

Save `script` with `vela_script_save` and use the Scripts page or `vela_script_run` to run it in Chromium or Firefox profiles. Vela shows the draft source in the existing save approval. Use `task.steps` with `vela_browser_task` for durable workflows. A verifier reports an observed receipt as applied and leaves uncertain outcomes for review. Use test values with persisted task arguments. WebKit supports form inspection and native browser programs.

For a fresh numeric code shown in an existing inbox tab, give a later stage `code: { input, pageUrl, selector, digits, timeoutMs }`. The saved script waits for a changed value from that one visible element in the same profile. An explicit run input takes precedence. A draft with inbox polling produces a script, since the comparison with the previous code lives in that run's memory.

For canvas and other visual controls, call `browser_devtools_visual_match` with a viewport `region` and either an on-page `reference` rectangle or a `templatePng`. Use the same CSS-pixel scale. Opaque reference pixels are compared in memory. The result includes viewport coordinates and a unique, ambiguous or missing status. Use a fresh match before acting on a moving page.

For a one-off visual failure, start `vela_browser_replay` explicitly before the operation. The following command exercises form authoring, script execution, delayed code entry and receipt checks with the pinned Windows runtimes.

```powershell
bun scripts/form-workflow-acceptance.ts --runtime-root D:/VelaBrowser
```

## Durable browser tasks

`vela_browser_task` with `operation: "start"` accepts a `profileId`, an optional `idempotencyKey` and `argument`, and ordered `steps` with an `id` and a JavaScript `run` function. It returns a `runId` after storing the plan. The desktop runs the steps after the MCP client disconnects. Resending the same plan and `idempotencyKey` retrieves the same run after a lost start reply.

Set `startUrl` to enable unattended recovery and give the task a dedicated tab. Choose a safe HTTP(S) GET entry point. To bind an existing tab, also supply its `tabId` from `vela_browser_replay` with `action: "tabs"`. If the browser or tab disappears, the task can reopen it at the next checkpoint's `recoveryUrl` or at `startUrl`. A desktop restart reloads queued work and unfinished checkpoints automatically. Legacy plans without `startUrl` still use `resume` after an interruption.

Each function gets the browser program API and an `argument` with `input`, `runId`, `stepId`, a stable `actionKey`, the current `attempt`, and `previous` step receipts keyed by step ID. In an unattended task, optional `pageUrl` and `frameUrl` wait for an exact address in the bound tab. Steps that need a different page in the same tab can navigate as part of their program. Mark a step `readOnly: true` when repeating it after a browser failure is safe. Where a site supports idempotency keys, send `argument.actionKey` with the write.

Add a `verify` function to a step that writes. It can read a receipt endpoint or another authoritative site state and return `{state: "applied", value: receipt}`, `{state: "absent"}`, or `{state: "unknown"}`. An absent result certifies that the effect is absent and the earlier request can no longer commit. After an uncertain write, the task checks this verifier before continuing. It advances on `applied`, can retry with the original action key on `absent`, and holds the checkpoint in `needs_verification` on `unknown`. Resume can supply a new verifier for that step. Completed step values remain available to later steps.

For a replacement verifier, copy the uncertain step's `expectedAttempt` from status and supply it with `verify` in `resume`. The desktop evidence panel fills in this checkpoint marker when an operator supplies a verifier. Prefer site-supported action keys and authoritative receipts so unattended work can resolve a lost reply on its own.

Use `start_batch` to store up to 100 runs with a shared plan. Each entry in `runs` provides its `profileId` and can override `argument`, `idempotencyKey`, `name`, `startUrl` or `tabId`. Runs in the same profile execute in order. Use distinct keys for multiple runs in a profile. The scheduler adjusts concurrency across profiles to available CPU and memory. To report a sign-in or verification barrier before issuing a write, return `{blocked: {code: "authentication_required", message: "Sign-in required"}}`. This pauses only that profile's queue. Call `resume` once the condition clears.

Use `skill_save` with a completed `runId` to save its plan for reuse. The optional `url` sets the origin and path prefix. Use `skill_find` with the current site URL to get matching skills, then `start` or `start_batch` with a `skillId` and fresh `argument`. The saved skill refers to the completed steps. Each new run uses its own profile, tab, arguments and evidence.

`operation: "status"` returns each checkpoint, the bound tab ID, and any scheduled recovery. `pause` and `cancel` take effect at a step boundary. `evidence` returns step and attempt metadata by `sequence`, plus paged result, network, console, events, and optional screenshots. The **Browser tasks** tab on the Scripts page shows the same evidence locally. Set `screenshots: true` in the plan to capture step screenshots.

Task evidence rotates after 30 days or 128 MiB of stored receipts, with older checkpoints retained when needed to resume a run written by an earlier version. Large receipts keep metadata. Checkpoint results and the plan are stored separately for recovery. The activity record links to the retained evidence. Use test values or retrieve sensitive application input at execution time from a scoped facility rather than storing it in a task argument. The temporary replay still expires in memory and starts only on an explicit capture request.

The task creator keeps ownership when a delegate resumes a run. Use `operation: "delegate"` with `runId` and `delegates` to replace the list of Agents that can inspect the run or act on it. Each Agent also needs access to the profile's group. Desktop users can manage the same list in **Browser tasks**.

For authenticated local Agent names, create `agent-credentials.json` in the Vela state directory as a JSON object mapping each Agent name to the lowercase SHA-256 hex digest of a random base64url token. Give each MCP process its matching raw token through `VELA_AGENT_TOKEN`. The desktop binds the session to the name in the registry and rejects name-only identification for an enrolled name. Removing a registry entry revokes the authenticated Agent's next operation. Use enrolled identities on both sides of a delegation between authenticated Agents.

Run the Chromium acceptance check with the pinned runtime in an existing Vela checkout.

```powershell
bun scripts/browser-task-batch-acceptance.ts D:/VelaBrowser
```

## Scheduled site skills

Call `vela_browser_task` with `operation: "schedule_save"`, a saved `skillId`, a `target` containing environment IDs, groups or tags, and a `schedule`. Daily schedules use local `HH:MM`. Interval schedules use `minutes`. Pass `argument` for fresh JSON inputs. Use `schedule_run` for immediate dispatch and `schedule_list` for the run IDs, status and errors. The desktop restores unfinished dispatches with the same per-profile idempotency key.

The dashboard, managed MCP page tools, scripts and durable browser tasks share one write queue per profile. A separate profile can keep working while a write waits. External raw browser debugging clients can participate through the agent-control `browser.write.begin` and `browser.write.end` operations.

## Kernel upgrades and network identity

Use `vela_browser_kernel` to list verified builds, inspect a profile, upgrade it, or roll back. Windows x64 currently offers Vela Chromium revisions `155.0.8059.85-aliasmode.4` and `155.0.8059.85-aliasmode.5`. Archives and the native Windows engine DLL are verified before the selected build is used. Use `upgrade_batch` with an explicit list of profiles and a revision to roll out to a cohort. The tool stops at the first failed profile and reports completed and pending profiles. A rollback restores the snapshot of the native user-data directory together with the previous build.

Set `canaryCount` to try the first profiles in the cohort. A successful canary returns `awaitingVerification` and the pending IDs. Verify the expected session and application state on the canary profiles, then submit the pending IDs for the same revision.

Call `vela_browser_network` for the live browser's egress address, timezone and WebRTC observations. Set `refresh: true` to save the session and reconnect when the same drift is observed twice. To sample idle proxied profiles, set `ALIASMODE_EGRESS_RECHECK_SECONDS` on the desktop process. Set `ALIASMODE_REFRESH_EGRESS=1` to enable the same reconnect policy for those samples. An unchanged drift finding triggers one automatic reconnect until a clean sample or a different finding arrives.

## Portable profiles and self-hosted workers

Call `vela_profile_portable` with `operation: "export"`, `profileId`, a `.vela-profile` file name and a passphrase. Copy the encrypted file between the desktops' `portable-profiles` folders and use `restore` at the destination. Native data uses a compatible browser build, operating system and architecture. The archive includes eligible native site files available at export time, up to a 96 MiB payload. The imported profile reports extension IDs that need to be installed on the destination. A handoff keeps the source profile closed.

For remote task execution, run Vela on a second host. To use the dedicated HTTPS listener, start it with `bun src/cli.ts serve --worker --state-root <directory> --port 50400 --worker-host <bind-address> --tls-cert <certificate.pem> --tls-key <private-key.pem>`. This listener serves only Worker operations. A reverse proxy in front of a loopback Worker remains supported. Use an HTTPS certificate matching the reachable hostname. For a private CA, the controller's node entry can supply the path `caFile`.

Put the configuration at `worker-nodes.json` in each Vela state directory. The destination uses a `clients` list with `name`, `token`, allowed `groups` and optional allowed `agents`. The controller uses a `nodes` object keyed by node ID, with a `url`, the matching `token`, and an optional `agents` list. Use a random base64url token from 32 bytes or more. The controller forwards the caller's identity under its Worker credential. The destination checks the credential's current group and Agent grants before each task step. A migration from legacy shared Worker identity keeps the original run records. An existing run can be inspected and recovered from the Worker desktop.

Call `vela_worker` with `operation: "health"` and a registered `node` for a fresh readiness, memory and queue check. The nested `task` request supports `start`, `status`, `resume`, `pause`, `cancel`, `delegate`, and `evidence`. Start requires a stable `idempotencyKey` and a recovery URL or a saved skill. Retry an interrupted response on the same Worker with the same key. Use `handoff` with the same node and key on every retry to initialize a destination profile and keep the source fenced. For workers sharing a host, assign each worker a separate Chromium debug port range with `--debug-port-range 12600-12699` or another available range.

## Native Android devices

Install [Android SDK Platform Tools](https://developer.android.com/tools/adb) and authorize USB or wireless debugging on a device. The desktop can find `adb` on PATH or via `ALIASMODE_ADB_PATH`. Set `ALIASMODE_ANDROID_SERIALS` to a comma-separated device list to restrict access. Use `vela_android` to list authorized serials, launch an installed Android package, observe controls and send input. The screenshot action returns a PNG in memory. Basic ADB text input accepts printable ASCII.

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

## Temporary browser tab replay

Use `vela_browser_replay` to review a visual change after it happens. It uses the selected open profile by default. Pass `profileId` to choose another open profile, or pass `runId` for the task's bound tab.

1. Call with `{"action":"tabs"}` to list tab IDs for replay.
2. Call with `{"action":"start","tabId":"<id from tabs>"}` before the operation. You can omit `tabId` when there is only one tab. Capture covers that tab across navigations.
3. Call with `{"action":"play"}` for the last 60 seconds, or with `{"action":"play","fromSecondsAgo":35,"toSecondsAgo":15}` for a specific interval. The tool returns up to four MCP images with timestamps. Open `playbackUrl` in a separate tab on the computer running Vela to play, pause, or seek within the available clip.
4. Call with `{"action":"stop"}` to discard the recording and its links.

To capture from the first task step, start replay on an existing tab and pass that `tabId` to `vela_browser_task` when starting the plan.

Replay is off until started. Capture stops after 60 seconds by default. For longer operations, set `durationSeconds` on start, up to 300. Vela keeps JPEG frames in memory, at up to about six frames per second, with a 24 MiB limit per recording and up to four recordings across profiles, including recordings with frames still available after capture stops. One MCP connection owns each profile's recording. Frames expire 60 seconds after capture, and the memory limit can shorten the available interval. Playback links share the original frame expiration times. Closing the tab or the profile, disconnecting MCP, or revoking profile access discards the recording. The player uses the recorded tab's visual content without audio. MCP clients may retain images they receive according to their own settings.

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

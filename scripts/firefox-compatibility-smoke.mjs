import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { firefox } from "playwright-core";
import { connectOfficial, nonClosingContext } from "../agent/playwright-proxy.mjs";
import { BrowserDevtools } from "../agent/devtools.mjs";

const executablePath = process.argv[2];
const root = process.argv[3] && resolve(process.argv[3]);
const headed = process.argv.includes("--headed");
const nativeUi = process.argv.includes("--native-ui");
const previousBrowserIndex = process.argv.indexOf("--previous-browser");
const previousBrowser = previousBrowserIndex < 0 ? undefined : process.argv[previousBrowserIndex + 1];
const run = promisify(execFile);
if (!executablePath || !root) {
  throw new Error("usage: node scripts/firefox-compatibility-smoke.mjs <browser> <new-test-directory> [--headed] [--native-ui] [--previous-browser <browser>]");
}
if (previousBrowserIndex >= 0 && (!previousBrowser || previousBrowser.startsWith("--"))) {
  throw new Error("--previous-browser requires a browser executable");
}
if (nativeUi && (!headed || process.platform !== "darwin")) {
  throw new Error("native Firefox UI acceptance requires headed macOS");
}
if (previousBrowser && !nativeUi) {
  throw new Error("--previous-browser requires native Firefox UI acceptance");
}
function appBundlePath(path) {
  const executable = resolve(path);
  const suffix = ".app/Contents/MacOS/";
  const index = executable.lastIndexOf(suffix);
  if (index < 0) throw new Error("native Firefox UI acceptance requires an executable inside a .app bundle");
  return executable.slice(0, index + 4);
}
const nativeExecutable = nativeUi ? resolve(executablePath) : undefined;
const nativeAppBundle = nativeUi ? appBundlePath(executablePath) : undefined;
await mkdir(root, { recursive: false });
const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const url = new URL(request.url, "http://fixture.test");
  if (url.pathname === "/devtools-frame") {
    const level = Number(url.searchParams.get("level"));
    const leafPort = Number(url.searchParams.get("leafPort"));
    const child = level === 3 ? `http://127.0.0.1:${leafPort}/leaf` : `/devtools-frame?level=${level + 1}&amp;leafPort=${leafPort}`;
    response.end(`<!doctype html><title>Frame ${level}</title><iframe name="depth-${level + 1}" src="${child}"></iframe>`);
    return;
  }
  response.end("<!doctype html><title>Vela Firefox proof</title><h1>Browser compatibility fixture</h1><button onclick=\"this.textContent='Clicked'\">Click</button>");
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const contexts = new Set();
let official;

async function verifyNestedDevtools(context) {
  // A second loopback port gives the deepest frame a distinct origin.
  const key = Buffer.alloc(16, 61), nonce = Buffer.alloc(12, 43);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const encrypted = Buffer.concat([nonce, cipher.update("Decoded draft", "utf8"), cipher.final(), cipher.getAuthTag()]);
  const leaf = createServer((request, response) => {
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write("event: draft\ndata: still connected\n\n");
      return;
    }
    if (request.url === "/packed") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(encrypted);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><head><title>Deep frame</title><meta name="state" content="loaded"></head><body>
      <main><h1>Draft editor</h1><form aria-label="Draft">
        <label>Message<input name="message" required></label><input type="hidden" name="draftId" value="fixture-draft">
        <button type="button" onclick="document.querySelector('#saved').hidden = false">Save draft</button>
        <button type="button" onclick="console.info('packed-draft-request'); fetch('/packed').catch(console.error)">Load encoded draft</button>
      </form><p id="saved" hidden>Draft saved</p><details><summary>More</summary><p id="collapsed">Collapsed detail</p></details>
      <p>Visi\u200bble evidence</p><p style="opacity:0">Invisible fixture noise</p><p style="font-size:0">Tiny fixture noise</p>
      <!-- DOM fixture comment --><template><p id="template-info">Template detail</p></template><div id="host"></div></main>
      <script type="application/json" id="draft-material">${JSON.stringify({ draftKey: key.toString("base64") })}</script>
      <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<p hidden data-private-state="fixture-shadow">Shadow detail</p>';</script>
      </body></html>`);
  });
  await new Promise((resolve, reject) => { leaf.once("error", reject); leaf.listen(0, "127.0.0.1", resolve); });
  const port = leaf.address().port;
  let page, devtools;
  const call = async (tool, args) => {
    const reply = await devtools.call(`browser_devtools_${tool}`, args);
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    return reply.structuredContent;
  };
  const start = `${origin}/devtools-frame?level=0&leafPort=${port}`;
  try {
    page = await context.newPage();
    devtools = new BrowserDevtools(context, { engine: "firefox" });
    await page.goto(start);
    const listing = await call("pages", {});
    const targetPage = listing.pages.find((entry) => entry.url === start);
    const deepest = targetPage?.frames.find((frame) => frame.url === `http://127.0.0.1:${port}/leaf`);
    assert.equal(deepest?.depth, 4);
    assert.equal(targetPage.frames.find((frame) => frame.frameId === deepest.parentFrameId)?.depth, 3);
    const target = { pageId: targetPage.pageId, frameId: deepest.frameId };
    const inspection = await call("page_inspect", { ...target, nodeLimit: 100 });
    assert.equal(inspection.title, "Deep frame");
    assert.ok(inspection.accessibility.includes("Draft editor"));
    assert.ok(inspection.readableText.text.includes("Visible evidence"));
    assert.ok(inspection.readableText.formatControls > 0);
    assert.ok(!inspection.readableText.text.includes("fixture noise"));
    assert.ok(inspection.forms[0].fields.some((field) => field.label === "Message" && field.required && field.invalid));
    assert.ok(inspection.hidden.nodes.some((node) => node.hiddenBy === "hidden input" && node.value === "fixture-draft"));
    assert.ok(inspection.hidden.nodes.some((node) => node.hiddenBy === "collapsed details" && node.text === "Collapsed detail"));
    assert.ok(inspection.hidden.nodes.some((node) => node.hiddenBy === "template" && node.text === "Template detail"));
    assert.ok(inspection.hidden.nodes.some((node) => node.dataAttributes?.["data-private-state"] === "fixture-shadow"));
    assert.ok(inspection.dom.nodes.some((node) => node.nodeType === 8 && node.text.includes("DOM fixture comment")));
    assert.ok(inspection.dom.nodes.some((node) => node.tag === "#shadow-root"));
    const filled = await call("action", { ...target, action: "fill", target: { label: "Message" }, value: "Notes" });
    assert.equal(filled.actionCompleted, true);
    const saved = await call("action", { ...target, action: "click", target: { role: "button", name: "Save draft" }, verify: { text: "Draft saved" } });
    assert.equal(saved.verification.passed, true);
    const updated = await call("page_inspect", target);
    assert.ok(updated.forms[0].fields.some((field) => field.label === "Message" && !field.invalid));
    const programmed = await call("program", { ...target, code: `async ({ page, frame, devtools }) => {
      const trace = await devtools.capture(async () => {
        const [response] = await Promise.all([
          page.waitForResponse(candidate => candidate.url().endsWith("/packed")),
          frame.getByRole("button", { name: "Load encoded draft" }).click(),
        ]);
        await response.finished();
      });
      const record = trace.network.records.find(entry => entry.url.endsWith("/packed"));
      const packed = await devtools.bytes(record.requestId);
      const material = await devtools.call("element", { selector: "#draft-material" });
      const { draftKey } = JSON.parse(material.text);
      const key = await crypto.subtle.importKey("raw", Buffer.from(draftKey, "base64"), "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(0, 12) }, key, packed.subarray(12));
      await frame.getByLabel("Message").fill(new TextDecoder().decode(plain));
      console.log("draft decrypted");
      return { input: await frame.getByLabel("Message").inputValue(), sawRequest: record.status === 200,
        sawLog: trace.events.records.some(event => event.kind === "console" && event.text === "packed-draft-request") };
    }` });
    assert.deepEqual(programmed.value, { input: "Decoded draft", sawRequest: true, sawLog: true });
    assert.equal(programmed.logs[0].text, "draft decrypted");
    const capture = await call("stream", { action: "start", pageId: target.pageId });
    const captureId = capture.captureId;
    const stream = await call("program", { ...target, argument: captureId, code: `async ({devtools, argument: captureId}) => {
      await devtools.call("stream", { action: "fetch", captureId, url: "/live" });
      for await (const event of devtools.watch(captureId)) {
        if (event.kind === "fetch-failed") throw new Error(event.error);
        if (event.kind === "fetch-data") return devtools.payload(captureId, event.payload).toString("utf8");
      }
    }` });
    assert.match(stream.value, /still connected/);
    await call("stream", { action: "discard", captureId });
    assert.equal(page.url(), start);
  } finally {
    devtools?.dispose();
    await page?.close().catch(() => {});
    leaf.closeAllConnections();
    await new Promise((resolve) => leaf.close(resolve));
  }
}

async function launch(directory, browser = executablePath) {
  const context = await firefox.launchPersistentContext(join(root, directory), {
    executablePath: resolve(browser),
    headless: !headed,
    viewport: null,
    // Match the profile owner for developer operations that need the frame's page world.
    ...(resolve(browser) === resolve(executablePath) ? { env: { ...process.env, CAMOU_CONFIG_1: '{"allowMainWorld":true}' } } : {}),
    // Expose Gecko's native controls to System Events in these scratch profiles.
    ...(nativeUi ? { firefoxUserPrefs: { "accessibility.force_disabled": -1 } } : {}),
    timeout: 120_000,
  });
  contexts.add(context);
  assert.ok(context.browser(), "persistent context exposes the browser used by scripts");
  return context;
}

async function fixturePage(page, title) {
  await page.goto(origin);
  if (title) await page.evaluate((title) => { document.title = title; }, title);
}

async function openFixture(context) {
  const page = context.pages()[0] ?? await context.newPage();
  await fixturePage(page);
  return page;
}

async function identity(page) {
  return page.evaluate(() => ({
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height, screen.colorDepth],
  }));
}

async function syntheticDuckDuckGo(context) {
  let fulfilled = 0;
  await context.route(/^https?:\/\/(?:[^/]+\.)?duckduckgo\.com(?:[/?]|$)/, async (route) => {
    fulfilled += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Vela Browser DuckDuckGo proof</title>",
    });
  });
  return () => fulfilled;
}

function nativeBrowserLookupScript() {
  return `ObjC.import('AppKit');
ObjC.import('Foundation');
// Some running applications have no bundle or executable URL; JXA gives them a nil object.
const canonicalPath = (url) => {
  const resolved = url && typeof url.isNil === "function" && !url.isNil() ? url.URLByResolvingSymlinksInPath : undefined;
  return resolved ? ObjC.unwrap(resolved.path) : null;
};
const targetBundlePath = canonicalPath($.NSURL.fileURLWithPath($(${JSON.stringify(nativeAppBundle)})));
const targetExecutablePath = canonicalPath($.NSURL.fileURLWithPath($(${JSON.stringify(nativeExecutable)})));
const applications = $.NSWorkspace.sharedWorkspace.runningApplications;
const matches = [];
const aliasModeCandidates = [];
for (let index = 0; index < applications.count; index += 1) {
  const application = applications.objectAtIndex(index);
  const bundlePath = canonicalPath(application.bundleURL);
  const executablePath = canonicalPath(application.executableURL);
  const name = String(ObjC.unwrap(application.localizedName) ?? "");
  const pid = Number(application.processIdentifier);
  if (bundlePath === targetBundlePath || executablePath === targetExecutablePath) {
    matches.push({ pid, name, bundlePath, executablePath });
  }
  if (name.toLowerCase().includes("aliasmode")) aliasModeCandidates.push({ pid, name, bundlePath, executablePath });
}
if (matches.length !== 1) throw new Error("expected exactly one supplied Firefox application process; matched " + matches.length + "; Vela Browser candidates " + JSON.stringify(aliasModeCandidates));
JSON.stringify(matches[0]);`;
}

function nativeBrowserScript(pid, commands = "") {
  return `tell application "System Events"
  set browserProcesses to every application process whose unix id is ${pid}
  if (count of browserProcesses) is not 1 then error "expected supplied Firefox process by PID; matched " & (count of browserProcesses)
  tell item 1 of browserProcesses
    set frontmost to true
    delay 0.2
${commands}  end tell
end tell`;
}

async function focusNativeBrowser() {
  const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", nativeBrowserLookupScript()]);
  const application = JSON.parse(stdout);
  const pid = application.pid;
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("native Firefox application lookup returned an invalid PID");
  assert.equal(application.name, "AliasMode Firefox", "native Dock application uses the Firefox-specific name");
  await run("osascript", ["-e", nativeBrowserScript(pid)]);
  return pid;
}

async function nativeAddressBarSearch(page, phase, duckDuckGoResponses) {
  if (!nativeUi) return;
  const query = `aliasmode firefox ${phase} search`;
  const before = duckDuckGoResponses();
  const pid = await focusNativeBrowser();
  await page.bringToFront();
  const searchResult = page.waitForURL((url) => {
    const destination = new URL(url);
    return (destination.hostname === "duckduckgo.com" || destination.hostname.endsWith(".duckduckgo.com"))
      && destination.searchParams.get("q") === query;
  }, { timeout: 30_000 });
  await run("osascript", ["-e", nativeBrowserScript(pid, `    keystroke "l" using command down
    keystroke "${query}"
    key code 36
`)]);
  try {
    await searchResult;
  } finally {
    await captureNativeFirefoxUi(page, `search-${phase}`);
  }
  assert.ok(duckDuckGoResponses() > before, "DuckDuckGo navigation must use the synthetic response");
}

async function captureRawNativeFirefoxUi(name) {
  if (!nativeUi) return;
  await run("screencapture", ["-x", join(root, `firefox-dock-tabs-${name}.png`)]);
}

async function captureNativeFirefoxUi(page, name) {
  if (!nativeUi) return;
  await focusNativeBrowser();
  await page.bringToFront();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await run("screencapture", ["-x", join(root, `firefox-dock-tabs-${name}.png`)]);
}

async function assertOneNativeWindow() {
  const pid = await focusNativeBrowser();
  const { stdout } = await run("osascript", ["-e", `tell application "System Events" to tell first application process whose unix id is ${pid} to count windows`]);
  assert.equal(Number.parseInt(stdout, 10), 1, "native tab evidence uses one browser window");
  return pid;
}

async function nativeTabButton(pid, label) {
  const { stdout } = await run("osascript", ["-e", nativeBrowserScript(pid, `    set targetButtons to {}
    set observedButtons to ""
    set navigationPosition to missing value
    set browserElements to entire contents of window 1
    repeat with candidate in browserElements
      if role of candidate is "AXButton" then
        set buttonName to ""
        set buttonDescription to ""
        set buttonHelp to ""
        try
          set buttonName to name of candidate as text
        end try
        try
          set buttonDescription to description of candidate as text
        end try
        try
          set buttonHelp to value of attribute "AXHelp" of candidate as text
        end try
        set observedButtons to observedButtons & buttonName & " / " & buttonDescription & " / " & buttonHelp & linefeed
        if buttonName is "Back" or buttonDescription is "Back" then set navigationPosition to position of candidate
        set buttonSize to size of candidate
        if enabled of candidate and (item 1 of buttonSize) > 0 and (item 2 of buttonSize) > 0 then
          set matchesLabel to buttonName is ${JSON.stringify(label)} or buttonDescription is ${JSON.stringify(label)} or buttonHelp is ${JSON.stringify(label)}
          if ${JSON.stringify(label)} is "New Tab" and buttonDescription starts with "Open a new tab (" then set matchesLabel to true
          if matchesLabel then
            set end of targetButtons to contents of candidate
          end if
        end if
      end if
    end repeat
    if (count of targetButtons) is 0 then error "native tab button missing; observed buttons: " & observedButtons
    if ${JSON.stringify(label)} is "New Tab" and (count of targetButtons) is not 1 then error "native new-tab button is ambiguous"
    set targetButton to item 1 of targetButtons
    set targetPosition to position of targetButton
    repeat with candidate in targetButtons
      set candidatePosition to position of candidate
      if (item 1 of candidatePosition) > (item 1 of targetPosition) then
        set targetButton to contents of candidate
        set targetPosition to candidatePosition
      end if
    end repeat
    if ${JSON.stringify(label)} is "New Tab" then
      if navigationPosition is missing value then error "native navigation toolbar was not found"
      if (item 2 of targetPosition) >= (item 2 of navigationPosition) then error "new-tab button must be beside the tabs, above the navigation toolbar"
    end if
    set observedButtons to observedButtons & "Selected ${label} at " & (item 1 of targetPosition) & ", " & (item 2 of targetPosition) & linefeed
    perform action "AXPress" of targetButton
    return observedButtons
`)]);
  await writeFile(join(root, `firefox-native-buttons-${label === "New Tab" ? "new" : "close"}.txt`), stdout);
}

async function nativeTab(context, title) {
  const pid = await assertOneNativeWindow();
  const [page] = await Promise.all([
    context.waitForEvent("page", { timeout: 30_000 }),
    nativeTabButton(pid, "New Tab"),
  ]);
  await fixturePage(page, title);
  await assertOneNativeWindow();
  return page;
}

async function closeOtherPages(context, page) {
  for (const other of context.pages()) {
    if (other !== page) await other.close();
  }
  assert.equal(context.pages().length, 1, "native tab evidence starts with one tab");
}

async function captureNativeTabEvidence(context, page) {
  if (!nativeUi) return;
  await closeOtherPages(context, page);
  await fixturePage(page, "Tab1");
  await assertOneNativeWindow();
  await captureNativeFirefoxUi(page, "one");
  const second = await nativeTab(context, "Tab2");
  assert.equal(context.pages().length, 2, "native two-tab evidence has two tabs");
  await captureNativeFirefoxUi(second, "two");
  const closePid = await assertOneNativeWindow();
  await Promise.all([
    second.waitForEvent("close", { timeout: 30_000 }),
    nativeTabButton(closePid, "Close tab"),
  ]);
  assert.equal(context.pages().length, 1, "native close-tab button closes the selected second tab");
  await captureNativeFirefoxUi(page, "after-close");
  await nativeTab(context, "Tab2");
  for (let index = 3; index <= 6; index += 1) {
    await nativeTab(context, `Tab${index}`);
  }
  assert.equal(context.pages().length, 6, "native several-tab evidence has six tabs");
  const lastPage = context.pages().at(-1);
  await captureNativeFirefoxUi(lastPage, "several");
  const pid = await assertOneNativeWindow();
  await run("osascript", ["-e", nativeBrowserScript(pid, "    set size of window 1 to {720, 620}\n")]);
  await assertOneNativeWindow();
  await captureNativeFirefoxUi(lastPage, "narrow");
  const overflowTab = await nativeTab(context, "Tab7");
  assert.equal(context.pages().length, 7, "native new-tab button works while tabs overflow");
  await captureNativeFirefoxUi(overflowTab, "narrow-new");
}

async function closedOriginStorage(context, fixture, keepUserWindow = true) {
  const userPage = keepUserWindow ? await context.newPage() : undefined;
  if (userPage) await userPage.setContent("<title>Capture must preserve this tab</title>");
  await fixture.close();
  assert.ok(context.pages().every((page) => !page.url().startsWith(origin)));
  let observe;
  let baseline;
  if (nativeUi) {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", nativeBrowserLookupScript()]);
    const { pid } = JSON.parse(stdout);
    if (userPage) await userPage.bringToFront();
    await run("osascript", ["-e", 'tell application "Finder" to activate']);
    observe = async () => {
      const { stdout } = await run("osascript", ["-e", `tell application "System Events"
        set browserProcess to first application process whose unix id is ${pid}
        set foregroundProcess to first application process whose frontmost is true
        set windowCount to count of windows of browserProcess
        set windowTitle to ""
        if windowCount > 0 then set windowTitle to name of window 1 of browserProcess
        return {windowCount, unix id of foregroundProcess, windowTitle}
      end tell`]);
      return stdout.trim();
    };
    const deadline = Date.now() + 30_000;
    do {
      baseline = await observe();
      const [windows, foreground] = baseline.split(",").map(Number);
      if (windows === (keepUserWindow ? 1 : 0) && foreground !== pid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(Number(baseline.split(",")[0]), keepUserWindow ? 1 : 0, "capture starts with the expected native windows");
    assert.notEqual(Number(baseline.split(",")[1]), pid, "capture starts with Firefox in the background");
  }
  const visibility = userPage && await userPage.evaluate(() => document.visibilityState);
  const native = context._connection.toImpl(context);
  const createPage = native.newPage;
  let helpers = 0;
  // Pause each helper while it exists, so before/after equality cannot hide a flashing window.
  native.newPage = async function (progress, forStorageState) {
    const helper = await createPage.call(this, progress, forStorageState);
    if (forStorageState) {
      helpers += 1;
      try {
        if (observe) assert.equal(await observe(), baseline, "capture preserves native windows, focus and selected tab");
        if (userPage) assert.equal(await userPage.evaluate(() => document.visibilityState), visibility);
      } catch (error) {
        await helper.close();
        throw error;
      }
    }
    return helper;
  };
  try {
    let state;
    for (let index = 0; index < 3; index += 1) {
      state = await context.storageState({ indexedDB: true });
      assert.equal(context.pages().length, keepUserWindow ? 1 : 0, "capture removes only its temporary helper");
      if (userPage) assert.equal(context.pages()[0], userPage);
      if (observe) assert.equal(await observe(), baseline);
      const saved = state.origins.find((entry) => entry.origin === origin);
      assert.ok(saved?.localStorage.some((entry) => entry.name === "proof" && entry.value === "saved"));
      assert.ok(saved?.indexedDB?.length, "closed-origin capture preserves IndexedDB");
      assert.ok(state.cookies.some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
    }
    assert.equal(helpers, 3, "each closed-origin capture exercises the temporary-page path");
    return state;
  } finally {
    native.newPage = createPage;
  }
}

async function databaseValue(page, value) {
  return page.evaluate((value) => new Promise((resolve, reject) => {
    const request = indexedDB.open("aliasmode-proof", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onerror = () => reject(new Error("could not open fixture IndexedDB"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("state", value === null ? "readonly" : "readwrite");
      const store = transaction.objectStore("state");
      const operation = value === null ? store.get("session") : store.put(value, "session");
      let result;
      operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = () => { database.close(); reject(new Error("fixture IndexedDB transaction failed")); };
    };
  }), value);
}

try {
  let context = await launch("profile");
  let duckDuckGoResponses = nativeUi ? await syntheticDuckDuckGo(context) : () => 0;
  let page = await openFixture(context);
  const initialIdentity = await identity(page);
  await context.addCookies([{ name: "proof", value: "saved", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
  await page.evaluate(() => localStorage.setItem("proof", "saved"));
  await databaseValue(page, { restored: true });
  if (nativeUi) {
    await closeOtherPages(context, page);
    await captureRawNativeFirefoxUi("raw-baseline");
    await captureNativeFirefoxUi(page, "baseline");
  }
  await nativeAddressBarSearch(page, "fresh", duckDuckGoResponses);
  if (nativeUi) {
    await page.goto(origin);
    const freshTab = await nativeTab(context, "Fresh tab");
    await captureNativeFirefoxUi(freshTab, "fresh-new");
    await freshTab.close();
  }

  official = await connectOfficial("firefox-proof", async () => nonClosingContext(context));
  assert.ok(official.tools.some((tool) => tool.name === "browser_snapshot"));
  const snapshot = await official.client.callTool({ name: "browser_snapshot", arguments: {} });
  assert.notEqual(snapshot.isError, true, JSON.stringify(snapshot));
  await official.client.close();
  await official.server.close();
  official = undefined;
  assert.equal(await page.title(), "Vela Firefox proof", "MCP disconnect leaves the browser open");

  const script = join(root, "proof-script.mjs");
  await writeFile(script, `export default async ({ browser, context, page }) => ({
    sameBrowser: context.browser() === browser,
    samePage: context.pages().includes(page),
    stored: await page.evaluate(() => localStorage.getItem("proof")),
  });\n`);
  const run = (await import(pathToFileURL(script).href)).default;
  assert.deepEqual(await run({ browser: context.browser(), context, page }), {
    sameBrowser: true, samePage: true, stored: "saved",
  });

  const transferred = {
    cookies: await context.cookies(),
    localStorage: await page.evaluate(() => Object.entries(localStorage)),
    indexedDB: await databaseValue(page, null),
  };
  const nativeState = await closedOriginStorage(context, page);
  assert.ok(nativeState.origins.some((entry) => entry.origin === origin && entry.indexedDB?.length));
  await context.close();
  contexts.delete(context);

  context = await launch("profile");
  duckDuckGoResponses = nativeUi ? await syntheticDuckDuckGo(context) : () => 0;
  page = await openFixture(context);
  assert.deepEqual(await identity(page), initialIdentity);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
  assert.equal(await page.evaluate(() => localStorage.getItem("proof")), "saved");
  assert.deepEqual(await databaseValue(page, null), { restored: true });
  await nativeAddressBarSearch(page, "reopened", duckDuckGoResponses);
  await captureNativeTabEvidence(context, page);
  await context.close();
  contexts.delete(context);

  if (previousBrowser) {
    context = await launch("previous-runtime-profile", previousBrowser);
    page = await openFixture(context);
    const previousIdentity = await identity(page);
    await context.addCookies([{ name: "previous-proof", value: "saved", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }]);
    await page.evaluate(() => localStorage.setItem("previous-proof", "saved"));
    await databaseValue(page, { upgraded: true });
    await context.close();
    contexts.delete(context);

    context = await launch("previous-runtime-profile");
    duckDuckGoResponses = await syntheticDuckDuckGo(context);
    page = await openFixture(context);
    // An engine update changes only the Firefox version in the user agent.
    const unversioned = (value) => ({ ...value, ua: value.ua.replace(/\d+(?:\.\d+)+(?:-beta\.\d+)?/g, "N") });
    assert.deepEqual(unversioned(await identity(page)), unversioned(previousIdentity), "candidate preserves prior runtime identity");
    assert.ok((await context.cookies()).some((cookie) => cookie.name === "previous-proof" && cookie.value === "saved"));
    assert.equal(await page.evaluate(() => localStorage.getItem("previous-proof")), "saved");
    assert.deepEqual(await databaseValue(page, null), { upgraded: true });
    await nativeAddressBarSearch(page, "upgraded", duckDuckGoResponses);
    await closeOtherPages(context, page);
    const upgradedTab = await nativeTab(context, "Upgraded tab");
    await captureNativeFirefoxUi(upgradedTab, "upgraded-new");
    await context.close();
    contexts.delete(context);

    context = await launch("previous-runtime-profile");
    page = await openFixture(context);
    await closeOtherPages(context, page);
    const reopenedTab = await nativeTab(context, "Upgraded reopened tab");
    await captureNativeFirefoxUi(reopenedTab, "upgraded-reopened-new");
    await context.close();
    contexts.delete(context);
  }

  const windowlessBrowser = await firefox.launch({
    executablePath: resolve(executablePath), headless: !headed, timeout: 120_000,
    ...(nativeUi ? { firefoxUserPrefs: { "accessibility.force_disabled": -1 } } : {}),
  });
  try {
    const isolated = await windowlessBrowser.newContext();
    const other = await windowlessBrowser.newContext();
    const fixture = await openFixture(isolated);
    await isolated.addCookies([{ name: "proof", value: "saved", url: origin }]);
    await fixture.evaluate(() => localStorage.setItem("proof", "saved"));
    await databaseValue(fixture, { restored: true });
    const otherPage = await openFixture(other);
    await other.addCookies([{ name: "proof", value: "other-context", url: origin }]);
    await otherPage.evaluate(() => localStorage.setItem("proof", "other-context"));
    await databaseValue(otherPage, { other: true });
    await otherPage.close();
    const saved = await closedOriginStorage(isolated, fixture, false);
    assert.deepEqual(saved.origins.find((entry) => entry.origin === origin)?.indexedDB[0].stores[0].records,
      [{ key: "session", value: { restored: true } }]);
    await isolated.close();
    const otherState = await other.storageState({ indexedDB: true });
    assert.ok(otherState.cookies.some((cookie) => cookie.name === "proof" && cookie.value === "other-context"));
    assert.deepEqual(otherState.origins.find((entry) => entry.origin === origin)?.localStorage,
      [{ name: "proof", value: "other-context" }]);
    assert.deepEqual(otherState.origins.find((entry) => entry.origin === origin)?.indexedDB[0].stores[0].records,
      [{ key: "session", value: { other: true } }]);
    assert.equal(other.pages().length, 0, "closing another context leaves no storage helper behind");
  } finally {
    await windowlessBrowser.close();
  }

  context = await launch("transferred-profile");
  await context.addCookies(transferred.cookies);
  page = await openFixture(context);
  await page.evaluate((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, transferred.localStorage);
  await databaseValue(page, transferred.indexedDB);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "proof" && cookie.value === "saved"));
  assert.equal(await page.evaluate(() => localStorage.getItem("proof")), "saved");
  assert.deepEqual(await databaseValue(page, null), { restored: true });
  await verifyNestedDevtools(context);

  const result = {
    platform: process.platform,
    browserVersion: context.browser().version(),
    persistentContext: true,
    localStateSurvivesRestart: true,
    nativeIdentityStableAcrossRestart: true,
    officialMcp: true,
    mcpDisconnectPreservesContext: true,
    nestedDeveloperTools: true,
    scriptContext: true,
    selectedStateTransfer: true,
    indexedDbSnapshot: true,
    windowlessStorageCapture: true,
    storageContextIsolation: true,
    nativeCapturePreservesWindowsAndFocus: nativeUi,
    nativeAddressBarDuckDuckGo: nativeUi,
    nativeTabAndDockEvidence: nativeUi,
    nativeNewAndCloseTabButtons: nativeUi,
    nativeFirefoxDockName: nativeUi,
    previousRuntimeUpgrade: Boolean(previousBrowser),
  };
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await official?.client.close().catch(() => {});
  await official?.server.close().catch(() => {});
  for (const context of contexts) await context.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

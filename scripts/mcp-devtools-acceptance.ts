/** Real pinned engines, two fresh profiles each, through the public MCP host and manager. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVelaBrowserMcp } from "../agent/mcp-host.mjs";
import { DEVTOOLS_TOOLS } from "../agent/devtools.mjs";
import { AGENT_CONTROL_PROTOCOL, AgentControlSession } from "../src/agent-control.ts";
import { LifecycleAdmissionController } from "../src/lifecycle-admission.ts";
import { ProfileStore } from "../src/store.ts";
import { Launcher } from "../src/launcher.ts";
import { buildNewProfile } from "../src/create.ts";
import { scanPlugins } from "../src/plugins.ts";
import { fingerprintProbe, type FingerprintSample } from "../src/diagnose.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import type { ProfileEngine } from "../src/types.ts";

const root = mkdtempSync(resolve("reports/mcp-devtools-acceptance-"));
const binaries = { chromium: resolve("reports/runtimes/chromium/chromium-155.0.8059.85-aliasmode.5/chrome.exe"),
  firefox: resolve("src-tauri/resources/firefox/aliasmode.exe"), webkit: resolve("reports/webkit-native-2388/Playwright.exe") };
const firefoxMetadata = JSON.parse(readFileSync("src-tauri/generated/browser.json", "utf8")).firefox;
for (const path of Object.values(binaries)) assert.ok(existsSync(path), `Missing pinned engine: ${path}`);
assert.equal(createHash("sha256").update(readFileSync(binaries.firefox)).digest("hex"), firefoxMetadata.sha256);
const report: { generatedAt: string; root: string; engines: Record<string, any>; checks: { name: string; pass: boolean }[]; fatal?: string } = {
  generatedAt: new Date().toISOString(), root, engines: {}, checks: [],
};
function check(name: string, pass: boolean) { report.checks.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`); assert.ok(pass, name); }
const binary = Buffer.from(Array.from({ length: 150_013 }, (_, i) => i % 251));
const fixture = createServer((request, response) => { void (async () => {
  const url = new URL(request.url!, "http://fixture");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/binary") { response.setHeader("content-type", "application/octet-stream"); response.end(binary); return; }
  if (url.pathname === "/stream") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: pending\n\n"); return; }
  if (url.pathname === "/missing") { response.writeHead(404); response.end("missing"); return; }
  if (url.pathname === "/redirect") { response.writeHead(302, { location: "/data" }); response.end(); return; }
  if (url.pathname === "/data") {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(part);
    response.writeHead(200, { "content-type": "application/json", "set-cookie": ["response_a=1; Path=/", "response_b=2; Path=/"] });
    response.end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString(), cookie: request.headers.cookie ?? "", marker: request.headers["x-vela-test"] ?? "" })); return;
  }
  if (url.pathname === "/worker.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end("globalThis.workerMarker = 'worker'; console.warn('worker-ready'); setInterval(() => {}, 60000);"); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/frame") { response.end("<!doctype html><p id=frame>iframe fixture</p>"); return; }
  response.end(`<!doctype html><meta charset=utf-8><title>MCP fixture</title><style>#target{color:rgb(32, 48, 64)}</style>
    <p id=target data-original=yes>original</p><input aria-label="Input"><button onclick="this.textContent='clicked'">Run</button><iframe src=/frame></iframe>
    <script>window.fixtureWorker = new Worker('/worker.js'); console.log('fixture-loaded');
    (async () => { const probe = (${fingerprintProbe.toString()}); await document.fonts.ready; await probe({details:true}); await document.fonts.ready;
    const value = await probe({details:true}); const output = document.createElement('pre'); output.id = 'baseline'; output.textContent = JSON.stringify(value); document.body.appendChild(output); })();</script>`);
})().catch(error => { response.statusCode = 500; response.end(String(error)); }); });
const sockets = new WebSocketServer({ server: fixture, path: "/socket" });
sockets.on("connection", socket => { socket.send("server-ready"); socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary })); });
await new Promise<void>(done => fixture.listen(0, "127.0.0.1", done));
const fixturePort = (fixture.address() as any).port;
const origin = `http://127.0.0.1:${fixturePort}`;
const proxyHits: { url: string; authorization?: string }[] = [];
const proxy = createServer((request, response) => {
  let url: URL; try { url = new URL(request.url!); } catch { response.writeHead(400); response.end(); return; }
  if (url.hostname !== "vela.test" && !(url.hostname === "127.0.0.1" && Number(url.port) === fixturePort)) { response.writeHead(502); response.end(); return; }
  proxyHits.push({ url: url.href, authorization: request.headers["proxy-authorization"] });
  const headers = { ...request.headers }; delete headers["proxy-authorization"];
  const upstream = httpRequest({ hostname: "127.0.0.1", port: fixturePort, path: url.pathname + url.search, method: request.method, headers }, result => {
    response.writeHead(result.statusCode!, result.headers); result.pipe(response);
  });
  upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
});
proxy.on("connect", (request, socket, head) => {
  const url = new URL(`http://${request.url}`);
  if (!["vela.test", "127.0.0.1"].includes(url.hostname) || Number(url.port) !== fixturePort) { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
  const upstream = connect(fixturePort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head);
    socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
});
proxy.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url!, origin);
  const upstream = connect(fixturePort, "127.0.0.1", () => {
    upstream.write(`${request.method} ${url.pathname} HTTP/1.1\r\n${Object.entries(request.headers).filter(([name]) => name !== "proxy-authorization").map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
});
await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
const proxyPort = (proxy.address() as any).port;
const store = new ProfileStore(join(root, "profiles.sqlite"));
const launcher = new Launcher({ store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"), headless: true,
  firefoxBinaryPath: binaries.firefox, expectedFirefoxBinarySha256: firefoxMetadata.sha256,
  ensureAliasmodeChromium: async () => binaries.chromium, ensureWebKit: async () => binaries.webkit,
  log: message => console.log(message) });
// A plugin that reports where it ran, tries to close its browser, and fetches through its page.
const pluginRoot = join(root, "plugins");
mkdirSync(join(pluginRoot, "vela-check"), { recursive: true });
writeFileSync(join(pluginRoot, "vela-check", "vela-plugin.json"), JSON.stringify({ id: "vela-check", name: "Vela check", version: "1.0.0",
  tools: [{ name: "inspect", description: "Reports the environment it runs in.", inputSchema: { type: "object", properties: { marker: { type: "string" } } } }] }));
writeFileSync(join(pluginRoot, "vela-check", "index.mjs"), `export default (vela) => {
  let calls = 0;
  return { async inspect({ marker }) {
    let closeRefused = false;
    try { await vela.context.close(); } catch { closeRefused = true; }
    const pages = await vela.devtools("pages");
    // vela.test resolves only through the environment's configured upstream proxy.
    const page = await vela.context.newPage();
    try {
      await page.goto("http://vela.test/?plugin=" + marker);
      const fetched = await page.evaluate(async marker => (await fetch("/data", { method: "POST", body: "plugin-" + marker, headers: { "x-vela-test": "plugin-" + marker } })).json(), marker);
      return { profileId: vela.profileId, engine: vela.engine, calls: ++calls, closeRefused, browser: vela.context.browser(), fetched, pageCount: pages.pages.length };
    } finally { await page.close(); }
  } };
};
`);
const manager = new AgentControlSession({ store, launcher, admission: new LifecycleAdmissionController(), plugins: () => scanPlugins(pluginRoot).specs });
let requestNumber = 0;
const runtime = { async call(method: string, params: any = {}) {
  const response = await manager.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: ++requestNumber, method, params }));
  if (!response.ok) throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.result;
}, close() { void manager.disconnect(); } };
const host = await createVelaBrowserMcp({ discovered: { client: runtime } });
const client = new Client({ name: "vela-devtools-acceptance", version: "0.1.3" }, { capabilities: {} });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
async function call(name: string, args: any = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.content)}`);
  return response.structuredContent ?? JSON.parse((response.content as any)[0].text);
}
const developer = (name: string, args: any = {}) => call(`browser_devtools_${name}`, args);
const ids: string[] = [];
const identityFields = ["userAgent", "platform", "language", "languages", "timezone", "hardwareConcurrency", "deviceMemory", "screen", "webglVendor", "webglRenderer",
  "canvasHash", "canvasPixelsHash", "audioHash", "audioSampleHash", "webglHash", "fontsHash", "textMetricsHash"] as const;
const identity = (sample: FingerprintSample) => Object.fromEntries(identityFields.map(key => [key, sample[key]]));
async function until(read: () => Promise<any>, accept: (value: any) => boolean) {
  const deadline = Date.now() + 15_000;
  let value;
  do { value = await read(); if (accept(value)) return value; await Bun.sleep(100); } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for recorded browser events: ${JSON.stringify(value).slice(0, 12000)}`);
}
try {
  for (const engine of (process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"]) as ProfileEngine[]) {
    const profiles = ["a", "b"].map(name => buildNewProfile({ engine, name: `MCP ${engine} ${name}`, screen: "1280x800",
      proxy: { type: "http", host: "127.0.0.1", port: String(proxyPort), user: `mcp-${name}`, pass: "fixture-only" },
      ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}) }, () => false));
    const evidence: any = report.engines[engine] = { profiles: profiles.map(profile => profile.id), baselines: [] };
    for (const profile of profiles) {
      store.upsertProfile(profile); ids.push(profile.id);
      await launcher.start(profile.id, [], { autoNavigate: false });
      const readWitness = () => runPlaywrightWorker<FingerprintSample[]>("page", { endpoint: store.getLaunch(profile.id)!.ws,
        kind: "scripts", url: origin, scripts: ["new Promise((resolve,reject) => { const deadline=Date.now()+15000; const read=()=>{const node=document.querySelector('#baseline'); if(node)resolve(JSON.parse(node.textContent)); else if(Date.now()>deadline)reject(new Error('Page fingerprint timed out')); else setTimeout(read,50);}; read(); })"] });
      // Warm the native platform font list before attaching MCP, then take a new-document
      // witness. Retain the initial sample too so startup font loading remains visible.
      const [initial] = await readWitness();
      (evidence.initial ??= []).push(initial);
      // Windows Firefox loads system font aliases on a delayed native startup task.
      // Retain that cold sample, then measure after the loader settles, before MCP
      // is attached. document.fonts.ready alone does not wait for this platform cache.
      if (engine === "firefox") await Bun.sleep(16_000);
      const [sample] = await readWitness();
      evidence.baselines.push(sample);
      const required = ["canvasPixelsHash", "webglHash", "fontsHash", "textMetricsHash", ...(engine === "webkit" ? [] : ["audioSampleHash"])];
      check(`${engine}/${profile.id}: baseline covers native fingerprint surfaces`, required.every(key => !!(sample as any)[key]));
    }
    for (const profile of profiles) await call("aliasmode_browser_select", { profileId: profile.id });
    const tools = (await client.listTools()).tools;
    check(`${engine}: all developer tools are available by default`, DEVTOOLS_TOOLS.every(tool => tools.some(candidate => candidate.name === tool.name)));
    const pages = await Promise.all(profiles.map(profile => developer("pages", { profileId: profile.id })));
    evidence.pages = pages;
    const targets = pages.map(listing => listing.pages.find((page: any) => page.url === `${origin}/`));
    assert.ok(targets.every(Boolean), "existing pages remain attached");
    const a = { profileId: profiles[0]!.id, pageId: targets[0].pageId }, b = { profileId: profiles[1]!.id, pageId: targets[1].pageId };
    check(`${engine}: plugin tools are listed with honest write hints`, tools.some(tool => tool.name === "plugin_vela_check_inspect" && tool.annotations?.destructiveHint === true));
    const pluginHits = proxyHits.length;
    const [pluginA, pluginB] = await Promise.all([call("plugin_vela_check_inspect", { profileId: a.profileId, marker: "a" }), call("plugin_vela_check_inspect", { profileId: b.profileId, marker: "b" })]);
    const pluginAgain = await call("plugin_vela_check_inspect", { profileId: a.profileId, marker: "a" });
    evidence.plugin = { pluginA, pluginB, proxyHits: proxyHits.slice(pluginHits) };
    check(`${engine}: a plugin runs in the environment it was called for`, pluginA.profileId === a.profileId && pluginB.profileId === b.profileId && pluginA.engine === engine && pluginA.pageCount >= 1);
    check(`${engine}: plugin state stays within its environment`, pluginA.calls === 1 && pluginB.calls === 1 && pluginAgain.calls === 2);
    check(`${engine}: a plugin cannot close or reach the browser`, pluginA.closeRefused === true && pluginA.browser === null
      && (await Promise.all(profiles.map(profile => call("aliasmode_browser_status", { profileId: profile.id })))).every((status: any) => status.running));
    check(`${engine}: plugin requests use the environment's own cookies and authenticated proxy`, pluginA.fetched.marker === "plugin-a" && pluginB.fetched.marker === "plugin-b"
      && proxyHits.slice(pluginHits).some(hit => hit.authorization === `Basic ${Buffer.from("mcp-a:fixture-only").toString("base64")}`)
      && proxyHits.slice(pluginHits).some(hit => hit.authorization === `Basic ${Buffer.from("mcp-b:fixture-only").toString("base64")}`));
    const evaluate = async (target: any, expression: string, argument?: any) => (await developer("evaluate", { ...target, expression, ...(argument === undefined ? {} : { argument }) })).value;
    await Promise.all([evaluate(a, "() => { console.debug('private-a-debug'); console.warn('private-a-warning'); setTimeout(() => { throw new Error('private-a-uncaught'); }, 0); document.querySelector('#target').textContent='edited'; }"),
      evaluate(b, "() => console.log('private-b-log')")]);
    const logs = await until(() => developer("console", a), value => value.records.some((record: any) => record.text.includes("private-a-uncaught") && record.stack));
    check(`${engine}: debug, warning and uncaught stack are recorded`, ["private-a-debug", "private-a-warning", "private-a-uncaught"].every(text => logs.records.some((record: any) => record.text.includes(text))));
    check(`${engine}: console history stays private`, !(JSON.stringify(await developer("console", b))).includes("private-a-"));
    check(`${engine}: DOM writes and computed styles work`, (await developer("element", { ...a, selector: "#target", styles: ["color"] })).text === "edited");
    await developer("storage_edit", { ...a, storage: "localStorage", action: "set", entries: { privateValue: "profile-a" } });
    await developer("storage_edit", { ...a, storage: "sessionStorage", action: "set", entries: { privateSession: "session-a" } });
    await developer("storage_edit", { ...a, storage: "cookies", action: "set", cookies: [{ name: "private_cookie", value: "cookie-a", url: origin, httpOnly: true }] });
    const own = await developer("storage", a), peer = await developer("storage", b);
    check(`${engine}: cookie/local/session storage writes stay isolated`, own.localStorage.value.privateValue === "profile-a" && own.sessionStorage.value.privateSession === "session-a"
      && own.cookies.some((cookie: any) => cookie.name === "private_cookie" && cookie.httpOnly) && !JSON.stringify(peer).includes("profile-a") && !peer.cookies.some((cookie: any) => cookie.name === "private_cookie"));
    const rejected = await client.callTool({ name: "browser_devtools_evaluate", arguments: { ...b, pageId: a.pageId, expression: "document.title" } });
    check(`${engine}: foreign page id cannot cross environments`, rejected.isError === true);
    const frame = targets[0].frames.find((frame: any) => !frame.main);
    check(`${engine}: iframe execution context is addressable`, !!frame && await evaluate({ ...a, frameId: frame.frameId }, "document.querySelector('#frame').textContent") === "iframe fixture");
    await evaluate(a, "() => { window.fixtureWorker.terminate(); window.fixtureWorker = new Worker('/worker.js'); }");
    const workerPages = await until(() => developer("pages", { profileId: a.profileId }), value => value.workers.some((worker: any) => worker.type === "worker" && worker.pageId === a.pageId));
    const worker = workerPages.workers.find((worker: any) => worker.type === "worker" && worker.pageId === a.pageId);
    check(`${engine}: worker execution context is addressable`, !!worker && await evaluate({ ...a, workerId: worker.workerId }, "globalThis.workerMarker") === "worker");
    await evaluate(a, `() => new Promise((resolve, reject) => { const socket = window.fixtureSocket = new WebSocket('ws://127.0.0.1:${fixturePort}/socket'); socket.onerror = reject; socket.onmessage = event => { if (event.data === 'server-ready') socket.send('private-a-websocket'); else resolve(event.data); }; })`);
    const wsEvents = await until(() => developer("events", { ...a, kind: "websocket-received" }), value => value.records.some((record: any) => record.text === "private-a-websocket"));
    check(`${engine}: websocket frames are readable`, wsEvents.records.some((record: any) => record.text === "private-a-websocket"));
    await evaluate(a, "async () => { await Promise.all([fetch('/data', {method:'POST', body:'original-post'}), fetch('/binary'), fetch('/redirect'), fetch('/missing')].map(async pending => (await pending).arrayBuffer())); await fetch('/stream').then(response => window.fixtureStream = response); }");
    const requests = await until(() => developer("network", a), value => value.records.some((record: any) => record.url.endsWith("/binary") && record.state === "finished"));
    const binaryRequest = requests.records.find((record: any) => record.url.endsWith("/binary"));
    const first = await developer("request", { ...{ profileId: a.profileId }, requestId: binaryRequest.requestId, responseBody: true, bytes: 65_536 });
    const second = await developer("request", { profileId: a.profileId, requestId: binaryRequest.requestId, responseBody: true, offset: first.responseBody.nextOffset, bytes: 1_048_576 });
    check(`${engine}: response chunks recover binary bytes without replay`, Buffer.concat([Buffer.from(first.responseBody.base64, "base64"), Buffer.from(second.responseBody.base64, "base64")]).equals(binary));
    const post = requests.records.find((record: any) => record.method === "POST");
    const detail = await developer("request", { profileId: a.profileId, requestId: post.requestId, responseBody: true });
    check(`${engine}: POST body, duplicate response headers and failure status are readable`, detail.requestBody.text === "original-post"
      && detail.responseHeadersArray.filter((header: any) => header.name.toLowerCase() === "set-cookie").length === 2
      && requests.records.some((record: any) => record.status === 404) && requests.records.some((record: any) => record.redirectedFrom));
    const streaming = requests.records.find((record: any) => record.url.endsWith("/stream"));
    const started = Date.now();
    const streamingDetail = await developer("request", { profileId: a.profileId, requestId: streaming.requestId, responseBody: true });
    check(`${engine}: a streaming request does not block diagnostics`, streamingDetail.responseBody.available === false && Date.now() - started < 2_000);
    const foreignRequest = await client.callTool({ name: "browser_devtools_request", arguments: { profileId: b.profileId, requestId: binaryRequest.requestId } });
    check(`${engine}: request ids stay within their original environment`, foreignRequest.isError === true);
    await evaluate(a, "() => { window.fixtureSocket.close(); window.fixtureStream.body.cancel(); }");
    if (engine === "chromium") {
      const cdp = await developer("protocol", { ...a, method: "Runtime.evaluate", params: { expression: "document.title = 'Native protocol write'", returnByValue: true } });
      check(`${engine}: arbitrary native protocol changes are available`, cdp.value.result.value === "Native protocol write");
    }
    // A hostname resolved only by this local upstream proves MCP fetch uses the configured proxy.
    const navigate = async (url: string) => {
      const response = await client.callTool({ name: "browser_navigate", arguments: { profileId: a.profileId, url } });
      assert.ok(!response.isError, JSON.stringify(response.content));
    };
    await navigate(`http://vela.test:${fixturePort}/`);
    await until(() => developer("pages", { profileId: a.profileId }), value => value.pages.some((page: any) => page.pageId === a.pageId && page.url.startsWith("http://vela.test:")));
    const hitCount = proxyHits.length;
    const fetched = await developer("fetch", { ...a, url: "/data", method: "POST", bodyBase64: Buffer.from("mcp-write").toString("base64"), headers: { "x-vela-test": "profile-a" } });
    const body = JSON.parse(Buffer.from(fetched.body.base64, "base64").toString());
    check(`${engine}: request writes use the native profile and authenticated proxy`, body.body === "mcp-write" && body.marker === "profile-a" && proxyHits.slice(hitCount).some(hit => hit.authorization === `Basic ${Buffer.from("mcp-a:fixture-only").toString("base64")}`));
    await navigate(`${origin}/`);
    await until(() => developer("pages", { profileId: a.profileId }), value => value.pages.some((page: any) => page.pageId === a.pageId && page.url === `${origin}/`));
    evidence.after = [];
    for (const [index, target] of [a, b].entries()) {
      if (index > 0) {
        const response = await client.callTool({ name: "browser_navigate", arguments: { profileId: target.profileId, url: `${origin}/` } });
        assert.ok(!response.isError, JSON.stringify(response.content));
      }
      // Measure what a normal document script sees, independently of the debugger's
      // execution principal; Firefox deliberately keeps its automation realm separate.
      const witness = await until(() => evaluate(target, "document.querySelector('#baseline')?.textContent"), value => !!value);
      const after = JSON.parse(witness);
      evidence.after.push(after);
      check(`${engine}/${index}: MCP diagnostics preserve all measured fingerprints`, JSON.stringify(identity(after)) === JSON.stringify(identity(evidence.baselines[index])));
      check(`${engine}/${index}: profile proxy and fingerprint seed are unchanged`, store.getProfile(target.profileId)!.fingerprintSeed === profiles[index]!.fingerprintSeed
        && JSON.stringify(store.getProfile(target.profileId)!.proxy) === JSON.stringify(profiles[index]!.proxy));
    }
    // Remove and clear are real storage operations, not simulated success.
    await developer("storage_edit", { ...a, storage: "localStorage", action: "remove", keys: ["privateValue"] });
    await developer("storage_edit", { ...a, storage: "sessionStorage", action: "clear" });
    await developer("storage_edit", { ...a, storage: "cookies", action: "remove", name: "private_cookie" });
    const removed = await developer("storage", a);
    check(`${engine}: storage remove and clear take effect`, removed.localStorage.value.privateValue === undefined && !removed.cookies.some((cookie: any) => cookie.name === "private_cookie"));
    for (const profile of profiles) { await call("aliasmode_browser_close", { profileId: profile.id }); }
  }
} catch (error) {
  report.fatal = error instanceof Error ? error.stack : String(error); console.error(report.fatal); process.exitCode = 1;
  const last = Object.values(report.engines).at(-1);
  if (last) last.diagnostics = await Promise.all(last.profiles.map(async (profileId: string) => ({ profileId,
    events: await developer("events", { profileId }).catch(String), network: await developer("network", { profileId }).catch(String) })));
}
finally {
  await client.close().catch(() => {}); await host.close().catch(() => {}); await manager.disconnect().catch(() => {});
  for (const id of ids) { await launcher.stop(id).catch(() => false); await launcher.cacheCleanupSettled(id).catch(() => {}); }
  store.close();
  for (const socket of sockets.clients) socket.terminate(); sockets.close();
  fixture.closeAllConnections(); fixture.close(); proxy.closeAllConnections(); proxy.close();
  writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${join(root, "report.json")}`);
}

/** Real product acceptance: no mocked owners, process scans, storage or browser input. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { buildNewProfile } from "../src/create.ts";
import { Launcher, readHostProcessSnapshot } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";
import { ensureWebKit } from "../src/webkit-install.ts";
import { callWebKitOwner, type WebKitOwner } from "../src/webkit-runtime.ts";
import { WorkbenchHub } from "../src/workbench.ts";
import { handleRequest } from "../src/server.ts";
import { serveDashboard } from "../src/web.ts";
import { AppConfigStore } from "../src/app-config.ts";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const reports = resolve("reports"); mkdirSync(reports, { recursive: true });
const root = mkdtempSync(join(reports, "webkit-launcher-"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
const report: { root: string; checks: Array<{ name: string; pass: boolean }>; observations: Record<string, unknown>; fatal?: string } = { root, checks: [], observations: {} };
const check = async (name: string, run: () => unknown) => { await run(); report.checks.push({ name, pass: true }); console.log(`pass: ${name}`); };
const listen = async (server: Server) => { await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); return (server.address() as net.AddressInfo).port; };
const stopServer = async (server: Server) => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); };
const fixture = `<!doctype html><meta charset=utf-8><title>WebKit · Atelier</title><style>body{margin:24px;font:16px system-ui;background:#faf9f6;min-height:2000px}h1{font:44px Georgia}input{display:block;margin:24px 0;width:280px;padding:12px}button{padding:12px}#drag{width:100px;height:50px;margin-top:30px;background:#dfd7c9;touch-action:none}</style><h1>A little room to grow.</h1><p>Independent WebKit environment</p><input aria-label="Acceptance input"><button id=click>Save</button><div id=drag>Drag</div><script>window.clicks=0;document.querySelector('#click').onclick=()=>clicks++;const d=document.querySelector('#drag');d.onpointerdown=e=>d.setPointerCapture(e.pointerId);d.onpointermove=e=>{if(e.buttons)window.dragged=true}</script>`;
const content = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/sw.js") { response.setHeader("content-type", "text/javascript"); response.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); return; }
  response.setHeader("content-type", "text/html; charset=utf-8"); response.end(fixture);
});
const proxyCounts = [0, 0], proxyHeaders: string[][] = [[], []];
let routeAvailable = true;
const proxies = [0, 1].map((index) => {
  const server = createServer((request, response) => {
    proxyCounts[index]!++; proxyHeaders[index]!.push(String(request.headers["proxy-authorization"] ?? ""));
    if (!routeAvailable) { response.writeHead(502); response.end("proxy unavailable"); return; }
    if (request.headers["proxy-authorization"] !== `Basic ${Buffer.from(`account${index}:secret${index}`).toString("base64")}`) { response.writeHead(407); response.end(); return; }
    response.setHeader("content-type", "text/html; charset=utf-8"); response.end(fixture.replace("Independent WebKit environment", `Proxy route ${index}`));
  });
  server.on("connect", (_request, socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  return server;
});
let launcher: Launcher;
const launchers: Launcher[] = [];
let dashboard: ReturnType<typeof serveDashboard> | undefined;
let proxyManager: ReturnType<typeof Bun.spawn> | undefined;
const ids: string[] = [];
const owner = (id: string): WebKitOwner => { const saved = store.getLaunch(id)?.webkitOwner; assert.ok(saved); return saved; };
const evaluate = async <T>(id: string, source: string): Promise<T> => {
  const [result] = await callWebKitOwner<any[]>(owner(id), "page", { kind: "scripts", scripts: [`(${source})()`] });
  if (result?.__aliasmodeError) throw new Error(result.__aliasmodeError);
  return result as T;
};
const state = (id: string) => evaluate<any>(id, `async()=>({cookie:document.cookie,local:localStorage.getItem('account'),indexed:await new Promise((done,fail)=>{const r=indexedDB.open('identity',1);r.onsuccess=()=>{const q=r.result.transaction('data').objectStore('data').get('account');q.onsuccess=()=>{r.result.close();done(q.result)};q.onerror=fail};r.onerror=fail}),cache:await(await caches.open('identity')).match('/account').then(r=>r?.text()),workers:(await navigator.serviceWorker.getRegistrations()).length,input:document.querySelector('input')?.value,clicks:window.clicks,dragged:!!window.dragged})`);
try {
  const contentPort = await listen(content);
  const proxyPorts = await Promise.all(proxies.map(listen));
  const runtimeRoot = join(root, "runtimes");
  const archive = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "reports/webkit-win64-2388.zip");
  await ensureWebKit(runtimeRoot, existsSync(archive) ? { download: async (_url, output) => { copyFileSync(archive, output); } } : {});
  const makeLauncher = () => {
    const value = new Launcher({ store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: runtimeRoot, headless: !process.argv.includes("--headed"), log: (message) => console.log(message) });
    launchers.push(value); return value;
  };
  launcher = makeLauncher();
  const url = `http://127.0.0.1:${contentPort}/`;
  for (const name of ["a", "b"]) {
    const profile = buildNewProfile({ engine: "webkit", name: `WebKit · ${name.toUpperCase()}`, group: "WebKit · Studio", screen: "1280x800" }, () => false);
    profile.locale = "zh-TW"; profile.timezone = "Asia/Taipei";
    store.upsertProfile(profile); ids.push(profile.id);
    await launcher.start(profile.id, [url]);
  }
  const [a, b] = ids as [string, string];
  const fingerprints = [a, b].map((id) => {
    const { capturedAt: _capturedAt, ...fingerprint } = store.getProfile(id)!.fpObserved!;
    assert.ok(fingerprint.canvas); return fingerprint;
  });
  report.observations.fingerprints = fingerprints;
  report.observations.processes = (await readHostProcessSnapshot())?.records.filter((record) => record.executablePath?.includes("webkit-2388") || record.commandLine?.includes("aliasmode-webkit-owner"));
  report.observations.status = await callWebKitOwner(owner(a), "status", {});
  const current = store.getLaunch(a)!;
  report.observations.launch = { ...current, webkitOwner: { ...current.webkitOwner, token: "redacted" } };
  report.observations.probes = {
    status: await (launcher as any).contextStatus(current).catch(String),
    processes: await (launcher as any).contextProcesses(current),
    cdp: await (launcher as any).probeLiveLaunchCdp(current),
  };
  const fullSnapshot = await readHostProcessSnapshot();
  const relatedPids = new Set([current.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const record of fullSnapshot!.records) if (record.parentPid && relatedPids.has(record.parentPid) && !relatedPids.has(record.pid)) { relatedPids.add(record.pid); changed = true; }
  }
  report.observations.related = fullSnapshot?.records.filter((r) => relatedPids.has(r.pid));
  await check("real launcher starts separate certified WebKit processes", async () => {
    assert.notEqual(store.getLaunch(a)!.pid, store.getLaunch(b)!.pid);
    assert.ok(await launcher.certifiedActive(a)); assert.ok(await launcher.certifiedActive(b));
    assert.equal(store.getLaunch(a)!.engine, "webkit");
  });
  for (const [index, id] of [a, b].entries()) await evaluate(id, `async()=>{const account=${JSON.stringify(index === 0 ? "a" : "b")};document.cookie='account='+account+';path=/';localStorage.setItem('account',account);await new Promise((done,fail)=>{const r=indexedDB.open('identity',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>{const d=r.result,t=d.transaction('data','readwrite');t.objectStore('data').put(account,'account');t.oncomplete=()=>{d.close();done(true)};t.onerror=fail};r.onerror=fail});await(await caches.open('identity')).put('/account',new Response(account));await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;return true}`);
  await check("native storage is independent through the product owner", async () => {
    const first = await state(a), second = await state(b);
    for (const [data, account] of [[first, "a"], [second, "b"]] as const) {
      assert.equal(data.local, account); assert.equal(data.indexed, account); assert.equal(data.cache, account);
      assert.equal(data.cookie, `account=${account}`); assert.equal(data.workers, 1);
    }
    report.observations.storage = [first, second];
  });
  await check("workbench input and frames use the selected owner only", async () => {
    const hub = new WorkbenchHub({ launcher, store }); const connection = await hub.connect(a);
    try {
    const events: any[] = []; await connection.start((event) => events.push(event));
    const ready = events.find((event) => event.type === "ready"); assert.ok(ready);
    await connection.enqueue({ action: "visibility", visible: true, focused: true, generation: connection.generation });
    const send = (input: unknown) => connection.enqueue({ action: "input", input, generation: connection.generation, targetId: ready.targetId });
    const rect = await evaluate<any>(a, "()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:r.x+20,y:r.y+20}}");
    for (const event of ["down", "up"]) await send({ kind: "pointer", event, ...rect, button: "left", buttons: event === "down" ? 1 : 0, clicks: 1, modifiers: 0 });
    await send({ kind: "text", text: "工作台 · WebKit 隔离 ✓" });
    assert.equal((await state(a)).input, "工作台 · WebKit 隔离 ✓"); assert.equal((await state(b)).input, "");
    const point = async (selector: string) => evaluate<any>(a, `()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+20,y:r.y+20}}`);
    const click = await point("button");
    for (const event of ["down", "up"]) await send({ kind: "pointer", event, ...click, button: "left", buttons: event === "down" ? 1 : 0, clicks: 1, modifiers: 0 });
    assert.equal((await state(a)).clicks, 1); assert.equal((await state(b)).clicks, 0);
    const drag = await point("#drag");
    for (const [event, x] of [["down", drag.x], ["move", drag.x + 80], ["up", drag.x + 80]] as const) await send({ kind: "pointer", event, x, y: drag.y, button: "left", buttons: event === "up" ? 0 : 1, clicks: 1, modifiers: 0 });
    assert.equal((await state(a)).dragged, true); assert.equal((await state(b)).dragged, false);
    await send({ kind: "wheel", x: 500, y: 500, dx: 0, dy: 420, modifiers: 0 });
    const scrolled = await evaluate<number>(a, "async()=>{for(let n=0;n<30&&!scrollY;n++)await new Promise(r=>requestAnimationFrame(r));return scrollY}");
    assert.ok(scrolled > 0); assert.equal(await evaluate(b, "()=>scrollY"), 0);
    await connection.enqueue({ action: "new", generation: connection.generation });
    const added = events.filter((event) => event.type === "tabs").at(-1); assert.equal(added.tabs.length, 2);
    await connection.enqueue({ action: "close", generation: connection.generation, targetId: added.targetId });
    assert.equal(events.filter((event) => event.type === "tabs").at(-1).tabs.length, 1);
    assert.equal((await callWebKitOwner<any[]>(owner(b), "workbench", { action: "tabs" })).length, 1);
    const targets = await callWebKitOwner<any[]>(owner(a), "workbench", { action: "tabs" });
    const frame = await callWebKitOwner<any>(owner(a), "workbench", { action: "frame", targetId: targets[0].id, focused: true });
    writeFileSync(join(root, "workbench.jpg"), Buffer.from(frame.data, "base64"));
    assert.deepEqual(await evaluate(a, "()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"), { width: 1280, height: 800, dpr: 1 });
    } finally { await connection.dispose(); }
    assert.ok(await launcher.certifiedActive(a));
  });
  await check("stale owner generations cannot read or close a replacement", async () => {
    await assert.rejects(callWebKitOwner({ ...owner(a), generation: "stale-generation" }, "close", {}));
    assert.ok(await launcher.certifiedActive(a));
  });
  await check("public API reports native capabilities without exposing private RPC", async () => {
    const response = await handleRequest(new Request(`http://127.0.0.1/api/v1/browser/active?user_id=${a}`), launcher, store);
    const result = await response.json(); assert.equal(result.data.engine, "webkit"); assert.equal(result.data.ws, undefined);
    assert.ok(result.data.capabilities.includes("workbench")); assert.ok(!result.data.capabilities.includes("mcp"));
  });
  await check("manager replacement reattaches the same process and generation", async () => {
    const previous = store.getLaunch(a)!; launcher = makeLauncher();
    assert.ok(await launcher.certifiedActive(a));
    const result = await launcher.start(a, [], { headless: !process.argv.includes("--headed") });
    assert.equal(result.reattached, true); assert.equal(store.getLaunch(a)!.pid, previous.pid); assert.equal(store.getLaunch(a)!.webkitOwner!.generation, previous.webkitOwner!.generation);
  });
  await check("close and reopen preserve Cookie, localStorage, IndexedDB, CacheStorage and service workers", async () => {
    for (const id of [a, b]) { await launcher.captureLocalSession(id); assert.ok(await launcher.stop(id)); await launcher.start(id, [url]); }
    const first = await state(a), second = await state(b);
    for (const [data, account] of [[first, "a"], [second, "b"]] as const) { assert.equal(data.local, account); assert.equal(data.indexed, account); assert.equal(data.cache, account); assert.equal(data.cookie, `account=${account}`); assert.equal(data.workers, 1); }
    report.observations.reopened = [first, second];
  });
  await check("saved native fingerprint remains stable through product restart", () => {
    for (const [index, id] of [a, b].entries()) {
      const { capturedAt: _capturedAt, ...fingerprint } = store.getProfile(id)!.fpObserved!;
      assert.deepEqual(fingerprint, fingerprints[index]);
    }
  });
  const proxied: string[] = [];
  for (const index of [0, 1]) {
    const profile = buildNewProfile({ engine: "webkit", name: `Proxy ${index}`, group: "WebKit · Proxy", proxy: { type: "http", host: "127.0.0.1", port: String(proxyPorts[index]), user: `account${index}`, pass: `secret${index}` } }, () => false);
    store.upsertProfile(profile); ids.push(profile.id); proxied.push(profile.id);
  }
  proxyManager = Bun.spawn([process.execPath, "scripts/webkit-manager-fixture.ts"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  (proxyManager.stdin as any).write(JSON.stringify({ root, headless: !process.argv.includes("--headed"), profiles: proxied.map((id, index) => ({ id, url: `http://vela-webkit.invalid/account-${index}` })) }) + "\n");
  const output = createInterface({ input: Readable.fromWeb(proxyManager.stdout as any), terminal: false });
  const ready = await output[Symbol.asyncIterator]().next();
  assert.ok(!ready.done && JSON.parse(ready.value).ready); output.close();
  await check("each WebKit profile uses its own authenticated proxy route", async () => {
    for (const [index, id] of proxied.entries()) {
      const text = await evaluate<string>(id, "()=>document.body.textContent"); assert.ok(text.includes(`Proxy route ${index}`));
      assert.ok(proxyCounts[index]! > 0); assert.ok(proxyHeaders[index]!.every((value) => value === `Basic ${Buffer.from(`account${index}:secret${index}`).toString("base64")}`));
    }
    assert.notEqual(store.getLaunch(proxied[0]!)!.relayPort, store.getLaunch(proxied[1]!)!.relayPort);
  });
  await check("manager replacement rebinds each proxy on its original isolated relay port", async () => {
    const previous = proxied.map((id) => store.getLaunch(id)!);
    report.observations.proxyLaunches = previous.map(({ profileId, pid, debugPort, relayPort }) => ({ profileId, pid, debugPort, relayPort }));
    (proxyManager!.stdin as any).end("exit\n"); assert.equal(await proxyManager!.exited, 0); proxyManager = undefined;
    launcher = makeLauncher();
    for (const [index, id] of proxied.entries()) {
      assert.equal((await launcher.start(id)).reattached, true);
      assert.equal(store.getLaunch(id)!.pid, previous[index]!.pid);
      assert.equal(store.getLaunch(id)!.relayPort, previous[index]!.relayPort);
      await launcher.navigate(store.getLaunch(id)!.ws, [`http://vela-webkit.invalid/rebound-${index}`], true);
      assert.ok((await evaluate<string>(id, "()=>document.body.textContent")).includes(`Proxy route ${index}`));
    }
  });
  await check("proxy failure never retries on the direct route", async () => {
    routeAvailable = false; const before = [...proxyCounts];
    await launcher.navigate(store.getLaunch(proxied[0]!)!.ws, ["http://vela-webkit.invalid/failure"], true).catch(() => {});
    assert.ok(proxyCounts[0]! > before[0]!); assert.equal(proxyCounts[1], before[1]);
    const text = await evaluate<string>(proxied[0]!, "()=>document.body.textContent"); assert.ok(!text.includes("Proxy route 0"));
    routeAvailable = true;
  });
  if (process.argv.includes("--serve")) {
    const appConfig = new AppConfigStore(join(root, "app-config.json")); appConfig.setMode("local");
    dashboard = serveDashboard({ launcher, store, port: 0, appConfig, agentNonce: "a".repeat(64) });
    writeFileSync(join(reports, "webkit-ui-session.json"), JSON.stringify({ url: `http://127.0.0.1:${dashboard.port}`, root, ids, pid: process.pid }));
    console.log(`WebKit acceptance UI http://127.0.0.1:${dashboard.port}`);
    await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); process.stdin.once("data", done); });
  }
} catch (caught) { report.fatal = String(caught instanceof Error ? caught.stack : caught); console.error(report.fatal); process.exitCode = 1; }
finally {
  dashboard?.stop(true);
  if (proxyManager) { (proxyManager.stdin as any).end("exit\n"); await proxyManager.exited; }
  for (const id of ids) { const stopped = await launcher!.stop(id).catch(() => false); if (!stopped) console.error(`QA cleanup remains unconfirmed for ${id}`); }
  for (const manager of launchers) for (const id of ids) (manager as any).closeRelay(id);
  await Promise.all([content, ...proxies].map(stopServer));
  store.close(); writeFileSync(join(reports, "webkit-launcher-acceptance.json"), JSON.stringify(report, null, 2));
}

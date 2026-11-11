/** Real WebKit feasibility checks, isolated from the user's profiles. Run with Node. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FirefoxWorkbench as ContextWorkbench } from "../workbench-firefox.mjs";

const reports = resolve("reports");
const { webkit } = await import(pathToFileURL(resolve(process.argv[3] ?? "node_modules/playwright-core/index.mjs")).href);
await mkdir(reports, { recursive: true });
const root = await mkdtemp(join(reports, "webkit-feasibility-"));
const contexts = new Set();
const result = { module: process.argv[3] ?? "playwright-core 1.58.2 / WebKit 2248", root, startedAt: new Date().toISOString(), checks: [], observations: {} };
const fixture = `<!doctype html><meta charset="utf-8"><title>WebKit isolation fixture</title>
<style>body{margin:24px;font:16px system-ui;min-height:2400px}input{display:block;margin:20px 0}#drag{width:80px;height:60px;background:#e8ded3;touch-action:none}iframe{width:180px;height:80px}</style>
<input aria-label="Chinese input"><button id="click">Click</button><div id="drag">Drag</div><iframe src="/frame"></iframe>
<script>window.clicks=0;document.querySelector('#click').onclick=()=>window.clicks++;const d=document.querySelector('#drag');d.onpointerdown=e=>{d.setPointerCapture(e.pointerId);window.dragged=false};d.onpointermove=e=>{if(e.buttons)window.dragged=true}</script>`;
const server = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.url === "/frame") { res.setHeader("content-type", "text/html; charset=utf-8"); res.end("<!doctype html><meta charset=utf-8><title>Frame</title><p>WebKit frame</p>"); return; }
  if (req.url === "/worker.js") { res.setHeader("content-type", "text/javascript"); res.end("postMessage({ua:navigator.userAgent,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency})"); return; }
  if (req.url === "/sw.js") { res.setHeader("content-type", "text/javascript"); res.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));"); return; }
  res.setHeader("content-type", "text/html; charset=utf-8"); res.end(fixture);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const options = { ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}), headless: true, viewport: { width: 900, height: 640 }, screen: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "zh-TW", timezoneId: "Asia/Taipei", timeout: 60000 };
async function launch(name) {
  const context = await webkit.launchPersistentContext(join(root, name), options);
  contexts.add(context);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin, { waitUntil: "load", timeout: 20000 });
  return { context, page };
}
async function close(context) { await context.close(); contexts.delete(context); }
async function check(name, run) {
  try { const value = await run(); result.checks.push({ name, pass: true, ...(value === undefined ? {} : { value }) }); console.log(`PASS ${name}`); }
  catch (e) { result.checks.push({ name, pass: false, error: String(e?.stack ?? e) }); console.log(`FAIL ${name}: ${e.message}`); }
}
async function writeIdentity(page, name) {
  await page.evaluate(async name => {
    localStorage.setItem("account", name);
    document.cookie = `account=${name}; Path=/; Max-Age=3600; SameSite=Lax`;
    await new Promise((resolve, reject) => { const req = indexedDB.open("identity", 1); req.onupgradeneeded = () => req.result.createObjectStore("data"); req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const tx=db.transaction("data","readwrite");tx.objectStore("data").put(name,"account");tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)} });
    const cache = await caches.open("identity"); await cache.put("/account", new Response(name));
    await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
  }, name);
}
async function readIdentity(page) {
  return page.evaluate(async () => ({
    local: localStorage.getItem("account"), cookie: document.cookie,
    indexed: await new Promise((resolve, reject) => {const req=indexedDB.open("identity",1);req.onupgradeneeded=()=>req.result.createObjectStore("data");req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result;const get=db.transaction("data").objectStore("data").get("account");get.onsuccess=()=>{const v=get.result;db.close();resolve(v??null)};get.onerror=()=>reject(get.error)}}),
    cached: await (await caches.open("identity")).match("/account").then(r=>r?.text()??null),
    cacheKeys: await (await caches.open("identity")).keys().then(keys=>keys.map(key=>key.url)),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
}
async function identity(page) {
  return page.evaluate(async () => {
    await document.fonts.load('17px sans-serif', 'Vela WebKit 中文');
    await document.fonts.ready;
    const measure = () => ({ ua:navigator.userAgent, language:navigator.language, languages:[...navigator.languages], timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, platform:navigator.platform, cores:navigator.hardwareConcurrency, screen:[screen.width,screen.height], viewport:[innerWidth,innerHeight], dpr:devicePixelRatio, webdriver:navigator.webdriver, rtc:typeof RTCPeerConnection });
    const main=measure();
    const worker=await new Promise((resolve,reject)=>{const w=new Worker('/worker.js');const timer=setTimeout(()=>{w.terminate();reject(Error('Worker probe timed out'))},5000);w.onmessage=e=>{clearTimeout(timer);w.terminate();resolve(e.data)};w.onerror=e=>{clearTimeout(timer);w.terminate();reject(Error(e.message))}});
    const frame=document.querySelector('iframe').contentWindow;
    const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d');ctx.font='17px sans-serif';ctx.fillText('Vela WebKit 中文',4,20);
    const gl=document.createElement('canvas').getContext('webgl');const ext=gl?.getExtension('WEBGL_debug_renderer_info');
    const canvasHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');
    return {main, worker, frame:{ua:frame.navigator.userAgent,language:frame.navigator.language,timezone:frame.Intl.DateTimeFormat().resolvedOptions().timeZone}, canvas:canvasHash, webgl:ext?{vendor:gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}:null};
  });
}
try {
  const a=await launch("a"); const b=await launch("b");
  result.observations.engineVersion=a.context.browser()?.version();
  await check("independent browser processes",()=>{const impl=c=>c._connection?.toImpl?.(c)?._browser?.options?.browserProcess?.process?.pid;const pids=[impl(a.context),impl(b.context)];assert.ok(pids.every(p=>Number.isSafeInteger(p)&&p>0));assert.notEqual(...pids);return pids});
  await check("blank independent storage",async()=>{for(const {page} of [a,b]){const data=await readIdentity(page);assert.equal(data.local,null);assert.equal(data.indexed,null);assert.equal(data.cached,null);assert.equal(data.cookie,"")}});
  await check("write separate persistent identities",async()=>{await writeIdentity(a.page,"a");await writeIdentity(b.page,"b");for(const [name,{page}] of [["a",a],["b",b]]){const data=await readIdentity(page);assert.equal(data.local,name);assert.equal(data.indexed,name);assert.equal(data.cached,name);assert.equal(data.cookie,`account=${name}`);assert.equal(data.serviceWorkers,1)}});
  result.observations.storageA=await readIdentity(a.page);result.observations.storageB=await readIdentity(b.page);
  const before=await identity(a.page);result.observations.identityA=before;result.observations.identityB=await identity(b.page);
  await check("native locale/timezone/screen controls",()=>{assert.equal(before.main.language,"zh-TW");assert.equal(before.main.timezone,"Asia/Taipei");assert.deepEqual(before.main.screen,[1280,800]);assert.equal(before.frame.language,"zh-TW");assert.equal(before.worker.language,"zh-TW");assert.equal(before.worker.timezone,"Asia/Taipei")});
  await check("workbench Chinese text, click, drag, wheel and screenshot",async()=>{
    const workbench=new ContextWorkbench(a.context);let tabs=await workbench.run({action:"tabs"});const targetId=tabs.find(t=>t.url===origin+"/").id;const run=(action,payload={})=>workbench.run({action,targetId,...payload});
    const input=await a.page.locator('input').boundingBox();await run('input',{input:{kind:'pointer',event:'down',x:input.x+12,y:input.y+10,button:'left',clicks:1}});await run('input',{input:{kind:'pointer',event:'up',x:input.x+12,y:input.y+10,button:'left',clicks:1}});await run('input',{input:{kind:'text',text:'WebKit 中文隔离 ✓'}});assert.equal(await a.page.locator('input').inputValue(),'WebKit 中文隔离 ✓');
    const button=await a.page.locator('#click').boundingBox();for(const event of ['down','up'])await run('input',{input:{kind:'pointer',event,x:button.x+12,y:button.y+10,button:'left',clicks:1}});assert.equal(await a.page.evaluate(()=>window.clicks),1);assert.equal(await b.page.evaluate(()=>window.clicks),0);
    const drag=await a.page.locator('#drag').boundingBox();await run('input',{input:{kind:'pointer',event:'down',x:drag.x+10,y:drag.y+10,button:'left'}});await run('input',{input:{kind:'pointer',event:'move',x:drag.x+60,y:drag.y+40}});await run('input',{input:{kind:'pointer',event:'up',x:drag.x+60,y:drag.y+40,button:'left'}});assert.equal(await a.page.evaluate(()=>window.dragged),true);
    await run('input',{input:{kind:'wheel',x:700,y:400,dx:0,dy:400}});await a.page.waitForFunction(()=>scrollY>0);const frame=await run('frame',{focused:true});assert.ok(frame.data.length>1000);assert.equal(frame.width,900);assert.equal(frame.height,640);await writeFile(join(root,'workbench.png'),await a.page.screenshot());
    assert.deepEqual((await identity(a.page)).main,before.main);
    const fresh=await run('new');assert.equal((await run('tabs')).length,tabs.length+1);await workbench.run({action:'close',targetId:fresh});assert.equal((await run('tabs')).length,tabs.length);
  });
  await close(a.context);await close(b.context);
  for(const name of ['a','b']){
    const reopened=await launch(name);
    await check(`native restart persistence ${name}`,async()=>{const data=await readIdentity(reopened.page);result.observations[`restarted${name}`]=data;assert.equal(data.local,name);assert.equal(data.indexed,name);assert.equal(data.cached,name);assert.equal(data.cookie,`account=${name}`);assert.equal(data.serviceWorkers,1)});
    await check(`restart fingerprint stability ${name}`,async()=>{const fp=await identity(reopened.page);const original=name==='a'?before:result.observations.identityB;assert.deepEqual(fp,original)});
    await close(reopened.context);
  }
} catch(e) {result.fatal=String(e?.stack??e);} finally {
  for(const context of contexts) await context.close().catch(()=>{});
  await new Promise(r=>server.close(r));
  result.finishedAt=new Date().toISOString();
  await writeFile(join(reports,'webkit-feasibility.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({root,checks:result.checks,fatal:result.fatal},null,2));
  if(result.fatal||result.checks.some(c=>!c.pass))process.exitCode=1;
}

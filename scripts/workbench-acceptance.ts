/** Run with `bun scripts/workbench-acceptance.ts`; test-only identity stubs never enter the product. */
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "../src/store.ts";
import { parseExport } from "../src/parse.ts";
import { AppConfigStore } from "../src/app-config.ts";
import { serveDashboard } from "../src/web.ts";
import { statePaths } from "../src/paths.ts";
import type { Launcher } from "../src/launcher.ts";
import { startFirefoxOwner, callFirefoxOwner, closeFirefoxOwner } from "../src/firefox-runtime.ts";
import { createHash } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "vela-workbench-qa-"));
const reportRoot = join(import.meta.dir, "..", "reports"); mkdirSync(reportRoot, { recursive: true });
const nonce = "7".repeat(64);
const fixturePage = `<!doctype html><html><meta charset="utf-8"><title>Atelier · Overview</title><style>
*{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#272927;font-family:Segoe UI,sans-serif}header{display:flex;justify-content:space-between;padding:32px 46px;border-bottom:1px solid #e9e7e0;font:12px Segoe UI;letter-spacing:2px}header b{font:italic 28px Georgia}main{padding:44px 46px}small{font-size:10px;letter-spacing:2px;color:#9c9d91}h1{font:normal 54px Georgia;margin:16px 0 26px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.stat{padding:22px;background:white;border:1px solid #ebe9e2;border-radius:5px}.stat b{display:block;font:32px Georgia;margin-top:16px}section{margin-top:28px;padding:28px;background:white;border:1px solid #ebe9e2;border-radius:5px}.chart{display:flex;align-items:end;gap:14px;height:150px;padding-top:20px}.chart i{flex:1;background:#d6d8cf;border-radius:3px 3px 0 0}input{margin-top:20px;padding:12px 16px;width:310px;border:1px solid #dddcd4;border-radius:5px}button{padding:12px 20px;background:#282d28;color:white;border:0;border-radius:24px;margin-left:8px;cursor:pointer}#drag{height:28px;width:80px;border-radius:4px;background:#e8d9b8;position:relative;touch-action:none}.long{height:900px;padding-top:300px;color:#aaa}</style>
<header><b>Atelier.</b><span>WORKSPACE <span id="account"></span></span><span>OVERVIEW　 COLLECTIONS　 ACCOUNT</span></header><main><small>YOUR DAILY PERSPECTIVE</small><h1>A little room to grow.</h1><div class="stats"><div class="stat"><small>REVENUE</small><b>$ 24,680</b></div><div class="stat"><small>ORDERS</small><b>1,284</b></div><div class="stat"><small>CONVERSION</small><b>3.62 %</b></div></div><section><small>THIS MONTH</small><div class="chart">${[35, 58, 42, 75, 62, 91, 69, 83, 74, 99, 85, 118].map((height) => `<i style="height:${height}px"></i>`).join("")}</div><input aria-label="Acceptance input" placeholder="A note for this workspace…"><button id="action">Save note · <span id="clicks">0</span></button><p><small>DRAG TO ARRANGE</small></p><div id="drag"></div></section><div class="long">The space to focus.</div></main><script>
const account=new URL(location.href).searchParams.get('account');localStorage.setItem('account',account);document.cookie='account='+account+';path=/';document.querySelector('#account').textContent=account;document.title='Atelier '+account+' · '+(new URL(location.href).searchParams.get('tab')||'Overview');document.querySelector('#action').onclick=()=>{document.querySelector('#clicks').textContent=Number(document.querySelector('#clicks').textContent)+1};const drag=document.querySelector('#drag');drag.onpointerdown=e=>{drag.setPointerCapture(e.pointerId)};drag.onpointermove=e=>{if(e.buttons){drag.style.transform='translateX(80px)';drag.dataset.dragged='true'}};
</script></html>`;
const content = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
  if (new URL(request.url).pathname === "/__vela-qa-stop" && request.method === "POST" && request.headers.get("x-vela-qa") === nonce) {
    setTimeout(() => void stop(), 25);
    return Response.json({ ok: true });
  }
  return new Response(fixturePage, { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const child = Bun.spawn(["node", join(import.meta.dir, "workbench-browser-fixture.mjs"), root, `http://127.0.0.1:${content.port}`, process.env.VELA_QA_FIREFOX ? "11" : "12"], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
console.log("Preparing 12 isolated acceptance browsers…");
const deadline = Date.now() + 180_000;
while (!existsSync(join(root, "chromium-ready.json"))) {
  if (Date.now() > deadline || child.exitCode !== null) throw new Error("Acceptance browser startup failed");
  await Bun.sleep(400);
}
const fixture = JSON.parse(readFileSync(join(root, "chromium-ready.json"), "utf8"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
for (const [index, launch] of fixture.launches.entries()) {
  const profile = parseExport(`id=${launch.id}\nname=Atelier · ${String(index + 1).padStart(2, "0")}\ngroup=${index < 6 ? "跨境电商" : index < 10 ? "社媒运营" : ""}\nresolution=1280*900`).profiles[0]!;
  store.upsertProfile(profile);
  store.recordLaunch({ profileId: profile.id, pid: child.pid, debugPort: Number(new URL(launch.ws).port), ws: launch.ws, startedAt: Date.now(), userDataDir: launch.directory });
}
const owners: Awaited<ReturnType<typeof startFirefoxOwner>>[] = [];
const firefoxPath = process.env.VELA_QA_FIREFOX;
if (firefoxPath) {
  const owner = await startFirefoxOwner({ profileId: "qa-firefox", executablePath: firefoxPath, executableSha256: createHash("sha256").update(readFileSync(firefoxPath)).digest("hex"), userDataDir: join(root, "firefox"), config: {}, headless: true, timeoutMs: 60000 });
  owners.push(owner);
  await callFirefoxOwner(owner, "navigate", { urls: [`http://127.0.0.1:${content.port}/?account=firefox`], replacePages: true });
  const profile = parseExport("id=qa-firefox\nname=Firefox · Studio\ngroup=独立测试\nresolution=1280*900").profiles[0]!;
  profile.engine = "firefox"; profile.firefox = { version: 1, runtimeVersion: "156.0.1-beta.36", config: {} };
  store.upsertProfile(profile);
  store.recordLaunch({ profileId: profile.id, engine: "firefox", pid: owner.browserPid, startedAt: Date.now(), debugPort: Number(new URL(owner.endpoint).port), ws: `firefox://127.0.0.1:${new URL(owner.endpoint).port}/${owner.generation}`, firefoxOwner: owner });
}
const appConfig = new AppConfigStore(join(root, "app-config.json")); appConfig.setMode("local");
const launcher = { reconcileOrphans: async () => {}, certifiedActive: async (id: string) => !!store.getLaunch(id), listRuntimeDownloads: () => [], isIdentityCertified: () => true, dataDriveFreeBytes: () => null } as unknown as Launcher;
// A data folder of its own, so snapshots, the activity record and the self-check cache work here too.
const dashboard = serveDashboard({ launcher, store, port: 0, appConfig, agentNonce: nonce, paths: statePaths(root) });
const report = { url: `http://127.0.0.1:${dashboard.port}`, fixtureState: fixture.stateUrl, fixtureContent: `http://127.0.0.1:${content.port}`, root, count: fixture.launches.length + owners.length, nonce, pid: process.pid };
writeFileSync(join(reportRoot, "workbench-acceptance-session.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ url: report.url, count: report.count, report: "reports/workbench-acceptance-session.json" }));
const stop = async () => { dashboard.stop(true); content.stop(true); child.stdin.end(); await Promise.allSettled(owners.map((owner) => closeFirefoxOwner(owner))); store.close(); process.exit(0); };
process.on("SIGINT", () => void stop()); process.on("SIGTERM", () => void stop());

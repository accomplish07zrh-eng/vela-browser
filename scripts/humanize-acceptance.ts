// Drives several real browsers at once through the MCP tool path with human-like input, and
// reads back what each page actually received. Run: bun scripts/humanize-acceptance.ts [count]
// Needs Microsoft Edge or Google Chrome installed. Prints one JSON report and exits non-zero on failure.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaywrightToolProxy } from "../agent/playwright-proxy.mjs";
import { createHumanizer, personaFor } from "../agent/humanize.mjs";

const count = Number(process.argv[2] ?? 3);
const candidates = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];
const executable = candidates.find((path) => existsSync(path));
if (!executable) throw new Error("No Edge or Chrome found");

const page = `<!doctype html><meta charset="utf-8"><title>Humanize proof</title>
<style>body{font:16px system-ui;margin:0;height:2200px}form{position:absolute;top:1500px;left:180px;display:grid;gap:14px;width:340px}input,textarea,button{font:inherit;padding:8px}</style>
<form onsubmit="event.preventDefault()"><label>Name <input id="name" value="old value"></label><label>Note <textarea id="note"></textarea></label><label><input type="checkbox" id="agree"> Agree</label><button id="send" type="button">Send</button></form>
<script>
const log = window.__log = { moves: 0, trusted: 0, untrusted: 0, wheel: 0, keys: [], downs: [], clicks: [], movesBeforeClick: 0 };
const mark = (e) => { e.isTrusted ? log.trusted++ : log.untrusted++; };
addEventListener("mousemove", (e) => { log.moves++; mark(e); }, true);
addEventListener("wheel", (e) => { log.wheel++; mark(e); }, true);
addEventListener("keydown", (e) => { log.keys.push(performance.now()); mark(e); }, true);
addEventListener("mousedown", (e) => { log.downs.push(performance.now()); mark(e); }, true);
addEventListener("click", (e) => { mark(e); if (e.target.id === "send") { const r = e.target.getBoundingClientRect(); log.clicks.push({ dx: +(e.clientX - r.left - r.width / 2).toFixed(1), dy: +(e.clientY - r.top - r.height / 2).toFixed(1), at: performance.now() }); log.movesBeforeClick = log.moves; } }, true);
</script>`;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) });
const url = `http://127.0.0.1:${server.port}/`;

async function launch(index: number) {
  const dir = mkdtempSync(join(tmpdir(), `vela-humanize-${index}-`));
  const child = spawn(executable!, [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--headless=new", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  // The browser writes its chosen port and path here once DevTools listens.
  const portFile = join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lines = existsSync(portFile) ? readFileSync(portFile, "utf8").trim().split(/\r?\n/) : [];
    if (lines.length >= 2) return { dir, child, ws: `ws://127.0.0.1:${lines[0]}${lines[1]}` };
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error("browser did not start");
}

const refOf = (snapshot: string, pattern: RegExp) => snapshot.match(pattern)?.[1];
const text = (result: any) => (result?.content ?? []).map((item: any) => item.text ?? "").join("\n");

async function drive(index: number, browser: Awaited<ReturnType<typeof launch>>) {
  const profileId = `acceptance-${index}`;
  const proxy = new PlaywrightToolProxy("humanize-acceptance");
  await proxy.attach(browser.ws);
  const context = proxy.context;
  if (!context) throw new Error("browser exposed no context");
  const humanizer = createHumanizer({ context, profileId, callOfficial: (name: string, args: object) => proxy.callTool(name, args) });
  const started = performance.now();
  await proxy.callTool("browser_navigate", { url });
  const snapshot = text(await proxy.callTool("browser_snapshot", {}));
  const nameRef = refOf(snapshot, /textbox "Name[^"]*"[^\n]*\[ref=(\w+)\]/);
  const noteRef = refOf(snapshot, /textbox "Note[^"]*"[^\n]*\[ref=(\w+)\]/);
  const agreeRef = refOf(snapshot, /checkbox "Agree"[^\n]*\[ref=(\w+)\]/);
  const sendRef = refOf(snapshot, /button "Send"[^\n]*\[ref=(\w+)\]/);
  if (!nameRef || !noteRef || !agreeRef || !sendRef) throw new Error(`refs missing in snapshot:\n${snapshot.slice(0, 800)}`);
  const typed = `Vela ${index} 你好`;
  const note = `Second field, browser ${index}.`;
  const results = [
    await humanizer.call("browser_type", { element: "Name", ref: nameRef, text: typed }),
    await humanizer.call("browser_fill_form", { fields: [{ name: "Note", type: "textbox", ref: noteRef, value: note }, { name: "Agree", type: "checkbox", ref: agreeRef, value: "true" }] }),
    await humanizer.call("browser_click", { element: "Send", ref: sendRef }),
  ];
  const finished = performance.now();
  const target = context.pages().find((item: any) => item.url() === url);
  if (!target) throw new Error("test page is gone");
  const evidence = await target.evaluate(() => {
    const log = (window as any).__log;
    const gaps = log.keys.slice(1).map((at: number, i: number) => at - log.keys[i]);
    const mean = gaps.reduce((a: number, b: number) => a + b, 0) / Math.max(1, gaps.length);
    const sd = Math.sqrt(gaps.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / Math.max(1, gaps.length));
    return {
      name: (document.getElementById("name") as HTMLInputElement).value,
      note: (document.getElementById("note") as HTMLTextAreaElement).value,
      agree: (document.getElementById("agree") as HTMLInputElement).checked,
      moves: log.moves, wheel: log.wheel, trusted: log.trusted, untrusted: log.untrusted,
      keyGapMeanMs: Math.round(mean), keyGapSdMs: Math.round(sd), clicks: log.clicks, webdriver: navigator.webdriver,
    };
  });
  await proxy.detach();
  return {
    profileId, persona: personaFor(profileId), started: Math.round(started), finished: Math.round(finished),
    ok: evidence.name === typed && evidence.note === note && evidence.agree && evidence.clicks.length === 1
      && evidence.moves > 20 && evidence.wheel > 0 && evidence.untrusted === 0 && !results.some((result: any) => result?.isError),
    expected: { name: typed, note }, evidence,
  };
}

const browsers = await Promise.all(Array.from({ length: count }, (_, index) => launch(index)));
let report: any;
try {
  const t0 = performance.now();
  const runs = await Promise.all(browsers.map((browser, index) => drive(index, browser)));
  const overlap = Math.min(...runs.map((run) => run.finished)) > Math.max(...runs.map((run) => run.started));
  const sequentialEstimate = runs.reduce((sum, run) => sum + run.finished - run.started, 0);
  report = { executable, count, parallel: overlap, wallMs: Math.round(performance.now() - t0), sumOfRunsMs: Math.round(sequentialEstimate), runs };
} finally {
  if (report) console.log(JSON.stringify(report, null, 2));
  // Ask each browser to quit over DevTools: on Windows, Edge and Chrome may hand the window to a
  // relaunched process, so ending the spawned process id would leave the real browser running.
  await Promise.all(browsers.map((browser) => new Promise<void>((resolve) => {
    const socket = new WebSocket(browser.ws);
    const done = () => { try { socket.close(); } catch {} resolve(); };
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    socket.onclose = done; socket.onerror = done;
    setTimeout(done, 5000);
  })));
  for (const browser of browsers) browser.child.kill();
  server.stop(true);
  await Bun.sleep(1500);
  for (const browser of browsers) { try { rmSync(browser.dir, { recursive: true, force: true }); } catch {} }
}
process.exit(report.parallel && report.runs.every((run: any) => run.ok) ? 0 : 1);

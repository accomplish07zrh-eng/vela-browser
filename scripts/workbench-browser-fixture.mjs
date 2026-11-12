/** Local acceptance fixture only. Owns disposable browser processes and no user profiles. */
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";

const [root, pageUrl, countText = "12"] = process.argv.slice(2);
const contexts = [], launches = [];
const server = createServer(async (request, response) => {
  if (request.url !== "/state") { response.writeHead(404).end(); return; }
  try {
    const state = await Promise.all(contexts.map(async (context, index) => {
      const pages = context.pages();
      const values = await Promise.all(pages.map((page) => page.evaluate(() => ({ title: document.title, input: document.querySelector("input")?.value, clicks: document.querySelector("#clicks")?.textContent,
        account: localStorage.getItem("account"), cookie: document.cookie, width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio, drag: document.querySelector("#drag")?.getAttribute("data-dragged"),
        controls: Object.fromEntries(["input", "#action", "#drag"].map((selector) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null]; })) })).catch(() => null)));
      return { id: `qa-${index + 1}`, pages: values };
    }));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
  } catch { response.writeHead(500).end(); }
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
try {
  for (let i = 0; i < Number(countText); i++) {
    const profileRoot = join(root, `chromium-${i + 1}`); await mkdir(profileRoot, { recursive: true });
    const context = await chromium.launchPersistentContext(profileRoot, {
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, viewport: null,
      args: ["--remote-debugging-port=0", "--window-size=1280,900", "--no-first-run"],
    });
    contexts.push(context);
    const { readFile } = await import("node:fs/promises");
    const [port, endpoint] = (await readFile(join(profileRoot, "DevToolsActivePort"), "utf8")).trim().split("\n");
    launches.push({ id: `qa-${i + 1}`, ws: `ws://127.0.0.1:${port}${endpoint}`, directory: profileRoot });
    const page = context.pages()[0];
    await page.goto(`${pageUrl}?account=${i + 1}`);
    if (i === 0) { const extra = await context.newPage(); await extra.goto(`${pageUrl}?account=1&tab=Notes`); }
  }
  await writeFile(join(root, "chromium-ready.json"), JSON.stringify({ launches, stateUrl: `http://127.0.0.1:${server.address().port}/state` }));
  process.stdin.resume();
  await new Promise((resolve) => { process.stdin.once("end", resolve); process.once("SIGTERM", resolve); });
} finally { await Promise.allSettled(contexts.map((context) => context.close())); server.close(); }

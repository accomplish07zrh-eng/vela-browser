/**
 * Screenshot regression for the dashboard: every page and panel, light and dark, at two window
 * sizes, compared pixel by pixel with the last accepted screenshots.
 *
 *   bun scripts/ui-regression.ts            compare with the baseline, write reports/ui-regression/index.html
 *   bun scripts/ui-regression.ts --update   accept the current screenshots as the new baseline
 *
 * The data is fixed (same profiles, groups, tags, proxy and dates every run) and no browser
 * environment is started, so a difference means the interface changed. Baselines depend on this
 * computer's fonts and rendering, so they live in reports/ (not in the repository).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "../src/app-config.ts";
import type { Launcher } from "../src/launcher.ts";
import { parseExport } from "../src/parse.ts";
import { statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import { serveDashboard } from "../src/web.ts";

const update = process.argv.includes("--update");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const repo = join(import.meta.dir, "..");
const baselineDir = join(repo, "reports", "ui-baseline");
const outDir = join(repo, "reports", "ui-regression");

const BROWSERS = [
  process.env.VELA_UI_CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter((path): path is string => !!path && existsSync(path));
if (!BROWSERS.length) throw new Error("No Chrome or Edge found; set VELA_UI_CHROME to a Chromium executable");

// Fixed data.
const root = mkdtempSync(join(tmpdir(), "vela-ui-regression-"));
const store = new ProfileStore(join(root, "profiles.sqlite"));
const created = Date.UTC(2026, 0, 15, 9, 30);
const rows = [
  ["ui-01", "Shop · 01", "跨境电商", "tiktok.com", "美区,养号中"], ["ui-02", "Shop · 02", "跨境电商", "tiktok.com", "美区"],
  ["ui-03", "Shop · 03", "跨境电商", "amazon.com", ""], ["ui-04", "Social · 01", "社媒运营", "facebook.com", "高优先,已实名,Gmail,备用"],
  ["ui-05", "Social · 02", "社媒运营", "x.com", ""], ["ui-06", "Mail · 01", "", "gmail.com", "Gmail"],
];
for (const [id, name, group, platform, tags] of rows) {
  const profile = parseExport(`id=${id}\nname=${name}\ngroup=${group}\nplatform=${platform}\nresolution=1920*1080\nua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36\ntimezone=America/New_York`).profiles[0]!;
  store.upsertProfile({ ...profile, tags: tags ? tags.split(",") : [], ...(id === "ui-04" ? { proxy: { type: "socks5", host: "203.0.113.10", port: "1080", user: "", pass: "" } } : {}) });
}
(store as any).db.query("UPDATE profiles SET created_at = ?, last_open_at = ?").run(created, created);
const appConfig = new AppConfigStore(join(root, "app-config.json")); appConfig.setMode("local");
const launcher = { reconcileOrphans: async () => {}, certifiedActive: async () => false, listRuntimeDownloads: () => [], isIdentityCertified: () => true, dataDriveFreeBytes: () => null } as unknown as Launcher;
const dashboard = serveDashboard({ launcher, store, port: 0, appConfig, agentNonce: "7".repeat(64), paths: statePaths(root) });
const url = `http://127.0.0.1:${dashboard.port}`;
// A second dashboard with no profiles at all, for the first-run guide.
const emptyRoot = mkdtempSync(join(tmpdir(), "vela-ui-regression-empty-"));
const emptyStore = new ProfileStore(join(emptyRoot, "profiles.sqlite"));
const emptyConfig = new AppConfigStore(join(emptyRoot, "app-config.json")); emptyConfig.setMode("local");
const emptyDashboard = serveDashboard({ launcher, store: emptyStore, port: 0, appConfig: emptyConfig, agentNonce: "7".repeat(64), paths: statePaths(emptyRoot) });
const emptyUrl = `http://127.0.0.1:${emptyDashboard.port}`;

type Step = (page: any) => Promise<void>;
const dock = (tip: string): Step => async (page) => { await page.locator(`.sidebar.dock [data-tip="${tip}"]`).first().click(); };
const tab = (name: string): Step => async (page) => { await page.getByRole("tab", { name }).click(); };
const SHOTS: Array<{ name: string; steps: Step[]; empty?: boolean }> = [
  { name: "first-run-1", steps: [], empty: true },
  { name: "first-run-2", steps: [async (page) => { await page.getByRole("button", { name: "下一步", exact: true }).click(); }], empty: true },
  { name: "first-run-3", steps: [async (page) => { await page.getByRole("button", { name: "下一步", exact: true }).click(); }, async (page) => { await page.getByRole("radio", { name: "直连" }).click(); }, async (page) => { await page.getByRole("button", { name: "下一步", exact: true }).click(); }], empty: true },
  { name: "workbench", steps: [] },
  { name: "shortcuts", steps: [async (page) => { await page.keyboard.press("Shift+Slash"); }] },
  { name: "palette", steps: [async (page) => { await page.keyboard.press("Control+K"); }] },
  { name: "profiles", steps: [dock("所有环境")] },
  { name: "profiles-selected", steps: [dock("所有环境"), async (page) => { await page.locator("tbody tr input[type=checkbox]").nth(1).check(); await page.locator("tbody tr input[type=checkbox]").nth(3).check(); }] },
  { name: "profile-detail", steps: [dock("所有环境"), async (page) => { await page.locator(".profile-name-link").first().click(); }] },
  { name: "create-profile", steps: [dock("新建环境")] },
  { name: "import", steps: [dock("导入环境")] },
  { name: "groups", steps: [dock("分组")] },
  { name: "proxies", steps: [dock("代理")] },
  { name: "scripts", steps: [dock("脚本")] },
  { name: "trash", steps: [dock("回收站")] },
  { name: "extensions", steps: [dock("管理扩展")] },
  { name: "settings-general", steps: [dock("设置")] },
  { name: "settings-ai", steps: [dock("设置"), tab("AI 与记录")] },
  { name: "settings-data", steps: [dock("设置"), tab("数据与安全")] },
  { name: "settings-advanced", steps: [dock("设置"), tab("高级")] },
];
const SIZES = [{ width: 1600, height: 1000 }, { width: 1280, height: 800 }];
const THEMES = ["light", "dark"] as const;

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: BROWSERS[0], headless: true });
mkdirSync(baselineDir, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** Compares two PNGs inside the browser: changed pixel count and a diff image, without extra packages. */
async function compare(page: any, before: Buffer, after: Buffer): Promise<{ changed: number; total: number; sizeChanged: boolean; diff?: string }> {
  return await page.evaluate(async ([a, b]: [string, string]) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return { changed: y.width * y.height, total: y.width * y.height, sizeChanged: true };
    const canvas = (image: HTMLImageElement) => { const c = document.createElement("canvas"); c.width = image.width; c.height = image.height; const g = c.getContext("2d")!; g.drawImage(image, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
    const p = canvas(x), q = canvas(y);
    const out = new ImageData(p.width, p.height);
    let changed = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      // Anti-aliasing moves a channel by a few steps; a real change moves it further.
      const delta = Math.abs(p.data[i]! - q.data[i]!) + Math.abs(p.data[i + 1]! - q.data[i + 1]!) + Math.abs(p.data[i + 2]! - q.data[i + 2]!);
      if (delta > 48) { changed++; out.data.set([230, 40, 40, 255], i); }
      else { const grey = (q.data[i]! + q.data[i + 1]! + q.data[i + 2]!) / 3; out.data.set([grey, grey, grey, 70], i); }
    }
    const c = document.createElement("canvas"); c.width = p.width; c.height = p.height; c.getContext("2d")!.putImageData(out, 0, 0);
    return { changed, total: p.width * p.height, sizeChanged: false, diff: changed ? c.toDataURL("image/png") : undefined };
  }, [`data:image/png;base64,${before.toString("base64")}`, `data:image/png;base64,${after.toString("base64")}`]);
}

const results: Array<{ file: string; status: "new" | "same" | "changed"; ratio: number }> = [];
try {
  for (const theme of THEMES) for (const size of SIZES) {
    const context = await browser.newContext({ viewport: size, colorScheme: theme, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
    await context.addCookies([{ name: "aliasmode.shell.theme", value: theme, url }, { name: "aliasmode.shell.theme", value: theme, url: emptyUrl }]);
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => 1, invoke: async (cmd: string) => cmd.includes("is_maximized") ? false : "7".repeat(64) };
      // Animations and blinking carets would make every run differ.
      addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}"; document.head.append(style); });
    });
    const page = await context.newPage();
    for (const shot of SHOTS) {
      if (only && !shot.name.includes(only)) continue;
      const file = `${shot.name}-${theme}-${size.width}x${size.height}.png`;
      await page.goto(shot.empty ? emptyUrl : url); await page.waitForTimeout(1500);
      try { for (const step of shot.steps) { await step(page); await page.waitForTimeout(700); } }
      catch (error) { console.log(`${file}: could not reach (${(error as Error).message.split("\n")[0]})`); continue; }
      await page.mouse.move(3, Math.round(size.height / 2)); await page.waitForTimeout(500);
      const shotPng: Buffer = await page.screenshot();
      writeFileSync(join(outDir, file), shotPng);
      const basePath = join(baselineDir, file);
      if (update || !existsSync(basePath)) {
        writeFileSync(basePath, shotPng);
        results.push({ file, status: "new", ratio: 0 });
        continue;
      }
      const result = await compare(page, readFileSync(basePath), shotPng);
      const ratio = result.changed / result.total;
      // Under 0.05% of the pixels is text rendering noise, not a change.
      if (ratio > 0.0005) {
        if (result.diff) writeFileSync(join(outDir, file.replace(".png", ".diff.png")), Buffer.from(result.diff.split(",")[1]!, "base64"));
        writeFileSync(join(outDir, file.replace(".png", ".before.png")), readFileSync(basePath));
        results.push({ file, status: "changed", ratio });
      } else results.push({ file, status: "same", ratio });
    }
    await context.close();
  }
} finally {
  await browser.close();
  dashboard.stop(true); emptyDashboard.stop(true);
  store.close(); emptyStore.close();
  rmSync(root, { recursive: true, force: true }); rmSync(emptyRoot, { recursive: true, force: true });
}

const changed = results.filter((item) => item.status === "changed");
const html = `<!doctype html><meta charset="utf-8"><title>UI regression</title>
<style>body{font:14px system-ui;margin:24px;background:#f6f4ef;color:#222}h2{margin:28px 0 8px}figure{display:inline-block;margin:0 12px 12px 0;vertical-align:top}img{width:520px;border:1px solid #ccc}figcaption{color:#666}</style>
<h1>UI regression · ${new Date().toLocaleString()}</h1>
<p>${results.length} screenshots · ${changed.length} changed · ${results.filter((item) => item.status === "new").length} new baseline</p>
${changed.map((item) => `<h2>${item.file} — ${(item.ratio * 100).toFixed(2)}% of pixels</h2>
<figure><img src="${item.file.replace(".png", ".before.png")}"><figcaption>before</figcaption></figure>
<figure><img src="${item.file}"><figcaption>now</figcaption></figure>
<figure><img src="${item.file.replace(".png", ".diff.png")}"><figcaption>difference</figcaption></figure>`).join("")}`;
writeFileSync(join(outDir, "index.html"), html);
for (const item of results) console.log(`${item.status.padEnd(8)} ${item.file}${item.status === "changed" ? `  ${(item.ratio * 100).toFixed(2)}%` : ""}`);
console.log(`\n${changed.length} changed of ${results.length}. Report: ${join(outDir, "index.html")}`);
process.exit(changed.length && !update ? 1 : 0);

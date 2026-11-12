import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const inputPath = process.argv[2] ?? "";
const outputPath = process.argv[3] ?? "";

// The app opens in Simplified Chinese unless the user picks another language, so every visible
// string is matched in English and in the zh-CN catalog.
const zhCN = JSON.parse(await readFile(new URL("../web/locales/zh-CN.json", import.meta.url), "utf8"));

function fill(source, values) {
  return source.replace(/\{\{?(\w+)\}?\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

function texts(source, values = {}) {
  return [...new Set([source, zhCN[source]].filter((text) => typeof text === "string").map((text) => fill(text, values)))];
}

function exactly(source) {
  const escaped = texts(source).map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})$`);
}

async function readInput() {
  let text = inputPath ? await readFile(inputPath, "utf8") : "";
  if (!inputPath) {
    for await (const chunk of process.stdin) text += chunk;
  }
  const input = JSON.parse(text);
  if (typeof input?.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.endpoint)) {
    throw new Error("desktop debug endpoint is invalid");
  }
  if (typeof input?.candidateVersion !== "string" || input.candidateVersion.length === 0) {
    throw new Error("candidate version is missing");
  }
  if (typeof input?.dashboardOrigin !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(input.dashboardOrigin)) {
    throw new Error("dashboard origin is invalid");
  }
  const actions = new Set([
    "click-update",
    "click-update-and-wait-error",
    "verify-update-result",
  ]);
  if (!actions.has(input?.action)) {
    throw new Error("desktop UI probe action is invalid");
  }
  if (input.action === "verify-update-result" &&
      (typeof input?.sourceVersion !== "string" || input.sourceVersion.length === 0)) {
    throw new Error("source version is missing");
  }
  return input;
}

async function writeResult(result) {
  const text = `${JSON.stringify(result)}\n`;
  if (outputPath) {
    await writeFile(outputPath, text, "utf8");
  } else {
    process.stdout.write(text);
  }
}

async function connectToBrowser(endpoint) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 1_000 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("installed Vela Browser debug endpoint was not ready");
}

async function findDashboardPage(browser, dashboardOrigin) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(`${dashboardOrigin}/`));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("installed Vela Browser dashboard target was not found");
}

async function main() {
  const input = await readInput();
  const browser = await connectToBrowser(input.endpoint);
  try {
    const page = await findDashboardPage(browser, input.dashboardOrigin);
    if (input.action === "verify-update-result") {
      const visibility = await page.evaluate(() => ({
        hidden: document.hidden,
        state: document.visibilityState,
      }));
      if (visibility.hidden || visibility.state !== "visible") {
        throw new Error("updated Vela Browser window was not visible");
      }
      const result = page.locator(".update-banner.update-result.success");
      await result.waitFor({ state: "visible", timeout: 60_000 });
      const title = (await result.locator("strong").innerText()).trim();
      const detail = (await result.locator(".update-copy span").innerText()).trim();
      if (!texts("Vela Browser {version} installed successfully.", { version: input.candidateVersion }).includes(title) ||
          !texts("Updated from {fromVersion} and verified the installed app after restart.", { fromVersion: input.sourceVersion }).includes(detail)) {
        throw new Error("durable updater result did not confirm the exact version handoff");
      }
      await writeResult({ ok: true, action: "verified-durable-success" });
      return;
    }

    const updateNow = exactly("Update now");
    const banner = page.locator(".update-banner").filter({
      has: page.getByRole("button", { name: updateNow }),
    });
    await banner.waitFor({ state: "visible", timeout: 60_000 });
    const announcedVersion = await banner.locator('[role="status"] strong').innerText();
    if (!texts("Vela Browser {version} is available.", { version: input.candidateVersion }).includes(announcedVersion.trim())) {
      throw new Error("visible update banner announced a different version");
    }
    const updateButton = banner.getByRole("button", { name: updateNow });
    await updateButton.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await updateButton.isEnabled())) throw new Error("visible Update now action was disabled");
    await updateButton.click({ noWaitAfter: true });
    if (input.action === "click-update-and-wait-error") {
      await banner.locator('[role="alert"]').waitFor({ state: "visible", timeout: 120_000 });
      await updateButton.waitFor({ state: "visible", timeout: 30_000 });
      if (!(await updateButton.isEnabled())) throw new Error("Update now did not reset after rejection");
      await writeResult({ ok: true, action: "visible-update-rejected" });
      return;
    }
    await writeResult({ ok: true, action: "visible-update-now" });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`Vela Browser updater UI probe failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});

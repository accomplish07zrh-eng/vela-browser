import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const runtime = option("runtime");
const endpoint = option("cdp");
const origin = option("origin");
assert(runtime && endpoint && origin, "Provide --runtime, --cdp and --origin");
const { chromium } = createRequire(join(resolve(runtime), "package.json"))("playwright-core");
const browser = await chromium.connectOverCDP(endpoint);
const errors = [];
try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith(`${origin}/`));
  assert(page, "Native dashboard is missing");
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".sidebar").waitFor();
  assert.equal(await page.locator(".account-button, .cloud-signin, .cloud-auth, .mode-choice").count(), 0);
  await page.locator('.sidebar button[title]').filter({ hasText: /^(Settings|设置|Настройки)$/ }).click();
  await page.locator('[role="tablist"]').waitFor();
  const tabs = await page.locator('[role="tablist"] [role="tab"]').allTextContents();
  assert.equal(tabs.length, 2);
  assert(!tabs.some((text) => /account|team|账户|团队|аккаунт|команда/i.test(text)));
  assert.equal(await page.locator('input[type="password"]').count(), 0);

  const retired = await page.evaluate(async () => {
    const paths = ["cloud-auth", "cloud-auth/sign-in", "cloud-auth/restore", "cloud-workspace", "cloud-connectors", "cloud-store", "scripts/example/publication", "app-mode"];
    const results = [];
    for (const path of paths) {
      const response = await fetch(`/ui/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      results.push({ path, status: response.status, cache: response.headers.get("cache-control"), body: await response.json() });
    }
    const config = await (await fetch("/ui/api/app-mode")).json();
    return { config, results };
  });
  assert.equal(retired.config.mode, "local");
  assert(!Object.hasOwn(retired.config, "cloudUrl"));
  for (const result of retired.results) {
    assert.equal(result.status, 410, result.path);
    assert.equal(result.cache, "no-store", result.path);
    assert.equal(result.body.code, "accounts_removed", result.path);
  }
  assert.deepEqual(errors, []);
  const result = { localStartup: true, settingsTabs: tabs, accountInterfaceAbsent: true, retiredRoutes: retired.results.length, javascriptErrors: errors.length };
  if (args.includes("--output")) writeFileSync(option("output"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}

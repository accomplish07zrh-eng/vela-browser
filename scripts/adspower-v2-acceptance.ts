/** Exercises a migrated profile using the public local API and a real Selenium client. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { aliasmodeChromiumArchive, aliasmodeChromiumExecutable } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { Launcher } from "../src/launcher.ts";
import { ProfileStore } from "../src/store.ts";
import { serveAutomationApi } from "../src/web.ts";

const { values } = parseArgs({ options: {
  "runtime-root": { type: "string", default: "." },
  python: { type: "string", default: "python" },
} });
const binary = aliasmodeChromiumExecutable(join(resolve(values["runtime-root"]), "reports/runtimes/chromium"));
assert.equal(await sha256File(binary), aliasmodeChromiumArchive(process.platform).executableSha256, "Use the pinned Vela Chromium");
mkdirSync("reports", { recursive: true });
const directory = realpathSync("reports");
const scratch = mkdtempSync(join(directory, "adspower-v2-qa-"));
const driverRoot = join(scratch, "runtimes");
const store = new ProfileStore(":memory:");
const launcher = new Launcher({
  store, dataRoot: join(scratch, "data"), chromiumRuntimeRoot: driverRoot,
  headless: true, ensureAliasmodeChromium: async () => binary, log: () => {},
});
const api = serveAutomationApi({ store, launcher, port: 0, log: () => {} });
const site = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch: () => new Response('<!doctype html><title>Vela Selenium smoke</title><input id="example">', {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }),
});
const fixture = new URL("/fixture", site.url).href;
const call = async (path: string, payload?: Record<string, unknown>) => {
  const reply = await fetch("http://127.0.0.1:" + api.port + path, payload === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const result = await reply.json() as { code: number; msg: string; data: any };
  assert.equal(result.code, 0, result.msg);
  return result.data;
};
const v2 = "/api/v2/browser-profile/";
const cookie = (name: string, value: string) => ({ name, value, domain: "127.0.0.1", path: "/" });
const attachWithSelenium = String.raw`
import sys
import selenium
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

path, address, fixture = sys.argv[1:]
options = webdriver.ChromeOptions()
options.debugger_address = address
driver = webdriver.Chrome(service=Service(path), options=options)
try:
    def startup_tab(browser):
        for handle in browser.window_handles:
            browser.switch_to.window(handle)
            if browser.current_url == fixture:
                return True
        return False
    WebDriverWait(driver, 10).until(startup_tab)
    assert driver.title == "Vela Selenium smoke", driver.title
    assert driver.get_cookie("migrated_create")["value"] == "created"
    assert driver.get_cookie("migrated_update")["value"] == "updated"
    field = driver.find_element(By.ID, "example")
    field.send_keys("attached via Selenium")
    assert field.get_attribute("value") == "attached via Selenium"
    print("Selenium", selenium.__version__, "attached to Chromium", driver.capabilities["browserVersion"])
finally:
    driver.quit()
`;
let id: string | undefined;
try {
  assert.equal(existsSync(driverRoot), false, "This check must exercise a cold driver cache");
  const profile = await call(v2 + "create", {
    name: "V2 migration", group_id: "qa", platform: "example.test",
    remark: "Migrated with the local API", tabs: [fixture], chromium_runtime: "aliasmode",
    user_proxy_config: { proxy_soft: "no_proxy" },
    fingerprint_config: { screen_resolution: "1440_900", language_switch: "0", language: ["en-US"],
      automatic_timezone: "0", timezone: "America/New_York" },
    cookie: JSON.stringify([cookie("migrated_create", "created")]),
  });
  id = profile.profile_id;
  assert.ok(id && /^\d+$/.test(profile.profile_no));
  await call(v2 + "update", {
    profile_id: id, name: "V2 migration updated", remark: "Updated",
    cookie: JSON.stringify([cookie("migrated_update", "updated")]),
  });
  assert.equal(store.getProfile(id)?.remark, "Updated");
  const listing = await call(v2 + "list", { profile_no: [profile.profile_no] });
  assert.equal(listing.list[0].name, "V2 migration updated");

  const started = await call(v2 + "start", { profile_no: profile.profile_no, headless: "1" });
  assert.match(started.ws.selenium, /^127\.0\.0\.1:\d+$/);
  assert.match(started.ws.puppeteer, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
  assert.ok(started.webdriver && existsSync(started.webdriver), "Missing installed ChromeDriver");
  const active = await call(v2 + "active?profile_id=" + id);
  assert.equal(active.webdriver, started.webdriver);
  assert.deepEqual(active.ws, started.ws);

  const selenium = Bun.spawn([values.python, "-c", attachWithSelenium, started.webdriver, started.ws.selenium, fixture], {
    stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(45_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    selenium.exited, new Response(selenium.stdout).text(), new Response(selenium.stderr).text(),
  ]);
  assert.equal(exitCode, 0, stderr);
  await call(v2 + "stop", { profile_id: id });
  assert.equal((await call(v2 + "active?profile_id=" + id)).status, "Inactive");
  console.log(stdout.trim());
  console.log("PASS: create, update, list, startup tab, both cookies, WebDriver, active and stop");
} finally {
  let stopped = true;
  if (id) {
    stopped = await launcher.stop(id);
    if (stopped) await launcher.cacheCleanupSettled(id);
  }
  await api.stop(true);
  await site.stop(true);
  store.close();
  const actual = realpathSync(scratch);
  if (stopped && dirname(actual) === directory && basename(actual).startsWith("adspower-v2-qa-")) {
    await rm(actual, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
}

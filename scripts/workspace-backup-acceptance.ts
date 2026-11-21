/** Recover a large test workspace into a clean store and actually reopen both browser engines. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { aliasmodeChromiumArchive, aliasmodeChromiumExecutable } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { buildNewProfile } from "../src/create.ts";
import { Launcher } from "../src/launcher.ts";
import { ensureStateDirectories, statePaths } from "../src/paths.ts";
import { runPlaywrightWorker } from "../src/playwright-runtime.ts";
import { ProfileStore } from "../src/store.ts";
import { serveDashboard } from "../src/web.ts";
import { WORKSPACE_BACKUP_PATH, type WorkspaceBackupPreview } from "../src/workspace-backup.ts";

const runtime = resolve(process.argv[2] ?? ".");
const chromium = aliasmodeChromiumExecutable(join(runtime, "reports/runtimes/chromium"));
const firefox = JSON.parse(readFileSync(join(runtime, "src-tauri/generated/browser.json"), "utf8")).firefox;
const firefoxBinary = join(runtime, "src-tauri/resources/firefox", firefox.executable);
assert.equal(await sha256File(chromium), aliasmodeChromiumArchive(process.platform).executableSha256);
assert.equal(await sha256File(firefoxBinary), firefox.sha256);
const temp = realpathSync(tmpdir());
const root = mkdtempSync(join(temp, "vela-workspace-qa-"));
const host = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
  new Response("<!doctype html><title>Workspace recovery fixture</title>", { headers: { "content-type": "text/html" } }) });
const site = host.url.href;
const passphrase = randomBytes(24).toString("hex");
const folder = "QA/Nested";
const profiles = [
  buildNewProfile({ name: "QA Chromium", group: folder, chromiumRuntime: "aliasmode" }, () => false),
  buildNewProfile({ name: "QA Firefox", group: folder, engine: "firefox" }, () => false),
];
const trashed = buildNewProfile({ name: "QA Trash", group: folder }, () => false);
const fixtures: Array<ReturnType<typeof fixture>> = [];

function fixture(name: string) {
  const paths = statePaths(join(root, name));
  ensureStateDirectories(paths);
  const store = new ProfileStore(":memory:");
  store.setFieldEncryption(true);
  const launcher = new Launcher({ store, dataRoot: paths.profiles, headless: true, log() {},
    ensureAliasmodeChromium: async () => chromium, firefoxBinaryPath: firefoxBinary, expectedFirefoxBinarySha256: firefox.sha256 });
  const nonce = randomBytes(32).toString("hex");
  const dashboard = serveDashboard({ store, launcher, paths, agentNonce: randomBytes(32).toString("hex"),
    desktopAdminNonce: nonce, port: 0, log() {} });
  return { store, launcher, dashboard, nonce };
}

async function pageAction(endpoint: string, code: string, argument?: string) {
  const result = await runPlaywrightWorker<{ completed: boolean; value: unknown; error?: string }>("devtools-program", { endpoint, code, argument });
  assert.equal(result.completed, true, result.error);
  return result.value;
}

const request = (node: ReturnType<typeof fixture>, body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${node.dashboard.port}${WORKSPACE_BACKUP_PATH}`, {
    method: "POST", headers: { authorization: `Bearer ${node.nonce}`, ...headers }, body,
  });

try {
  const source = fixture("first");
  fixtures.push(source);
  const target = fixture("restored");
  fixtures.push(target);
  source.store.createGroup("QA");
  source.store.createGroup("Nested", "QA");
  source.store.upsertProfiles([...profiles, trashed]);
  assert.equal(source.store.trashProfile(trashed.id), true);
  source.store.setDeletionProtection([profiles[0]!.id], true);
  for (const profile of profiles) {
    const launch = await source.launcher.start(profile.id, [site]);
    assert.equal(await pageAction(launch.ws, `async ({context, argument}) => {
      const page = context.pages().find(page => page.url() === ${JSON.stringify(site)});
      return page?.evaluate(value => {
        document.cookie = "vela_restore=" + value + "; Path=/; Max-Age=600";
        localStorage.setItem("vela_restore", value);
        return document.title;
      }, argument);
    }`, profile.id), "Workspace recovery fixture");
    assert.equal(await source.launcher.captureLocalSession(profile.id), true);
    assert.equal(await source.launcher.stop(profile.id), true);
  }
  for (let index = 0; index < 700; index++) {
    const profile = { ...profiles[0]!, id: `workspace-import-${index}`, name: `Imported profile ${index}` };
    source.store.upsertProfile(profile);
  }
  const exported = await request(source, JSON.stringify({ passphrase }), { "content-type": "application/json" });
  assert.ok(exported.ok, `Export failed with HTTP ${exported.status}`);
  const file = await exported.blob();
  for (const action of ["preview", "restore"]) {
    const form = new FormData();
    form.set("file", file, "workspace.vela-workspace");
    form.set("passphrase", passphrase);
    form.set("action", action);
    const response = await request(target, form);
    assert.ok(response.ok, `${action} failed with HTTP ${response.status}`);
    const { summary } = await response.json() as { summary: WorkspaceBackupPreview };
    assert.deepEqual([summary.profiles, summary.folders, summary.savedSessions, summary.protectedProfiles, summary.trashed], [703, 2, 2, 1, 1]);
    assert.deepEqual(summary.conflicts, []);
  }
  assert.equal(target.store.workspaceBackupProfileIds().length, 703);
  assert.equal(target.store.isDeletionProtected(profiles[0]!.id), true);
  assert.equal(target.store.isTrashed(trashed.id), true);
  for (const profile of profiles) {
    assert.ok(!lstatSync(target.launcher.userDataDir(profile.id), { throwIfNoEntry: false }), "Recovery should not require native profile files");
    const launch = await target.launcher.start(profile.id);
    const result = await pageAction(launch.ws, `async ({context}) => {
      const page = context.pages().find(page => page.url() === ${JSON.stringify(site)});
      return page?.evaluate(() => [document.cookie, localStorage.getItem("vela_restore")]);
    }`);
    assert.deepEqual(result, [`vela_restore=${profile.id}`, profile.id]);
  }
  console.log(JSON.stringify({ profiles: 703, restoredSessionEngines: ["chromium", "firefox"], protectedProfiles: 1,
    trashedProfiles: 1, encryptedArchiveBytes: file.size }));
} finally {
  let closed = true;
  for (const fixture of fixtures) {
    for (const launch of fixture.store.listLaunches()) if (!await fixture.launcher.stop(launch.profileId)) closed = false;
    await Promise.all(profiles.map(({ id }) => fixture.launcher.cacheCleanupSettled(id)));
    await fixture.dashboard.stop(true);
    fixture.store.close();
  }
  host.stop(true);
  assert.ok(closed, "Every recovery browser must close");
  if (dirname(realpathSync(root)) === temp) await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}

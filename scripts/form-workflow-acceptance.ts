/** Exercises form authoring, script approval and execution on a local two-step site. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { createVelaBrowserMcp } from "../agent/mcp-host.mjs";
import { AGENT_PATH, AGENT_PROTOCOL, AgentRuntimeClient } from "../agent/runtime-client.mjs";
import { aliasmodeChromiumExecutable, ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 } from "../src/aliasmode-chromium.ts";
import { sha256File } from "../src/browser-install.ts";
import { buildNewProfile } from "../src/create.ts";
import { Launcher } from "../src/launcher.ts";
import { ensureStateDirectories, statePaths } from "../src/paths.ts";
import { ProfileStore } from "../src/store.ts";
import { WEBKIT_EXECUTABLE_SHA256 } from "../src/webkit-install.ts";
import { serveDashboard } from "../src/web.ts";
import { stageAgentRuntime } from "./prepare-windows-bundle.ts";

const { values } = parseArgs({ options: {
  "runtime-root": { type: "string", default: "." },
  engine: { type: "string", multiple: true, default: ["chromium", "firefox", "webkit"] },
  report: { type: "string", default: "reports/form-workflow-acceptance.json" },
} });
const engines = values.engine.map(engine => {
  assert.ok(engine === "chromium" || engine === "firefox" || engine === "webkit", "Choose chromium, firefox or webkit");
  return engine;
});
const runtimeRoot = resolve(values["runtime-root"]), output = resolve(values.report);
const firefox = engines.includes("firefox") ? JSON.parse(readFileSync(join(runtimeRoot, "src-tauri/generated/browser.json"), "utf8")).firefox : undefined;
const binaries = {
  chromium: aliasmodeChromiumExecutable(join(runtimeRoot, "reports/runtimes/chromium")),
  firefox: firefox ? join(runtimeRoot, "src-tauri/resources/firefox", firefox.executable) : "",
  webkit: join(runtimeRoot, "reports/webkit-native-2388/Playwright.exe"),
};
const hashes = { chromium: ALIASMODE_CHROMIUM_EXECUTABLE_SHA256, firefox: firefox?.sha256, webkit: WEBKIT_EXECUTABLE_SHA256 };
for (const engine of engines) assert.equal(await sha256File(binaries[engine]), hashes[engine], "Use the pinned Vela " + engine + " runtime");
const node = Bun.which("node");
assert.ok(node, "A supported Node.js executable is required");
const temp = realpathSync(tmpdir());
const root = mkdtempSync(join(temp, "vela-form-workflow-qa-")), paths = statePaths(join(root, "state"));
const runtime = join(root, "playwright");
const checks: { engine: string; script: string; durable: boolean; privateValuesAbsent: boolean; cdp?: boolean; writes: number }[] = [];
const ids: string[] = [];
const previousRuntime = process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
let store: ProfileStore | undefined, launcher: Launcher | undefined, manager: ReturnType<typeof serveDashboard> | undefined;
let host: Awaited<ReturnType<typeof createVelaBrowserMcp>> | undefined, client: Client | undefined, socket: WebSocket | undefined;
let requested = 0, submitted = 0, readyAt = 0, failure: string | undefined;
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/request-code" && req.method === "POST") {
    requested++; readyAt = Date.now() + 650; return new Response("Accepted");
  }
  if (path === "/code") return new Response(readyAt && Date.now() >= readyAt ? "314159" : "111111", { headers: { "Cache-Control": "no-store" } });
  if (path === "/submit" && req.method === "POST") { submitted++; return new Response("Completed"); }
  if (path === "/inbox") return new Response([
    "<!doctype html><output id=mail-code>111111</output><script>",
    "setInterval(async () => { document.querySelector('#mail-code').textContent = await (await fetch('/code')).text(); }, 75);",
    "</script>",
  ].join(""), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return new Response([
    "<!doctype html><meta charset=utf-8><title>Vela offline form</title>",
    "<form id=signup aria-label='Profile details'><label>Email <input name=email type=email required></label>",
    "<label>Password <input name=password type=password value='private-prefilled-password' required></label>",
    "<label>确认密码 <input name=repeat type=password autocomplete=new-password required></label>",
    "<label>Region <select name=region required><option value=tw>Taipei</option></select></label>",
    "<label>Terms <input name=terms type=checkbox required></label><button id=next type=submit>Next</button></form>",
    "<form id=verification hidden><label>Verification code <input name=otp autocomplete=one-time-code required></label>",
    "<button id=finish type=submit>Finish</button></form><output id=receipt hidden></output>",
    "<script>",
    "const signup = document.querySelector('#signup'), verification = document.querySelector('#verification');",
    "signup.onsubmit = async event => { event.preventDefault();",
    "  if (signup.password.value !== signup.repeat.value || !signup.terms.checked || signup.region.value !== 'tw') return;",
    "  await fetch('/request-code', {method:'POST'}); signup.hidden = true; verification.hidden = false;",
    "};",
    "verification.onsubmit = async event => { event.preventDefault();",
    "  if (verification.otp.value !== '314159') return;",
    "  const receipt = document.querySelector('#receipt'); receipt.textContent = await (await fetch('/submit', {method:'POST'})).text();",
    "  verification.hidden = true; receipt.hidden = false;",
    "};",
    "</script>",
  ].join("\n"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
} });
const origin = "http://127.0.0.1:" + site.port, entry = origin + "/signup", inbox = origin + "/inbox";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 25000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the workflow");
}

try {
  stageAgentRuntime(resolve("."), runtime);
  mkdirSync(join(runtime, "node"), { recursive: true });
  copyFileSync(node, join(runtime, "node", process.platform === "win32" ? "node.exe" : "node"));
  process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = runtime;
  ensureStateDirectories(paths);
  store = new ProfileStore(paths.database);
  launcher = new Launcher({ store, dataRoot: paths.profiles, headless: true,
    ensureAliasmodeChromium: async () => binaries.chromium, ensureWebKit: async () => binaries.webkit,
    ...(firefox ? { firefoxBinaryPath: binaries.firefox, expectedFirefoxBinarySha256: firefox.sha256 } : {}),
  });
  const nonce = randomBytes(32).toString("hex");
  manager = serveDashboard({ store, launcher, paths, agentNonce: nonce, port: 0, log: () => {} });
  const local = "http://127.0.0.1:" + manager.port;
  socket = new WebSocket("ws://127.0.0.1:" + manager.port + AGENT_PATH, AGENT_PROTOCOL, { headers: { authorization: "Bearer " + nonce } });
  await new Promise<void>((done, reject) => { socket!.once("open", done); socket!.once("error", reject); });
  host = await createVelaBrowserMcp({ discovered: { client: new AgentRuntimeClient(socket) } });
  client = new Client({ name: "vela-form-workflow-acceptance", version: "1" }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.server.connect(serverTransport), client.connect(clientTransport)]);
  async function call(name: string, args: Record<string, unknown>) {
    const answer = await client!.callTool({ name, arguments: args }, undefined, { timeout: 110000 })
      .catch(error => { throw new Error(name + ": " + error.message); });
    if (answer.isError) throw new Error(name + ": " + JSON.stringify(answer.content));
    return (answer.structuredContent ?? JSON.parse((answer.content as any)[0].text)) as any;
  }
  const form = (args: Record<string, unknown>) => call("browser_devtools_form_workflow", args);
  const approvalPath = local + "/ui/api/code-approvals";
  for (const engine of engines) {
    requested = 0; submitted = 0; readyAt = 0;
    const profile = buildNewProfile({ engine, name: "Workflow " + engine,
      ...(engine === "chromium" ? { chromiumRuntime: "aliasmode" } : {}) }, () => false);
    store.upsertProfile(profile);
    ids.push(profile.id);
    const profileId = profile.id;
    console.log(engine + " starting");
    await call("vela_browser_open", { profileId, startupUrls: [entry, inbox] });
    const pages = await until(() => call("browser_devtools_pages", { profileId }),
      (view: any) => view.pages.some((page: any) => page.url === entry) && view.pages.some((page: any) => page.url === inbox));
    const target = { profileId, pageId: pages.pages.find((page: any) => page.url === entry).pageId };
    const evaluate = (expression: string) => call("browser_devtools_evaluate", { ...target, expression });
    await evaluate("() => {" +
      " const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 80;" +
      " canvas.style.cssText = 'position:fixed;left:10px;top:180px;width:240px;height:80px;z-index:1000';" +
      " const ctx = canvas.getContext('2d'); ctx.fillStyle = '#edf0fa'; ctx.fillRect(0,0,240,80);" +
      " for (const [left,top] of [[2,2],[145,41]]) for (let y=0;y<12;y++) for (let x=0;x<12;x++) {" +
      " ctx.fillStyle = ['#f03022','#334058','#263dc3','#43be21'][(x*x+y*7+x*y)%4]; ctx.fillRect(left+x,top+y,1,1); }" +
      " canvas.id = 'vision-fixture'; document.body.append(canvas); }");
    const match = await call("browser_devtools_visual_match", { ...target,
      region: { x: 100, y: 190, width: 150, height: 70 }, reference: { x: 12, y: 182, width: 12, height: 12 }, tolerance: 0.015 });
    assert.equal(match.status, "unique", JSON.stringify(match));
    assert.deepEqual(match.candidates[0].center, { x: 161, y: 227 });
    await evaluate("() => document.querySelector('#vision-fixture').remove()");
    const signup = await form({ action: "inspect", ...target, selector: "#signup" });
    assert.equal(signup.forms.length, 1);
    assert.ok(!JSON.stringify(signup).includes("private-prefilled-password"));
    assert.equal(signup.forms[0].fields.find((field: any) => field.kind === "confirmPassword").action, "fill");
    await evaluate("() => { document.querySelector('#signup').hidden = true; document.querySelector('#verification').hidden = false; }");
    const verification = await form({ action: "inspect", ...target, selector: "#verification" });
    await evaluate("() => { document.querySelector('#signup').hidden = false; document.querySelector('#verification').hidden = true; }");
    const stages = [
      { ...signup.forms[0].suggestedStage, id: "details", verify: { selector: "#verification" } },
      { ...verification.forms[0].suggestedStage, id: "verify", verify: { selector: "#receipt", text: "Completed" } },
    ];
    stages[1].fields = stages[1].fields.map((field: any) => ({ ...field, action: "type" }));
    const authored = await form({ action: "draft", ...target, name: "Offline form", exampleInputs: true, stages: [
      stages[0], { ...stages[1], code: { input: "oneTimeCode", pageUrl: inbox, selector: "#mail-code", timeoutMs: 6000 } },
    ] });
    assert.ok(!JSON.stringify(authored).includes("private-prefilled-password"));
    const inputs = { ...authored.exampleInputs, region: "tw" };
    assert.ok(!Object.hasOwn(inputs, "oneTimeCode"));
    if (engine === "webkit") {
      const code = "async ({ context, argument }) => {\n" + authored.script.source.replace("export default async", "async")
        + "\n return workflow({ context, inputs: argument });\n}";
      assert.equal((await call("browser_devtools_program", { ...target, code, argument: inputs })).value.verified, true);
    } else {
      const save = call("vela_script_save", authored.script);
      void save.catch(() => {});
      const approval = await until(() => fetch(approvalPath).then(response => response.json()) as Promise<any>, value => value.pending.length === 1);
      assert.ok(approval.pending[0].files[0].content === authored.script.source, "The approval gateway must show the exact draft");
      const answer = await fetch(approvalPath + "/answer", { method: "POST", headers: { "Content-Type": "application/json", Origin: local },
        body: JSON.stringify({ id: approval.pending[0].id, approve: true }) });
      assert.ok(answer.ok, await answer.text());
      const saved = await save;
      await call("vela_script_run", { scriptId: saved.script.id, profileIds: [profileId], inputs });
      const ended = await until(() => call("vela_script_run_status", {}), (value: any) => value.run?.status === "finished", 45000);
      assert.equal(ended.run.profiles[0].status, "succeeded", JSON.stringify(ended));
      assert.ok(!JSON.stringify(ended).includes(inputs.password));
    }
    assert.equal(requested, 1);
    assert.equal(submitted, 1);
    const durable = await form({ action: "draft", ...target, stages: [stages[1]] });
    const task = await call("vela_browser_task", { operation: "start", profileId, steps: durable.task.steps,
      argument: { ...inputs, oneTimeCode: "314159" } });
    const finished = await until(() => call("vela_browser_task", { operation: "status", runId: task.task.runId }),
      (view: any) => ["completed", "needs_verification", "interrupted"].includes(view.task.state), 45000);
    assert.equal(finished.task.state, "completed", JSON.stringify(finished));
    assert.equal(submitted, 1, "a confirmed action must not be resubmitted");
    const { task: unattended } = await call("vela_browser_task", {
      operation: "start", profileId, startUrl: entry, steps: [{ id: "observe", readOnly: true, run: [
        "async ({devtools}) => {",
        " const view = await devtools.call('observe', {selector: '#signup'});",
        " if (!view.controls.some(control => control.name === 'Next' && control.anchor)) throw new Error('Missing next button anchor');",
        " if (JSON.stringify(view).includes('private-prefilled-password')) throw new Error('Observation read a password');",
        " return view.controls.length;",
        "}",
      ].join("\n") }],
    });
    const bound = await until(() => call("vela_browser_task", { operation: "status", runId: unattended.runId }),
      (view: any) => ["completed", "interrupted", "needs_verification"].includes(view.task.state));
    assert.equal(bound.task.state, "completed", JSON.stringify(bound));
    const taskTabs = await call("vela_browser_replay", { action: "tabs", runId: unattended.runId });
    assert.deepEqual(taskTabs.tabs.map((tab: { tabId: string }) => tab.tabId), [bound.task.tabId]);
    let cdp: boolean | undefined;
    if (engine === "chromium") {
      const { data } = await fetch(local + "/api/v2/browser-profile/active?profile_id=" + profileId).then(response => response.json()) as any;
      const external = await chromium.connectOverCDP(data.ws.puppeteer);
      try {
        const tab = external.contexts()[0]?.pages().find(page => page.url() === entry);
        assert.equal(await tab?.locator("#receipt").textContent(), "Completed");
      } finally { await external.close(); }
      cdp = (await call("vela_browser_status", { profileId })).running === true;
      assert.equal(cdp, true, "detaching an external client preserves the environment");
    }
    checks.push({ engine, script: engine === "webkit" ? "native browser program" : "saved script", durable: true, privateValuesAbsent: true, cdp, writes: submitted });
    console.log(engine + " passed workflow authoring, execution, and receipt verification");
    await call("vela_browser_close", { profileId });
  }
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await host?.close().catch(() => {});
  socket?.close();
  await manager?.stopScripts().catch(() => {});
  for (const id of ids) {
    await launcher?.stop(id).catch(() => false);
    await launcher?.cacheCleanupSettled(id).catch(() => {});
  }
  await manager?.stop(true);
  store?.close();
  site.stop(true);
  if (previousRuntime === undefined) delete process.env.ALIASMODE_PLAYWRIGHT_RUNTIME;
  else process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = previousRuntime;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ checks, failure }, null, 2) + "\n");
  assert.equal(dirname(realpathSync(root)), temp);
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  console.log("Workflow acceptance report " + output);
}

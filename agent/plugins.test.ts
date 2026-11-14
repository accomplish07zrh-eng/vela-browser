import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, isPluginTool, pluginTools } from "./plugins.mjs";

let counter = 0;
function moduleFile(source: string) {
  // A fresh path per module: the test runtime caches modules by path.
  const path = join(mkdtempSync(join(tmpdir(), "vela-plugin-module-")), `index-${++counter}.mjs`);
  writeFileSync(path, source);
  return path;
}
function spec(module: string, tools: any[] = [{ name: "read", readOnly: true, timeoutSeconds: 5 }], revision = module) {
  return [{ id: "fixture", name: "Fixture", version: "1.0.0", description: "", module, revision,
    tools: tools.map(tool => ({ title: `Fixture: ${tool.name}`, description: `Does ${tool.name}.`, inputSchema: { type: "object" }, readOnly: false, timeoutSeconds: 120,
      ...tool, toolName: `plugin_fixture_${tool.name}` })) }];
}
function environment(profileId = "a") {
  const closes: string[] = [];
  const page = { url: () => `https://${profileId}.test/`, isClosed: () => false, title: async () => `Page ${profileId}` };
  const context = { pages: () => [page], close: async () => { closes.push("context"); }, browser: () => ({ close: async () => { closes.push("browser"); } }), marker: profileId };
  const devtools = { call: async (name: string, args: unknown) => ({ structuredContent: { name, args } }) };
  return { host: new PluginHost({ context, engine: "chromium", profileId, devtools }), closes };
}

test("plugin tools are listed with their plugin's name and honest read/write hints", () => {
  const [read, write] = pluginTools(spec("/x/index.mjs", [{ name: "read", readOnly: true }, { name: "write" }]));
  expect(read).toMatchObject({ name: "plugin_fixture_read", description: "[Fixture plugin] Does read.", annotations: { readOnlyHint: true, destructiveHint: false } });
  expect(write!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect(pluginTools(undefined)).toEqual([]);
  expect(pluginTools([{ id: "x", module: "relative.mjs", revision: "r", tools: [] }])).toEqual([]);
  expect(isPluginTool("plugin_fixture_read")).toBe(true);
  expect(isPluginTool("browser_click")).toBe(false);
});

test("a tool runs with its arguments, this environment's page and developer tools", async () => {
  const module = moduleFile(`export default (vela) => ({
    async read(args) {
      const page = vela.page();
      return { echo: args.value, url: page.url(), title: await page.title(), profileId: vela.profileId, engine: vela.engine,
        devtools: await vela.devtools("console", { level: "error" }), plugin: vela.plugin.id };
    },
  });`);
  const { host } = environment("a");
  const result = await host.call(spec(module), "plugin_fixture_read", { value: 7 });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toEqual({ echo: 7, url: "https://a.test/", title: "Page a", profileId: "a", engine: "chromium",
    devtools: { name: "browser_devtools_console", args: { level: "error" } }, plugin: "fixture" });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
});

test("a plugin cannot close the browser or reach the Browser object", async () => {
  const module = moduleFile(`export default (vela) => ({
    async read() {
      let closeError = null;
      try { await vela.context.close(); } catch (error) { closeError = error.message; }
      return { closeError, browser: vela.context.browser(), marker: vela.context.marker };
    },
  });`);
  const { host, closes } = environment("a");
  const result = await host.call(spec(module), "plugin_fixture_read", {});
  expect(result.structuredContent.closeError).toContain("cannot close");
  expect(result.structuredContent.browser).toBeNull();
  expect(result.structuredContent.marker).toBe("a");
  expect(closes).toEqual([]);
});

test("each environment gets its own setup, so plugin state never crosses environments", async () => {
  const module = moduleFile(`export default (vela) => { let count = 0; return { read: () => ({ profileId: vela.profileId, count: ++count }) }; };`);
  const a = environment("a").host, b = environment("b").host;
  await a.call(spec(module), "plugin_fixture_read", {});
  expect((await a.call(spec(module), "plugin_fixture_read", {})).structuredContent).toEqual({ profileId: "a", count: 2 });
  expect((await b.call(spec(module), "plugin_fixture_read", {})).structuredContent).toEqual({ profileId: "b", count: 1 });
});

test("a changed plugin sets up again and the old instance is disposed", async () => {
  const module = moduleFile(`let setups = 0; const disposed = [];
    export default () => { const id = ++setups; return { read: () => ({ id, disposed: [...disposed] }), dispose: () => { disposed.push(id); } }; };`);
  const { host } = environment("a");
  expect((await host.call(spec(module, undefined, "r1"), "plugin_fixture_read", {})).structuredContent).toEqual({ id: 1, disposed: [] });
  expect((await host.call(spec(module, undefined, "r2"), "plugin_fixture_read", {})).structuredContent).toEqual({ id: 2, disposed: [1] });
  host.dispose();
  expect((await host.call(spec(module, undefined, "r2"), "plugin_fixture_read", {})).isError).toBe(true);
});

test("failures come back as tool errors naming the plugin, never as crashes", async () => {
  const { host } = environment("a");
  const throwing = moduleFile(`export default () => ({ read() { throw new Error("selector not found"); } });`);
  expect((await host.call(spec(throwing), "plugin_fixture_read", {})).content[0].text).toBe("Fixture: selector not found");
  const slow = moduleFile(`export default () => ({ read: () => new Promise(() => {}) });`);
  const timedOut = await host.call(spec(slow, [{ name: "read", timeoutSeconds: 1 }]), "plugin_fixture_read", {});
  expect(timedOut.content[0].text).toContain("did not finish within 1 seconds");
  const noSetup = moduleFile(`export const read = () => 1;`);
  expect((await host.call(spec(noSetup), "plugin_fixture_read", {})).content[0].text).toContain("default setup(vela)");
  const missing = moduleFile(`export default () => ({});`);
  expect((await host.call(spec(missing), "plugin_fixture_read", {})).content[0].text).toContain("no function named read");
  expect((await host.call(spec(missing), "plugin_fixture_other", {})).content[0].text).toContain("not an enabled plugin tool");
  expect((await host.call([], "plugin_fixture_read", {})).isError).toBe(true);
});

test("a tool may return its own MCP content, or any plain value", async () => {
  const module = moduleFile(`export default () => ({
    read: () => ({ content: [{ type: "text", text: "custom" }] }),
    list: () => [1, 2],
  });`);
  const { host } = environment("a");
  const specs = spec(module, [{ name: "read" }, { name: "list" }]);
  expect(await host.call(specs, "plugin_fixture_read", {})).toEqual({ content: [{ type: "text", text: "custom" }] });
  expect((await host.call(specs, "plugin_fixture_list", {})).structuredContent).toEqual({ value: [1, 2] });
});

test("vela.log handles circular and BigInt values safely without throwing", async () => {
  const logs: string[] = [];
  const module = moduleFile(`export default (vela) => ({
    read() {
      const circular = {};
      circular.self = circular;
      vela.log("hi", circular, 42n);
      return { ok: true };
    },
  });`);
  const host = new PluginHost({ context: { pages: () => [] }, engine: "chromium", profileId: "a", log: (m: string) => logs.push(m) });
  const result = await host.call(spec(module), "plugin_fixture_read", {});
  expect(result.isError).not.toBe(true);
  expect(logs[0]).toContain("[plugin fixture] hi");
  expect(logs[0]).toContain("42");
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_MANIFEST, pluginToolName, scanPlugins, writeExamplePlugin } from "./plugins.ts";

function folder() { return mkdtempSync(join(tmpdir(), "vela-plugins-")); }
function plugin(root: string, id: string, manifest: Record<string, unknown> | string, module = "export default () => ({});") {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, PLUGIN_MANIFEST), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  writeFileSync(join(root, id, "index.mjs"), module);
}
const valid = (id: string, tools: unknown[] = [{ name: "read", description: "Reads.", readOnly: true }]) => ({ id, name: "Fixture", version: "1.0.0", tools });

test("a valid plugin becomes a spec with prefixed tool names, absolute module and a revision", () => {
  const root = folder();
  plugin(root, "price-watch", valid("price-watch", [
    { name: "read_price", description: "Reads the price.", readOnly: true, inputSchema: { type: "object", properties: { selector: { type: "string" } } } },
    { name: "set_alert", description: "Saves an alert.", timeoutSeconds: 30 },
  ]));
  const { infos, specs } = scanPlugins(root);
  expect(infos).toHaveLength(1);
  expect(infos[0]).toMatchObject({ id: "price-watch", enabled: true, name: "Fixture" });
  expect(infos[0]!.error).toBeUndefined();
  expect(specs[0]!.module).toBe(join(root, "price-watch", "index.mjs"));
  expect(specs[0]!.revision).toBeString();
  expect(specs[0]!.tools.map(tool => [tool.toolName, tool.readOnly, tool.timeoutSeconds])).toEqual([
    ["plugin_price_watch_read_price", true, 120],
    // A tool that does not say it only reads counts as one that changes things.
    ["plugin_price_watch_set_alert", false, 30],
  ]);
  expect(pluginToolName("a-b", "c")).toBe("plugin_a_b_c");
});

test("switched-off plugins are listed but never loaded", () => {
  const root = folder();
  plugin(root, "one", valid("one"));
  plugin(root, "two", valid("two"));
  const { infos, specs } = scanPlugins(root, ["two"]);
  expect(infos.map(info => [info.id, info.enabled])).toEqual([["one", true], ["two", false]]);
  expect(specs.map(spec => spec.id)).toEqual(["one"]);
});

test("broken manifests are reported with the reason and never loaded", () => {
  const root = folder();
  plugin(root, "bad-json", "{ nope");
  plugin(root, "wrong-id", valid("other"));
  plugin(root, "no-tools", valid("no-tools", []));
  plugin(root, "bad-tool", valid("bad-tool", [{ name: "Has Spaces", description: "x" }]));
  plugin(root, "reserved", valid("reserved", [{ name: "dispose", description: "x" }]));
  plugin(root, "escape", { ...valid("escape"), main: "../outside.mjs" });
  plugin(root, "schema", valid("schema", [{ name: "x", description: "x", inputSchema: { type: "string" } }]));
  plugin(root, "slow", valid("slow", [{ name: "x", description: "x", timeoutSeconds: 3600 }]));
  plugin(root, "Upper", valid("Upper"));
  mkdirSync(join(root, "empty"));
  const { infos, specs } = scanPlugins(root);
  expect(specs).toEqual([]);
  const reasons = Object.fromEntries(infos.map(info => [info.id, info.error]));
  expect(reasons["bad-json"]).toContain("not valid JSON");
  expect(reasons["wrong-id"]).toContain('id must be "wrong-id"');
  expect(reasons["no-tools"]).toContain("at least one tool");
  expect(reasons["bad-tool"]).toContain("a-z, 0-9 and _");
  expect(reasons.reserved).toContain("reserved");
  expect(reasons.escape).toContain("inside the plugin folder");
  expect(reasons.schema).toContain('type "object"');
  expect(reasons.slow).toContain("1 to 600");
  expect(reasons.Upper).toContain("folder name");
  expect(reasons.empty).toContain("missing");
});

test("two plugins can never offer the same tool name; the second one is held back", () => {
  const root = folder();
  plugin(root, "a-b", valid("a-b", [{ name: "c", description: "x" }]));
  plugin(root, "a", valid("a", [{ name: "b_c", description: "x" }]));
  const { infos, specs } = scanPlugins(root);
  expect(specs.map(spec => spec.id)).toEqual(["a"]);
  expect(infos.find(info => info.id === "a-b")!.error).toContain("also provided by plugin a");
});

test("a missing plugins folder lists nothing; the example plugin is valid and not overwritten", () => {
  expect(scanPlugins(join(folder(), "absent"))).toEqual({ infos: [], specs: [] });
  const root = folder();
  writeExamplePlugin(root);
  const { infos, specs } = scanPlugins(root);
  expect(infos[0]!.error).toBeUndefined();
  expect(specs[0]!.tools[0]!.toolName).toBe("plugin_page_info_summary");
  writeFileSync(join(root, "page-info", "index.mjs"), "// edited by the user");
  writeExamplePlugin(root);
  expect(require("node:fs").readFileSync(join(root, "page-info", "index.mjs"), "utf8")).toBe("// edited by the user");
});

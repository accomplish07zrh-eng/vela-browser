import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Plugins add tools the AI can call. Each one is a folder in the plugins folder with a
 * vela-plugin.json manifest and a JavaScript module. The module runs where the browser's own
 * automation runs (the MCP host for Chromium, the environment's owner process for Firefox and
 * WebKit), receives only that environment's existing context, and never starts, configures or
 * closes a browser. This file is the one place manifests are read and checked; the runtimes
 * load only what it accepted.
 */
export const PLUGIN_MANIFEST = "vela-plugin.json";
export const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const PLUGIN_TOOL = /^[a-z0-9](?:[a-z0-9_]{0,38}[a-z0-9])?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOOLS = 32;
const MCP_NAME_LIMIT = 64;
const RESERVED_TOOLS = new Set(["dispose"]);

export interface PluginToolSpec {
  /** The name inside the plugin, as the module exports it. */
  name: string;
  /** The name the AI sees: plugin_<id>_<name>. */
  toolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  timeoutSeconds: number;
}

/** A plugin the runtimes may load. */
export interface PluginSpec {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Absolute path of the module, inside the plugin's folder. */
  module: string;
  /** Changes whenever the manifest or module changes, so a runtime loads the new code. */
  revision: string;
  tools: PluginToolSpec[];
}

/** What the Settings page shows for each folder, including ones that could not be read. */
export interface PluginInfo {
  id: string;
  folder: string;
  enabled: boolean;
  name?: string;
  version?: string;
  description?: string;
  tools?: { name: string; toolName: string; description: string; readOnly: boolean }[];
  error?: string;
}

export function pluginsDirectory(stateRoot: string): string {
  return join(stateRoot, "plugins");
}

export function pluginToolName(pluginId: string, tool: string): string {
  return `plugin_${pluginId.replaceAll("-", "_")}_${tool}`;
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be text`);
  if (value.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return value.trim();
}

function readManifest(folder: string, id: string): Omit<PluginSpec, "revision"> & { manifestStat: string } {
  const path = join(folder, PLUGIN_MANIFEST);
  if (!existsSync(path)) throw new Error(`${PLUGIN_MANIFEST} is missing`);
  const stat = statSync(path);
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error(`${PLUGIN_MANIFEST} is larger than 256 KB`);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")); }
  catch (error) { throw new Error(`${PLUGIN_MANIFEST} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${PLUGIN_MANIFEST} must be an object`);
  if (raw.id !== id) throw new Error(`id must be "${id}", the name of its folder`);
  const name = text(raw.name, "name", 60);
  const version = text(raw.version, "version", 32);
  const description = text(raw.description, "description", 500, false);
  const main = raw.main === undefined ? "index.mjs" : text(raw.main, "main", 200);
  if (isAbsolute(main)) throw new Error("main must be a path inside the plugin folder");
  const module = resolve(folder, main);
  const inside = relative(resolve(folder), module);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("main must be a path inside the plugin folder");
  if (![".mjs", ".js"].includes(extname(module))) throw new Error("main must be a .mjs or .js module");
  if (!existsSync(module) || !statSync(module).isFile()) throw new Error(`main ${main} does not exist`);
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) throw new Error("tools must list at least one tool");
  if (raw.tools.length > MAX_TOOLS) throw new Error(`a plugin can have at most ${MAX_TOOLS} tools`);
  const seen = new Set<string>();
  const tools = raw.tools.map((value, index): PluginToolSpec => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tools[${index}] must be an object`);
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string" || !PLUGIN_TOOL.test(tool.name)) throw new Error(`tools[${index}].name must use a-z, 0-9 and _`);
    if (RESERVED_TOOLS.has(tool.name)) throw new Error(`tools[${index}].name "${tool.name}" is reserved`);
    if (seen.has(tool.name)) throw new Error(`tool ${tool.name} is listed twice`);
    seen.add(tool.name);
    const toolName = pluginToolName(id, tool.name);
    if (toolName.length > MCP_NAME_LIMIT) throw new Error(`tool ${tool.name}: ${toolName} is longer than ${MCP_NAME_LIMIT} characters`);
    const schema = tool.inputSchema ?? { type: "object", properties: {} };
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as Record<string, unknown>).type !== "object") {
      throw new Error(`tool ${tool.name}: inputSchema must be a JSON Schema with type "object"`);
    }
    if (tool.readOnly !== undefined && typeof tool.readOnly !== "boolean") throw new Error(`tool ${tool.name}: readOnly must be true or false`);
    const timeout = tool.timeoutSeconds ?? 120;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
      throw new Error(`tool ${tool.name}: timeoutSeconds must be a whole number from 1 to 600`);
    }
    return {
      name: tool.name, toolName,
      title: tool.title === undefined ? `${name}: ${tool.name.replaceAll("_", " ")}` : text(tool.title, `tool ${tool.name} title`, 80),
      description: text(tool.description, `tool ${tool.name} description`, 1000),
      inputSchema: schema as Record<string, unknown>,
      // A tool that does not say it only reads is treated as one that changes things.
      readOnly: tool.readOnly === true,
      timeoutSeconds: timeout,
    };
  });
  return { id, name, version, description, module, tools, manifestStat: `${stat.mtimeMs}-${stat.size}` };
}

/** Every folder in the plugins folder, in name order, with the reason it cannot load if it cannot. */
export function scanPlugins(directory: string, disabled: readonly string[] = []): { infos: PluginInfo[]; specs: PluginSpec[] } {
  const infos: PluginInfo[] = [];
  const specs: PluginSpec[] = [];
  if (!existsSync(directory)) return { infos, specs };
  const owners = new Map<string, string>();
  const folders = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort();
  for (const id of folders) {
    const folder = join(directory, id);
    const enabled = !disabled.includes(id);
    try {
      if (!PLUGIN_ID.test(id)) throw new Error("the folder name must use a-z, 0-9 and -, up to 32 characters");
      const { manifestStat, ...spec } = readManifest(folder, id);
      const info: PluginInfo = {
        id, folder, enabled, name: spec.name, version: spec.version, description: spec.description,
        tools: spec.tools.map(tool => ({ name: tool.name, toolName: tool.toolName, description: tool.description, readOnly: tool.readOnly })),
      };
      if (enabled) {
        const clash = spec.tools.find(tool => owners.has(tool.toolName));
        if (clash) throw Object.assign(new Error(`tool ${clash.toolName} is also provided by plugin ${owners.get(clash.toolName)}`), { info });
        for (const tool of spec.tools) owners.set(tool.toolName, id);
        const moduleStat = statSync(spec.module);
        specs.push({ ...spec, revision: `${manifestStat}-${moduleStat.mtimeMs}-${moduleStat.size}` });
      }
      infos.push(info);
    } catch (error) {
      const partial = (error as { info?: PluginInfo }).info;
      infos.push({ ...(partial ?? { id, folder }), id, folder, enabled, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { infos, specs };
}

const EXAMPLE_ID = "page-info";
const EXAMPLE_MANIFEST = {
  id: EXAMPLE_ID,
  name: "Page info",
  version: "1.0.0",
  description: "An example plugin: reads the title and headings of the open page, and its recent console errors.",
  main: "index.mjs",
  tools: [
    {
      name: "summary",
      description: "Return the open page's URL, title and h1-h3 headings, and the console errors recorded for it.",
      readOnly: true,
      inputSchema: { type: "object", properties: { maxHeadings: { type: "integer", minimum: 1, maximum: 100, default: 20 } } },
    },
  ],
};
const EXAMPLE_MODULE = `// Vela Browser plugin. setup runs once for each environment that uses this plugin, so
// anything kept here belongs to that environment alone.
export default function setup(vela) {
  return {
    // Each tool listed in vela-plugin.json is a function here, with the same name.
    async summary({ maxHeadings = 20 } = {}) {
      const page = vela.page();
      if (!page) return { error: "No page is open in this environment" };
      const headings = await page.locator("h1, h2, h3").allTextContents();
      const errors = await vela.devtools("console", { level: "error", limit: 20 });
      return {
        url: page.url(),
        title: await page.title(),
        headings: headings.map(text => text.trim()).filter(Boolean).slice(0, maxHeadings),
        consoleErrors: errors.records.map(record => record.text),
      };
    },
  };
}
`;

/** Puts the example plugin in the plugins folder unless a folder with its name is there. */
export function writeExamplePlugin(directory: string): string {
  const folder = join(directory, EXAMPLE_ID);
  mkdirSync(folder, { recursive: true });
  const manifest = join(folder, PLUGIN_MANIFEST), module = join(folder, "index.mjs");
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify(EXAMPLE_MANIFEST, null, 2)}\n`, "utf8");
  if (!existsSync(module)) writeFileSync(module, EXAMPLE_MODULE, "utf8");
  return EXAMPLE_ID;
}

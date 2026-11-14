// Runs plugin tools inside the process that already owns a browser's automation context.
// The plugin list comes from Vela Browser itself, which read and checked every manifest; this
// side only imports the accepted modules. A plugin receives that one environment's existing
// context and pages: it cannot reach another environment, and it cannot close or relaunch the
// browser, so the environment's isolation, proxy and fingerprint stay as Vela configured them.
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_TOOL_PREFIX = "plugin_";
export function isPluginTool(name) { return typeof name === "string" && name.startsWith(PLUGIN_TOOL_PREFIX); }

function validSpecs(specs) {
  if (!Array.isArray(specs)) return [];
  return specs.filter(spec => spec && typeof spec === "object" && typeof spec.id === "string" && typeof spec.module === "string"
    && isAbsolute(spec.module) && typeof spec.revision === "string" && Array.isArray(spec.tools));
}

/** MCP tool definitions for the enabled plugins. */
export function pluginTools(specs) {
  return validSpecs(specs).flatMap(spec => spec.tools.map(tool => ({
    name: tool.toolName,
    description: `[${spec.name} plugin] ${tool.description}`,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, readOnlyHint: tool.readOnly === true, destructiveHint: tool.readOnly !== true, openWorldHint: tool.readOnly !== true },
  })));
}

/** The context a plugin sees: everything Playwright offers except ending the browser's lifecycle. */
function guardedContext(context) {
  return new Proxy(context, {
    get(target, property) {
      if (property === "close") return async () => { throw new Error("Vela Browser owns this browser's lifecycle; plugins cannot close it"); };
      if (property === "browser") return () => null;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function asResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) return value;
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value : { value: value ?? null };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

function failure(spec, error) {
  return { isError: true, content: [{ type: "text", text: `${spec?.name ?? "Plugin"}: ${error instanceof Error ? error.message : String(error)}` }] };
}

export class PluginHost {
  /** @param {{ context: any, engine: string, profileId?: string, devtools?: any, log?: (message: string) => void }} options */
  constructor({ context, engine, profileId, devtools, log = () => {} }) {
    this.context = context;
    this.engine = engine;
    this.profileId = profileId;
    this.devtools = devtools;
    this.log = log;
    this.instances = new Map();
    this.closed = false;
  }

  /** One instance per plugin revision in this environment; a changed plugin loads fresh. */
  async instance(spec) {
    const key = `${spec.id}@${spec.revision}`;
    let pending = this.instances.get(key);
    if (!pending) {
      for (const [other, old] of this.instances) if (other.startsWith(`${spec.id}@`)) { this.instances.delete(other); void old.then(dispose, () => {}); }
      pending = (async () => {
        // The query gives each environment and revision its own module instance under Node.
        const url = `${pathToFileURL(spec.module).href}?profile=${encodeURIComponent(this.profileId ?? "")}&revision=${encodeURIComponent(spec.revision)}`;
        const module = await import(url);
        if (typeof module.default !== "function") throw new Error("the module must export a default setup(vela) function");
        const tools = await module.default(this.api(spec));
        if (!tools || typeof tools !== "object") throw new Error("setup(vela) must return an object of tool functions");
        return tools;
      })();
      this.instances.set(key, pending);
      pending.catch(() => { if (this.instances.get(key) === pending) this.instances.delete(key); });
    }
    return pending;
  }

  api(spec) {
    const context = guardedContext(this.context);
    const open = () => this.context.pages().filter(page => !page.isClosed?.());
    return Object.freeze({
      plugin: Object.freeze({ id: spec.id, name: spec.name, version: spec.version }),
      profileId: this.profileId,
      engine: this.engine,
      context,
      /** The open pages of this environment, oldest first. */
      pages: open,
      /** The page this environment shows, or null when none is open. */
      page: () => open().at(-1) ?? null,
      /** Calls a built-in developer tool of this environment, by its short or full name. */
      devtools: async (tool, args = {}) => {
        if (!this.devtools) throw new Error("developer tools are unavailable in this environment");
        const raw = String(tool ?? "");
        const name = raw.startsWith("browser_devtools_") ? raw : `browser_devtools_${raw}`;
        return (await this.devtools.call(name, args)).structuredContent;
      },
      log: (...values) => this.log(`[plugin ${spec.id}] ${values.map((value) => {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value); } catch { return String(value); }
      }).join(" ")}`),
    });
  }

  async call(specs, name, args = {}) {
    if (this.closed) return failure(undefined, new Error("this environment's plugin session has closed"));
    let spec, tool;
    for (const candidate of validSpecs(specs)) {
      tool = candidate.tools.find(item => item.toolName === name);
      if (tool) { spec = candidate; break; }
    }
    if (!spec) return failure(undefined, new Error(`${name} is not an enabled plugin tool`));
    try {
      const tools = await this.instance(spec);
      const handler = tools[tool.name];
      if (typeof handler !== "function") throw new Error(`setup(vela) returned no function named ${tool.name}`);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tool.name} did not finish within ${tool.timeoutSeconds} seconds`)), tool.timeoutSeconds * 1000);
      });
      try { return asResult(await Promise.race([Promise.resolve().then(() => handler.call(tools, args ?? {})), timeout])); }
      finally { clearTimeout(timer); }
    } catch (error) {
      return failure(spec, error);
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.instances.values()) void pending.then(dispose, () => {});
    this.instances.clear();
  }
}

function dispose(tools) {
  try { void Promise.resolve(tools?.dispose?.()).catch(() => {}); } catch {}
}

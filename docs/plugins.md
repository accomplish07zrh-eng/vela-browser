# Plugins

A plugin adds tools that an AI connected to Vela Browser over MCP can call. It works in the environment the AI has selected, or the one named by `profileId`. It uses that environment's existing context: its sign-ins, proxy, fingerprint and isolation stay exactly as Vela configured them. Plugins work in Chromium, Firefox and WebKit.

Plugins are code that runs on this computer with the same trust as a script, so install only ones you trust. They are available in the local desktop app only.

## Where plugins live

Each plugin is one folder in the `plugins` folder of Vela Browser's data folder. **Settings → Advanced → Plugins** shows that folder, lists every plugin with its tools, and switches each one on or off. **Add the example plugin** puts a working example in place.

```
plugins/
  page-info/
    vela-plugin.json
    index.mjs
```

The folder name is the plugin id. It uses `a-z`, `0-9` and `-`, up to 32 characters.

## vela-plugin.json

```json
{
  "id": "page-info",
  "name": "Page info",
  "version": "1.0.0",
  "description": "Reads the title and headings of the open page.",
  "main": "index.mjs",
  "tools": [
    {
      "name": "summary",
      "description": "Return the open page's URL, title and headings.",
      "readOnly": true,
      "timeoutSeconds": 60,
      "inputSchema": { "type": "object", "properties": { "maxHeadings": { "type": "integer" } } }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Must equal the folder name. |
| `name`, `version` | Shown in Settings and in each tool's description. |
| `main` | The module, inside the folder. `.mjs` or `.js`; defaults to `index.mjs`. |
| `tools[].name` | `a-z`, `0-9` and `_`. The AI sees `plugin_<id>_<name>`, with `-` in the id written as `_`. The name `dispose` is reserved. |
| `tools[].readOnly` | `true` only for a tool that changes nothing. Every other tool is marked as one that changes things, so an AI client can ask before calling it. |
| `tools[].timeoutSeconds` | 1 to 600; defaults to 120. A call that runs longer returns an error. |
| `tools[].inputSchema` | A JSON Schema with `"type": "object"`. |

A plugin that cannot be read is listed in Settings with the reason and is never loaded. If two plugins would offer the same tool name, the second is held back.

## The module

The module's default export is `setup(vela)`. It runs once for each environment that uses the plugin and returns an object with one function per tool:

```js
export default function setup(vela) {
  return {
    async summary({ maxHeadings = 20 } = {}) {
      const page = vela.page();
      if (!page) return { error: "No page is open" };
      const headings = await page.locator("h1, h2, h3").allTextContents();
      const errors = await vela.devtools("console", { level: "error" });
      return { url: page.url(), title: await page.title(), headings: headings.slice(0, maxHeadings), errors: errors.records.length };
    },
    // Optional: called when the environment detaches or the plugin changes.
    dispose() {},
  };
}
```

`vela` offers:

| Member | What it is |
| --- | --- |
| `vela.page()` | The environment's most recently opened page, or `null`. |
| `vela.pages()` | Its open pages, oldest first. |
| `vela.context` | The environment's Playwright `BrowserContext`. `close()` is refused and `browser()` returns `null`: Vela Browser owns the browser's lifecycle. |
| `vela.devtools(tool, args)` | Calls a built-in developer tool of this environment, such as `"console"`, `"network"` or `"storage"`, and returns its result. |
| `vela.profileId`, `vela.engine` | The environment and its engine: `chromium`, `firefox` or `webkit`. |
| `vela.plugin` | This plugin's `id`, `name` and `version`. |
| `vela.log(...)` | Writes to the MCP host's diagnostics. |

A tool returns any JSON value. A returned object becomes the tool's structured result. A tool that needs full control can return MCP content itself (`{ content: [...] }`). A thrown error becomes a tool error that names the plugin.

State kept inside `setup` belongs to that environment alone. Each environment also loads its own copy of the module, so module-level state does not cross environments in the packaged app either.

## When changes take effect

Vela Browser reads the plugins folder each time an AI selects or opens a browser. Adding, editing or switching off a plugin reaches the AI the next time it selects a browser. An edited module is loaded fresh, and the previous instance's `dispose` runs.

## Scripts

JavaScript scripts receive `devtools` next to `page` and `context`. `await devtools.call("console", { level: "error" })` reads what the browser logged since the script started. Any other developer tool can be called the same way.

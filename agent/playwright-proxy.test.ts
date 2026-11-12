import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PlaywrightToolProxy } from "./playwright-proxy.mjs";
import { DEVTOOLS_TOOLS } from "./devtools.mjs";

test("Playwright proxy exposes stable annotated actions without a browser", async () => {
  let browserClosed = false;
  const context = Object.assign(new EventEmitter(), { pages: () => [] });
  const proxy = new PlaywrightToolProxy("1", async () => ({
    contexts: () => [context],
    close: async () => { browserClosed = true; },
  }) as any);
  await proxy.initialize();
  const tools = structuredClone(proxy.listTools());
  const names = new Set(tools.map((tool) => tool.name));

  for (const name of [
    "browser_run_code",
    "browser_file_upload",
    "browser_tabs",
    "browser_evaluate",
    "browser_press_key",
    "browser_click",
    "browser_start_tracing",
    "browser_stop_tracing",
  ]) {
    expect(names.has(name)).toBe(true);
  }
  expect(names.has("browser_close")).toBe(false);
  expect(names.has("browser_install")).toBe(false);
  for (const tool of DEVTOOLS_TOOLS) expect(names.has(tool.name)).toBe(true);
  for (const tool of tools) {
    expect(typeof tool.annotations?.title).toBe("string");
    expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
    expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
    expect(typeof tool.annotations?.openWorldHint).toBe("boolean");
  }

  await proxy.attach("ws://127.0.0.1:9333/devtools/browser/test");
  expect(proxy.listTools()).toEqual(tools);

  await proxy.detach();
  expect(proxy.listTools()).toEqual(tools);
  expect(browserClosed).toBe(true);
  expect(context.eventNames()).toEqual([]);
});

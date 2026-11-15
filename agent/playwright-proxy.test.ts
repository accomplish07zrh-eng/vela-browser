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

test("browser_resize resizes the window and never pins the page to a fixed viewport", async () => {
  const sent: Array<[string, unknown]> = [];
  let layout = { clientWidth: 1378, clientHeight: 802 };
  let bounds = { left: 0, top: 0, width: 1400, height: 900, windowState: "normal" };
  const cdp = {
    send: async (method: string, params?: any) => {
      sent.push([method, params]);
      if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds };
      if (method === "Browser.getWindowBounds") return { bounds };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: layout };
      if (method === "Browser.setWindowBounds" && params.bounds.width) {
        bounds = { ...bounds, ...params.bounds };
        layout = { clientWidth: params.bounds.width - 22, clientHeight: params.bounds.height - 98 };
      }
      return {};
    },
    detach: async () => {},
  };
  const page = { setViewportSize: () => { throw new Error("must not pin the viewport"); } };
  // The tab shows up after attaching, so the devtools recorder does not watch the stand-in page.
  let open: unknown[] = [];
  const context = Object.assign(new EventEmitter(), { pages: () => open, newCDPSession: async () => cdp });
  const proxy = new PlaywrightToolProxy("1", async () => ({ contexts: () => [context], close: async () => {} }) as any);
  await proxy.attach("ws://127.0.0.1:9333/devtools/browser/test");
  open = [page];
  expect(proxy.listTools().find((tool: any) => tool.name === "browser_resize")?.description).toContain("never given a fixed viewport");

  const result = await proxy.callTool("browser_resize", { width: 1000, height: 700 });
  expect(result.content[0].text).toContain("1000x700");
  expect(sent).toContainEqual(["Browser.setWindowBounds", { windowId: 7, bounds: { width: 1022, height: 798 } }]);
  expect(sent.some(([method]) => method === "Emulation.setDeviceMetricsOverride")).toBe(false);

  await expect(proxy.callTool("browser_run_code", { code: "async (page) => page.setViewportSize({ width: 600, height: 400 })" })).rejects.toThrow("fixed viewport");
  // A page already pinned smaller than its window is reported, not "fixed" with a huge window.
  layout = { clientWidth: 600, clientHeight: 400 };
  await expect(proxy.callTool("browser_resize", { width: 1000, height: 700 })).rejects.toThrow("reopen the browser");
  await proxy.detach();
});

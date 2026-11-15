import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PlaywrightToolProxy, guardViewports } from "./playwright-proxy.mjs";
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

  await proxy.detach();
});

test("the viewport guard turns pinning into window resizes and refuses pinning CDP calls", async () => {
  const sent: string[] = [];
  let bounds = { width: 1400, height: 900, windowState: "normal" };
  const rawSession = () => ({
    send: async (method: string, params?: any) => {
      sent.push(method);
      if (method === "Browser.getWindowForTarget") return { windowId: 1, bounds };
      if (method === "Browser.getWindowBounds") return { bounds };
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: bounds.width - 22, clientHeight: bounds.height - 98 } };
      if (method === "Browser.setWindowBounds" && params.bounds.width) bounds = { ...bounds, ...params.bounds };
      return {};
    },
    detach: async () => {},
  });
  const page: any = { setViewportSize: () => { throw new Error("must not pin the viewport"); } };
  const context: any = Object.assign(new EventEmitter(), { pages: () => [page], newCDPSession: async () => rawSession() });
  const browser: any = { newBrowserCDPSession: async () => rawSession() };
  const guard = guardViewports(context, browser);

  await page.setViewportSize({ width: 600, height: 400 });
  expect(bounds).toMatchObject({ width: 622, height: 498 });

  const { sessions } = await guard.capture(async () => {
    const pageSession = await context.newCDPSession(page);
    await expect(pageSession.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 400 })).rejects.toThrow("fixed viewport");
    const browserSession = await browser.newBrowserCDPSession();
    const wrapped = JSON.stringify({ id: 1, method: "Emulation.setDeviceMetricsOverride", params: { width: 600, height: 400 } });
    await expect(browserSession.send("Target.sendMessageToTarget", { sessionId: "s", message: wrapped })).rejects.toThrow("fixed viewport");
    await browserSession.send("Target.getTargets");
  });
  expect(sessions.size).toBe(2);
  expect(sent).not.toContain("Emulation.setDeviceMetricsOverride");
  expect(sent).not.toContain("Target.sendMessageToTarget");
  guard.dispose();
});

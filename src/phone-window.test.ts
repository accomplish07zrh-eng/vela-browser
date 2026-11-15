import { describe, expect, test } from "bun:test";
import { PhoneWindows, phoneBounds, withBrowserCdp } from "./phone-window.ts";

describe("phone mode windows", () => {
  test("a phone-shaped window stays inside the claimed screen", () => {
    const area = { left: 0, top: 0, width: 1536, height: 824 };
    expect(phoneBounds({ left: 100, top: 50, width: 1200, height: 800 }, area)).toEqual({ left: 100, top: 0, width: 440, height: 824 });
    expect(phoneBounds({ left: 1400, top: 10 }, area)).toEqual({ left: 1096, top: 0, width: 440, height: 824 });
    expect(phoneBounds({}, { left: 0, top: 0, width: 400, height: 2000 })).toEqual({ left: 0, top: 0, width: 400, height: 900 });
  });

  test("narrows the real window only, and gives back its old size and maximized state", async () => {
    const calls: Array<[string, any]> = [];
    const bounds: Record<number, any> = { 7: { left: -8, top: -8, width: 1552, height: 840, windowState: "maximized" } };
    const fake = (async (_ws: string, run: any) => run(async (method: string, params: any = {}) => {
      calls.push([method, params]);
      if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "a", url: "https://example.com" }, { type: "page", targetId: "b", url: "chrome://omnibox-popup.top-chrome/" }] };
      if (method === "Browser.getWindowForTarget") return { windowId: 7 };
      if (method === "Browser.getWindowBounds") return { bounds: bounds[params.windowId] };
      return {};
    })) as unknown as typeof withBrowserCdp;
    const windows = new PhoneWindows(fake);
    await windows.enter("p1", "ws://x", { left: 0, top: 0, width: 1536, height: 824 });
    expect(windows.isOn("p1")).toBe(true);
    const sets = calls.filter(([method]) => method === "Browser.setWindowBounds").map(([, params]) => params.bounds);
    expect(sets).toEqual([{ windowState: "normal" }, { left: 0, top: 0, width: 440, height: 824, windowState: "normal" }]);
    // Nothing that pins the viewport or changes what the page is told.
    expect(calls.some(([method]) => /Emulation|setDeviceMetrics|setUserAgent/.test(method))).toBe(false);
    // The browser's own popup windows are left alone.
    expect(calls.filter(([method]) => method === "Browser.getWindowForTarget").map(([, params]) => params.targetId)).toEqual(["a"]);

    calls.length = 0;
    await windows.leave("p1", "ws://x");
    expect(windows.isOn("p1")).toBe(false);
    expect(calls.map(([, params]) => params.bounds)).toEqual([{ left: -8, top: -8, width: 1552, height: 840, windowState: "normal" }, { windowState: "maximized" }]);
    // Leaving twice does nothing more.
    calls.length = 0;
    await windows.leave("p1", "ws://x");
    expect(calls).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { createServer, type RequestListener } from "node:http";
import { callWebKitOwner, forgetWebKitOwner, webkitEndpoint, webkitOwnerReady, type WebKitOwner } from "./webkit-runtime.ts";
import { firefoxOwnerForEndpoint } from "./firefox-runtime.ts";
import { runPlaywrightWorker } from "./playwright-runtime.ts";
import { webkitLaunchOptions } from "./webkit-worker.mjs";

async function ownerServer(handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no listener");
  const owner: WebKitOwner = { endpoint: `http://127.0.0.1:${address.port}/`, token: "private-token", generation: "new-generation", pid: 101, browserPid: 102 };
  return { owner, close: async () => { forgetWebKitOwner(owner); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}

test("WebKit opaque routes authenticate the correct owner and generation independently from Firefox", async () => {
  let authorization = "", request: any;
  const fixture = await ownerServer(async (incoming, response) => {
    authorization = incoming.headers.authorization ?? "";
    request = JSON.parse(await new Response(incoming as any).text());
    response.end(JSON.stringify({ version: 1, ok: true, result: { injected: true } }));
  });
  try {
    const endpoint = webkitEndpoint(fixture.owner);
    expect(endpoint).not.toContain(fixture.owner.token);
    expect(firefoxOwnerForEndpoint(endpoint)).toBeUndefined();
    await expect(runPlaywrightWorker("ensure-cookies", { endpoint, cookies: [], ownerGeneration: "stale" })).resolves.toEqual({ injected: true });
    expect(authorization).toBe(`Bearer ${fixture.owner.token}`);
    expect(request.payload.ownerGeneration).toBe("new-generation");
    forgetWebKitOwner(fixture.owner);
    await expect(runPlaywrightWorker("ensure-cookies", { endpoint, cookies: [] })).rejects.toMatchObject({ code: "runtime_unavailable" });
  } finally { await fixture.close(); }
});

test("WebKit rejects non-loopback routes, redirects, invalid readiness and stale RPC responses", async () => {
  const fixture = await ownerServer((_incoming, response) => {
    response.writeHead(400); response.end(JSON.stringify({ version: 1, ok: false, error: { code: "runtime_unavailable", message: "stale generation" } }));
  });
  try {
    for (const endpoint of ["https://127.0.0.1:41001/", "http://example.com:41001/", "http://127.0.0.1:41001/?secret=x", "http://private@127.0.0.1:41001/"]) {
      await expect(callWebKitOwner({ ...fixture.owner, endpoint }, "status", {})).rejects.toMatchObject({ name: "WebKitOwnerError", code: "invalid_request" });
    }
    await expect(callWebKitOwner(fixture.owner, "status", {})).rejects.toMatchObject({ name: "WebKitOwnerError", code: "runtime_unavailable" });
    expect(() => webkitOwnerReady({ version: 1, ok: true, result: { ...fixture.owner, browserPid: 0 } })).toThrow();
  } finally { await fixture.close(); }
  const redirect = await ownerServer((_incoming, response) => { response.writeHead(302, { location: "http://127.0.0.1:41001/" }); response.end(); });
  try { await expect(callWebKitOwner(redirect.owner, "status", {})).rejects.toMatchObject({ code: "runtime_unavailable" }); }
  finally { await redirect.close(); }
});

test("WebKit status honors bounded caller timeouts", async () => {
  const fixture = await ownerServer(() => {});
  try { await expect(callWebKitOwner(fixture.owner, "status", {}, { timeoutMs: 5 })).rejects.toMatchObject({ name: "WebKitOwnerError", code: "timeout" }); }
  finally { await fixture.close(); }
});

test("WebKit passes native identity and proxy options without Chromium or injected spoof settings", () => {
  const config = { viewport: { width: 1200, height: 750 }, screen: { width: 1920, height: 1080 }, deviceScaleFactor: 1.25, locale: "zh-TW", timezoneId: "Asia/Taipei", userAgent: "saved-agent" };
  const options = webkitLaunchOptions({ config, executablePath: "Playwright.exe", headless: false, proxy: { server: "http://127.0.0.1:45001" } });
  expect(options).toMatchObject({ ...config, executablePath: "Playwright.exe", headless: false, proxy: { server: "http://127.0.0.1:45001" }, colorScheme: null });
  expect(options).not.toHaveProperty("args"); expect(options).not.toHaveProperty("firefoxUserPrefs");
});

/** Verify isolation, close/reopen and session continuity on a disposable desktop fixture. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { AGENT_PATH, AGENT_PROTOCOL, AgentRuntimeClient } from "../agent/runtime-client.mjs";
import { openCdp } from "../agent/chromium-fingerprint.mjs";

const [descriptorFile, phase, engine, first, second, originArg] = process.argv.slice(2);
if (!descriptorFile || !["seed", "verify"].includes(phase) || !["firefox", "chromium"].includes(engine) || !first || !second || first === second) {
  throw new Error("Expected a fixture runtime descriptor, seed or verify, browser engine, and two disposable profile IDs");
}
if (engine === "firefox" && !originArg) throw new Error("Firefox session acceptance needs the same loopback fixture origin before and after the update");
const { port, nonce } = JSON.parse(await readFile(descriptorFile, "utf8"));
assert.ok(Number.isSafeInteger(port) && port > 0 && /^[a-f0-9]{64}$/.test(nonce));
const fixture = new URL(originArg ?? `http://127.0.0.1:${port}/`);
assert.ok(fixture.hostname === "127.0.0.1" && fixture.protocol === "http:" && !fixture.username && !fixture.password);
const socket = new WebSocket(`ws://127.0.0.1:${port}${AGENT_PATH}`, AGENT_PROTOCOL, { headers: { authorization: "Bearer " + nonce }, handshakeTimeout: 5000 });
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
const agent = new AgentRuntimeClient(socket);
const name = "vela_release_fixture";
const value = (id) => "profile-" + id;
const inspect = async (id, ws, seed) => {
  if (engine === "firefox") {
    const call = (name, args) => agent.call("firefox.tools.call", { profileId: id, name, arguments: args });
    const pageState = await call("browser_devtools_pages", {});
    const listings = pageState.structuredContent ?? JSON.parse(pageState.content[0].text);
    const pageId = listings.pages[0]?.pageId;
    assert.ok(pageId, "The Firefox fixture has a page");
    const response = await call("browser_devtools_program", { pageId, argument: { url: fixture.href, name, expected: value(id), seed },
      code: `async ({ page, argument }) => {
        await page.goto(argument.url);
        if (argument.seed) await page.evaluate(({name,expected}) => {
          document.cookie = name + "=" + expected + "; Path=/; Max-Age=7200";
          localStorage.setItem(name, expected);
        }, argument);
        return await page.evaluate(name => ({
          cookie: document.cookie.split("; ").find(c => c.startsWith(name + "=")),
          stored: localStorage.getItem(name),
        }), argument.name);
      }`,
    });
    const result = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(result.completed, true, "The release fixture browser program completed");
    assert.deepEqual(result.value, { cookie: name + "=" + value(id), stored: value(id) });
    return;
  }
  const cdp = await openCdp(ws, 8000);
  try {
    if (seed) await cdp.send("Storage.setCookies", { cookies: [{ name, value: value(id), url: fixture.origin, expires: Date.now() / 1000 + 7200 }] });
    const { cookies } = await cdp.send("Storage.getCookies");
    assert.deepEqual(cookies.filter(cookie => cookie.name === name).map(cookie => cookie.value), [value(id)]);
  } finally { cdp.close(); }
};
const ids = [first, second];
try {
  await agent.call("session.identify", { name: "vela-release-session-" + randomUUID().slice(0, 8) });
  const rounds = phase === "seed" ? [true, false] : [false];
  for (const seed of rounds) {
    for (const id of ids) {
      const opened = await agent.call("browser.open", { profileId: id, headless: true });
      try {
        if (engine === "chromium") {
          const endpoint = new URL(opened.ws);
          assert.equal(endpoint.protocol, "ws:");
          assert.equal(endpoint.hostname, "127.0.0.1");
        }
        await inspect(id, opened.ws, seed);
      }
      finally {
        await agent.call("browser.close", { profileId: id });
        assert.equal((await agent.call("browser.status", { profileId: id })).running, false);
      }
    }
  }
  console.log(JSON.stringify({ phase, engine, profiles: ids.length, isolatedSessions: true, reopened: true }));
} finally { agent.close(); }

import { expect, test } from "bun:test";
import { ProxyApprovalQueue } from "./proxy-approvals.ts";

const ask = { profileId: "p1", profileName: "Shop", client: "Claude", from: "http · A", to: "anytls · SG", reopens: true };

test("a request waits for a person's answer", async () => {
  const queue = new ProxyApprovalQueue();
  const approved = queue.request(ask);
  const [pending] = queue.list();
  expect(pending).toMatchObject({ ...ask });
  expect(queue.answer(pending!.id, true)).toBe(true);
  expect(await approved).toBe("approved");
  expect(queue.list()).toEqual([]);
  // An answered request is no longer waiting.
  expect(queue.answer(pending!.id, false)).toBe(false);
  const denied = queue.request(ask);
  queue.answer(queue.list()[0]!.id, false);
  expect(await denied).toBe("denied");
});

test("no answer in time is a refusal, and a newer request for the same profile replaces an older one", async () => {
  const queue = new ProxyApprovalQueue();
  expect(await queue.request(ask, 30)).toBe("timeout");
  const first = queue.request(ask);
  const second = queue.request({ ...ask, to: "vless · JP" });
  expect(await first).toBe("denied");
  expect(queue.list().map((entry) => entry.to)).toEqual(["vless · JP"]);
  queue.answer(queue.list()[0]!.id, true);
  expect(await second).toBe("approved");
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "./app-config.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

test("the dashboard lists waiting AI proxy changes, answers them, and keeps the standing choice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-approvals-"));
  const store = new ProfileStore(":memory:");
  const queue = new ProxyApprovalQueue();
  const appConfig = new AppConfigStore(join(dir, "config.json"));
  const call = (path: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    handleUiRequest(new Request(`http://localhost${path}`, body === undefined ? { method: "GET" } : { method: "POST", headers, body: JSON.stringify(body) }),
      {} as never, store, null, { proxyApprovals: queue, appConfig }).then((r) => r!);
  try {
    const waiting = queue.request(ask);
    const listed = await (await call("/ui/api/proxy-approvals")).json();
    expect(listed).toMatchObject({ ok: true, policy: "ask", pending: [{ profileId: "p1", client: "Claude", to: "anytls · SG" }] });
    expect((await call("/ui/api/proxy-approvals/answer", { id: listed.pending[0].id, approve: true }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await call("/ui/api/proxy-approvals/answer", { id: listed.pending[0].id, approve: true })).status).toBe(200);
    expect(await waiting).toBe("approved");
    expect((await call("/ui/api/proxy-approvals/answer", { id: listed.pending[0].id, approve: true })).status).toBe(409);

    expect(await (await call("/ui/api/proxy-approvals/policy", { policy: "allow_pool" })).json()).toEqual({ ok: true, policy: "allow_pool" });
    expect(appConfig.read().aiProxyChanges).toBe("allow_pool");
    expect((await (await call("/ui/api/proxy-approvals")).json()).policy).toBe("allow_pool");
    await call("/ui/api/proxy-approvals/policy", { policy: "ask" });
    expect(appConfig.read().aiProxyChanges).toBeUndefined();
    expect((await call("/ui/api/proxy-approvals/policy", { policy: "always" })).status).toBe(400);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

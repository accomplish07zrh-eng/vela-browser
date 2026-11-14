import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore } from "./app-config.ts";
import { CodeApprovalQueue } from "./code-approvals.ts";
import { ProfileStore } from "./store.ts";
import { handleUiRequest } from "./ui.ts";

const sampleScript = {
  kind: "script" as const,
  action: "create" as const,
  title: "check-title",
  client: "Claude",
  detail: "javascript",
  files: [{ name: "check-title.mjs", content: "export default async () => {};" }],
};

test("a code approval waits for an answer and records approved or denied", async () => {
  const queue = new CodeApprovalQueue();
  const approved = queue.request(sampleScript);
  const [pending] = queue.list();
  expect(pending).toMatchObject(sampleScript);
  expect(queue.answer(pending!.id, true)).toBe(true);
  expect(await approved).toBe("approved");
  expect(queue.list()).toEqual([]);
  expect(queue.answer(pending!.id, false)).toBe(false);

  const denied = queue.request(sampleScript);
  queue.answer(queue.list()[0]!.id, false);
  expect(await denied).toBe("denied");
});

test("code approval times out without an answer, and a newer request for the same item replaces the old one", async () => {
  const queue = new CodeApprovalQueue();
  expect(await queue.request(sampleScript, 30)).toBe("timeout");
  expect(queue.list()).toEqual([]);

  const first = queue.request(sampleScript);
  const second = queue.request({ ...sampleScript, files: [{ name: "check-title.mjs", content: "// v2" }] });
  expect(await first).toBe("denied");
  expect(queue.list()).toHaveLength(1);
  expect(queue.list()[0]!.files[0]!.content).toBe("// v2");
  queue.answer(queue.list()[0]!.id, true);
  expect(await second).toBe("approved");
});

test("the dashboard lists waiting AI code changes, answers them, and persists the policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-code-approvals-"));
  const store = new ProfileStore(":memory:");
  const queue = new CodeApprovalQueue();
  const appConfig = new AppConfigStore(join(dir, "config.json"));
  const call = (path: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    handleUiRequest(
      new Request(`http://localhost${path}`, body === undefined ? { method: "GET" } : { method: "POST", headers, body: JSON.stringify(body) }),
      {} as never,
      store,
      null,
      { codeApprovals: queue, appConfig },
    ).then((r) => r!);
  try {
    const waiting = queue.request(sampleScript);
    const listed = await (await call("/ui/api/code-approvals")).json();
    expect(listed).toMatchObject({ ok: true, policy: "ask", pending: [{ kind: "script", title: "check-title", client: "Claude" }] });
    expect((await call("/ui/api/code-approvals/answer", { id: listed.pending[0].id, approve: true }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await call("/ui/api/code-approvals/answer", { id: listed.pending[0].id, approve: true })).status).toBe(200);
    expect(await waiting).toBe("approved");
    expect((await call("/ui/api/code-approvals/answer", { id: listed.pending[0].id, approve: true })).status).toBe(409);

    expect(await (await call("/ui/api/code-approvals/policy", { policy: "allow" })).json()).toEqual({ ok: true, policy: "allow" });
    expect(appConfig.read().aiCodeChanges).toBe("allow");
    expect((await (await call("/ui/api/code-approvals")).json()).policy).toBe("allow");
    expect(await (await call("/ui/api/code-approvals/policy", { policy: "deny" })).json()).toEqual({ ok: true, policy: "deny" });
    expect(appConfig.read().aiCodeChanges).toBe("deny");
    await call("/ui/api/code-approvals/policy", { policy: "ask" });
    expect(appConfig.read().aiCodeChanges).toBeUndefined();
    expect((await call("/ui/api/code-approvals/policy", { policy: "always" })).status).toBe(400);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

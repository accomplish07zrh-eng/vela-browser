import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCountdown, ApprovalHttpError, requestApprovalJson } from "./approval-queue.tsx";
import { CodeApprovalPrompts, fetchCodeApprovals, setCodePolicy } from "./code-approvals.tsx";
import { I18nProvider } from "./i18n.tsx";

test("requestApprovalJson preserves HTTP status and handles code-approval endpoints", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/ui/api/code-approvals") {
      return new Response(JSON.stringify({ ok: true, policy: "allow", pending: [] }), { status: 200 });
    }
    if (url === "/ui/api/code-approvals/policy" && init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true, policy: "deny" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "This request is no longer waiting" }), { status: 409 });
  }) as unknown as typeof fetch;

  try {
    expect(await fetchCodeApprovals()).toEqual({ ok: true, policy: "allow", pending: [] } as any);
    expect(await setCodePolicy("deny")).toEqual({ ok: true, policy: "deny" } as any);
    let caught: unknown;
    try {
      await requestApprovalJson("/ui/api/code-approvals/answer", { id: "missing", approve: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApprovalHttpError);
    expect((caught as ApprovalHttpError).status).toBe(409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CodeApprovalPrompts returns empty markup without pending items and ApprovalCountdown renders remaining seconds", () => {
  expect(renderToStaticMarkup(<I18nProvider><CodeApprovalPrompts /></I18nProvider>)).toBe("");
  const countdownHtml = renderToStaticMarkup(
    <I18nProvider><ApprovalCountdown expiresAt={Date.now() + 12_500} /></I18nProvider>,
  );
  expect(countdownHtml).toMatch(/Refused automatically in 1[23] s\./);
});

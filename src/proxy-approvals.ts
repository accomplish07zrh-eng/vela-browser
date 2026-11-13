/**
 * Approval for proxy changes an AI asks for (design §6.2). A change of exit is outward-facing and
 * shows the account's sites an IP jump, so by default a person approves each one on the
 * dashboard. Unanswered requests are refused after a while; nothing waits forever.
 */

import { randomUUID } from "node:crypto";

/** "ask": every AI change waits for a person. "allow_pool": pool nodes go through. "deny": none. */
export type AiProxyPolicy = "ask" | "allow_pool" | "deny";
export const AI_PROXY_POLICIES: readonly AiProxyPolicy[] = ["ask", "allow_pool", "deny"];

export interface ProxyApprovalRequest {
  profileId: string;
  profileName: string;
  /** The AI client, as it named itself to the MCP server. */
  client: string;
  from: string;
  to: string;
  /** The open browser will reopen on the new exit. */
  reopens: boolean;
}

export interface PendingApproval extends ProxyApprovalRequest {
  id: string;
  requestedAt: number;
  expiresAt: number;
}

export type ApprovalOutcome = "approved" | "denied" | "timeout";

export class ProxyApprovalQueue {
  private pending = new Map<string, PendingApproval & { settle: (outcome: ApprovalOutcome) => void }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Wait for a person's answer; `timeoutMs` without one is a refusal. */
  request(request: ProxyApprovalRequest, timeoutMs = 60_000): Promise<ApprovalOutcome> {
    // One open question per profile: a newer request replaces an unanswered one, which is refused.
    for (const entry of this.pending.values()) if (entry.profileId === request.profileId) entry.settle("denied");
    return new Promise((resolve) => {
      const id = randomUUID();
      const requestedAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        resolve(outcome);
      };
      this.pending.set(id, { ...request, id, requestedAt, expiresAt: requestedAt + timeoutMs, settle });
      timer = setTimeout(() => settle("timeout"), timeoutMs);
    });
  }

  /** The questions waiting for an answer, oldest first. */
  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ settle: _settle, ...entry }) => entry).sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Answer one. False when it is no longer waiting (answered, replaced or expired). */
  answer(id: string, approve: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(approve ? "approved" : "denied");
    return true;
  }
}

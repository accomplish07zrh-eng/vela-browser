/**
 * Approval for proxy changes an AI asks for (design §6.2). A change of exit is outward-facing and
 * shows the account's sites an IP jump, so by default a person approves each one on the
 * dashboard. Unanswered requests are refused after a while; nothing waits forever.
 */

import { ApprovalQueue, type ApprovalOutcome } from "./approval-queue.ts";

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

export type { ApprovalOutcome };

export class ProxyApprovalQueue {
  private readonly queue: ApprovalQueue<ProxyApprovalRequest>;

  constructor(now: () => number = Date.now) {
    this.queue = new ApprovalQueue(60_000, (request) => request.profileId, now);
  }

  /** Wait for a person's answer; `timeoutMs` without one is a refusal. Aborted on disconnect. */
  request(request: ProxyApprovalRequest, timeoutMs = 60_000, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return this.queue.request(request, timeoutMs, signal);
  }

  /** The questions waiting for an answer, oldest first. */
  list(): PendingApproval[] {
    return this.queue.list();
  }

  /** Answer one. False when it is no longer waiting (answered, replaced, aborted, or expired). */
  answer(id: string, approve: boolean): boolean {
    return this.queue.answer(id, approve);
  }
}

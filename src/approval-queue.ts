/**
 * Shared pending-approval queue with per-target replacement, deadline timeout, and optional
 * AbortSignal cancellation when an AI session disconnects before a human answers.
 */

import { randomUUID } from "node:crypto";

export type ApprovalOutcome = "approved" | "denied" | "timeout" | "aborted";

export interface PendingApprovalBase {
  id: string;
  requestedAt: number;
  expiresAt: number;
}

interface Entry<TRequest extends object> {
  item: TRequest & PendingApprovalBase;
  key: string;
  settle: (outcome: ApprovalOutcome) => void;
}

export class ApprovalQueue<TRequest extends object> {
  private pending = new Map<string, Entry<TRequest>>();

  constructor(
    private readonly defaultTimeoutMs: number,
    private readonly keyOf: (request: TRequest) => string,
    private readonly now: () => number = Date.now,
  ) {}

  request(request: TRequest, timeoutMs = this.defaultTimeoutMs, signal?: AbortSignal): Promise<ApprovalOutcome> {
    if (signal?.aborted) return Promise.resolve("aborted");
    const key = this.keyOf(request);
    // One open question per target: a newer request replaces the older unanswered one.
    for (const entry of [...this.pending.values()]) {
      if (entry.key === key) entry.settle("denied");
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const requestedAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle("aborted");
      const settle = (outcome: ApprovalOutcome) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      this.pending.set(id, {
        item: { ...request, id, requestedAt, expiresAt: requestedAt + timeoutMs },
        key,
        settle,
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle("timeout"), timeoutMs);
    });
  }

  /** Pending questions in creation order, oldest first. */
  list(): (TRequest & PendingApprovalBase)[] {
    return [...this.pending.values()].map((entry) => entry.item).sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** Answer one question. False when it is no longer waiting (answered, replaced, aborted, or expired). */
  answer(id: string, approve: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(approve ? "approved" : "denied");
    return true;
  }
}

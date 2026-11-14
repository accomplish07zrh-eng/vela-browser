/**
 * Approval for code an AI asks to save: a script or a plugin. Both run on this computer with the
 * user's rights, so by default a person reads the source on the dashboard and approves it before it
 * is written. Running a saved script needs no approval: it is code the user already accepted.
 * Unanswered requests are refused after a while; nothing waits forever.
 */

import { randomUUID } from "node:crypto";

/** "ask": every AI save waits for a person. "allow": saves go through. "deny": none. */
export type AiCodePolicy = "ask" | "allow" | "deny";
export const AI_CODE_POLICIES: readonly AiCodePolicy[] = ["ask", "allow", "deny"];

export interface CodeApprovalRequest {
  kind: "script" | "plugin";
  /** New, or a change to something the user already has. */
  action: "create" | "update";
  /** What it is called: the script's title, or the plugin's id. */
  title: string;
  /** The AI client, as it named itself to the MCP server. */
  client: string;
  /** For a script: "javascript" or "python". For a plugin: its tool names. */
  detail: string;
  /** Every file it would write, in full, for the person to read. */
  files: { name: string; content: string }[];
}

export interface PendingCodeApproval extends CodeApprovalRequest {
  id: string;
  requestedAt: number;
  expiresAt: number;
}

export type CodeApprovalOutcome = "approved" | "denied" | "timeout";

export class CodeApprovalQueue {
  private pending = new Map<string, PendingCodeApproval & { settle: (outcome: CodeApprovalOutcome) => void }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Wait for a person's answer; `timeoutMs` without one is a refusal. */
  request(request: CodeApprovalRequest, timeoutMs = 5 * 60_000): Promise<CodeApprovalOutcome> {
    // One open question per thing: a newer request for the same script or plugin replaces the old.
    for (const entry of this.pending.values()) {
      if (entry.kind === request.kind && entry.title === request.title) entry.settle("denied");
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const requestedAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: CodeApprovalOutcome) => {
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
  list(): PendingCodeApproval[] {
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

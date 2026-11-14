/**
 * Approval for code an AI asks to save: a script or a plugin. Both run on this computer with the
 * user's rights, so by default a person reads the source on the dashboard and approves it before it
 * is written. Running a saved script needs no approval: it is code the user already accepted.
 * Unanswered requests are refused after a while; nothing waits forever.
 */

import { ApprovalQueue, type ApprovalOutcome } from "./approval-queue.ts";

/** "ask": every AI save waits for a person. "allow": saves go through. "deny": none. */
export type AiCodePolicy = "ask" | "allow" | "deny";
export const AI_CODE_POLICIES: readonly AiCodePolicy[] = ["ask", "allow", "deny"];

export interface CodeApprovalRequest {
  kind: "script" | "plugin";
  /** New, or a change to something the user already has. */
  action: "create" | "update";
  /** What it is called: the script's title, or the plugin's id. */
  title: string;
  /** Optional stable key for replacement (e.g. scriptId); falls back to kind + title. */
  dedupeKey?: string;
  /** The AI client, as it named itself to the MCP server. */
  client: string;
  /** For a script: "javascript" or "python" (plus short id when updating). For a plugin: its tool names. */
  detail: string;
  /** Every file it would write, in full, for the person to read. */
  files: { name: string; content: string }[];
}

export interface PendingCodeApproval extends Omit<CodeApprovalRequest, "dedupeKey"> {
  id: string;
  requestedAt: number;
  expiresAt: number;
}

export type CodeApprovalOutcome = ApprovalOutcome;

export class CodeApprovalQueue {
  private readonly queue: ApprovalQueue<CodeApprovalRequest>;

  constructor(now: () => number = Date.now) {
    this.queue = new ApprovalQueue(
      5 * 60_000,
      (request) => `${request.kind}:${request.dedupeKey ?? request.title}`,
      now,
    );
  }

  /** Wait for a person's answer; `timeoutMs` without one is a refusal. Aborted on disconnect. */
  request(request: CodeApprovalRequest, timeoutMs = 5 * 60_000, signal?: AbortSignal): Promise<CodeApprovalOutcome> {
    return this.queue.request(request, timeoutMs, signal);
  }

  /** The questions waiting for an answer, oldest first. */
  list(): PendingCodeApproval[] {
    return this.queue.list().map(({ dedupeKey: _dedupeKey, ...entry }) => entry);
  }

  /** Answer one. False when it is no longer waiting (answered, replaced, aborted, or expired). */
  answer(id: string, approve: boolean): boolean {
    return this.queue.answer(id, approve);
  }
}

import { useCallback, useState } from "react";
import { ApprovalCountdown, requestApprovalJson, useApprovalQueue } from "./approval-queue.tsx";
import { useTranslation } from "./i18n.tsx";
import { CodeBlock } from "./scripts.tsx";
import "./code-approvals.css";

export interface PendingCodeApproval {
  id: string;
  kind: "script" | "plugin";
  action: "create" | "update";
  title: string;
  client: string;
  detail: string;
  files: { name: string; content: string }[];
  requestedAt: number;
  expiresAt: number;
}

export type AiCodePolicy = "ask" | "allow" | "deny";

const codeApprovalsCall = <T,>(path: string, body?: unknown) =>
  requestApprovalJson<T>(`/ui/api/code-approvals${path}`, body);

export const fetchCodeApprovals = () => codeApprovalsCall<{ pending: PendingCodeApproval[]; policy: AiCodePolicy }>("");
export const setCodePolicy = (policy: AiCodePolicy) => codeApprovalsCall<{ policy: AiCodePolicy }>("/policy", { policy });

/**
 * Scripts and plugins an AI asked to save, each waiting for the person to read the code and allow it.
 * Nothing is written before that; an unanswered request is refused by itself.
 */
export function CodeApprovalPrompts() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const loadPending = useCallback(async () => (await fetchCodeApprovals()).pending, []);
  const postAnswer = useCallback((id: string, approve: boolean) => codeApprovalsCall("/answer", { id, approve }), []);
  const { pending, answering, error, answer } = useApprovalQueue(loadPending, postAnswer);

  if (!pending.length) return null;
  return <div className="code-approvals" role="region" aria-label={t("Code from an AI")}>
    {error && <div className="code-approval-error" role="alert">{t(error)}</div>}
    {pending.map((item) => {
      const expanded = open[item.id] ?? false;
      const isPython = item.kind === "script" && item.detail.startsWith("python");
      const lines = item.files.reduce((sum, file) => sum + file.content.split("\n").length, 0);
      return <div key={item.id} className="code-approval" role="alertdialog" aria-labelledby={`code-approval-${item.id}`} aria-describedby={`code-approval-note-${item.id}`}>
        <div className="code-approval-head">
          <span className={`code-approval-kind ${item.kind}${isPython ? " python" : ""}`} aria-hidden="true">
            {item.kind === "script" ? (isPython ? "PY" : "JS") : "PL"}
          </span>
          <div>
            <strong id={`code-approval-${item.id}`}>{item.kind === "script"
              ? t(item.action === "create" ? "{client} wants to save a new script" : "{client} wants to change a script", { client: item.client })
              : t(item.action === "create" ? "{client} wants to add a plugin" : "{client} wants to change a plugin", { client: item.client })}</strong>
            <p>{item.title}{item.detail ? ` · ${item.detail}` : ""}</p>
          </div>
        </div>
        <p id={`code-approval-note-${item.id}`} className="code-approval-note">{t("It runs on this computer with your rights. Read it before you allow it.")}</p>
        <button type="button" className="code-approval-toggle" aria-expanded={expanded} onClick={() => setOpen((state) => ({ ...state, [item.id]: !expanded }))}>
          {expanded ? t("Hide the code") : t("Read the code ({count} lines)", { count: lines })}
        </button>
        {expanded && <div className="code-approval-files">
          {item.files.map((file) => <figure key={file.name}><figcaption>{file.name}</figcaption><CodeBlock source={file.content} /></figure>)}
        </div>}
        <div className="code-approval-foot">
          <small><ApprovalCountdown expiresAt={item.expiresAt} /></small>
          <button type="button" className="btn ghost" disabled={answering === item.id} onClick={() => void answer(item.id, false)}>{t("Deny")}</button>
          <button type="button" className="btn primary" disabled={answering === item.id} onClick={() => void answer(item.id, true)}>{t("Allow")}</button>
        </div>
      </div>;
    })}
  </div>;
}

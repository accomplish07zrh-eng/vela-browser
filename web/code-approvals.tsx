import { useCallback, useEffect, useState } from "react";
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

async function codeApprovalsCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/ui/api/code-approvals${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "Request failed");
  return data as T;
}

export const fetchCodeApprovals = () => codeApprovalsCall<{ pending: PendingCodeApproval[]; policy: AiCodePolicy }>("");
export const setCodePolicy = (policy: AiCodePolicy) => codeApprovalsCall<{ policy: AiCodePolicy }>("/policy", { policy });

/**
 * Scripts and plugins an AI asked to save, each waiting for the person to read the code and allow it.
 * Nothing is written before that; an unanswered request is refused by itself.
 */
export function CodeApprovalPrompts() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingCodeApproval[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const poll = useCallback(async () => {
    try { setPending((await fetchCodeApprovals()).pending); } catch { /* keep what is shown; the next poll retries */ }
  }, []);
  useEffect(() => {
    void poll();
    const timer = setInterval(() => { void poll(); setNow(Date.now()); }, 2000);
    return () => clearInterval(timer);
  }, [poll]);
  if (!pending.length) return null;
  const answer = async (id: string, approve: boolean) => {
    setAnswering(id);
    try { await codeApprovalsCall("/answer", { id, approve }); } catch { /* it expired or was replaced; the poll clears it */ }
    finally { setAnswering(null); await poll(); }
  };
  return <div className="code-approvals" role="region" aria-label={t("Code from an AI")}>
    {pending.map((item) => {
      const expanded = open[item.id] ?? false;
      const lines = item.files.reduce((sum, file) => sum + file.content.split("\n").length, 0);
      return <div key={item.id} className="code-approval" role="alertdialog" aria-labelledby={`code-approval-${item.id}`}>
        <div className="code-approval-head">
          <span className={`code-approval-kind ${item.kind}`} aria-hidden="true">{item.kind === "script" ? (item.detail === "python" ? "PY" : "JS") : "PL"}</span>
          <div>
            <strong id={`code-approval-${item.id}`}>{item.kind === "script"
              ? t(item.action === "create" ? "{client} wants to save a new script" : "{client} wants to change a script", { client: item.client })
              : t(item.action === "create" ? "{client} wants to add a plugin" : "{client} wants to change a plugin", { client: item.client })}</strong>
            <p>{item.title}{item.kind === "plugin" && item.detail ? ` · ${item.detail}` : ""}</p>
          </div>
        </div>
        <p className="code-approval-note">{t("It runs on this computer with your rights. Read it before you allow it.")}</p>
        <button type="button" className="code-approval-toggle" aria-expanded={expanded} onClick={() => setOpen((state) => ({ ...state, [item.id]: !expanded }))}>
          {expanded ? t("Hide the code") : t("Read the code ({count} lines)", { count: lines })}
        </button>
        {expanded && <div className="code-approval-files">
          {item.files.map((file) => <figure key={file.name}><figcaption>{file.name}</figcaption><CodeBlock source={file.content} /></figure>)}
        </div>}
        <div className="code-approval-foot">
          <small>{t("Refused automatically in {seconds} s.", { seconds: Math.max(0, Math.ceil((item.expiresAt - now) / 1000)) })}</small>
          <button type="button" className="btn ghost" disabled={answering === item.id} onClick={() => void answer(item.id, false)}>{t("Deny")}</button>
          <button type="button" className="btn primary" disabled={answering === item.id} onClick={() => void answer(item.id, true)}>{t("Allow")}</button>
        </div>
      </div>;
    })}
  </div>;
}

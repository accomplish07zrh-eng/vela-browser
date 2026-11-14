/**
 * Shared client primitives for dashboard AI approval queues (proxy changes and AI-written code):
 * HTTP status preservation, out-of-order-safe polling, 409 cleanup on answer, and an isolated
 * 1-second countdown leaf so open code viewers do not re-render every tick.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n.tsx";

export class ApprovalHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApprovalHttpError";
  }
}

export async function requestApprovalJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || data?.ok === false) {
    throw new ApprovalHttpError(
      typeof data?.error === "string" && data.error ? data.error : "Request failed",
      response.status,
    );
  }
  return data as T;
}

export function ApprovalCountdown({ expiresAt }: { expiresAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return <>{t("Refused automatically in {seconds} s.", { seconds })}</>;
}

export function useApprovalQueue<TItem extends { id: string }>(
  fetchPending: () => Promise<TItem[]>,
  sendAnswer: (id: string, approve: boolean) => Promise<unknown>,
) {
  const [pending, setPending] = useState<TItem[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const poll = useCallback(async () => {
    const seq = ++pollSeq.current;
    try {
      const items = await fetchPending();
      if (mounted.current && seq === pollSeq.current) setPending(items);
    } catch {
      /* keep what is shown; the next poll retries */
    }
  }, [fetchPending]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [poll]);

  const answer = useCallback(async (id: string, approve: boolean) => {
    if (!mounted.current) return;
    setAnswering(id);
    setError(null);
    try {
      await sendAnswer(id, approve);
    } catch (caught) {
      if (caught instanceof ApprovalHttpError && caught.status === 409) {
        if (mounted.current) setPending((items) => items.filter((item) => item.id !== id));
      } else if (mounted.current) {
        setError("Request failed");
      }
    } finally {
      await poll();
      if (mounted.current) setAnswering(null);
    }
  }, [poll, sendAnswer]);

  return { pending, answering, error, answer };
}

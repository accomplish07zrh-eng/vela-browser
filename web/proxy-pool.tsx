/**
 * The proxy pool in the dashboard: import proxies once, check them, and give them to profiles.
 * Nothing here ever holds a node's credentials; the server keeps them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Select } from "./select.tsx";
import { NumberInput } from "./controls.tsx";
import { useTranslation } from "./i18n.tsx";
import type { PoolCheck, PoolNodeView, PoolSubscriptionView } from "../src/proxy-pool.ts";

export class ProxyPoolClientError extends Error {}

/**
 * Messages the pool routes may send. Only these are shown (translated); anything else becomes a
 * generic message, so no server text reaches the page unchecked.
 */
const SERVER_MESSAGES = new Set([
  "Paste at least one proxy", "Too much text at once", "tags must be a list of text",
  "the sharing limit must be a whole number from 1, or no limit", "This proxy is no longer in the pool",
  "Only the name, tags, sharing limit and disabled state can change", "The name cannot be empty",
  "disabled must be true or false", "Invalid pool selection", "Country must be a two-letter code", "Invalid tag",
  "Choose a proxy", "Choose a profile and a proxy", "This proxy is not available in the pool",
  "This proxy is already used by as many profiles as its sharing limit allows", "no such profile",
  "Unknown proxy pool operation", "Unsupported proxy type", "Invalid request", "POST is required",
  "Proxy pool operation failed", "Proxy check failed",
  "Paste a subscription link", "Choose a subscription", "This subscription is no longer here", "This subscription is already added",
  "The subscription link is not a valid URL", "The subscription link must use https", "The subscription could not be read",
  "The subscription could not be downloaded", "The subscription is too large", "The subscription is empty",
  "The subscription format is not recognised", "The subscription lists no usable node", "The subscription is not valid YAML",
  "The subscription is not valid JSON", "The subscription has no proxies", "The subscription has no outbounds",
  "The subscription link redirects too many times", "The subscription link redirects to an insecure address",
  "This subscription link cannot be read on this computer. Remove it and add it again", "Encrypted storage is unavailable right now",
]);

/** A failure's message for the page: a known server message, translated, or `fallback`. */
function failureText(t: (key: string, vars?: Record<string, string | number>) => string, failure: unknown, fallback: string): string {
  const message = failure instanceof Error ? failure.message : "";
  // Subscription errors come from Vela's own fetcher; some carry a status code.
  const answered = /^The subscription server answered (\d{3})$/.exec(message);
  if (answered) return t("The subscription server answered {status}", { status: answered[1]! });
  return SERVER_MESSAGES.has(message) ? t(message) : t(fallback);
}

async function poolCall<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/ui/api/proxy-pool${path}`, body === undefined ? { signal } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  let parsed: any = null;
  try { parsed = await response.json(); } catch { /* handled below */ }
  if (!response.ok || parsed?.ok !== true) {
    const error = new ProxyPoolClientError(typeof parsed?.error === "string" ? parsed.error : "Proxy pool request failed");
    Object.assign(error, { code: parsed?.code, profiles: parsed?.profiles });
    throw error;
  }
  return parsed as T;
}

export const fetchPool = (signal?: AbortSignal) => poolCall<{ nodes: PoolNodeView[] }>("", undefined, signal).then((r) => r.nodes);
export const fetchPoolAll = (signal?: AbortSignal) => poolCall<{ nodes: PoolNodeView[]; subscriptions: PoolSubscriptionView[] }>("", undefined, signal);
interface SubscriptionResult { added: number; kept: number; removed: number; infoEntries: number; nonNodes: number; unsupported: Array<{ name: string; reason: string }> }
export const addSubscription = (url: string, name: string) => poolCall<SubscriptionResult>("/subscriptions/add", { url, ...(name.trim() ? { name } : {}) });
export const refreshSubscription = (id: string) => poolCall<SubscriptionResult>("/subscriptions/refresh", { id });
export const deleteSubscription = (id: string) => poolCall<{ removedNodes: number; keptNodes: number }>("/subscriptions/delete", { id });

function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

/** Remaining traffic and expiry, warning under 10% left or 7 days to go. */
export function subscriptionUsage(sub: PoolSubscriptionView, now = Date.now()): { used?: number; total?: number; left?: number; expireAt?: number; warn: boolean } {
  const used = sub.usage ? (sub.usage.uploadBytes ?? 0) + (sub.usage.downloadBytes ?? 0) : undefined;
  const total = sub.usage?.totalBytes;
  const left = total !== undefined && used !== undefined ? Math.max(0, total - used) : undefined;
  const expireAt = sub.usage?.expireAt ? sub.usage.expireAt * 1000 : undefined;
  const warn = (total !== undefined && left !== undefined && total > 0 && left / total < 0.1) || (expireAt !== undefined && expireAt - now < 7 * 86_400_000);
  return { ...(used !== undefined ? { used } : {}), ...(total !== undefined ? { total } : {}), ...(left !== undefined ? { left } : {}), ...(expireAt !== undefined ? { expireAt } : {}), warn };
}
export const importPool = (text: string, type: string, tags: string[]) =>
  poolCall<{ added: number; duplicates: number; invalid: Array<{ line: number; error: string }> }>("/import", { text, type, tags });
export const updatePoolNode = (id: string, patch: Record<string, unknown>) => poolCall<{ node: PoolNodeView }>("/update", { id, ...patch });
export const deletePoolNodes = (ids: string[]) => poolCall<{ removed: number }>("/delete", { ids });
export interface SwitchAnswer { applied: "saved" | "reopened"; previous: string; next: string; exit?: { ip?: string; country?: string }; sharedWith: Array<{ id: string; name: string; group: string }> }
export const switchPoolNode = (profileId: string, nodeId: string) => poolCall<SwitchAnswer>("/switch", { profileId, nodeId });
export interface SwitchHistoryView { at: number; by: string; from: string; to: string; outcome: "saved" | "reopened" | "failed"; code?: string; exitCountry?: string }
export const fetchSwitchHistory = (profileId: string) => poolCall<{ history: SwitchHistoryView[] }>(`/history?profileId=${encodeURIComponent(profileId)}`).then((r) => r.history);
export const assignPoolNode = (profileId: string, nodeId: string) =>
  poolCall<{ restartRequired?: true; sharedWith: Array<{ id: string; name: string; group: string }> }>("/assign", { profileId, nodeId });

/** Run checks, calling `onNode` as each result lands. */
export async function checkPool(ids: string[] | undefined, onNode: (node: PoolNodeView) => void, onProgress: (done: number, total: number) => void, signal?: AbortSignal) {
  const response = await fetch("/ui/api/proxy-pool/check", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ids ? { ids } : {}), signal,
  });
  if (!response.ok || !response.body) throw new ProxyPoolClientError("The check could not start");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", done = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "node") onNode(event.node);
      else if (event.type === "progress") onProgress(event.completed, event.total);
      else if (event.type === "done") done = true;
      else if (event.type === "error") throw new ProxyPoolClientError("The check failed");
    }
  }
  if (!done) throw new ProxyPoolClientError("The check was interrupted");
}

/** The exit country a node is known by: its last check, else what its name says. */
export function nodeCountry(node: PoolNodeView): { code?: string; fromName: boolean } {
  if (node.check?.country) return { code: node.check.country.toUpperCase(), fromName: false };
  return node.regionHint ? { code: node.regionHint, fromName: true } : { fromName: false };
}

/** Room left under the node's sharing limit. */
export function nodeRoom(node: PoolNodeView): number {
  return node.maxProfiles === null ? Infinity : node.maxProfiles - node.profiles.length;
}

function reasonLabel(t: (key: string) => string, reason: string | undefined): string | null {
  if (!reason) return null;
  const labels: Record<string, string> = {
    authentication_failed: t("Authentication failed"), timeout: t("Timed out"), dns_failed: t("DNS lookup failed"),
    unreachable: t("Cannot connect"), connection_failed: t("Connection failed"), intermittent: t("Intermittent connection"),
    proxy_bypassed: t("Connection bypassed the proxy"), check_unavailable: t("Check service unavailable"),
  };
  return labels[reason] ?? null;
}

function statusLabel(t: (key: string) => string, check: PoolCheck | undefined): string {
  if (!check) return t("Not checked");
  return ({ working: t("Alive"), failed: t("Dead"), unstable: t("Unstable"), unavailable: t("Unknown") } as Record<string, string>)[check.status] ?? t("Unknown");
}

function NodeEditor({ node, onSaved, onCancel }: { node: PoolNodeView; onSaved: (node: PoolNodeView) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(node.name);
  const [tags, setTags] = useState(node.tags.join(", "));
  const [unlimited, setUnlimited] = useState(node.maxProfiles === null);
  const [limit, setLimit] = useState(node.maxProfiles ?? 1);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const { node: saved } = await updatePoolNode(node.id, {
        name, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), maxProfiles: unlimited ? null : limit,
      });
      onSaved(saved);
    } catch (failure) { setError(failureText(t, failure, "Could not save")); }
  };
  return <div className="pool-editor">
    <label className="fld"><span>{t("Name")}</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label className="fld"><span>{t("Tags")} <span className="muted">{t("(comma-separated)")}</span></span><input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
    <div className="fld"><span>{t("Profiles that may share it")}</span>
      <div className="proxy-actions">
        <label className="proxy-choice"><input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />{t("No limit")}</label>
        {!unlimited && <NumberInput aria-label={t("Profiles that may share it")} min={1} step={1} value={limit} onChange={(e) => setLimit(Math.max(1, Math.floor(Number(e.target.value)) || 1))} />}
      </div>
    </div>
    <p className="tools-hint">{t("The proxy itself cannot change here: a different proxy is a new node, so no profile moves to another exit without you choosing it.")}</p>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    <div className="proxy-actions"><button type="button" className="btn primary" onClick={() => void save()}>{t("Save")}</button><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
  </div>;
}

export function ProxyPoolPanel({ active, onChanged }: { active: boolean; onChanged?: () => void }) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<PoolNodeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [type, setType] = useState("http");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState<"import" | "check" | "delete" | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");

  const [subs, setSubs] = useState<PoolSubscriptionView[]>([]);
  const [subUrl, setSubUrl] = useState("");
  const [subName, setSubName] = useState("");
  const [subBusy, setSubBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const all = await fetchPoolAll(); setNodes(all.nodes); setSubs(all.subscriptions); setError(null); } catch { setError(t("The proxy pool could not load.")); }
  }, [t]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const countries = useMemo(() => [...new Set((nodes ?? []).map((node) => nodeCountry(node).code).filter(Boolean) as string[])].sort(), [nodes]);
  const shown = (nodes ?? []).filter((node) =>
    (!country || nodeCountry(node).code === country)
    && (!status || (status === "unchecked" ? !node.check : node.check?.status === status)));
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]));

  const doImport = async () => {
    setBusy("import"); setError(null); setNotice(null);
    try {
      const result = await importPool(text, type, tags.split(",").map((tag) => tag.trim()).filter(Boolean));
      setNotice(t("Added {added} · already in the pool {duplicates} · invalid {invalid}", {
        added: result.added, duplicates: result.duplicates, invalid: result.invalid.length,
      }) + (result.invalid.length ? ` (${t("lines")} ${result.invalid.slice(0, 10).map((row) => row.line).join(", ")}${result.invalid.length > 10 ? "…" : ""})` : ""));
      if (result.added) setText("");
      await load();
    } catch (failure) { setError(failureText(t, failure, "Import failed")); }
    finally { setBusy(null); }
  };

  const doCheck = async (ids?: string[]) => {
    setBusy("check"); setError(null); setNotice(null); setProgress([0, ids?.length ?? nodes?.length ?? 0]);
    try {
      await checkPool(ids, (node) => setNodes((rows) => rows?.map((row) => row.id === node.id ? { ...row, check: node.check } : row) ?? rows),
        (done, total) => setProgress([done, total]));
      await load();
      setNotice(t("Checks finished. Unknown means the check could not establish a result."));
    } catch (failure) { setError(failureText(t, failure, "The check failed")); }
    finally { setBusy(null); setProgress(null); }
  };

  const doDelete = async () => {
    const ids = [...selected];
    const used = ids.reduce((sum, id) => sum + (byId.get(id)?.profiles.length ?? 0), 0);
    const message = used
      ? t("Remove {count} proxies from the pool? {used} profiles use them and keep their proxy; it is just no longer in the pool.", { count: ids.length, used })
      : t("Remove {count} proxies from the pool?", { count: ids.length });
    if (!window.confirm(message)) return;
    setBusy("delete");
    try { await deletePoolNodes(ids); setSelected(new Set()); await load(); }
    catch { setError(t("Could not remove the selected proxies.")); }
    finally { setBusy(null); }
  };

  const toggle = async (node: PoolNodeView) => {
    try { await updatePoolNode(node.id, { disabled: !node.disabled }); await load(); }
    catch { setError(t("Could not save")); }
  };

  return <>
    <section className="tools-panel proxy-input-panel">
      <div className="tools-panel-head"><div><h3>{t("Subscriptions")}</h3><p>{t("Paste a provider's subscription link. Its nodes join the pool; providers share their exits, so their nodes have no sharing limit by default. The link stays on this computer.")}</p></div></div>
      <div className="tools-panel-body">
        <div className="fld-row">
          <label className="fld grow"><span>{t("Subscription link")}</span><input type="password" autoComplete="off" spellCheck={false} value={subUrl} disabled={!!subBusy} placeholder="https://…" onChange={(e) => setSubUrl(e.target.value)} /></label>
          <label className="fld"><span>{t("Name")}</span><input value={subName} disabled={!!subBusy} onChange={(e) => setSubName(e.target.value)} /></label>
        </div>
        <p className="tools-hint">{t("Subscription nodes such as VLESS, Trojan or Hysteria2 run in sing-box, a separate open-source program (GPL-3.0-or-later, by nekohasekai) that Vela Browser is not associated with. On first use Vela downloads its official release, checks it and runs it unmodified. Source: github.com/SagerNet/sing-box")}</p>
        <div className="tools-result-bar"><span />
          <button type="button" className="btn primary" disabled={!!subBusy || !subUrl.trim()} onClick={() => void (async () => {
            setSubBusy("add"); setError(null); setNotice(null);
            try {
              const result = await addSubscription(subUrl.trim(), subName);
              setSubUrl(""); setSubName("");
              setNotice(subscriptionNotice(t, result));
              await load();
            } catch (failure) { setError(failureText(t, failure, "The subscription could not be read")); await load(); }
            finally { setSubBusy(null); }
          })()}>{subBusy === "add" ? t("Adding…") : t("Add subscription")}</button></div>
        {subs.length > 0 && <div className="proxy-table-wrap"><table className="profile-table proxy-table pool-table"><thead><tr>
          <th>{t("Name")}</th><th>{t("Traffic left")}</th><th>{t("Expires")}</th><th>{t("Nodes")}</th><th>{t("Updated")}</th><th></th>
        </tr></thead><tbody>{subs.map((sub) => {
          const usage = subscriptionUsage(sub);
          const nodeCount = (nodes ?? []).filter((node) => node.subscriptionId === sub.id && !node.removedFromSource).length;
          return <tr key={sub.id}>
            <td><strong>{sub.name}</strong><small className="tools-mono">{sub.host}</small></td>
            <td className={usage.warn ? "pool-warn" : ""}>{usage.left !== undefined ? `${bytes(usage.left)} / ${bytes(usage.total)}` : "—"}</td>
            <td className={usage.warn ? "pool-warn" : ""}>{usage.expireAt ? new Date(usage.expireAt).toLocaleDateString() : "—"}</td>
            <td>{nodeCount}{sub.lastImport && (sub.lastImport.unsupported.length > 0 || sub.lastImport.infoEntries > 0) && <small>{t("{unsupported} unsupported · {info} notices", { unsupported: sub.lastImport.unsupported.length, info: sub.lastImport.infoEntries })}</small>}</td>
            <td>{sub.lastFetchedAt ? new Date(sub.lastFetchedAt).toLocaleString() : "—"}{sub.lastError && <small className="pool-warn">{failureText(t, new Error(sub.lastError), "The subscription could not be read")}</small>}</td>
            <td><div className="proxy-actions">
              <button type="button" className="btn sm" disabled={!!subBusy} onClick={() => void (async () => {
                setSubBusy(sub.id); setError(null); setNotice(null);
                try { setNotice(subscriptionNotice(t, await refreshSubscription(sub.id))); }
                catch (failure) { setError(failureText(t, failure, "The subscription could not be read")); }
                finally { setSubBusy(null); await load(); }
              })()}>{subBusy === sub.id ? t("Updating…") : t("Update")}</button>
              <button type="button" className="btn sm" disabled={!!subBusy} onClick={() => void (async () => {
                if (!window.confirm(t("Remove this subscription? Its nodes that profiles use stay in the pool; the others are removed."))) return;
                setSubBusy(sub.id);
                try { await deleteSubscription(sub.id); } catch { setError(t("Could not save")); }
                finally { setSubBusy(null); await load(); }
              })()}>{t("Remove")}</button>
            </div></td>
          </tr>;
        })}</tbody></table></div>}
      </div>
    </section>
    <section className="tools-panel proxy-input-panel">
      <div className="tools-panel-head"><div><h3>{t("Add proxies to the pool")}</h3><p>{t("One per line: host:port:user:pass or a URL. Add #name at the end to name it. A proxy already in the pool is not added twice.")}</p></div></div>
      <div className="tools-panel-body">
        <div className="fld-row">
          <label className="fld type"><span>{t("Default type")}</span><Select value={type} disabled={!!busy} onChange={(e) => setType(e.target.value)}>
            <option value="http">http</option><option value="https">https</option><option value="socks5">socks5</option>
          </Select></label>
          <label className="fld grow"><span>{t("Tags")} <span className="muted">{t("(comma-separated)")}</span></span><input value={tags} disabled={!!busy} placeholder="residential, us" onChange={(e) => setTags(e.target.value)} /></label>
        </div>
        <label className="fld"><span>{t("Proxies")}</span><textarea aria-label={t("Proxies")} rows={4} value={text} disabled={!!busy} spellCheck={false} autoComplete="off"
          placeholder={"proxy.example.com:8080:username:password#🇺🇸 LA 01\nsocks5://username:password@proxy.example.com:1080#HK 02"} onChange={(e) => setText(e.target.value)} /></label>
        <p className="tools-hint">{t("Hand-added proxies are exclusive: one profile each, unless you raise the limit. Several accounts on one IP are easily linked.")}</p>
        <div className="tools-result-bar"><span />
          <button type="button" className="btn primary" disabled={!!busy || !text.trim()} onClick={() => void doImport()}>{busy === "import" ? t("Adding…") : t("Add to pool")}</button></div>
      </div>
    </section>
    {error && <div className="tools-alert" role="alert">{error}</div>}
    {notice && <div className="tools-notice" role="status">{notice}</div>}
    {progress && <div className="tools-progress" role="status"><div className="proxy-actions"><strong>{t("Checking proxies")}: {progress[0]} / {progress[1]}</strong></div>
      <progress aria-label={t("Proxy operation progress")} value={progress[0]} max={Math.max(1, progress[1])} /></div>}
    <section className="tools-panel">
      <div className="tools-panel-head"><div><h3>{t("Proxy pool")}</h3><p>{t("Exit country comes from the last check; before a check, from the name. Proxies that left through one IP are marked.")}</p></div>
        <div className="proxy-actions">
          <button type="button" className="btn" disabled={!!busy || !selected.size} onClick={() => void doCheck([...selected])}>{t("Check selected")}</button>
          <button type="button" className="btn primary" disabled={!!busy || !nodes?.length} onClick={() => void doCheck()}>{busy === "check" ? t("Checking…") : t("Check all")}</button>
        </div></div>
      {nodes && nodes.length > 0 ? <>
        <div className="tools-result-bar">
          <div className="proxy-actions">
            <Select value={country} aria-label={t("Country")} onChange={(e) => setCountry(e.target.value)}>
              <option value="">{t("All countries")}</option>{countries.map((code) => <option key={code} value={code}>{code}</option>)}
            </Select>
            <Select value={status} aria-label={t("Status")} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("Any status")}</option><option value="working">{t("Alive")}</option><option value="unstable">{t("Unstable")}</option>
              <option value="failed">{t("Dead")}</option><option value="unavailable">{t("Unknown")}</option><option value="unchecked">{t("Not checked")}</option>
            </Select>
          </div>
          <div className="proxy-actions">
            <span className="tools-hint">{t("{count} selected", { count: selected.size })}</span>
            <button type="button" className="btn" disabled={!!busy || !selected.size} onClick={() => void doDelete()}>{t("Remove from pool")}</button>
          </div>
        </div>
        <div className="proxy-table-wrap"><table className="profile-table proxy-table pool-table"><thead><tr>
          <th><input type="checkbox" aria-label={t("Select all")} checked={shown.length > 0 && shown.every((node) => selected.has(node.id))}
            onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((node) => node.id)) : new Set())} /></th>
          <th>{t("Name")}</th><th>{t("Proxy address")}</th><th>{t("Country")}</th><th>{t("Connection")}</th><th>{t("Exit IP")}</th><th>{t("Used by")}</th><th></th>
        </tr></thead><tbody>{shown.map((node) => {
          const where = nodeCountry(node);
          const mismatch = node.regionHint && node.check?.country && node.regionHint !== node.check.country.toUpperCase();
          const room = nodeRoom(node);
          return <tr key={node.id} className={node.disabled ? "pool-disabled" : ""}>
            <td><input type="checkbox" aria-label={node.name} checked={selected.has(node.id)} onChange={(e) => setSelected((set) => {
              const next = new Set(set); if (e.target.checked) next.add(node.id); else next.delete(node.id); return next;
            })} /></td>
            <td>{editing === node.id
              ? <NodeEditor node={node} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); onChanged?.(); }} />
              : <><strong>{node.name}</strong>{node.disabled && <small>{t("Disabled")}</small>}{node.tags.length > 0 && <small>{node.tags.join(" · ")}</small>}</>}</td>
            <td className="tools-mono">{node.proxy}{node.hasAuth && !node.subscriptionId && <small>{t("with login")}</small>}
              {node.subscriptionId && <small>{subs.find((sub) => sub.id === node.subscriptionId)?.name ?? t("Subscription")}</small>}
              {node.insecureTls && <small className="pool-warn">{t("certificate not checked")}</small>}
              {node.removedFromSource && <small className="pool-warn">{t("no longer in its subscription")}</small>}</td>
            <td>{where.code ?? "—"}{where.fromName && <small>{t("from name")}</small>}{mismatch && <small className="pool-warn">{t("name says {code}", { code: node.regionHint! })}</small>}</td>
            <td><span className={`tools-status ${node.check?.status ?? "unavailable"}`}>{statusLabel(t, node.check)}</span>
              {reasonLabel(t, node.check?.reason) && <small>{reasonLabel(t, node.check?.reason)}</small>}
              {node.check?.durationMs !== undefined && <small>{(node.check.durationMs / 1000).toFixed(1)} s</small>}
              {node.check?.rotating && <small className="pool-warn">{t("IP changes between requests")}</small>}</td>
            <td className="tools-mono">{node.check?.ip ?? "—"}{node.check?.city && <small>{node.check.city}</small>}
              {node.sameExitAs.length > 0 && <small className="pool-warn">{t("same exit as {names}", { names: node.sameExitAs.map((id) => byId.get(id)?.name ?? id).join(", ") })}</small>}</td>
            <td>{node.profiles.length}{node.maxProfiles === null ? ` / ${t("no limit")}` : ` / ${node.maxProfiles}`}
              {node.profiles.length > 0 && <small>{node.profiles.slice(0, 3).map((profile) => profile.name || profile.id).join(", ")}{node.profiles.length > 3 ? "…" : ""}</small>}
              {room <= 0 && <small>{t("Full")}</small>}</td>
            <td><div className="proxy-actions">
              <button type="button" className="btn sm" disabled={!!busy} onClick={() => setEditing(node.id)}>{t("Edit")}</button>
              <button type="button" className="btn sm" disabled={!!busy} onClick={() => void toggle(node)}>{node.disabled ? t("Enable") : t("Disable")}</button>
            </div></td>
          </tr>;
        })}</tbody></table></div>
      </> : <div className="tools-empty compact"><p>{nodes ? t("The pool is empty. Add proxies above, then give them to profiles from Replace proxies or a profile's edit form.") : t("Loading…")}</p></div>}
    </section>
    <AiProxyPolicyField />
  </>;
}

/** Pool filters for "Replace proxies": they become the preview's input. */
export function PoolSelectionFields({ value, onChange, disabled }: { value: string; onChange: (input: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [nodes, setNodes] = useState<PoolNodeView[]>([]);
  useEffect(() => { void fetchPool().then(setNodes, () => setNodes([])); }, []);
  let parsed: { country?: string; tag?: string; onlyWorking?: boolean } = {};
  try { parsed = JSON.parse(value || "{}"); } catch { parsed = {}; }
  const set = (patch: Record<string, unknown>) => {
    const next = { ...parsed, ...patch };
    for (const key of Object.keys(next)) if ((next as Record<string, unknown>)[key] === "" || (next as Record<string, unknown>)[key] === undefined) delete (next as Record<string, unknown>)[key];
    onChange(JSON.stringify(next));
  };
  useEffect(() => { if (!value) onChange("{}"); }, [value, onChange]);
  const countries = [...new Set(nodes.map((node) => nodeCountry(node).code).filter(Boolean) as string[])].sort();
  const tags = [...new Set(nodes.flatMap((node) => node.tags))].sort();
  const onlyWorking = parsed.onlyWorking ?? true;
  const fitting = nodes.filter((node) => !node.disabled
    && (!parsed.country || nodeCountry(node).code === parsed.country)
    && (!parsed.tag || node.tags.includes(parsed.tag))
    && (!onlyWorking || node.check?.status === "working"));
  const room = fitting.reduce((sum, node) => sum + nodeRoom(node), 0);
  return <>
    <div className="fld-row">
      <label className="fld"><span>{t("Country")}</span><Select value={parsed.country ?? ""} disabled={disabled} onChange={(e) => set({ country: e.target.value })}>
        <option value="">{t("All countries")}</option>{countries.map((code) => <option key={code} value={code}>{code}</option>)}
      </Select></label>
      <label className="fld"><span>{t("Tag")}</span><Select value={parsed.tag ?? ""} disabled={disabled} onChange={(e) => set({ tag: e.target.value })}>
        <option value="">{t("Any tag")}</option>{tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
      </Select></label>
    </div>
    <label className="proxy-choice"><input type="checkbox" checked={onlyWorking} disabled={disabled} onChange={(e) => set({ onlyWorking: e.target.checked })} />{t("Only proxies whose last check worked")}</label>
    <p className="tools-hint">{t("{nodes} fitting proxies · room for {room} more profiles. A profile already on a fitting proxy keeps it; the others get the least-used one.", {
      nodes: fitting.length, room: room === Infinity ? t("any number of") : room,
    })}</p>
  </>;
}

/** "From the pool" in a profile's edit form: saves the chosen node as the profile's proxy. */
/** Why a switch stopped, for the person who asked for it. */
function switchFailure(t: (key: string, vars?: Record<string, string | number>) => string, failure: unknown): string {
  const { code, retryAfterMs } = failure as { code?: string; retryAfterMs?: number };
  switch (code) {
    case "pool_exhausted": return t("This proxy already has as many profiles as its sharing limit allows.");
    case "node_unavailable": return t("This proxy is not available in the pool");
    case "rate_limited": return t("This profile changed its proxy moments ago. Try again in {seconds} s.", { seconds: Math.ceil((retryAfterMs ?? 30_000) / 1000) });
    case "profile_busy": return t("This profile is already changing its proxy.");
    case "switch_check_failed": return t("The new proxy did not pass its check. Nothing was changed.");
    case "teardown_unconfirmed": return t("The browser could not be closed for certain, so it keeps its current proxy.");
    case "reopen_failed": return t("The new proxy is saved, but the browser did not reopen. Open it again.");
    case "exit_is_direct": return t("After reopening, the browser's traffic left from this computer's own address, so it was closed.");
    default: return t("Could not save");
  }
}

export function PoolProxyPicker({ profileId, running, onAssigned }: { profileId: string; running?: boolean; onAssigned: (result: SwitchAnswer) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<PoolNodeView[] | null>(null);
  const [choice, setChoice] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<SwitchHistoryView[]>([]);
  useEffect(() => { if (open) void fetchPool().then(setNodes, () => setNodes([])); }, [open]);
  useEffect(() => { void fetchSwitchHistory(profileId).then(setHistory, () => setHistory([])); }, [profileId, busy]);
  const last = history[0];
  const lastLine = last && <small className="pool-picker-message">{t("Last change: {when} · {from} → {to} · {by} · {outcome}", {
    when: new Date(last.at).toLocaleString(), from: last.from, to: last.to,
    by: last.by === "dashboard" ? t("you") : last.by.replace(/^mcp:/, "MCP · "),
    outcome: last.outcome === "failed" ? t("not changed") : last.outcome === "reopened" ? t("reopened") : t("saved"),
  })}</small>;
  if (!open) return <>
    <button type="button" className="btn proxy-check-btn" onClick={() => { setOpen(true); setMessage(null); }}>{t("From the pool…")}</button>
    {message && <small className="pool-picker-message">{message}</small>}
    {lastLine}
  </>;
  const usable = (nodes ?? []).filter((node) => !node.disabled);
  const assign = async () => {
    if (running && !window.confirm(t("Change this open browser's exit? Its session is saved, it closes, and it reopens on the new exit with its tabs. Timezone and WebRTC follow the new exit."))) return;
    setBusy(true); setMessage(null);
    try {
      const result = await switchPoolNode(profileId, choice);
      const shared = result.sharedWith.length ? " " + t("This exit is shared with {names}.", { names: result.sharedWith.map((p) => p.name || p.id).join(", ") }) : "";
      setMessage((result.applied === "reopened"
        ? t("Changed. The browser reopened on the new exit ({country}).", { country: result.exit?.country ?? "—" })
        : t("Saved. The profile uses the new exit from its next start.")) + shared);
      onAssigned(result);
      setOpen(false);
    } catch (failure) {
      setMessage(switchFailure(t, failure));
    } finally { setBusy(false); }
  };
  return <div className="pool-picker">
    <Select value={choice} aria-label={t("Proxy from the pool")} onChange={(e) => setChoice(e.target.value)}>
      <option value="">{nodes ? t("Choose a proxy…") : t("Loading…")}</option>
      {usable.map((node) => {
        const where = nodeCountry(node).code ?? "—";
        const room = nodeRoom(node);
        const usedByThis = node.profiles.some((profile) => profile.id === profileId);
        return <option key={node.id} value={node.id} disabled={room <= 0 && !usedByThis}>
          {`${node.name} · ${where} · ${statusLabel(t, node.check)} · ${node.profiles.length}/${node.maxProfiles ?? "∞"}${usedByThis ? ` · ${t("current")}` : ""}`}
        </option>;
      })}
    </Select>
    <button type="button" className="btn primary" disabled={!choice || busy} onClick={() => void assign()}>{busy ? t("Checking the new exit…") : running ? t("Change and reopen") : t("Use this proxy")}</button>
    <button type="button" className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
    {message && <small>{message}</small>}
  </div>;
}

/** A profile's proxy that is a pool node: shown by name, never edited as text. */
export function PoolNodeField({ nodeId, onManual }: { nodeId: string; onManual: () => void }) {
  const { t } = useTranslation();
  const [node, setNode] = useState<PoolNodeView | null | undefined>(undefined);
  useEffect(() => { void fetchPool().then((nodes) => setNode(nodes.find((n) => n.id === nodeId) ?? null), () => setNode(null)); }, [nodeId]);
  return <div className="fld-row">
    <div className="fld grow">
      <span>{t("Proxy from the pool")}</span>
      <div className="pool-node-field">
        {node === undefined ? t("Loading…")
          : node === null ? <span className="pool-warn">{t("This node is no longer in the pool. The profile will not open until you choose another proxy.")}</span>
          : <><strong>{node.name}</strong><small>{node.protocol} · {nodeCountry(node).code ?? "—"} · {statusLabel(t, node.check)}{node.removedFromSource ? ` · ${t("no longer in its subscription")}` : ""}</small></>}
      </div>
      <small>{t("Runs through this profile's own proxy kernel.")}</small>
    </div>
    <button type="button" className="btn" onClick={onManual}>{t("Type a proxy instead")}</button>
  </div>;
}

function subscriptionNotice(t: (key: string, vars?: Record<string, string | number>) => string, result: SubscriptionResult): string {
  const parts = [t("Added {added} · kept {kept} · no longer listed {removed}", { added: result.added, kept: result.kept, removed: result.removed })];
  if (result.unsupported.length) parts.push(t("{count} not supported", { count: result.unsupported.length }) + `: ${[...new Set(result.unsupported.map((row) => row.reason))].slice(0, 3).join("; ")}`);
  if (result.infoEntries) parts.push(t("{count} provider notices skipped", { count: result.infoEntries }));
  if (result.nonNodes) parts.push(t("{count} entries are not exits (direct, reject, groups)", { count: result.nonNodes }));
  return parts.join(" · ");
}

/* ---------- AI proxy changes (MCP) ---------- */

type AiProxyPolicy = "ask" | "allow_pool" | "deny";
interface PendingApproval { id: string; profileId: string; profileName: string; client: string; from: string; to: string; reopens: boolean; expiresAt: number }

async function approvalsCall<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/ui/api/proxy-approvals${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const parsed: any = await response.json().catch(() => null);
  if (!response.ok || parsed?.ok !== true) throw new ProxyPoolClientError(typeof parsed?.error === "string" ? parsed.error : "Request failed");
  return parsed as T;
}
const fetchApprovals = () => approvalsCall<{ pending: PendingApproval[]; policy: AiProxyPolicy }>("");

/** The standing answer to proxy changes an AI asks for through MCP. */
export function AiProxyPolicyField() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<AiProxyPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetchApprovals().then((r) => setPolicy(r.policy), () => setPolicy("ask")); }, []);
  return <section className="tools-panel proxy-input-panel">
    <div className="tools-panel-head"><div><h3>{t("AI proxy changes")}</h3><p>{t("An AI connected through MCP can give a profile a pool proxy. Changing a profile's exit shows its sites an IP change.")}</p></div></div>
    <div className="tools-panel-body">
      <label className="fld"><span>{t("When an AI asks to change a proxy")}</span>
        <Select value={policy ?? "ask"} disabled={!policy} onChange={(e) => {
          const next = e.target.value as AiProxyPolicy;
          setError(null);
          void approvalsCall<{ policy: AiProxyPolicy }>("/policy", { policy: next }).then((r) => setPolicy(r.policy), () => setError(t("Could not save")));
        }}>
          <option value="ask">{t("Ask me each time")}</option>
          <option value="allow_pool">{t("Allow pool proxies without asking")}</option>
          <option value="deny">{t("Never allow")}</option>
        </Select></label>
      {error && <div className="tools-alert" role="alert">{error}</div>}
    </div>
  </section>;
}

/**
 * Questions from AI clients waiting for a person: shown over any page of the dashboard, so an
 * approval does not depend on which view is open. Unanswered ones are refused after a minute.
 */
export function ProxyApprovalPrompts() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [answering, setAnswering] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const poll = useCallback(async () => {
    try { setPending((await fetchApprovals()).pending); } catch { /* keep what is shown; the next poll retries */ }
  }, []);
  useEffect(() => {
    void poll();
    const timer = setInterval(() => { void poll(); setNow(Date.now()); }, 2000);
    return () => clearInterval(timer);
  }, [poll]);
  if (!pending.length) return null;
  const answer = async (id: string, approve: boolean) => {
    setAnswering(id);
    try { await approvalsCall("/answer", { id, approve }); } catch { /* it expired or was replaced; the poll clears it */ }
    finally { setAnswering(null); await poll(); }
  };
  return <div className="proxy-approvals" role="region" aria-label={t("AI proxy changes")}>
    {pending.map((item) => <div key={item.id} className="proxy-approval" role="alertdialog" aria-labelledby={`approval-${item.id}`}>
      <strong id={`approval-${item.id}`}>{t("{client} wants to change the proxy of {profile}", { client: item.client, profile: item.profileName })}</strong>
      <p className="tools-mono">{item.from} → {item.to}</p>
      <p>{item.reopens ? t("The open browser will save its tabs, close and reopen on the new exit.") : t("The profile uses it from its next start.")}
        {" "}{t("Refused automatically in {seconds} s.", { seconds: Math.max(0, Math.ceil((item.expiresAt - now) / 1000)) })}</p>
      <div className="proxy-actions">
        <button type="button" className="btn" disabled={answering === item.id} onClick={() => void answer(item.id, false)}>{t("Deny")}</button>
        <button type="button" className="btn primary" disabled={answering === item.id} onClick={() => void answer(item.id, true)}>{t("Allow")}</button>
      </div>
    </div>)}
  </div>;
}

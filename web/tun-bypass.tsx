import { useEffect, useState } from "react";
import { useTranslation } from "./i18n.tsx";

interface Physical { name: string; address: string; description?: string }
interface TestResult { interface: Physical | null; resolved?: { name: string; address: string }; boundLocal?: string; defaultLocal?: string; directExit?: string; defaultExit?: string; ok: boolean; problem?: string }

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

/**
 * Going around this computer's own TUN proxy client: the connections to profiles' proxies leave
 * through the physical adapter. With a test that shows, with real connections, that it works.
 */
export function TunBypassControl({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ enabled: boolean; interface: Physical | null } | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<"toggle" | "test" | null>(null), [error, setError] = useState("");
  useEffect(() => { call<any>("/ui/api/tun-bypass").then(setState, () => setState(null)); }, []);
  if (!state) return null;
  const toggle = async (enabled: boolean) => {
    setBusy("toggle"); setError("");
    try { setState(await call("/ui/api/tun-bypass", { enabled })); } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(null); }
  };
  const runTest = async () => {
    setBusy("test"); setError("");
    try { setTest((await call<{ test: TestResult }>("/ui/api/tun-bypass/test", {})).test); } catch (cause) { setError(t(cause instanceof Error ? cause.message : String(cause))); }
    finally { setBusy(null); }
  };
  const tunActive = test && test.defaultLocal && /^198\.1[89]\./.test(test.defaultLocal);
  return <div className={`tun-bypass${compact ? " compact" : ""}`}>
    <div className="settings-row"><span>{t("Go around it: connect to proxies through {adapter}", { adapter: state.interface?.name ?? t("the physical adapter") })}</span>
      <label className="plugin-switch"><input type="checkbox" role="switch" checked={state.enabled} disabled={!!busy || (!state.enabled && !state.interface)} onChange={(event) => void toggle(event.target.checked)} />
        <span>{state.enabled ? t("On") : t("Off")}</span></label>
    </div>
    <p className="tun-bypass-note">{state.interface
      ? t("Only Vela Browser's connections to profiles' proxies take the physical adapter; websites are still reached through each profile's proxy, and a proxy's name is looked up with encrypted DNS. Applies to browsers started after the change.")
      : t("No physical network adapter was found, so this cannot be turned on.")}</p>
    <div className="tun-bypass-actions">
      <button type="button" className="btn sm" disabled={!!busy} onClick={() => void runTest()}>{busy === "test" ? t("Testing…") : t("Test the bypass")}</button>
      {error && <span className="tun-bypass-error" role="alert">{error}</span>}
    </div>
    {test && <dl className={`tun-bypass-result${test.ok ? " ok" : " bad"}`}>
      <div><dt>{t("Physical adapter")}</dt><dd>{test.interface ? `${test.interface.name} · ${test.interface.address}` : "—"}</dd></div>
      {test.resolved && <div><dt>{t("Encrypted DNS through it")}</dt><dd>{test.resolved.name} → {test.resolved.address}</dd></div>}
      {test.boundLocal && <div><dt>{t("Connection used")}</dt><dd>{test.boundLocal}{test.defaultLocal && test.defaultLocal !== test.boundLocal ? ` (${t("without the bypass: {address}", { address: test.defaultLocal })})` : ""}</dd></div>}
      {test.directExit && <div><dt>{t("Comes out at")}</dt><dd>{test.directExit}{test.defaultExit && test.defaultExit !== test.directExit ? ` (${t("through the TUN client: {address}", { address: test.defaultExit })})` : ""}</dd></div>}
      <div className="tun-bypass-verdict"><dt>{t("Result")}</dt><dd>{test.ok
        ? tunActive ? t("Works: proxies are reached directly, not through the TUN client.") : t("Works. No TUN client seems to be running right now, so both paths are the same.")
        : t(test.problem ?? "The test did not pass")}</dd></div>
    </dl>}
  </div>;
}

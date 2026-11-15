import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { confirmDialog } from "./dialog.tsx";
import { useTranslation } from "./i18n.tsx";
import "./phone-app.css";

interface PhoneState {
  enabled: boolean; port: number | null; pin: string | null; addresses: string[];
  reachability?: { checked: boolean; firewallBlocked: boolean; publicNetwork: boolean; adapter?: string };
  app: null | {
    name: string; fingerprint: string; qr?: string;
    devices: Array<{ id: string; name: string; createdAt: number; lastSeenAt?: number }>;
    pending: Array<{ id: string; name: string; code: string; expiresAt: number }>;
  };
}

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

/** A QR code drawn as one SVG path, crisp at any size and in both themes. */
function QrCode({ text, label }: { text: string; label: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text, "Byte");
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { path: d, size: count + 8 };
  }, [text]);
  return <svg className="phone-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} rx="3" fill="#fff" />
    <path d={path} fill="#111114" />
  </svg>;
}

const digits = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Settings: the Vela Browser phone app, paired over the same Wi-Fi. */
export function MobileViewCard({ flash }: { flash(message: string): void }) {
  const { t, language } = useTranslation();
  const [state, setState] = useState<PhoneState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => call<PhoneState>("/ui/api/mobile-view").then(setState, () => setState(null));
  useEffect(() => { void load(); }, []);
  // While it is on, look for phones asking to pair and refresh the "last used" times.
  useEffect(() => {
    if (!state?.enabled) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 2000);
    return () => clearInterval(timer);
  }, [state?.enabled]);
  if (!state) return null;
  const act = (path: string, method = "POST", body?: unknown) => {
    setBusy(true);
    return call<PhoneState>(path, method, body).then(setState, (error) => flash(String(error.message ?? error))).finally(() => setBusy(false));
  };
  const when = (at?: number) => at ? new Date(at).toLocaleString(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : t("Not yet");
  const app = state.app;
  return <section className="settings-card mobile-card phone-card">
    <header><svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17.5h2" /></svg><h2>{t("Phone app")}</h2></header>
    <div className="card-body">
      <p>{t("Use Vela Browser from your phone on the same Wi-Fi: start and close browsers, run scripts and tasks, answer AI approvals, and work in one browser by touch. Pair once by scanning the code with the Vela Browser app.")}</p>
      <div className="settings-row"><span>{t("Let phones connect")}</span>
        <label className="plugin-switch"><input type="checkbox" role="switch" checked={state.enabled} disabled={busy} onChange={(event) => void act("/ui/api/mobile-view", "POST", { enabled: event.target.checked })} />
          <span>{state.enabled ? t("On") : t("Off")}</span></label>
      </div>
      {state.enabled && app?.pending.map((pair) => <div key={pair.id} className="phone-pending" role="alert">
        <div>
          <strong>{t("{name} wants to pair", { name: pair.name })}</strong>
          <p>{t("Pair only if the phone shows the same digits:")}</p>
          <b className="mono">{digits(pair.code)}</b>
        </div>
        <div className="phone-pending-actions">
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => void act("/ui/api/mobile-view/pair", "POST", { id: pair.id, allow: true })}>{t("Pair")}</button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => void act("/ui/api/mobile-view/pair", "POST", { id: pair.id, allow: false })}>{t("Refuse")}</button>
        </div>
      </div>)}
      {state.enabled && <div className="phone-pairing">
        {app?.qr ? <QrCode text={app.qr} label={t("Pairing code for the phone app")} /> : <div className="phone-qr empty">{t("No local network address found")}</div>}
        <div className="phone-pairing-text">
          <strong>{t("Scan with the Vela Browser app")}</strong>
          <p>{t("Open the app and tap Pair, then point it here. Scanned with the phone's camera instead, the code opens a page to download the app.")}</p>
          <div className="phone-pin-row"><span>{t("Or type the PIN")}</span><strong className="mobile-pin mono">{state.pin}</strong>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void act("/ui/api/mobile-view/pin")}>{t("New code")}</button></div>
          <p className="cardnote">{t("With the PIN, you confirm here that both screens show the same six digits. The code works once; pairing again needs a new one.")}</p>
          {state.addresses.length > 0 && <p className="cardnote">{t("Without the app, a phone browser can watch at {address}.", { address: `http://${state.addresses[0]}:${state.port}` })}</p>}
        </div>
      </div>}
      {state.enabled && state.reachability?.firewallBlocked && <div className="mobile-warn" role="alert">
        <strong>{t("Windows Firewall is keeping phones out")}</strong>
        <p>{t("A firewall rule blocks Vela Browser from receiving connections, often left by a dismissed permission prompt. In Windows Defender Firewall > Advanced settings > Inbound rules, delete the Block rules for aliasmode-sidecar.exe, then turn the phone view off and on and allow private networks when Windows asks.")}</p>
      </div>}
      {state.enabled && state.reachability?.publicNetwork && <div className="mobile-warn" role="alert">
        <strong>{t("This Wi-Fi is set as a public network")}</strong>
        <p>{t("Windows keeps devices on a public network from reaching this computer. If this is your own Wi-Fi, open Settings > Network & internet > {adapter} > the network's properties and choose Private network.", { adapter: state.reachability.adapter ?? "Wi-Fi" })}</p>
      </div>}
      {app && app.devices.length > 0 && <div className="phone-devices">
        <h3>{t("Paired phones")}</h3>
        {app.devices.map((device) => <div key={device.id} className="phone-device">
          <svg className="icon sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 17.5h2" /></svg>
          <div><strong>{device.name}</strong><span>{t("Paired {paired} · last used {used}", { paired: when(device.createdAt), used: when(device.lastSeenAt) })}</span></div>
          <button type="button" className="btn sm" disabled={busy} onClick={async () => {
            if (!await confirmDialog(t("The phone is disconnected now and has to pair again to use this computer."), { title: t("Remove {name}?", { name: device.name }), confirmLabel: t("Remove"), danger: true })) return;
            void act(`/ui/api/mobile-view/devices/${encodeURIComponent(device.id)}`, "DELETE");
          }}>{t("Remove")}</button>
        </div>)}
      </div>}
      <p className="cardnote">{t("Only phones on the same network can connect, and only while this is on. Everything between the phone and this computer is encrypted with the key made when pairing. The first time, Windows may ask whether Vela Browser may use the network: allow private networks only.")}</p>
    </div>
  </section>;
}

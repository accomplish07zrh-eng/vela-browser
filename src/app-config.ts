import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { normalizeCoolingSettings, type CoolingSettings } from "./cooling.ts";
import { parseKernelDnsEnvironment, type KernelDnsEnvironment } from "./kernel-config.ts";
import { normalizeAiAccess, type AiAccessSettings } from "./ai-access.ts";

export type AppMode = "unconfigured" | "local" | "cloud";

export interface AppConfig {
  version: 1;
  mode: AppMode;
  cloudUrl?: string;
  localAnalytics: boolean;
  /** Set when the user hid the Services page from the sidebar. */
  servicesHidden?: boolean;
  /** Windows: environment windows have no taskbar button. Nothing else about them changes. */
  hideFromTaskbar?: boolean;
  /** Cooling of idle browsers when memory runs short. Absent means the defaults. */
  cooling?: CoolingSettings;
  /** Network environment for sing-box encrypted DoH node-server resolution. Absent means auto. */
  kernelDns?: KernelDnsEnvironment;
  /** Plugins in the plugins folder that the user switched off. Every other plugin there is on. */
  disabledPlugins?: string[];
  /** Whether an AI may change a profile's proxy: ask each time (absent), allow pool nodes, or never. */
  aiProxyChanges?: "allow_pool" | "deny";
  /** Whether scripts and plugins an AI writes are saved: ask each time (absent), always, or never. */
  aiCodeChanges?: "allow" | "deny";
  /** Which groups each AI may use. Absent means every AI may use every profile. */
  aiAccess?: AiAccessSettings;
  /** Set to false when the user turned off the daily backup of sign-ins. */
  sessionBackups?: boolean;
  /** Account passwords, 2FA secrets, cookies and saved sign-ins are stored encrypted. */
  encryptData?: boolean;
  /** Connections to profiles' proxies go around this computer's TUN proxy client. */
  tunBypass?: boolean;
  /** A phone on the same network may watch the running browsers (read only, with a PIN). */
  mobileView?: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  mode: "local",
  localAnalytics: false,
};

export function normalizeSecureServiceUrl(value: string, label: string): string {
  const parsed = new URL(value.trim());
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) throw new Error(`${label} URL must use HTTPS`);
  return parsed.toString().replace(/\/$/, "");
}

export function parseAppConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object") throw new Error("Vela Browser config must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("unsupported Vela Browser config version");
  if (raw.mode !== "unconfigured" && raw.mode !== "local" && raw.mode !== "cloud") {
    throw new Error("invalid Vela Browser mode");
  }
  return {
    version: 1,
    // Retired Cloud and first-run configurations open the same local workspace.
    // Profile databases, browser directories and recovery archives are untouched.
    mode: "local",
    localAnalytics: raw.localAnalytics === true,
    ...(raw.servicesHidden === true ? { servicesHidden: true } : {}),
    ...(raw.hideFromTaskbar === true ? { hideFromTaskbar: true } : {}),
    ...(raw.cooling !== undefined ? { cooling: normalizeCoolingSettings(raw.cooling) } : {}),
    ...(parseKernelDnsEnvironment(raw.kernelDns) ? { kernelDns: parseKernelDnsEnvironment(raw.kernelDns)! } : {}),
    ...(Array.isArray(raw.disabledPlugins) && raw.disabledPlugins.some(id => typeof id === "string")
      ? { disabledPlugins: [...new Set(raw.disabledPlugins.filter((id): id is string => typeof id === "string" && id.length <= 64))].sort() } : {}),
    ...(raw.aiProxyChanges === "allow_pool" || raw.aiProxyChanges === "deny" ? { aiProxyChanges: raw.aiProxyChanges } : {}),
    ...(raw.aiCodeChanges === "allow" || raw.aiCodeChanges === "deny" ? { aiCodeChanges: raw.aiCodeChanges } : {}),
    ...(normalizeAiAccess(raw.aiAccess) ? { aiAccess: normalizeAiAccess(raw.aiAccess)! } : {}),
    ...(raw.sessionBackups === false ? { sessionBackups: false } : {}),
    ...(raw.encryptData === true ? { encryptData: true } : {}),
    ...(raw.tunBypass === true ? { tunBypass: true } : {}),
    ...(raw.mobileView === true ? { mobileView: true } : {}),
  };
}

export function legacyHubUrl(
  config: AppConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return undefined;
}

export class AppConfigStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  read(): AppConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_CONFIG };
    return parseAppConfig(JSON.parse(readFileSync(this.path, "utf8")));
  }

  write(config: AppConfig): AppConfig {
    const normalized = parseAppConfig(config);
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    return normalized;
  }

  setMode(mode: Exclude<AppMode, "unconfigured">, cloudUrl?: string): AppConfig {
    if (mode !== "local") throw new Error("Accounts and Cloud mode have been removed from Vela Browser");
    const current = this.read();
    return this.write({ ...current, mode: "local" });
  }
}

import { Channel } from "@tauri-apps/api/core";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./proxies.css";
import { ProxiesPage } from "./proxies.tsx";
import { PoolNodeField, PoolProxyPicker, ProxyApprovalPrompts } from "./proxy-pool.tsx";
import { WorkbenchPage } from "./workbench.tsx";
import { CommandPalette, type SearchTarget } from "./command-palette.tsx";
import "./design-tokens.css";
import "./shell.css";
import "./profile-management.css";
import { ProfileDetailDrawer } from "./profile-detail.tsx";
import { SavedProfileViews, ProfileTemplateBar, ProfileBatchOptions, ProfileCreationDialog, ProfileCreationReceipt, ProfileCreateSummary } from "./profile-management-controls.tsx";
import { batchProfileNames, matchesProfileFilters, runProfileCreation, type BatchCreateItem, type ProfileFilters, type ProfileStatusFilter, type ProfileEngineFilter } from "./profile-management.ts";
import { TrashPage } from "./trash.tsx";
import { parsePastedProxy } from "./proxy-input.ts";
import { ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
import { TitleBar, usesOwnTitleBar } from "./titlebar.tsx";
import { Select } from "./select.tsx";
import { DialogHost, confirmDialog, noticeDialog } from "./dialog.tsx";
import { Tooltips } from "./tooltip.tsx";
import { guardContextMenu } from "./controls.tsx";
import { DockBlob } from "./dock-blob.tsx";
import { I18nProvider, availableLanguages, languageNativeName, useTranslation } from "./i18n.tsx";
import { localeTimezoneMismatch } from "../src/profile-locale.ts";
import type { FingerprintAudit } from "../src/fingerprint-audit.ts";
import { folderTree, folderScope, type FolderInfo } from "../src/folders.ts";
import { THEME_KEY, readThemeChoice, themeCookie, type ThemeChoice } from "./theme.ts";
import {
  describeDesktopUpdateResult,
  parseDesktopUpdateResult,
  type DesktopUpdateResult,
} from "./desktop-update-result.ts";
import {
  type UiProfile,
  type HealthSource,
  type DiagnoseReport,
  type EditProfile,
  type Extension,
  type GroupExtensionDefaults,
  type AppModeConfig,
  fetchAppMode,
  saveTaskbarHidden,
  saveCooling,
  type CoolingSettings,
  fetchPlugins,
  setPluginEnabled,
  addExamplePlugin,
  openPluginsFolder,
  type PluginListing,
  fetchRuntimeDownloads,
  type RuntimeDownload,
  fetchProfiles,
  serialLoader,
  fetchHealth,
  fetchDiskSpace,
  type DiskSpace,
  fetchLogs,
  fetchDiagnose,
  checkProxy,
  ProxyCheckError,
  type ProxyCheckInput,
  type ProxyCheckResult,
  addProfileCookies,
  fetchPendingCookies,
  clearPendingCookies,
  openProfile,
  closeProfile,
  restartProfile,
  raiseProfile,
  checkFingerprint,
  measureFingerprint,
  fetchExtensions,
  installWebStoreExtension,
  uploadExtensions,
  removeExtension,
  assignExtensionBulk,
  fetchGroupExtensionDefaults,
  setGroupExtensionDefaults,
  uploadExports,
  moveProfiles,
  deleteProfiles,
  createProfile,
  fetchProfileEdit,
  updateProfile,
  refreshProfileTimezone,
  convertMobileProfile,
  exportProfiles,
  type ExportFormat,
  type ExportProgress,
  updateFromFile,
  createGroup,
  renameGroup,
  moveGroup,
  deleteGroup,
  fetchTotp,
} from "./api.ts";

/** Run async tasks with bounded concurrency (so "Open 50" isn't 50 at once). */
async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]!); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

const CSV_TEMPLATE =
  "name,group,platform,proxy,username,password,email,emailpassword,twofa\n" +
  "alice_warmup,Warmup,x.com,1.2.3.4:8080:proxyuser:proxypass,alice_user,SuperSecret1,alice@example.com,MailboxSecret1,JBSWY3DPEHPK3PXP\n" +
  "bob_eu,EU,telegram.org,,bob_user,SuperSecret2,bob@example.com,MailboxSecret2,\n" +
  "carol_noproxy,Warmup,,,carol_user,SuperSecret3,carol@example.com,MailboxSecret3,KRSXG5CTMVRXEZLU\n";

const TXT_EXAMPLE =
  "id=k1example01\ngroup=Warmup\nplatform=x.com\nname=alice_warmup\nusername=alice@example.com\n" +
  "password=SuperSecret1\nemail=mailbox@example.com\nemailpassword=MailboxSecret1\nfakey=JBSWY3DPEHPK3PXP\ncookie=[]\nproxytype=http\n" +
  "proxy=1.2.3.4:8080:proxyuser:proxypass\nua=\nresolution=1920*1080\n******************\n";

// Example sheet for the Update-from-file flow. The FIRST column (id) is what
// matches each row to an existing profile — keep it. Edit the other columns;
// delete any column you don't want to change.
const UPDATE_TEMPLATE_CSV =
  "id,name,group,platform,proxy,proxytype,username,password,twofa,resolution,custom_no\n" +
  "<paste-the-profile-id-here>,New name,Warmup,x.com,1.2.3.4:8080:user:pass,http,new@example.com,NewPass1,JBSWY3DPEHPK3PXP,1920*1080,123456\n";

/**
 * How many profiles a pasted AdsPower export would create. Every record starts
 * with its own `id=` line, so counting those is exact rather than a guess at
 * blocks — and it gives the operator a number to sanity-check before importing.
 */
function countPastedRecords(text: string): number {
  return (text.match(/^id=/gm) ?? []).length;
}

function sameExtensionSelection(left: string[], right: string[]): boolean {
  const leftIds = new Set(left);
  const rightIds = new Set(right);
  return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
}

function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

const REFRESH_MS = 3000;
const PROFILE_PAGE_SIZE = 50;
const PAGE_SIZES = [25, 50, 100, 200];

const PAGE_TITLES: Record<"profiles" | "workbench" | "scripts" | "settings" | "extensions" | "proxies" | "trash", string> = {
  profiles: "Profiles",
  workbench: "Multi-view workbench",
  scripts: "Scripts",
  settings: "Settings",
  extensions: "Extensions",
  proxies: "Proxies",
  trash: "Trash",
};

const SETTINGS_TABS = [
  { key: "general", label: "General" },
  { key: "advanced", label: "Advanced" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["key"];

/** Mirrors MAX_CUSTOM_NO_LENGTH in parse.ts — the server rejects anything longer. */
const MAX_CUSTOM_NO = 12;

/**
 * Roster columns. `width` is the single source of truth: each column is laid out
 * at exactly that width and the table's min-width is their sum, so a column can
 * never be squeezed below a readable size — the roster scrolls sideways instead.
 * Only the checkbox column is fixed; everything else can be hidden.
 */
const COLUMNS = [
  { key: "no", label: "No.", sort: true, width: 96 },
  { key: "name", label: "Name", sort: true, width: 220 },
  { key: "group", label: "Group", sort: true, width: 120 },
  { key: "platform", label: "Platform", sort: true, width: 128 },
  { key: "tags", label: "Tags", sort: false, width: 140 },
  { key: "proxy", label: "Proxy", sort: true, width: 160 },
  /* Every row action lives here, beside Open/Close — no hover reveal. */
  { key: "action", label: "Action", sort: false, width: 230 },
] as const;

/** Width of the always-present select-all checkbox column. */
const CHECKBOX_COLUMN_WIDTH = 44;

type ColumnKey = (typeof COLUMNS)[number]["key"];
type SortKey = ColumnKey | "status";

const THEMES = [
  { key: "system", label: "System", icon: "laptop" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
] as const;

function readTheme(): ThemeChoice {
  let cookies = "";
  let stored: string | null = null;
  try { cookies = document.cookie; } catch {}
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  return readThemeChoice(cookies, stored);
}

const HIDDEN_COLUMNS_KEY = "aliasmode.roster.hiddenColumns";
const PAGE_SIZE_KEY = "aliasmode.roster.pageSize";

/** Tags are off until an operator asks for them — most rosters do not use them. */
const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["tags"];

/** Roster layout preferences are a convenience: a hostile/empty store must not break the view. */
function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (stored === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
    const raw = JSON.parse(stored);
    const known = new Set(COLUMNS.map((column) => column.key as string));
    return new Set((Array.isArray(raw) ? raw : []).filter((key) => known.has(key)) as ColumnKey[]);
  } catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }
}

function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return PAGE_SIZES.includes(stored) ? stored : PROFILE_PAGE_SIZE;
  } catch { return PROFILE_PAGE_SIZE; }
}

function writeSetting(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / disabled storage */ }
}

/**
 * Stroke-icon set (16px grid, 1.7 stroke) used everywhere a control needs a
 * glyph. Inline so the dashboard ships no icon font or sprite request, and one
 * `.icon` rule in styles.css controls size and color for all of them.
 */
const ICONS = {
  plus: <path d="M12 5v14M5 12h14" />,
  import: <><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  /* Pulling a file INTO the app. A bare download tray reads as "save to disk",
     which is the opposite of what the import control does. */
  fileImport: <><path className="duo" d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M13.6 3.2v3.3a1 1 0 0 0 1 1h3.2" /><path d="M12 17.6v-6.4M9.4 13.7 12 11.1l2.6 2.6" /></>,
  export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" /></>,
  search: <><circle className="duo" cx="11" cy="11" r="6.5" /><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  refresh: <><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  sort: <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />,
  sortUp: <path d="M7 14l5-5 5 5" />,
  sortDown: <path d="M7 10l5 5 5-5" />,
  profiles: <><rect className="duo" x="3" y="5" width="18" height="14" rx="3" /><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="9" cy="10.8" r="2.2" /><path d="M5.9 16.1c.6-1.5 1.7-2.3 3.1-2.3s2.5.8 3.1 2.3M14.6 10h3.4M14.6 13.4h2.4" /></>,
  folder: <><path className="duo" d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></>,
  folders: <><path d="M3.5 9.5V17a2 2 0 0 0 2 2h11" /><path className="duo" d="M7 6.5A1.5 1.5 0 0 1 8.5 5h3l1.6 1.8h5.4A1.5 1.5 0 0 1 20 8.3V15a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 7 15z" /><path d="M7 6.5A1.5 1.5 0 0 1 8.5 5h3l1.6 1.8h5.4A1.5 1.5 0 0 1 20 8.3V15a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 7 15z" /></>,
  puzzle: <><path className="duo" d="M5 8.5A1.5 1.5 0 0 1 6.5 7H9a2.1 2.1 0 1 1 4.2 0h2.3A1.5 1.5 0 0 1 17 8.5v2.3a2.1 2.1 0 1 1 0 4.2v2.5a1.5 1.5 0 0 1-1.5 1.5h-2.3a2.1 2.1 0 1 0-4.2 0H6.5A1.5 1.5 0 0 1 5 17.5z" /><path d="M5 8.5A1.5 1.5 0 0 1 6.5 7H9a2.1 2.1 0 1 1 4.2 0h2.3A1.5 1.5 0 0 1 17 8.5v2.3a2.1 2.1 0 1 1 0 4.2v2.5a1.5 1.5 0 0 1-1.5 1.5h-2.3a2.1 2.1 0 1 0-4.2 0H6.5A1.5 1.5 0 0 1 5 17.5z" /></>,
  logs: <><path className="duo" d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M13.6 3.2v3.3a1 1 0 0 0 1 1h3.2M9 12.5h6M9 16h4" /></>,
  user: <><circle className="duo" cx="12" cy="8.2" r="3.6" /><circle cx="12" cy="8.2" r="3.6" /><path d="M5 20c.7-3.7 3.3-5.8 7-5.8s6.3 2.1 7 5.8" /></>,
  settings: <><path d="M4 8h9M17.6 8H20M4 16h2.4M11.6 16H20" /><circle className="duo" cx="15.4" cy="8" r="2.3" /><circle cx="15.4" cy="8" r="2.3" /><circle className="duo" cx="9" cy="16" r="2.3" /><circle cx="9" cy="16" r="2.3" /></>,
  columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></>,
  play: <><path className="duo" d="M7.5 5.2v13.6a1 1 0 0 0 1.5.9l10.6-6.8a1 1 0 0 0 0-1.7L9 4.4a1 1 0 0 0-1.5.8z" /><path d="M7.5 5.2v13.6a1 1 0 0 0 1.5.9l10.6-6.8a1 1 0 0 0 0-1.7L9 4.4a1 1 0 0 0-1.5.8z" /></>,
  power: <><path d="M12 3v9" /><path d="M6.5 6.5a8 8 0 1011 0" /></>,
  trash: <><path className="duo" d="M6.6 7.5h10.8l-.8 11.1a2 2 0 0 1-2 1.9H9.4a2 2 0 0 1-2-1.9z" /><path d="M4.5 7.5h15M9.5 7.5V5.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1v1.9" /><path d="m6.6 7.5.8 11.1a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.8-11.1M10.3 11v5.6M13.7 11v5.6" /></>,
  edit: <><path className="duo" d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16z" /><path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4" /></>,
  move: <><path d="M4 20h13a3 3 0 003-3v-6a2 2 0 00-2-2h-7.5a2 2 0 01-1.6-.8L7.6 5.8A2 2 0 006 5H4a2 2 0 00-2 2v11a2 2 0 002 2z" /><path d="M9 14h6M13 11.5l2.5 2.5L13 16.5" /></>,
  raise: <><rect className="duo" x="8.5" y="3.5" width="12" height="12" rx="2.2" /><rect x="8.5" y="3.5" width="12" height="12" rx="2.2" /><path d="M15.5 15.5v2.7a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2v-7.6a2.2 2.2 0 0 1 2.2-2.2h2.8" /></>,
  key: <><circle className="duo" cx="8" cy="12" r="4" /><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15.5 12v2.5" /></>,
  fingerprint: <><path d="M7 11a5 5 0 0110 0v2a9 9 0 01-1.5 5" /><path d="M10 11a2 2 0 014 0v2a12 12 0 01-2.5 7" /><path d="M4.5 15a14 14 0 00.5-4 7 7 0 0114 0" /></>,
  cookie: <><path className="duo" d="M20.9 12.6A9 9 0 1 1 11.4 3.1a3 3 0 0 0 3.5 3.6 3 3 0 0 0 3.9 3.9 3 3 0 0 0 2.1 2z" /><path d="M20.9 12.6A9 9 0 1 1 11.4 3.1a3 3 0 0 0 3.5 3.6 3 3 0 0 0 3.9 3.9 3 3 0 0 0 2.1 2z" /><path d="M8.5 10.5h.01M11 15.5h.01M15.5 15h.01" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  alert: <><circle className="duo" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.3" /></>,
  warning: <><path className="duo" d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" /><path d="M12 9.5v4M12 17v.3" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  snow: <><circle className="duo" cx="12" cy="12" r="3.4" /><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6.5l2.5-2M9.5 19.5 12 17.5l2.5 2M4 10.6l3.3-.6-.9-3.2M20 13.4l-3.3.6.9 3.2M4 13.4l3.3.6-.9 3.2M20 10.6l-3.3-.6.9-3.2" /></>,
  // The wall: two lanes of live pages, the lower one running off both edges.
  wall: <><rect className="duo" x="3.5" y="4.5" width="7.5" height="6" rx="1.6" /><rect x="3.5" y="4.5" width="7.5" height="6" rx="1.6" /><rect x="13" y="4.5" width="7.5" height="6" rx="1.6" /><rect className="duo" x="7.25" y="13.5" width="9.5" height="6" rx="1.6" /><rect x="7.25" y="13.5" width="9.5" height="6" rx="1.6" /><path d="M3.5 14v5M20.5 14v5" /></>,
  globe: <><circle className="duo" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="3.9" ry="9" /><path d="M3.6 9h16.8M3.6 15h16.8" /></>,
  code: <><rect className="duo" x="3" y="4" width="18" height="16" rx="3.6" /><rect x="3" y="4" width="18" height="16" rx="3.6" /><path d="M9.6 9.4 7 12l2.6 2.6M14.4 9.4 17 12l-2.6 2.6M12.9 8.4l-1.8 7.2" /></>,
  lock: <><rect className="duo" x="5" y="11" width="14" height="9" rx="2.2" /><rect x="5" y="11" width="14" height="9" rx="2.2" /><path d="M8 11V8a4 4 0 1 1 8 0v3M12 14.8v1.8" /></>,
  laptop: <><rect className="duo" x="4" y="5" width="16" height="11" rx="2" /><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 20h20" /></>,
  hash: <path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16" />,
  window: <><rect className="duo" x="3" y="4" width="18" height="5" rx="2" /><rect x="3" y="4" width="18" height="16" rx="2.4" /><path d="M3 9h18M6.2 6.5h.01M8.6 6.5h.01" /></>,
  file: <><path className="duo" d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h6.3L18 7.2v12.3a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z" /><path d="M13.6 3.2v3.3a1 1 0 0 0 1 1h3.2" /></>,
  copy: <><rect className="duo" x="9" y="9" width="11" height="11" rx="2.2" /><rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M5 15V5.4A2.4 2.4 0 0 1 7.4 3H15" /></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8z" />,
  sun: <><circle className="duo" cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  moon: <><path className="duo" d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.7 6.7 0 0 0 9.7 9.7z" /><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.7 6.7 0 0 0 9.7 9.7z" /></>,
  help: <><circle className="duo" cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="9" /><path d="M9.4 9.1a2.7 2.7 0 0 1 5.3.7c0 1.8-2.7 2.2-2.7 3.7M12 16.8v.3" /></>,
  // A plug: what a plugin adds to the AI's tools.
  plug: <><path className="duo" d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z" /><path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4" /></>,
} as const;

/** Settings: plugins add tools the AI can call; each one is a folder in the plugins folder. */
function PluginsCard({ flash }: { flash: (message: string) => void }) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<PluginListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (task: () => Promise<PluginListing | void>) => {
    setBusy(true);
    task()
      .then((next) => { if (next) setListing(next); setError(null); })
      .catch((caught) => flash(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    fetchPlugins().then(setListing).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, []);
  if (error) return null;
  const plugins = listing?.plugins ?? [];
  return (
    <section className="settings-card plugins-card">
      <header><Icon name="plug" className="sm" /><h2>{t("Plugins")}</h2></header>
      <div className="card-body">
        <p>{t("A plugin adds tools the AI can call. It works inside the environment the AI has selected, with that environment's own sign-ins, proxy and fingerprint, and cannot start or close a browser. Plugins are code that runs on this computer, so add only ones you trust.")}</p>
        <div className="plugin-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => run(openPluginsFolder)}><Icon name="folder" className="sm" />{t("Open plugins folder")}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => run(fetchPlugins)}><Icon name="refresh" className="sm" />{t("Refresh")}</button>
        </div>
        {listing && plugins.length === 0 && (
          <div className="plugins-empty">
            <p className="formnote">{t("No plugins yet. Put a plugin's folder in the plugins folder, or start from the example.")}</p>
            <button type="button" className="btn" disabled={busy} onClick={() => run(addExamplePlugin)}><Icon name="plus" className="sm" />{t("Add the example plugin")}</button>
          </div>
        )}
        {plugins.length > 0 && (
          <ul className="plugin-list">
            {plugins.map((plugin) => (
              <li key={plugin.id} className={plugin.error ? "plugin has-error" : plugin.enabled ? "plugin" : "plugin off"}>
                <div className="plugin-head">
                  <strong>{plugin.name ?? plugin.id}</strong>
                  {plugin.version && <span className="mono plugin-version">{plugin.version}</span>}
                  <label className="plugin-switch">
                    <input type="checkbox" role="switch" aria-label={plugin.name ?? plugin.id} checked={plugin.enabled} disabled={busy}
                      onChange={(event) => run(() => setPluginEnabled(plugin.id, event.target.checked))} />
                    <span>{plugin.enabled ? t("On") : t("Off")}</span>
                  </label>
                </div>
                {plugin.description && <p className="plugin-description">{plugin.description}</p>}
                {plugin.error
                  ? <p className="plugin-error" role="alert">{t("Cannot load: {reason}", { reason: plugin.error })}</p>
                  : plugin.tools && (
                    <ul className="plugin-tools">
                      {plugin.tools.map((tool) => (
                        <li key={tool.name}><code>{tool.toolName}</code><span className={tool.readOnly ? "tag" : "tag warn"}>{tool.readOnly ? t("Reads only") : t("Can change things")}</span></li>
                      ))}
                    </ul>
                  )}
              </li>
            ))}
          </ul>
        )}
        {listing?.directory && <p className="cardnote">{t("Plugins folder")}: <span className="mono">{listing.directory}</span></p>}
        <p className="cardnote">{t("Changes reach the AI the next time it selects a browser.")}</p>
      </div>
    </section>
  );
}

type IconName = keyof typeof ICONS;

/**
 * Official project links for Vela Browser.
 */
const PROJECT_LINKS = [
  {
    href: "https://github.com/accomplish07zrh-eng/vela-browser",
    label: "GitHub",
    path: "M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.4 5.4 18.4 5.7 18.4 5.7c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3z",
  },
] as const;

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/**
 * Close a popover on outside click or Escape. The returned ref goes on the
 * wrapper holding BOTH the trigger and the panel, so clicking the trigger again
 * toggles it instead of closing and immediately reopening.
 */
function useDismiss<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose.current();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose.current(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return ref;
}

/**
 * The Vela typographic glass icon mark (Playfair Display Bold Italic, matching
 * silk-wallet), inlined as exact glyph outlines so it adapts to both light and
 * dark themes without depending on external font loading.
 */
function AliasLoop({ className }: { className?: string }) {
  return (
    <svg className={className ? `alias-loop ${className}` : "alias-loop"} viewBox="0 0 512 512" aria-hidden="true">
      <rect className="vela-tile" x="28" y="28" width="456" height="456" rx="116" stroke="currentColor" />
      <path className="loop-accent" d="M76 156C76 102 110 68 164 68H348" stroke="currentColor" />
      <path
        className="vela-word"
        fill="currentColor"
        d="M171.1 218.7Q177.5 209.1 177.7 203.6Q177.8 198 173.1 195.5Q168.4 192.9 159.8 192.5L160.9 188.2Q163.9 188.4 168.9 188.5Q173.9 188.6 179.5 188.8Q185 188.9 188.9 188.9Q193.8 188.9 197.6 188.6Q201.5 188.4 204.9 188.2L203.8 192.5Q199.5 193.6 195.7 195.8Q191.9 198 187.7 202.6Q183.5 207.2 178.4 215.1L96.9 340.4Q94.1 340.2 91.4 340.2Q88.7 340.2 86 340.4L69.1 206.2Q68.2 198.5 64.6 195.6Q61 192.7 58 192.5L59.1 188.2Q64.6 188.4 73.2 188.6Q81.7 188.9 89.8 188.9Q100.1 188.9 108.5 188.6Q116.9 188.4 122.5 188.2L121.4 192.5Q114.6 192.7 110.5 194.1Q106.5 195.5 105 199.1Q103.5 202.7 104.3 210.4L115.4 308.8L109.2 314ZM204.2 293Q213 289.6 220.9 285.4Q228.8 281.1 234.3 276Q242.7 268.5 247.7 258.6Q252.7 248.6 252.7 237.1Q252.7 232.8 251.8 231.5Q251 230.1 249.3 230.1Q244.6 230.1 239.1 234.9Q233.7 239.7 228.4 247.7Q223 255.7 218.6 265.9Q214.3 276.2 211.6 287.3Q208.9 298.4 208.9 308.8Q208.9 320.8 213.5 325.2Q218.1 329.5 225.4 329.5Q231.1 329.5 239.7 325.7Q248.2 321.9 256.5 312L259.9 313.7Q255.5 320.8 248.2 327.4Q240.9 334 231.3 338.2Q221.7 342.4 210.4 342.4Q200.8 342.4 193.2 338.9Q185.7 335.5 181.3 328.8Q176.9 322.1 176.9 312.3Q176.9 300.9 180.6 289Q184.4 277 191.2 265.8Q198 254.6 207.6 245.5Q217.3 236.5 229 231.2Q240.7 226 254 226Q263.4 226 269.8 230.2Q276.2 234.3 276.2 242.9Q276.2 251.2 271.6 258.5Q267 265.7 259.3 271.7Q251.6 277.7 242.1 282.4Q232.6 287.1 222.7 290.5Q212.8 293.9 204 295.8ZM306.7 321.2Q305.2 326.8 306.4 329.3Q307.6 331.9 310.3 331.9Q312.7 331.9 316.1 328.8Q319.5 325.7 323.1 315L327 304.8H331L325.7 320.4Q322.7 329.1 318 333.8Q313.3 338.5 308 340.4Q302.6 342.4 297.3 342.4Q290.3 342.4 286 339.9Q281.7 337.4 279.7 332.9Q277.7 328.3 278 322.1Q278.3 315.9 280.4 308.4L314 197Q316.1 189.7 313.5 186.3Q311 182.9 300.5 182.9L302 178.4Q317.4 178.2 329 175.9Q340.6 173.7 351.5 169.6ZM377.8 330.8Q381.2 330.8 385.3 327.2Q389.3 323.6 393.6 316.6Q397.9 309.7 401.9 299.7Q406 289.6 409.4 276.4L404.7 299.7Q399.3 315.5 392.9 324.8Q386.5 334.2 379.3 338.3Q372 342.4 364.1 342.4Q352.2 342.4 346.2 335.3Q340.2 328.3 340.2 316.1Q340.2 304.6 344.2 292Q348.1 279.4 354.8 267.6Q361.6 255.9 370 246.5Q378.4 237.1 387.9 231.6Q397.4 226 406.6 226Q413.7 226 417.5 231.6Q421.3 237.1 419.8 248.8L417.5 250.1Q418.6 242.4 416.7 238.2Q414.9 233.9 410.7 233.9Q406.4 233.9 401.2 238.8Q395.9 243.7 390.8 252.3Q385.7 260.8 381.3 271.6Q376.9 282.4 374.4 294.2Q371.8 306.1 371.8 317.6Q371.8 324.8 373.3 327.8Q374.8 330.8 377.8 330.8ZM423 229.2Q432.2 229 439.7 228.2Q447.2 227.5 454 226L426 321.2Q425.4 324 425.1 326.4Q424.8 328.9 425.7 330.4Q426.7 331.9 429 331.9Q431.8 331.9 435.2 328.6Q438.6 325.3 442.3 315L446.1 304.8H450.2L444.8 320.4Q441.8 329.1 437.1 333.8Q432.4 338.5 427.1 340.4Q421.8 342.4 416.6 342.4Q405.5 342.4 400.8 335.7Q397.6 331 398 324.1Q398.3 317.2 400.8 308.2Z"
      />
    </svg>
  );
}

/**
 * The number an operator sees for a profile: their custom NO. when set, else the
 * store serial, else the row's position. Mirrors profileDisplayNo in launcher.ts
 * so the roster, the browser window title and the identity bookmark agree.
 */
function displayNo(profile: UiProfile, fallbackIndex: number): { value: string; custom: boolean } {
  const custom = (profile.customNo ?? "").trim();
  if (custom) return { value: custom, custom: true };
  if (profile.serial != null) return { value: String(profile.serial), custom: false };
  return { value: String(fallbackIndex + 1), custom: false };
}

/**
 * Whether this profile's last measured fingerprint still matches the one its
 * import claimed. Renders nothing when there is no attestation to check
 * against — "unknown" must not look like "verified".
 */
function FingerprintBadge({ p }: { p: UiProfile }) {
  const v = p.fpVerdict;
  if (!v) return null;
  if (v.verdict === "match") {
    return (
      <span className="fpbadge ok" title={`Fingerprint verified against the import${p.fpCapturedAt ? ` — measured ${p.fpCapturedAt}` : ""}`}>
        verified
      </span>
    );
  }
  const detail = v.differences
    .map((d) => `${d.field}: ${d.expected || "(none)"} → ${d.observed || "(none)"}`)
    .join("; ");
  return (
    <span className="fpbadge warn" title={`This browser no longer matches the imported fingerprint — ${detail}`}>
      identity changed
    </span>
  );
}

function StatusDot({ running }: { running: boolean }) {
  return <span className={`dot ${running ? "on" : ""}`} title={running ? "running" : "stopped"} />;
}

function HealthSources({ sources }: { sources: HealthSource[] }) {
  if (sources.length === 0) return <div className="health-sources none">No health nodes</div>;
  return (
    <div className="health-sources" aria-label="Automation node freshness">
      {sources.map((source) => (
        <span
          key={source.sourceId}
          className={`health-source${source.stale ? " stale" : ""}`}
          title={`Last snapshot ${new Date(source.lastSnapshotAt).toLocaleString()}`}
        >
          <Icon name="activity" className="sm" />
          {source.sourceId} · {source.stale ? "stale" : "fresh"} · {new Date(source.lastSnapshotAt).toLocaleTimeString()}
        </span>
      ))}
    </div>
  );
}

/**
 * Real brand marks for the platforms a profile can target. A letter in a colored
 * box reads as a placeholder; the actual logo is what makes a row scannable at a
 * glance. Paths are the official single-color marks on a 24x24 grid, filled (not
 * stroked) — see .brandmark in styles.css. Tile colors live in CSS as .pm-*.
 */
const PLATFORM_MARKS: Record<string, { key: string; path: string }> = {
  "x.com": {
    key: "x",
    path: "M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.153h7.594l5.243 6.932ZM17.61 20.644h2.04L6.486 3.24H4.298Z",
  },
  "telegram.org": {
    key: "telegram",
    path: "M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-1.99.93l-5.49-4.05-2.65 2.55c-.3.3-.55.55-1.12.55l.4-5.63 10.24-9.25c.45-.4-.1-.62-.69-.22L6.44 13.09.2 11.14c-1.36-.42-1.38-1.36.28-2.01L22.17 1.8c1.13-.42 2.12.26 1.74 1.99Z",
  },
  "instagram.com": {
    key: "instagram",
    path: "M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.9 5.9 0 0 0-2.13 1.38A5.9 5.9 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91a5.9 5.9 0 0 0 1.38 2.13 5.9 5.9 0 0 0 2.13 1.38c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.9 5.9 0 0 0 2.13-1.38 5.9 5.9 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.9 5.9 0 0 0-1.38-2.13A5.9 5.9 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32ZM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0Z",
  },
  "facebook.com": {
    key: "facebook",
    path: "M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z",
  },
  "tiktok.com": {
    key: "tiktok",
    path: "M12.53.02C13.84 0 15.14.01 16.44 0c.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07Z",
  },
  "linkedin.com": {
    key: "linkedin",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13Zm1.78 13.02H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z",
  },
  "reddit.com": {
    key: "reddit",
    path: "M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0Zm6.07 6.53a1.4 1.4 0 0 1 1.4 1.4 1.4 1.4 0 0 1-.83 1.28c.02.15.03.3.03.45 0 2.87-3.44 5.2-7.67 5.2s-7.67-2.33-7.67-5.2c0-.16.01-.31.03-.46a1.4 1.4 0 1 1 1.58-2.28 7.6 7.6 0 0 1 4.1-1.31l.78-3.66a.34.34 0 0 1 .4-.26l2.6.55a1 1 0 1 1-.14.67l-2.24-.48-.7 3.3c1.5.06 2.9.5 4.05 1.2a1.4 1.4 0 0 1 1.28-.8ZM8.1 10.42a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm7.8 0a1.16 1.16 0 1 0 0 2.32 1.16 1.16 0 0 0 0-2.32Zm-7.6 4.9a.34.34 0 0 0-.24.58c.98.98 2.53 1.46 3.94 1.46s2.96-.48 3.94-1.46a.34.34 0 0 0-.48-.48c-.78.78-2.1 1.18-3.46 1.18s-2.68-.4-3.46-1.18a.34.34 0 0 0-.24-.1Z",
  },
  "youtube.com": {
    key: "youtube",
    path: "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  },
  "threads.com": {
    key: "threads",
    path: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z",
  },
  "pinterest.com": {
    key: "pinterest",
    path: "M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z",
  },
  "snapchat.com": {
    key: "snapchat",
    path: "M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06z",
  },
  "discord.com": {
    key: "discord",
    path: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  },
  "twitch.tv": {
    key: "twitch",
    path: "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z",
  },
  "gmail.com": {
    key: "gmail",
    path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  },
  "amazon.com": {
    key: "amazon",
    path: "M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.14c.138-.06.234-.1.293-.13.226-.088.39-.046.525.13.12.174.09.336-.12.48-.256.19-.6.41-1.006.654-1.244.743-2.64 1.316-4.185 1.726a17.617 17.617 0 01-10.951-.577 17.88 17.88 0 01-5.43-3.35c-.1-.074-.151-.15-.151-.22 0-.047.021-.09.051-.13zm6.565-6.218c0-1.005.247-1.863.743-2.577.495-.71 1.17-1.25 2.04-1.615.796-.335 1.756-.575 2.912-.72.39-.046 1.033-.103 1.92-.174v-.37c0-.93-.105-1.558-.3-1.875-.302-.43-.78-.65-1.44-.65h-.182c-.48.046-.896.196-1.246.46-.35.27-.575.63-.675 1.096-.06.3-.206.465-.435.51l-2.52-.315c-.248-.06-.372-.18-.372-.39 0-.046.007-.09.022-.15.247-1.29.855-2.25 1.82-2.88.976-.616 2.1-.975 3.39-1.05h.54c1.65 0 2.957.434 3.888 1.29.135.15.27.3.405.48.12.165.224.314.283.45.075.134.15.33.195.57.06.254.105.42.135.51.03.104.062.3.076.615.01.313.02.493.02.553v5.28c0 .376.06.72.165 1.036.105.313.21.54.315.674l.51.674c.09.136.136.256.136.36 0 .12-.06.226-.18.314-1.2 1.05-1.86 1.62-1.963 1.71-.165.135-.375.15-.63.045a6.062 6.062 0 01-.526-.496l-.31-.347a9.391 9.391 0 01-.317-.42l-.3-.435c-.81.886-1.603 1.44-2.4 1.665-.494.15-1.093.227-1.83.227-1.11 0-2.04-.343-2.76-1.034-.72-.69-1.08-1.665-1.08-2.94l-.05-.076zm3.753-.438c0 .566.14 1.02.425 1.364.285.34.675.512 1.155.512.045 0 .106-.007.195-.02.09-.016.134-.023.166-.023.614-.16 1.08-.553 1.424-1.178.165-.28.285-.58.36-.91.09-.32.12-.59.135-.8.015-.195.015-.54.015-1.005v-.54c-.84 0-1.484.06-1.92.18-1.275.36-1.92 1.17-1.92 2.43l-.035-.02zm9.162 7.027c.03-.06.075-.11.132-.17.362-.243.714-.41 1.05-.5a8.094 8.094 0 011.612-.24c.14-.012.28 0 .41.03.65.06 1.05.168 1.172.33.063.09.099.228.099.39v.15c0 .51-.149 1.11-.424 1.8-.278.69-.664 1.248-1.156 1.68-.073.06-.14.09-.197.09-.03 0-.06 0-.09-.012-.09-.044-.107-.12-.064-.24.54-1.26.806-2.143.806-2.64 0-.15-.03-.27-.087-.344-.145-.166-.55-.257-1.224-.257-.243 0-.533.016-.87.046-.363.045-.7.09-1 .135-.09 0-.148-.014-.18-.044-.03-.03-.036-.047-.02-.077 0-.017.006-.03.02-.063v-.06z",
  },
  "ebay.com": {
    key: "ebay",
    path: "M6.056 12.132v-4.92h1.2v3.026c.59-.703 1.402-.906 2.202-.906 1.34 0 2.828.904 2.828 2.855 0 .233-.015.457-.06.668.24-.953 1.274-1.305 2.896-1.344.51-.018 1.095-.018 1.56-.018v-.135c0-.885-.556-1.244-1.53-1.244-.72 0-1.245.3-1.305.81h-1.275c.136-1.29 1.5-1.62 2.686-1.62 1.064 0 1.995.27 2.415 1.02l-.436-.84h1.41l2.055 4.125 2.055-4.126H24l-3.72 7.305h-1.346l1.07-2.04-2.33-4.38c.13.255.2.555.2.93v2.46c0 .346.01.69.04 1.005H16.8a6.543 6.543 0 01-.046-.765c-.603.734-1.32.96-2.32.96-1.48 0-2.272-.78-2.272-1.695 0-.15.015-.284.037-.405-.3 1.246-1.36 2.086-2.767 2.086-.87 0-1.694-.315-2.2-.93 0 .24-.015.494-.04.734h-1.18c.02-.39.04-.855.04-1.245v-1.05h-4.83c.065 1.095.818 1.74 1.853 1.74.718 0 1.355-.3 1.568-.93h1.24c-.24 1.29-1.61 1.725-2.79 1.725C.95 15.009 0 13.822 0 12.232c0-1.754.982-2.91 3.116-2.91 1.688 0 2.93.886 2.94 2.806v.005zm9.137.183c-1.095.034-1.77.233-1.77.95 0 .465.36.97 1.305.97 1.26 0 1.935-.69 1.935-1.814v-.13c-.45 0-.99.006-1.484.022h.012zm-6.06 1.875c1.11 0 1.876-.806 1.876-2.02s-.768-2.02-1.893-2.02c-1.11 0-1.89.806-1.89 2.02s.765 2.02 1.875 2.02h.03zm-4.35-2.514c-.044-1.125-.854-1.546-1.725-1.546-.944 0-1.694.474-1.815 1.546z",
  },
  "etsy.com": {
    key: "etsy",
    path: "M8.559 2.445c0-.325.033-.52.59-.52h7.465c1.3 0 2.02 1.11 2.54 3.193l.42 1.666h1.27c.23-4.728.43-6.784.43-6.784s-3.196.36-5.09.36H6.635L1.521.196v1.37l1.725.326c1.21.24 1.5.496 1.6 1.606 0 0 .11 3.27.11 8.64 0 5.385-.09 8.61-.09 8.61 0 .973-.39 1.333-1.59 1.573l-1.722.33V24l5.13-.165h8.55c1.935 0 6.39.165 6.39.165.105-1.17.75-6.48.855-7.064h-1.2l-1.284 2.91c-1.005 2.28-2.476 2.445-4.11 2.445h-4.906c-1.63 0-2.415-.64-2.415-2.05V12.8s3.62 0 4.79.096c.912.064 1.463.325 1.76 1.598l.39 1.695h1.41l-.09-4.278.192-4.305h-1.391l-.45 1.89c-.283 1.244-.48 1.47-1.754 1.6-1.666.17-4.815.14-4.815.14V2.45h-.05z",
  },
};

const KNOWN_PLATFORMS: { value: string; label: string }[] = [
  { value: "", label: "No platform" },
  { value: "x.com", label: "Twitter / X" },
  { value: "instagram.com", label: "Instagram" },
  { value: "facebook.com", label: "Facebook" },
  { value: "tiktok.com", label: "TikTok" },
  { value: "linkedin.com", label: "LinkedIn" },
  { value: "reddit.com", label: "Reddit" },
  { value: "telegram.org", label: "Telegram" },
  { value: "youtube.com", label: "YouTube" },
  { value: "threads.com", label: "Threads" },
  { value: "pinterest.com", label: "Pinterest" },
  { value: "snapchat.com", label: "Snapchat" },
  { value: "discord.com", label: "Discord" },
  { value: "twitch.tv", label: "Twitch" },
  { value: "gmail.com", label: "Gmail" },
  { value: "amazon.com", label: "Amazon" },
  { value: "ebay.com", label: "eBay" },
  { value: "etsy.com", label: "Etsy" },
];

function PlatformPill({ platform }: { platform: string }) {
  if (!platform) return <span className="muted">—</span>;
  const known = KNOWN_PLATFORMS.find((candidate) => candidate.value === platform);
  const mark = PLATFORM_MARKS[platform];
  return (
    <span className="platform-pill" title={platform}>
      <span className={`glyph pm-${mark?.key ?? "other"}`}>
        {mark
          ? <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={mark.path} /></svg>
          : platform.slice(0, 1).toUpperCase()}
      </span>
      {known?.label ?? platform}
    </span>
  );
}

/**
 * Group selector used in every dialog: a styled <Select> of existing groups
 * plus "New group…", which flips to an inline text field so you can create a
 * group on the fly. Consistent with the other modal selects (no native datalist).
 */
function GroupPicker({ value, onChange, groups, allowCreate = true }: { value: string; onChange: (v: string) => void; groups: string[]; allowCreate?: boolean }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  if (creating) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder="new group name" value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip={t("Pick an existing group")} title={t("Pick an existing group")} onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>
    );
  }
  return (
    <Select
      value={groups.includes(value) ? value : ""}
      onChange={(e) => {
        if (e.target.value === "__new__") { setCreating(true); onChange(""); }
        else onChange(e.target.value);
      }}
    >
      <option value="">{t("(ungrouped)")}</option>
      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
      {allowCreate && <option value="__new__">{t("New group…")}</option>}
    </Select>
  );
}

function PlatformPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const known = KNOWN_PLATFORMS.some((p) => p.value === value);
  const [creating, setCreating] = useState(false);
  if (creating || (!!value && !known)) {
    return (
      <div className="grouppick">
        <input autoFocus placeholder={t("new platform (e.g. linkedin.com)")} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn gp-back tip" data-tip={t("Pick a known platform")} title={t("Pick a known platform")} onClick={() => { setCreating(false); onChange(""); }}><Icon name="chevronLeft" /></button>
      </div>
    );
  }
  return (
    <Select value={value} onChange={(e) => { if (e.target.value === "__new__") { setCreating(true); onChange(""); } else onChange(e.target.value); }}>
      {KNOWN_PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.value ? p.label : t(p.label)}</option>)}
      <option value="__new__">{t("New platform…")}</option>
    </Select>
  );
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy failed");
}

function CopyField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyPlainText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="fld grow">
      <span>{label}</span>
      {/* Copy sits inside the field rather than beside it: a separate bordered
          button per credential turned the dialog into a grid of grey boxes. */}
      <div className="inputwrap">
        <input value={value} onChange={(event) => onChange(event.target.value)} />
        <button
          type="button"
          className={`inline-action tip${copied ? " ok" : ""}`}
          data-tip={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
          aria-label={`Copy ${label}`}
          onClick={copy}
        >
          <Icon name={copied ? "check" : "copy"} className="sm" />
        </button>
      </div>
    </div>
  );
}

const AUTOMATIC_FINGERPRINT_FIELDS = [
  ["User agent", "Automatic"],
  ["Browser version", "Automatic · latest installed"],
  ["GPU", "Automatic"],
  ["CPU", "Automatic"],
  ["RAM", "Automatic"],
  ["Fingerprint seed", "Automatic · unique and stable"],
  ["Timezone", "Stored · set from the proxy automatically"],
  ["Canvas / WebGL / audio", "Automatic"],
  ["WebRTC", "Automatic · proxy-aware"],
] as const;

// A template literal, so the translation key holds the same line breaks as the source.
/** What an import brought in, for the notice after it. */
function importedSummary(
  result: { profiles?: number; files?: number; errors?: readonly unknown[] },
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  const summary = t("Imported {profiles} profile(s) from {files} file(s).", { profiles: result.profiles ?? 0, files: result.files ?? 0 });
  return result.errors?.length
    ? summary + "\n\n" + t("{count} invalid record(s) were reported; invalid proxies were quarantined for repair.", { count: result.errors.length })
    : summary;
}

const FINGERPRINT_EDIT_WARNING = `These settings work together. Changing them can create an inconsistent fingerprint, make your browser easier to detect, or trigger account verification. We recommend automatic settings. Custom changes are your responsibility.

Save fingerprint changes?`;

const CLOAKBROWSER_NOTE = "CloakBrowser profiles on one computer can be linked to each other. Use Vela Chromium or Vela Firefox for separate identities.";

const WEBKIT_NOTE = "Independent process and storage; saved language, timezone and screen. Canvas, audio, fonts and GPU have no per-profile spoofing. This runtime is not Safari.";

function browserLabel(engine: "chromium" | "firefox" | "webkit", chromiumRuntime?: string): string {
  if (engine === "webkit") return "WebKit";
  if (engine === "firefox") return "Vela Firefox";
  return chromiumRuntime ? "Vela Chromium" : "CloakBrowser";
}

function FingerprintSettings({
  engine,
  chromiumRuntime,
  screen,
  onScreenChange,
  platformOs,
  onPlatformOsChange,
  timezone,
  onTimezoneChange,
  locale,
  onLocaleChange,
  cores,
  onCoresChange,
  seed,
  onSeedChange,
  disabled = false,
  onUndo,
  hardware,
}: {
  engine: "chromium" | "firefox" | "webkit";
  chromiumRuntime?: string;
  screen: string;
  onScreenChange: (value: string) => void;
  platformOs: string;
  onPlatformOsChange?: (value: string) => void;
  timezone?: string;
  onTimezoneChange?: (value: string) => void;
  locale?: string;
  onLocaleChange?: (value: string) => void;
  cores?: string;
  onCoresChange?: (value: string) => void;
  seed?: string;
  onSeedChange?: (value: string) => void;
  disabled?: boolean;
  onUndo?: () => void;
  hardware?: { gpu?: string; cores?: number };
}) {
  const { t } = useTranslation();
  return (
    <details className="fingerprint-settings">
      <summary>
        <span>{t("Fingerprint settings")}</span>
        <span className="automatic-badge">{onTimezoneChange ? t("Advanced") : t("Automatic")}</span>
      </summary>
      <div className="fingerprint-grid">
        <label className="fld">
          <span>{t("Browser")}</span>
          <input value={browserLabel(engine, chromiumRuntime)} readOnly tabIndex={-1} className="ro" />
        </label>
        <label className="fld">
          <span>{t("Screen")}</span>
          <input value={screen} disabled={disabled} placeholder={t("Automatic · e.g. 1920x1080")} onChange={(event) => onScreenChange(event.target.value)} />
        </label>
        <label className="fld">
          <span>{t("Operating system")}</span>
          {onPlatformOsChange && engine !== "webkit" ? (
            <Select value={platformOs} disabled={disabled} onChange={(event) => onPlatformOsChange(event.target.value)}>
              <option value="">{t("Automatic — match this computer")}</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </Select>
          ) : (
            <input value={{ windows: "Windows", macos: "macOS", linux: "Linux" }[platformOs] ?? "Automatic"} readOnly tabIndex={-1} className="ro" />
          )}
        </label>
        {onTimezoneChange && (
          <label className="fld">
            <span>{t("Timezone")}</span>
            <input value={timezone ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. Europe/Paris")} onChange={(event) => onTimezoneChange(event.target.value)} />
          </label>
        )}
        {onLocaleChange && (
          <label className="fld">
            <span>{t("Language")}</span>
            <input value={locale ?? ""} disabled={disabled} placeholder={t("Automatic · e.g. en-US")} onChange={(event) => onLocaleChange(event.target.value)} />
          </label>
        )}
        {onCoresChange && engine !== "webkit" && (
          <label className="fld">
            <span>{t("CPU")}</span>
            <input value={cores ?? ""} disabled={disabled} inputMode="numeric" placeholder={hardware?.cores ? t("Automatic · {n} cores", { n: hardware.cores }) : t("Automatic · e.g. 8")} onChange={(event) => onCoresChange(event.target.value)} />
          </label>
        )}
        {onSeedChange && engine !== "webkit" && (
          <label className="fld">
            <span>{t("Fingerprint seed")}</span>
            <input value={seed ?? ""} disabled={disabled} inputMode="numeric" onChange={(event) => onSeedChange(event.target.value)} />
          </label>
        )}
        {(engine === "webkit" ? [
          ["User agent", "WebKit default"], ["Browser version", "WebKit 27.2 · pinned"],
          ["GPU", "Engine default"], ["CPU", "Engine default"], ["RAM", "Engine default"],
          ["Timezone", "Stored · set from the proxy automatically"], ["Canvas / WebGL / audio", "Engine default · no fingerprint spoofing"], ["WebRTC", "Unavailable in this build"],
        ] : AUTOMATIC_FINGERPRINT_FIELDS).filter(([label]) => !(
          (label === "Timezone" && onTimezoneChange) || (label === "CPU" && onCoresChange) || (label === "Fingerprint seed" && onSeedChange)
        )).map(([label, value]) => {
          // A stored value is the same on every computer that opens the profile.
          const stored = label === "GPU" ? hardware?.gpu : label === "CPU" && hardware?.cores ? `${hardware.cores} cores` : undefined;
          return (
            <label className="fld" key={label}>
              <span>{t(label)}</span>
              <input value={stored ? `Stored · ${stored}` : t(value)} title={stored} readOnly tabIndex={-1} className="ro" />
            </label>
          );
        })}
        <div className="hint">{t("We recommend keeping every setting automatic. Custom values can make the browser look inconsistent, easier to detect, and can trigger account checks.")}</div>
        <div className="hint">{engine === "webkit" ? t(WEBKIT_NOTE) : onTimezoneChange
          ? `${t("Leave a field blank to keep it automatic. A timezone you type stays when the proxy changes.")}${chromiumRuntime && cores ? ` ${t("Vela Chromium shows at most the processor count of the computer it runs on.")}` : ""}`
          : engine === "firefox"
            ? t("Vela Firefox uses its native profile. CDP, PDF, and Chrome extensions are unavailable.")
            : t("The browser keeps the locked values coordinated. Screen and operating system are the only fingerprint settings you can override.")}</div>
        {onUndo && <button type="button" className="btn ghost" disabled={disabled} onClick={onUndo}>{t("Undo fingerprint edits")}</button>}
      </div>
    </details>
  );
}

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type DesktopUpdateStatus =
  | { state: "upToDate"; currentVersion: string }
  | { state: "available"; currentVersion: string; version: string; highlights: string[] };
type DesktopUpdateProgress =
  | { phase: "preparing" | "reconnecting" | "verifying" | "closingBrowsers" | "installing" }
  | { phase: "downloading"; percent: number | null; downloadedBytes: number; totalBytes: number | null };
type DesktopUpdateMessage =
  | DesktopUpdateProgress
  | { phase: "ready"; version: string; highlights: string[] };
function isUpdateHighlights(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 3 && value.every((highlight) => typeof highlight === "string");
}

function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!value || typeof value !== "object") throw new Error("Vela Browser returned an invalid update status.");
  const status = value as Record<string, unknown>;
  if (status.state === "upToDate" && typeof status.currentVersion === "string") {
    return { state: "upToDate", currentVersion: status.currentVersion };
  }
  if (
    status.state === "available" &&
    typeof status.currentVersion === "string" &&
    typeof status.version === "string" &&
    isUpdateHighlights(status.highlights)
  ) {
    return {
      state: "available",
      currentVersion: status.currentVersion,
      version: status.version,
      highlights: status.highlights,
    };
  }
  throw new Error("Vela Browser returned an invalid update status.");
}

function parseDesktopUpdateMessage(value: unknown): DesktopUpdateMessage {
  if (!value || typeof value !== "object") throw new Error("Vela Browser returned invalid update progress.");
  const progress = value as Record<string, unknown>;
  if (progress.phase === "ready" && typeof progress.version === "string" && isUpdateHighlights(progress.highlights)) {
    return { phase: "ready", version: progress.version, highlights: progress.highlights };
  }
  if (
    progress.phase === "preparing" ||
    progress.phase === "reconnecting" ||
    progress.phase === "verifying" ||
    progress.phase === "closingBrowsers" ||
    progress.phase === "installing"
  ) {
    return { phase: progress.phase };
  }
  const isByteCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (
    progress.phase === "downloading" &&
    (progress.percent === null ||
      (typeof progress.percent === "number" && Number.isInteger(progress.percent) && progress.percent >= 0 && progress.percent <= 100)) &&
    isByteCount(progress.downloadedBytes) &&
    (progress.totalBytes === null || isByteCount(progress.totalBytes))
  ) {
    return {
      phase: "downloading",
      percent: progress.percent as number | null,
      downloadedBytes: progress.downloadedBytes,
      totalBytes: progress.totalBytes as number | null,
    };
  }
  throw new Error("Vela Browser returned invalid update progress.");
}

function desktopInvoke(): DesktopInvoke | undefined {
  return (window as any).__TAURI_INTERNALS__?.invoke as DesktopInvoke | undefined;
}

function UpdateHighlights({ version, highlights }: { version: string; highlights: string[] }) {
  if (highlights.length === 0) return null;
  return (
    <details className="update-highlights">
      <summary>What’s new in {version}</summary>
      <ul>{highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    </details>
  );
}

function DesktopUpdateProgressView({ progress }: { progress: DesktopUpdateProgress }) {
  const { t } = useTranslation();
  const percent = progress.phase === "downloading" ? progress.percent : null;
  const label = progress.phase === "preparing"
    ? t("Preparing update…")
    : progress.phase === "downloading"
      ? percent === null ? t("Downloading update…") : t("Downloading update… {percent}%", { percent: String(percent) })
      : progress.phase === "reconnecting"
        ? t("Connection lost. Reconnecting…")
        : progress.phase === "verifying"
          ? t("Verifying update…")
          : progress.phase === "closingBrowsers"
            ? t("Saving and closing browsers…")
            : t("Installing and restarting…");
  // Megabytes received, so a slow download still shows movement between percent steps.
  const size = progress.phase !== "downloading"
    ? null
    : progress.totalBytes === null
      ? t("{downloaded} MB", { downloaded: String(Math.floor(progress.downloadedBytes / 1e6)) })
      : t("{downloaded} of {total} MB", {
        downloaded: String(Math.floor(progress.downloadedBytes / 1e6)),
        total: String(Math.ceil(progress.totalBytes / 1e6)),
      });
  return (
    <div className="update-progress" role="status">
      <span>{size ? `${label} ${size}` : label}</span>
      <progress max={100} value={percent ?? undefined} aria-label="Update progress" />
    </div>
  );
}

/** Percent of the bytes these browser downloads have received. */
function downloadPercent(downloads: RuntimeDownload[]): number {
  const total = downloads.reduce((sum, download) => sum + download.totalBytes, 0);
  const received = downloads.reduce((sum, download) => sum + download.receivedBytes, 0);
  return Math.floor(received * 100 / total);
}

/** The browser downloads that opening this profile waits for. */
function profileDownloads(profile: UiProfile, downloads: RuntimeDownload[]): RuntimeDownload[] {
  const runtime = profile.engine === "webkit" ? "webkit" : profile.engine === "firefox" ? "firefox" : profile.chromiumRuntime ?? "cloakbrowser";
  return downloads.filter((download) => download.runtime === runtime);
}

function RuntimeDownloadProgressView({ downloads }: { downloads: RuntimeDownload[] }) {
  const { t } = useTranslation();
  const percent = downloadPercent(downloads);
  return (
    <div className="update-progress" role="status">
      <span>{t("Downloading browser… {percent}%", { percent: String(percent) })}</span>
      <progress max={100} value={percent} aria-label={t("Browser download progress")} />
    </div>
  );
}

const BLANK_FORM = {
  name: "", engine: "chromium" as "chromium" | "firefox" | "webkit", chromiumRuntime: "" as "" | "aliasmode", group: "", platform: "", proxyType: "http", host: "", port: "", user: "", pass: "",
  screen: "", platformOs: "", customNo: "", username: "", password: "", email: "", emailPassword: "", twofa: "",
};
const BLANK_COOKIE_FORM = { name: "", value: "", domain: "", path: "/" };

type ProxyCheckUiState = {
  checking: boolean;
  result: ProxyCheckResult | null;
  error: "invalid" | "unavailable" | null;
};

const EMPTY_PROXY_CHECK: ProxyCheckUiState = { checking: false, result: null, error: null };

function proxyFailureMessage(t: (s: string) => string, reason: ProxyCheckResult["reason"]): string {
  if (reason === "authentication_failed") return t("Proxy authentication failed.");
  if (reason === "timeout") return t("Proxy connection timed out.");
  if (reason === "dns_failed") return t("Proxy host could not be resolved.");
  if (reason === "unreachable") return t("Proxy server is unreachable.");
  if (reason === "proxy_bypassed") return t("Traffic did not use this proxy.");
  return t("Proxy connection failed.");
}

function ProxyCheckFeedback({ hasProxy, state }: { hasProxy: boolean; state: ProxyCheckUiState }) {
  const { t } = useTranslation();
  if (!hasProxy) return null;
  if (state.error) {
    const invalid = state.error === "invalid";
    return (
      <div className={`proxy-check-result ${invalid ? "failed" : "unavailable"}`} role="status">
        <Icon name={invalid ? "alert" : "activity"} className="sm" />
        <span>{invalid
          ? t("Proxy details are invalid. Check them and try again.")
          : t("Proxy check is unavailable. Try again later.")}</span>
      </div>
    );
  }
  const result = state.result;
  if (!result) return null;
  const location = [result.city, result.region, result.country].filter(Boolean).join(", ");
  const exit = [result.ip ? `Exit IP: ${result.ip}` : "", location].filter(Boolean).join(" · ");
  if (result.status === "working") {
    return (
      <div className="proxy-check-result working" role="status">
        <Icon name="check" className="sm" />
        <span><strong>{t("Proxy is working.")}</strong>{exit && <> {exit}.</>}{result.rotating && <> Rotating exit IPs detected.</>}</span>
      </div>
    );
  }
  if (result.status === "unstable") {
    return (
      <div className="proxy-check-result unstable" role="status">
        <Icon name="warning" className="sm" />
        <span><strong>{t("Proxy checks were mixed.")}</strong> {result.successes} of {result.attempts} succeeded.</span>
      </div>
    );
  }
  if (result.status === "failed") {
    return (
      <div className="proxy-check-result failed" role="status">
        <Icon name="alert" className="sm" />
        <span>{proxyFailureMessage(t, result.reason)}</span>
      </div>
    );
  }
  return (
    <div className="proxy-check-result unavailable" role="status">
      <Icon name="activity" className="sm" />
      <span>{t("Proxy check is unavailable. Try again later.")}</span>
    </div>
  );
}

function App() {
  const { t, language, setLanguage } = useTranslation();
  const dockNav = useRef<HTMLElement>(null);
  const [profiles, setProfiles] = useState<UiProfile[]>([]);
  const [registeredGroups, setRegisteredGroups] = useState<string[]>([]);
  const [localFolders, setLocalFolders] = useState<FolderInfo[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [sharedOnly, setSharedOnly] = useState(false);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [folderMenuPosition, setFolderMenuPosition] = useState({ left: 0, top: 0 });
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [movingFolder, setMovingFolder] = useState<string | null>(null);
  const [folderParent, setFolderParent] = useState("");
  const [folderMoveBusy, setFolderMoveBusy] = useState(false);
  const [folderMoveErr, setFolderMoveErr] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<AppModeConfig | null>(null);
  // "profiles" is the roster; "settings" replaces it in the same content area
  // rather than opening a dialog — Settings outgrew a modal. New profile and
  // Edit stay dialogs: short forms, and a page felt like too much ceremony.
  // The wall is home: every other section rises over it as a sheet.
  const [view, setView] = useState<"profiles" | "workbench" | "scripts" | "settings" | "extensions" | "proxies" | "trash">("workbench");
  const [dockGroups, setDockGroups] = useState(false);
  useEffect(() => {
    if (!dockGroups) return;
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest?.(".sidesection, .dock-groups")) setDockGroups(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setDockGroups(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [dockGroups]);
  const [scriptRunOpen, setScriptRunOpen] = useState(false);
  const [workbenchLocate, setWorkbenchLocate] = useState({ id: "", revision: 0 });
  const [searchScriptId, setSearchScriptId] = useState<string>();
  const [scriptRunProfiles, setScriptRunProfiles] = useState<UiProfile[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [createProxyOpen, setCreateProxyOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [healthSources, setHealthSources] = useState<HealthSource[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [desktopUpdateResult, setDesktopUpdateResult] = useState<DesktopUpdateResult | null>(null);
  const [desktopUpdateResultDismissed, setDesktopUpdateResultDismissed] = useState(false);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const [desktopUpdateInstalling, setDesktopUpdateInstalling] = useState(false);
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<DesktopUpdateProgress | null>(null);
  const [desktopUpdateErr, setDesktopUpdateErr] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | undefined>(undefined);
  const [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null);
  const [diskWarningDismissed, setDiskWarningDismissed] = useState(false);
  const [logView, setLogView] = useState<{ file: string; content: string } | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [diag, setDiag] = useState<DiagnoseReport | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [statusFilter, setStatusFilter] = useState<ProfileStatusFilter>("all");
  const [engineFilter, setEngineFilter] = useState<ProfileEngineFilter>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [profilePage, setProfilePage] = useState(0);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "no", dir: 1 });
  const [hiddenCols, setHiddenCols] = useState<Set<ColumnKey>>(readHiddenColumns);
  const [colsOpen, setColsOpen] = useState(false);
  const [nodesOpen, setNodesOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [tableScrolled, setTableScrolled] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [runtimeDownloads, setRuntimeDownloads] = useState<RuntimeDownload[]>([]);
  // Two error slots so an auto-refresh can't silently wipe why an action failed:
  // actionErr is sticky (Open/Close/move/import), connErr tracks load() only.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // transient success banner
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const deleteInFlight = useRef(false);
  const rosterLoader = useRef(serialLoader(() => loadRoster()));
  // Active profile export: null when idle, otherwise how far the server-side
  // collection has progressed ({completed: total} = file being built).
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [newMode, setNewMode] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [dragging, setDragging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [createBatch, setCreateBatch] = useState(false);
  const [createCount, setCreateCount] = useState("5");
  const [createPattern, setCreatePattern] = useState("Studio {n:2}");
  const [createStart, setCreateStart] = useState("1");
  const [createItems, setCreateItems] = useState<BatchCreateItem[]>([]);
  const [createStopping, setCreateStopping] = useState(false);
  const createInFlight = useRef(false);
  const createStopRequested = useRef(false);
  const [createProxyCheck, setCreateProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const createProxyCheckGeneration = useRef(0);
  const [cookieTargets, setCookieTargets] = useState<UiProfile[] | null>(null);
  const [cookieForm, setCookieForm] = useState(BLANK_COOKIE_FORM);
  const [cookieText, setCookieText] = useState("");
  const [cookieErr, setCookieErr] = useState<string | null>(null);
  const [cookieSaving, setCookieSaving] = useState(false);
  const [pendingView, setPendingView] = useState<{ profile: UiProfile; cookies: Array<{ domain: string; name: string }> | null; error: string | null; busy: boolean } | null>(null);
  const [fingerprintView, setFingerprintView] = useState<{ profile: UiProfile; audit: FingerprintAudit | null; error: string | null } | null>(null);
  const fingerprintRequest = useRef(0);
  const [proxyPaste, setProxyPaste] = useState("");
  const [proxyPasteOk, setProxyPasteOk] = useState<string | null>(null);
  // Edit modal + bulk export/update + group rename
  const [editId, setEditId] = useState<string | null>(null);
  const [editExpectedVersion, setEditExpectedVersion] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editInitialFingerprint, setEditInitialFingerprint] = useState<Record<string, string>>({});
  const [editInitialProxy, setEditInitialProxy] = useState({ proxy: "", proxyType: "http" });
  const [editProxyCheck, setEditProxyCheck] = useState<ProxyCheckUiState>(EMPTY_PROXY_CHECK);
  const editProxyCheckGeneration = useRef(0);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  // Null until the profile detail loads, so a failed load never names a browser.
  const [editEngine, setEditEngine] = useState<"chromium" | "firefox" | "webkit" | null>(null);
  const [editChromiumRuntime, setEditChromiumRuntime] = useState("");
  const [editHardware, setEditHardware] = useState<{ gpu?: string; cores?: number } | undefined>();
  const [timezoneBusy, setTimezoneBusy] = useState(false);
  const editFetchId = useRef<string | null>(null);
  const [editMobile, setEditMobile] = useState<NonNullable<EditProfile["desktopConversion"]> | null>(null);
  const [editTotp, setEditTotp] = useState<{ code: string; secs: number } | null>(null);
  const [twoFaFlash, setTwoFaFlash] = useState<{ id: string; code: string } | null>(null);
  const [editExts, setEditExts] = useState<string[]>([]);
  const [editInitialExts, setEditInitialExts] = useState<string[]>([]);
  // Local extension registry + Extensions page
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [groupExtensionDefaults, setGroupExtensionDefaultsState] = useState<GroupExtensionDefaults[]>([]);
  const [groupDefaultName, setGroupDefaultName] = useState("");
  const [groupDefaultExts, setGroupDefaultExts] = useState<string[]>([]);
  const [groupDefaultBusy, setGroupDefaultBusy] = useState(false);
  const [extSource, setExtSource] = useState("");
  const [extInstallBusy, setExtInstallBusy] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extErr, setExtErr] = useState<string | null>(null);
  const extFileRef = useRef<HTMLInputElement>(null);
  const [bulkExt, setBulkExt] = useState(""); // extension chosen for bulk assign
  // Update-from-file modal (export → edit → re-upload, matched by id)
  const [showUpdate, setShowUpdate] = useState(false);
  const [updateFile, setUpdateFile] = useState<File | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [updateOver, setUpdateOver] = useState(false);
  const updateFileRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [sidebarGroupName, setSidebarGroupName] = useState("");
  // Bulk add accounts from provider files or pasted AdsPower text.
  const [showBulk, setShowBulk] = useState(false);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkText, setBulkText] = useState("");
  const [bulkGroup, setBulkGroup] = useState("");
  const [bulkPlatform, setBulkPlatform] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkOver, setBulkOver] = useState(false);
  // One source at a time: two full-height inputs stacked made it ambiguous which
  // one the Import button would actually read.
  const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");
  // After an import, offer proxies for the profiles that have none, until dismissed.
  const [showImportOffer, setShowImportOffer] = useState(false);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const publishedRuntimeReadiness = useRef<string | null>(null);
  const [runtimeReadinessAttempt, setRuntimeReadinessAttempt] = useState(0);
  const desktopUpdateCheckStarted = useRef(false);
  // Only public proxy addresses are needed for the missing-proxy count.
  const profilesWithoutProxy = profiles.filter((p) => !p.proxy?.trim()).length;
  const workspaceReady = appMode !== null;
  const managementScope = "local";
  const creationScope = useRef(managementScope);
  creationScope.current = managementScope;
  useEffect(() => {
    setStatusFilter("all"); setEngineFilter("all"); setTagFilter(""); setDetailId(null);
    setQ(""); setGroup("all"); setSharedOnly(false); setSelected(new Set());
    createStopRequested.current = true;
    if (!createInFlight.current) { setShowCreate(false); setCreateItems([]); }
  }, [managementScope]);
  // The app resolves "system" itself and stamps the result on <html>, so the
  // stylesheet carries exactly one dark palette instead of a duplicated media query.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    // Only follow the OS while the operator has actually asked us to.
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // Escape closes whatever dialog is open, topmost first — standard desktop
  // behavior the mouse-only close buttons don't cover.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector("dialog[open]")) return;

      if (movingFolder) { if (!folderMoveBusy) setMovingFolder(null); return; }

      if (logView || logErr) { setLogView(null); setLogErr(null); return; }
      if (showUpdate) { setShowUpdate(false); return; }
      if (showBulk) { closeBulk(); return; }
      if (pendingView) { if (!pendingView.busy) setPendingView(null); return; }
      if (cookieTargets) { if (!cookieSaving) closeCookie(); return; }
      if (editId) { closeEdit(); return; }
      if (showCreate) { closeCreate(); return; }
      // Nothing left to close: Escape puts the sheet away and returns to the wall.
      if (view !== "workbench" && !event.defaultPrevented && !document.querySelector('.popover, [role="dialog"], [aria-modal="true"]')
        && !(event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]")) setView("workbench");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const reloadGroupExtensionDefaults = async () => {
    try {
      setGroupExtensionDefaultsState(await fetchGroupExtensionDefaults());
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error));
    }
  };

  // One roster request at a time: on a slow link a large roster takes longer
  // than the poll interval, and stacked requests share the bandwidth until
  // every one of them fails.
  const { load, poll: pollRoster } = rosterLoader.current;

  const loadRoster = async () => {
    try {
      const roster = await fetchProfiles();
      setProfiles(roster.profiles);
      setRegisteredGroups(roster.groups);
      setLocalFolders(roster.folders ?? []);
      setHealthSources(roster.healthSources);
      setConnErr(null); // manages connectivity only; never clears an action error
    } catch (e) {
      setConnErr(String(e));
    } finally {
      setLoaded(true);
    }
  };

  const checkDesktopUpdate = async (manual: boolean) => {
    const invoke = desktopInvoke();
    if (!invoke) {
      if (manual) setDesktopUpdateErr("Updates are available only in the desktop app.");
      return;
    }
    setDesktopUpdateChecking(true);
    if (manual) setDesktopUpdateErr(null);
    try {
      setDesktopUpdate(parseDesktopUpdateStatus(await invoke("check_for_updates")));
    } catch (error) {
      if (manual) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
    } finally {
      setDesktopUpdateChecking(false);
    }
  };

  const installDesktopUpdate = async () => {
    const invoke = desktopInvoke();
    if (!invoke || desktopUpdate?.state !== "available") return;
    const onProgress = new Channel<unknown>();
    onProgress.onmessage = (value) => {
      try {
        const message = parseDesktopUpdateMessage(value);
        if (message.phase === "ready") {
          setDesktopUpdate((status) => status?.state === "available"
            ? { ...status, version: message.version, highlights: message.highlights }
            : status);
        } else {
          setDesktopUpdateProgress(message);
        }
      } catch { /* Ignore malformed native progress without interrupting the update. */ }
    };
    setDesktopUpdateInstalling(true);
    setDesktopUpdateProgress({ phase: "preparing" });
    setDesktopUpdateErr(null);
    try {
      await invoke("update_now", { onProgress });
    } catch (error) {
      setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      setDesktopUpdateProgress(null);
      setDesktopUpdateInstalling(false);
    }
  };

  const openSettings = () => setView("settings");

  useEffect(() => {
    const invoke = desktopInvoke();
    if (!invoke) return;
    let active = true;
    void invoke("last_update_result")
      .then((value) => {
        if (!active) return;
        setDesktopUpdateResult(parseDesktopUpdateResult(value));
        setDesktopUpdateResultDismissed(false);
      })
      .catch((error) => {
        if (active) setDesktopUpdateErr(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetchAppMode().then((config) => {
      setAppMode(config);
    }).catch((error) => {
      setConnErr(String(error));
      setLoaded(true);
    });
  }, []);

  useEffect(() => {

    const readiness = appMode ? "local" : null;
    const invoke = desktopInvoke();
    if (!readiness || !invoke || publishedRuntimeReadiness.current === readiness) return;
    let active = true;
    let retry: number | undefined;
    publishedRuntimeReadiness.current = readiness;
    void invoke("agent_runtime_ready", { readiness }).catch(() => {
      if (!active || publishedRuntimeReadiness.current !== readiness) return;
      publishedRuntimeReadiness.current = null;
      retry = window.setTimeout(() => {
        if (active) setRuntimeReadinessAttempt((attempt) => attempt + 1);
      }, 500);
    });
    return () => {
      active = false;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [appMode, runtimeReadinessAttempt]);

  useEffect(() => {
    if (!appMode  || desktopUpdateCheckStarted.current) return;
    desktopUpdateCheckStarted.current = true;
    void checkDesktopUpdate(false);
  }, [appMode?.mode]);

  useEffect(() => {
    if (!appMode || !workspaceReady ) return;
    load();
    fetchHealth().then((health) => { setAppVersion(health.version); setLogDir(health.logDir); }).catch(() => {});
    // Extensions are managed locally and shared only through explicit assignments.
    fetchExtensions().then(setExtensions).catch(() => {});
    {
      fetchDiagnose().then(setDiag).catch(() => {});
    }
  }, [appMode?.mode, false, workspaceReady]);

  useEffect(() => {
    if (view !== "extensions" || !appMode || !workspaceReady ) return;
    void reloadGroupExtensionDefaults();
  }, [view, appMode?.mode, false, workspaceReady]);

  useEffect(() => {
    const editable = groupExtensionDefaults.filter((item) => item.permission === "edit");
    if (!editable.some((item) => item.name === groupDefaultName)) {
      setGroupDefaultName(editable[0]?.name ?? "");
    }
  }, [groupExtensionDefaults, groupDefaultName]);

  useEffect(() => {
    setGroupDefaultExts(
      groupExtensionDefaults.find((item) => item.name === groupDefaultName)?.extensions ?? [],
    );
  }, [groupExtensionDefaults, groupDefaultName]);

  useEffect(() => {
    if (!appMode || !workspaceReady ) return;
    const t = setInterval(pollRoster, REFRESH_MS);
    return () => clearInterval(t);
  }, [appMode?.mode, false, workspaceReady]);

  // Both browsers delete saved site data when the profiles drive is almost full.
  useEffect(() => {
    let live = true;
    const check = () => void fetchDiskSpace().then((next) => { if (live) setDiskSpace(next); }).catch(() => {});
    check();
    const timer = setInterval(check, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  // Browser runtime downloads: read once when the profile count changes (a new profile
  // starts its download), then every second while one runs or a row is busy opening.
  const anyBusy = Object.values(busy).some(Boolean);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const poll = () => {
      void fetchRuntimeDownloads().then((next) => {
        if (!live) return;
        setRuntimeDownloads(next);
        if (next.length > 0 || anyBusy) timer = window.setTimeout(poll, 1000);
      }).catch(() => {
        // A missed check must not freeze the label while a row still opens.
        if (live && anyBusy) timer = window.setTimeout(poll, 1000);
      });
    };
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [anyBusy, profiles.length]);

  // Live 2FA code in the Edit modal: fetch the current TOTP, count it down
  // locally, and refetch when the window rolls over.
  useEffect(() => {
    if (!editId ) { setEditTotp(null); return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetchTotp(editId);
        if (alive) setEditTotp(r.code ? { code: r.code, secs: r.secondsRemaining ?? 30 } : null);
      } catch { if (alive) setEditTotp(null); }
    };
    tick();
    const timer = setInterval(() => {
      setEditTotp((t) => {
        if (!t) return t;
        if (t.secs <= 1) { tick(); return t; }
        return { ...t, secs: t.secs - 1 };
      });
    }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [editId]);

  const folders = useMemo<FolderInfo[]>(() => {

    const metadata = new Map(localFolders.map((folder) => [folder.name, folder]));
    return [...new Set([...registeredGroups, ...profiles.map((profile) => profile.group).filter(Boolean)])]
      .map((name) => metadata.get(name) ?? { name });
  }, [localFolders, registeredGroups, profiles]);
  const tree = useMemo(() => folderTree(folders), [folders]);
  const groups = useMemo(() => ["all", ...tree.map((folder) => folder.name)], [tree]);
  const selectedScope = useMemo(() => folderScope(folders, group), [folders, group]);
  const sharedProfiles = useMemo<UiProfile[]>(() => [], []);
  const breadcrumb = tree.find((folder) => folder.name === group);
  const selectFolder = (name: string) => { setSharedOnly(false); setGroup(name); if (view !== "workbench") setView("profiles"); };
  const folderLabel = (name: string) => folders.find((folder) => folder.name === name)?.label ?? name;

  /**
   * Every profile's visible "No.", resolved once against the unsorted roster so
   * sorting or paging can never renumber a row underneath the operator.
   */
  const numbering = useMemo(() => {
    const map = new Map<string, { value: string; custom: boolean }>();
    profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));
    return map;
  }, [profiles]);

  const sortField = (p: UiProfile, key: SortKey): string | number => {
    switch (key) {
      case "no": return Number(numbering.get(p.id)?.value ?? 0);
      case "name": return p.name.toLowerCase();
      case "group": return p.group.toLowerCase();
      case "platform": return p.platform.toLowerCase();
      case "proxy": return (p.proxy ?? "").toLowerCase();
      case "status": return p.running ? 0 : 1;
      default: return 0;
    }
  };

  const profileFilters = useMemo<ProfileFilters>(() => ({ query: q, group, sharedOnly, status: statusFilter, engine: engineFilter, tag: tagFilter }), [q, group, sharedOnly, statusFilter, engineFilter, tagFilter]);
  const profileTags = useMemo(() => [...new Set(profiles.flatMap((profile) => profile.tags ?? []))].sort((a, b) => a.localeCompare(b)), [profiles]);
  const clearProfileFilters = () => { setQ(""); setGroup("all"); setSharedOnly(false); setStatusFilter("all"); setEngineFilter("all"); setTagFilter(""); };
  const applyProfileFilters = (filters: ProfileFilters) => {
    setQ(filters.query); setGroup(filters.group); setSharedOnly(filters.sharedOnly);
    setStatusFilter(filters.status); setEngineFilter(filters.engine); setTagFilter(filters.tag);
    setSelected(new Set());
  };
  const filtered = useMemo(() => {
    const matched = profiles.filter((p) => {
      if (sharedOnly ? !sharedProfiles.includes(p) : group !== "all" && !selectedScope.has(p.group)) return false;
      return matchesProfileFilters(p, profileFilters, numbering.get(p.id)?.value ?? "");
    });
    // Running profiles stay on top regardless of the chosen column: an open
    // browser is the row an operator acts on next.
    return matched.sort((a, b) => {
      if (a.running !== b.running) return a.running ? -1 : 1;
      const left = sortField(a, sort.key);
      const right = sortField(b, sort.key);
      if (left < right) return -sort.dir;
      if (left > right) return sort.dir;
      return a.id.localeCompare(b.id);
    });
  }, [profiles, group, sharedOnly, sharedProfiles, selectedScope, profileFilters, sort, numbering]);

  const profilePageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleProfilePage = Math.min(profilePage, profilePageCount - 1);
  const visibleProfiles = filtered.slice(visibleProfilePage * pageSize, (visibleProfilePage + 1) * pageSize);
  useEffect(() => setProfilePage(0), [profileFilters, pageSize]);
  const detailProfile = detailId && view === "profiles" ? profiles.find((profile) => profile.id === detailId) : undefined;

  const editSerial = editId ? profiles.find((profile) => profile.id === editId)?.serial ?? null : null;
  const editRunning = editId ? profiles.find((profile) => profile.id === editId)?.running === true : false;
  const createHasProxy = !!(form.host.trim() || form.port.trim() || form.user.trim() || form.pass);
  const editHasProxy = !!(editForm.proxy ?? "").trim();
  const editProxyChanged = (editForm.proxy ?? "") !== editInitialProxy.proxy ||
    (editHasProxy && editForm.proxyType !== editInitialProxy.proxyType);

  const pastedRecordCount = bulkText.trim() ? countPastedRecords(bulkText) : null;

  const folderMenuRef = useDismiss<HTMLSpanElement>(folderMenu !== null, () => setFolderMenu(null));
  const colsRef = useDismiss<HTMLDivElement>(colsOpen, () => setColsOpen(false));
  const nodesRef = useDismiss<HTMLDivElement>(nodesOpen, () => setNodesOpen(false));
  const exportRef = useDismiss<HTMLDivElement>(exportOpen, () => setExportOpen(false));

  const columnVisible = (key: ColumnKey) => !hiddenCols.has(key);
  const toggleColumn = (key: ColumnKey) =>
    setHiddenCols((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeSetting(HIDDEN_COLUMNS_KEY, JSON.stringify([...next]));
      return next;
    });
  const applyPageSize = (size: number) => { setPageSize(size); writeSetting(PAGE_SIZE_KEY, String(size)); };
  const chooseTheme = (choice: ThemeChoice) => {
    setTheme(choice);
    writeSetting(THEME_KEY, choice);
    try { document.cookie = themeCookie(choice); } catch {}
  };
  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const refreshRoster = async () => {
    setRefreshing(true);
    try { await Promise.all([load(), Promise.resolve()]); } finally { setRefreshing(false); }
  };
  useEffect(() => {
    if (profilePage !== visibleProfilePage) setProfilePage(visibleProfilePage);
  }, [profilePage, visibleProfilePage]);

  const runningCount = profiles.filter((p) => p.running).length;
  const selectedMobileCount = profiles.filter((p) => selected.has(p.id) && p.mobilePersona).length;
  const existingGroups = groups.slice(1); // drop the "all" pseudo-group
  const editableGroups = existingGroups;
  const selectedProfilesSupportChromeExtensions = [...selected].every((id) =>
    profiles.find((profile) => profile.id === id)?.engine === "chromium");
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const byName = new Map(tree.map((folder) => [folder.name, folder]));
    for (const profile of profiles) {
      for (const name of [profile.group, ...(byName.get(profile.group)?.ancestors ?? [])]) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [tree, profiles]);
  const countFor = (g: string) => folderCounts.get(g) ?? 0;
  const canEditGroup = (name: string) => true;
  const selectedMovable = true;
  const editableDefaultGroups = groupExtensionDefaults.filter((item) => item.permission === "edit");
  const installedExtensionIds = new Set(extensions.map((item) => item.id));
  const storedGroupDefaultExts = groupExtensionDefaults.find((item) => item.name === groupDefaultName)?.extensions ?? [];
  const editExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...editInitialExts, ...editExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];
  const groupDefaultExtensionChoices = [
    ...extensions.map((item) => ({ ...item, missing: false })),
    ...[...new Set([...storedGroupDefaultExts, ...groupDefaultExts])]
      .filter((id) => !installedExtensionIds.has(id))
      .map((id) => ({ id, name: id, missing: true })),
  ];
  const groupDefaultProfileCount = profiles.filter((profile) => profile.group === groupDefaultName).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allVisibleSelected = visibleProfiles.length > 0 && visibleProfiles.every((p) => selected.has(p.id));
  const selectedFilteredCount = filtered.filter((p) => selected.has(p.id)).length;
  const selectedOutsideFilter = selected.size - selectedFilteredCount;
  const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length && selectedOutsideFilter === 0;
  const scopeCount = q ? t("{count} matching profiles", { count: filtered.length.toLocaleString() }) : t("{count} profiles", { count: filtered.length.toLocaleString() });
  const selectionScope = group === "all" ? scopeCount : t("{scope} in “{group}”", { scope: scopeCount, group });
  const selectAllFiltered = () => setSelected(new Set(filtered.map((p) => p.id)));
  const toggleAll = () =>
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visibleProfiles.forEach((p) => n.delete(p.id));
      else visibleProfiles.forEach((p) => n.add(p.id));
      return n;
    });

  const moveSelected = async () => {
    const ids = [...selected];
    const group = newMode ? newGroup.trim() : moveTarget;
    if (ids.length === 0 || !group) return;
    setActionErr(null);
    try {

      const r = await moveProfiles(ids, group);
      if (r.ok === false) {
        setActionErr(r.error || "move failed");
        return;
      }
      setSelected(new Set());
      setNewMode(false);
      setNewGroup("");
      setMoveTarget("");
      await load();
    } catch (e) {
      setActionErr(String(e));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0 || deleteInFlight.current) return;
    const legacy = !!appMode?.legacyRemote;
    if (!await confirmDialog(legacy
      ? t("Delete {count} profile(s)?", { count: ids.length.toLocaleString() }) + "\n\n" + t("This removes them from the roster and any saved session. This can't be undone.")
      : t("Move {count} selected profiles to Trash?", { count: ids.length.toLocaleString() }) + "\n\n" + t("This includes every selected page. You can restore them with their saved data."),
      { danger: legacy, confirmLabel: legacy ? t("Delete") : t("Move to Trash") })) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setActionErr(null);
    try {
      const r = await deleteProfiles(ids);
      if (r.ok === false) {
        setActionErr(r.error || "delete failed");
        return;
      }
      const problems = [
        r.locked?.length && `${r.locked.length} in use, not deleted`,
        r.failed?.length && `${r.failed.length} failed`,
      ].filter(Boolean);
      if (problems.length) setActionErr(`${problems.join("; ")}. These profiles remain selected.`);
      setSelected(new Set([...(r.locked ?? []), ...(r.failed ?? [])]));
      flash(`${r.deleted.toLocaleString()} profiles ${appMode?.legacyRemote ? "deleted" : "moved to Trash"}`);
      await load();
    } catch (e) {
      setActionErr(String(e));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  };

  const actionWarning = (r: any): string => r.warning;
  const fingerprintPage = language.startsWith("ru") ? "ru" : language.startsWith("zh") ? "zh-cn" : "en";
  const act = async (id: string, fn: (id: string) => Promise<any>) => {
    setActionErr(null);
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const r = await fn(id);
      await load(); // refresh first; load() no longer clears action errors
      if (r && r.ok === false) setActionErr(r.error || "action failed");
      else if (r && r.warning) setActionErr(actionWarning(r));
    } catch (e) {
      await load().catch(() => {});
      setActionErr(String(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  /** While a profile opens, its Open button shows the browser download it waits for. */
  const openLabel = (profile: UiProfile) => {
    if (!busy[profile.id]) return t("Open");
    const waiting = profileDownloads(profile, runtimeDownloads);
    return waiting.length > 0
      ? t("Downloading browser… {percent}%", { percent: String(downloadPercent(waiting)) })
      : t("Opening…");
  };

  const openCookie = (targets: UiProfile[]) => {
    setCookieTargets(targets);
    setCookieForm({ ...BLANK_COOKIE_FORM, domain: targets.length === 1 ? targets[0]!.platform : "" });
    setCookieText("");
    setCookieErr(null);
  };
  const closeCookie = () => {
    setCookieTargets(null);
    setCookieForm(BLANK_COOKIE_FORM);
    setCookieText("");
    setCookieErr(null);
  };
  const openPendingCookies = async (profile: UiProfile) => {
    setPendingView({ profile, cookies: null, error: null, busy: false });
    try {
      const result = await fetchPendingCookies(profile.id);
      setPendingView((view) => view && { ...view, cookies: result.cookies ?? [], error: result.ok ? null : result.error ?? t("Cookies could not be loaded.") });
    } catch (error) {
      setPendingView((view) => view && { ...view, cookies: [], error: error instanceof Error ? error.message : t("Cookies could not be loaded.") });
    }
  };
  const removePendingCookies = async () => {
    if (!pendingView) return;
    setPendingView({ ...pendingView, busy: true, error: null });
    try {
      const result = await clearPendingCookies(pendingView.profile.id);
      if (!result.ok) throw new Error(result.error || t("Cookies could not be removed."));
      setPendingView(null);
      await load().catch(() => {});
      flash(t("Pending cookies removed."));
    } catch (error) {
      setPendingView((view) => view && { ...view, busy: false, error: error instanceof Error ? error.message : t("Cookies could not be removed.") });
    }
  };
  const setCookieField = (key: keyof typeof BLANK_COOKIE_FORM, value: string) =>
    setCookieForm((current) => ({ ...current, [key]: value }));
  const submitCookie = async () => {
    if (!cookieTargets) return;
    setCookieSaving(true);
    setCookieErr(null);
    try {
      const result = await addProfileCookies(cookieTargets.map((profile) => profile.id), cookieText.trim() ? { text: cookieText } : cookieForm);
      await load().catch(() => {});
      if (result.errors?.length) {
        const names = new Map(cookieTargets.map((profile) => [profile.id, profile.name]));
        setCookieErr(result.errors.map((item) => `${names.get(item.id) ?? item.id}: ${item.error}`).join("\n"));
        return;
      }
      if (!result.ok) {
        setCookieErr(result.error || t("Cookies could not be added."));
        return;
      }
      closeCookie();
      flash(t("{count} cookie(s) added: {now} open browser(s) now, {later} profile(s) at next start.", {
        count: String(result.count ?? 0), now: String(result.live ?? 0), later: String(result.nextStart ?? 0),
      }));
    } catch (error) {
      setCookieErr(error instanceof Error ? error.message : t("Cookies could not be added."));
    } finally {
      setCookieSaving(false);
    }
  };


  const doUpload = async (files: FileList | File[]) => {
    setActionErr(null);
    try {
      const list = Array.from(files);
      if (list.length === 0) return;
      const r = await uploadExports(list);
      await load();
      if (r.ok) {
        await noticeDialog(importedSummary(r, t), { title: t("Import finished") });
      }
      else setActionErr(r.error || "import failed");
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk add accounts from provider export files or AdsPower text ----
  const openBulk = () => {
    setBulkFiles([]);
    setBulkText("");
    setBulkGroup(group !== "all" && (true) ? group : "");
    setBulkPlatform("");
    setBulkErr(null);
    setBulkSource("file");
    setShowBulk(true);
  };
  const closeBulk = () => {
    setShowBulk(false);
    setBulkFiles([]);
    setBulkText("");
    setBulkErr(null);
  };
  const submitBulk = async () => {
    if ((!bulkFiles.length && !bulkText.trim()) || (false)) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const uploads = [...bulkFiles];
      if (bulkText.trim()) uploads.push(new File([bulkText], "pasted-adspower.txt", { type: "text/plain" }));
      if (!uploads.length) throw new Error("no rows found in the file(s)");
      const r = await uploadExports(uploads, { group: bulkGroup.trim(), platform: bulkPlatform });
      if (r.ok) {
        closeBulk();
        await load();
        setShowImportOffer(true);
        await noticeDialog(importedSummary(r, t), { title: t("Import finished") });
      }
      else setBulkErr(r.error || "import failed");
    } catch (e) {
      setBulkErr(String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const resetCreateProxyCheck = () => {
    createProxyCheckGeneration.current++;
    setCreateProxyCheck(EMPTY_PROXY_CHECK);
  };
  const setF = (k: keyof typeof BLANK_FORM, v: string) => {
    if (k === "proxyType" || k === "host" || k === "port" || k === "user" || k === "pass") {
      resetCreateProxyCheck();
    }
    setForm((f) => ({ ...f, [k]: v }));
  };
  // Open prefilled with the folder you're browsing; close always resets so a
  // cancelled draft never leaks into the next open.
  const openCreate = () => {
    if (createInFlight.current) return;
    setDetailId(null);
    resetCreateProxyCheck();
    setForm({ ...BLANK_FORM, engine: appMode?.defaultEngine ?? "chromium", chromiumRuntime: appMode?.defaultChromiumRuntime ?? "", group: group !== "all" && (true) ? group : "" });
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
    setCreateBatch(false); setCreateCount("5"); setCreatePattern("Studio {n:2}"); setCreateStart("1"); setCreateItems([]);
    // A first profile needs no proxy, so the section starts closed until profiles use one.
    setCreateProxyOpen(profiles.some((profile) => !!profile.proxy));
    setShowCreate(true);
  };
  const closeCreate = () => {
    if (createInFlight.current) return;
    resetCreateProxyCheck();
    setShowCreate(false);
    setForm(BLANK_FORM);
    setProxyPaste("");
    setProxyPasteOk(null);
    setCreateErr(null);
    setCreateItems([]);
  };
  const applyProxyPaste = (raw: string) => {
    try {
      const parsed = parsePastedProxy(raw, form.proxyType === "socks5" ? "socks5" : "http");
      resetCreateProxyCheck();
      setForm((current) => ({
        ...current,
        proxyType: parsed.type,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        pass: parsed.pass,
      }));
      setProxyPaste("");
      setProxyPasteOk(`✓ ${parsed.type.toUpperCase()} proxy fields filled`);
      setCreateErr(null);
    } catch (error) {
      setProxyPasteOk(null);
      setCreateErr(error instanceof Error ? error.message : String(error));
    }
  };
  const checkCreateProxy = async () => {
    const generation = ++createProxyCheckGeneration.current;
    if (form.proxyType === "https") {
      setCreateProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setCreateProxyCheck({ checking: true, result: null, error: null });
    const proxy: ProxyCheckInput = {
      type: form.proxyType,
      host: form.host,
      port: form.port,
      user: form.user,
      pass: form.pass,
    };
    try {
      const result = await checkProxy(proxy);
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === createProxyCheckGeneration.current) {
        setCreateProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
  const submitCreate = async (resume = false, retryFailed = false) => {
    if (createInFlight.current  || !workspaceReady) return;
    let items: BatchCreateItem[];
    try {
      if (resume) {
        // The result list retains successes and ambiguous responses across explicit retries.
        if (createItems.some((item) => item.state === "uncertain")) return;
        items = createItems.map((item) => retryFailed && item.state === "failed" ? { input: item.input, state: "queued" } : { ...item });
      } else {
        const names = createBatch ? batchProfileNames(Number(createCount), createPattern, Number(createStart)) : [form.name];
        const input: BatchCreateItem["input"] = {
          name: form.name,
          engine: form.engine,
          ...(form.engine === "chromium" && !appMode?.legacyRemote ? { chromiumRuntime: appMode?.chromiumRuntime ?? (form.chromiumRuntime || "cloakbrowser") } : {}),
          group: form.group,
          platform: form.platform,
          screen: form.screen,
          ...(form.platformOs && form.engine !== "webkit" ? { platformOs: form.platformOs } : {}),
          customNo: form.customNo,
          username: form.username,
          password: form.password,
          email: form.email,
          emailPassword: form.emailPassword,
          twofa: form.twofa,
          proxy: form.host.trim() ? { type: form.proxyType, host: form.host, port: form.port, user: form.user, pass: form.pass } : null,
        };
        items = names.map((name) => ({ input: { ...input, name, ...(createBatch ? { customNo: "" } : {}) }, state: "queued" }));
      }
    } catch (error) { setCreateErr(t(error instanceof Error ? error.message : String(error))); return; }
    const scope = managementScope;
    createInFlight.current = true;
    createStopRequested.current = false;
    setCreateStopping(false);
    setCreating(true);
    setCreateErr(null);
    try {
      const result = await runProfileCreation(items, createProfile, (next) => {
        if (creationScope.current === scope) setCreateItems(next);
      }, () => createStopRequested.current || creationScope.current !== scope);
      if (creationScope.current === scope) {
        setCreateItems(result);
        if (!createBatch && result[0]?.state === "created") { setShowCreate(false); setCreateItems([]); }
        await load();
      }
    } finally {
      createInFlight.current = false;
      setCreating(false);
      if (creationScope.current !== scope) { setShowCreate(false); setCreateItems([]); }
    }
  };

  // ---- Edit one profile (full detail) ----
  const resetEditProxyCheck = () => {
    editProxyCheckGeneration.current++;
    setEditProxyCheck(EMPTY_PROXY_CHECK);
  };
  const setEF = (k: string, v: string) => {
    if (k === "proxy" || k === "proxyType") {
      resetEditProxyCheck();
      setTimezoneBusy(false);
    }
    setEditForm((f) => ({ ...f, [k]: v }));
  };
  // The dialog opens on the click; the detail fetch fills it in when it lands.
  // The ref discards a stale response if the operator has moved on meanwhile.
  const openEdit = (id: string) => {
    resetEditProxyCheck();
    setActionErr(null);
    editFetchId.current = id;
    setEditId(id);
    setEditForm({});
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditMobile(null);
    setEditExpectedVersion(null);
    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    setEditErr(null);
    setEditLoading(true);
    void (async () => {
      try {
        const p: EditProfile = await fetchProfileEdit(id);
        if (editFetchId.current !== id) return;
        setEditForm({
          name: p.name, group: p.group, platform: p.platform,
          proxyType: p.proxyType || "http", proxy: p.proxy,
          proxyError: p.proxyError ?? "",
          username: p.username, password: p.password,
          email: p.email, emailPassword: p.emailPassword, twofa: p.twofa,
          resolution: p.resolution, tags: p.tags,
          customNo: p.customNo ?? "",
          platformOs: p.platformOs ?? "",
          timezone: p.timezone,
          locale: p.locale ?? "",
          cores: p.cores ?? "",
          fingerprintSeed: p.fingerprintSeed ?? "",
        });
        setEditInitialProxy({ proxy: p.proxy, proxyType: p.proxyType || "http" });
        setEditInitialFingerprint({
          resolution: p.resolution, platformOs: p.platformOs ?? "", timezone: p.timezone ?? "",
          locale: p.locale ?? "", cores: p.cores ?? "", fingerprintSeed: p.fingerprintSeed ?? "",
        });
        setEditEngine(p.engine === "firefox" || p.engine === "webkit" ? p.engine : "chromium");
        setEditChromiumRuntime(p.chromiumRuntime ?? "");
        setEditHardware(p.hardware);
        setEditExts(p.extensions ?? []);
        setEditInitialExts(p.extensions ?? []);
        setEditMobile(p.desktopConversion ?? null);
        setEditExpectedVersion(p.expectedVersion ?? null);
      } catch (e) {
        if (editFetchId.current === id) setEditErr(String(e));
      } finally {
        if (editFetchId.current === id) setEditLoading(false);
      }
    })();
  };
  const closeEdit = () => {
    resetEditProxyCheck();
    editFetchId.current = null;
    setEditId(null);
    setEditExpectedVersion(null);
    setEditEngine(null);
    setEditChromiumRuntime("");
    setEditHardware(undefined);
    setTimezoneBusy(false);
    setEditLoading(false);
    setEditForm({});
    setEditInitialFingerprint({});
    setEditExts([]);
    setEditInitialExts([]);
    setEditErr(null);
    setEditMobile(null);
  };
  const checkEditedProxy = async () => {
    const generation = ++editProxyCheckGeneration.current;
    const value = editForm.proxy ?? "";
    if (editForm.proxyType === "https" || /^\s*https:\/\//i.test(value)) {
      setEditProxyCheck({ checking: false, result: null, error: "unavailable" });
      return;
    }
    setEditProxyCheck({ checking: true, result: null, error: null });
    let proxy: ProxyCheckInput;
    try {
      proxy = parsePastedProxy(value, editForm.proxyType === "socks5" ? "socks5" : "http");
    } catch {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result: null, error: "invalid" });
      }
      return;
    }
    try {
      const result = await checkProxy(proxy);
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({ checking: false, result, error: null });
      }
    } catch (error) {
      if (generation === editProxyCheckGeneration.current) {
        setEditProxyCheck({
          checking: false,
          result: null,
          error: error instanceof ProxyCheckError ? error.kind : "unavailable",
        });
      }
    }
  };
  const refreshEditedTimezone = async () => {
    if (!editId || editProxyChanged || timezoneBusy || editSaving || editForm.proxyError) return;
    if (!await confirmDialog(t(FINGERPRINT_EDIT_WARNING), { confirmLabel: t("Save") })) return;
    const id = editId;
    const generation = editProxyCheckGeneration.current;
    setTimezoneBusy(true);
    setEditErr(null);
    try {
      const { timezone, locale } = await refreshProfileTimezone(id);
      if (editFetchId.current !== id || generation !== editProxyCheckGeneration.current) return;
      setEditForm((form) => ({ ...form, timezone, locale }));
      setEditInitialFingerprint((initial) => ({ ...initial, timezone }));
      await load();
    } catch (error) {
      if (editFetchId.current === id && generation === editProxyCheckGeneration.current) setEditErr(error instanceof Error ? error.message : String(error));
    } finally {
      if (editFetchId.current === id && generation === editProxyCheckGeneration.current) setTimezoneBusy(false);
    }
  };
  const saveEdit = async () => {
    if (!editId) return;
    const fingerprintEdits = Object.fromEntries(Object.entries(editInitialFingerprint)
      .filter(([key, value]) => editForm[key] !== value)
      .map(([key]) => [key, editForm[key] ?? ""]));
    if (Object.keys(fingerprintEdits).length && !await confirmDialog(t(FINGERPRINT_EDIT_WARNING), { confirmLabel: t("Save") })) return;
    setEditSaving(true);
    setEditErr(null);
    try {

      const r = await updateProfile(editId, {
        name: editForm.name ?? "", group: editForm.group ?? "", platform: editForm.platform ?? "",
        proxy: editForm.proxy ?? "", proxyType: editForm.proxyType ?? "http",
        username: editForm.username ?? "", password: editForm.password ?? "",
        email: editForm.email ?? "", emailPassword: editForm.emailPassword ?? "", twofa: editForm.twofa ?? "",
        tags: editForm.tags ?? "", ...fingerprintEdits,
        customNo: editForm.customNo ?? "",
        ...(!sameExtensionSelection(editExts, editInitialExts) && editEngine === "chromium" ? { extensions: editExts } : {}),
      }, undefined);
      if (r.ok) {
        closeEdit();
        await load();
        if (r.restartRequired) flash(t("Saved. The open browser keeps its current proxy and fingerprint until it restarts."));
      }
      else if (r.status === 409) {
        const message = r.error || "Profile changed; reopen Edit before saving";
        closeEdit();
        setActionErr(message);
      } else setEditErr(r.error || "save failed");
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };
  const convertEditedMobile = async () => {
    if (!editId || !editMobile) return;
    const platform = editMobile.platform === "macos" ? "macOS" : "Windows";
    const screenNote = editMobile.screenChanged
      ? t("Its mobile-sized screen will become {resolution}.", { resolution: editMobile.resolution })
      : t("Its existing desktop-sized screen will be kept.");
    if (!await confirmDialog(
      t("Convert this imported mobile persona to a stable {platform} desktop persona?", { platform }) + "\n\n" +
      t("Cookies, login/session, credentials, proxy, timezone, fingerprint seed, tags and extensions are preserved.") + " " + screenNote + "\n\n" +
      t("The website may treat the first launch as a new desktop device and request verification. Other unsaved edits in this dialog are not included."),
      { confirmLabel: t("Convert") },
    )) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      const r = await convertMobileProfile(editId);
      if (!r.ok) { setEditErr(r.error || "conversion failed"); return; }
      closeEdit();
      await load();
      flash(`Converted profile to a stable ${platform} desktop persona`);
    } catch (e) {
      setEditErr(String(e));
    } finally {
      setEditSaving(false);
    }
  };

  // ---- Extensions manager (Store URL / upload / delete) ----
  const reloadExtensions = async () => { try { setExtensions(await fetchExtensions()); } catch {} };
  const toggleGroupDefaultExt = (id: string) =>
    setGroupDefaultExts((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]));
  const applyGroupExtensionDefault = async () => {
    if (!groupDefaultName) return;
    if (!await confirmDialog(
      t("Apply this extension default to “{group}”?", { group: groupDefaultName }) + "\n\n" +
      t("This replaces extension assignments on {count} current profile(s). New and moved profiles inherit this selection. Individual profile edits can differ later.", { count: groupDefaultProfileCount }) + "\n\n" +
      t("Reopen browsers to apply the change."),
      { confirmLabel: t("Apply") },
    )) return;
    setGroupDefaultBusy(true);
    setExtErr(null);
    try {
      const result = await setGroupExtensionDefaults(groupDefaultName, groupDefaultExts);
      if (result.ok === false) { setExtErr(result.error || "group default update failed"); return; }
      await Promise.all([reloadGroupExtensionDefaults(), load()]);
      flash(`Updated extension defaults for “${groupDefaultName}” on ${result.updatedCount} profile(s)`);
    } catch (error) {
      setExtErr(error instanceof Error ? error.message : String(error));
    } finally {
      setGroupDefaultBusy(false);
    }
  };
  const doInstallWebStoreExtension = async () => {
    const source = extSource.trim();
    if (!source) { setExtErr("Paste a Chrome Web Store URL or extension ID"); return; }
    setExtInstallBusy(true);
    setExtErr(null);
    try {
      const r = await installWebStoreExtension(source);
      if (!r.ok) { setExtErr(r.error || "installation failed"); return; }
      setExtSource("");
      await reloadExtensions();
      flash(r.alreadyInstalled ? `${r.installed.name} is already installed` : `Installed ${r.installed.name}`);
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtInstallBusy(false);
    }
  };
  const doUploadExtensions = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setExtBusy(true);
    setExtErr(null);
    try {
      const r = await uploadExtensions(list);
      if (!r.ok) setExtErr(r.error || "upload failed");
      await reloadExtensions();
    } catch (e) {
      setExtErr(String(e));
    } finally {
      setExtBusy(false);
    }
  };
  const doRemoveExtension = async (id: string, name: string) => {
    if (!await confirmDialog(
      t("Remove extension “{name}”?", { name }) + "\n\n" + t("It will be unassigned from all profiles."),
      { danger: true, confirmLabel: t("Remove") },
    )) return;
    setExtErr(null);
    try {
      const r = await removeExtension(id);
      if (!r.ok) setExtErr(r.error || "remove failed");
      setEditExts((xs) => xs.filter((x) => x !== id));
      await Promise.all([reloadExtensions(), reloadGroupExtensionDefaults()]);
    } catch (e) {
      setExtErr(String(e));
    }
  };
  const toggleEditExt = (id: string) =>
    setEditExts((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const bulkAssignExt = async (op: "add" | "remove") => {
    const ids = [...selected];
    if (!ids.length || !bulkExt) return;
    setActionErr(null);
    try {
      const r = await assignExtensionBulk(ids, bulkExt, op);
      if (r.ok === false) { setActionErr(r.error || "extension assign failed"); return; }
      await load();
      const name = extensions.find((x) => x.id === bulkExt)?.name ?? "extension";
      flash(`${op === "add" ? "Added" : "Removed"} “${name}” ${op === "add" ? "to" : "from"} ${r.updated} profile(s)`);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- 2FA quick-copy (row authenticator button) ----
  const copy2fa = async (id: string) => {
    setActionErr(null);
    try {
      const r = await fetchTotp(id);
      if (!r.code) { setActionErr("no 2FA secret on this profile"); return; }
      try { await navigator.clipboard.writeText(r.code); } catch {}
      setTwoFaFlash({ id, code: r.code });
      setTimeout(() => setTwoFaFlash((f) => (f && f.id === id ? null : f)), 4000);
    } catch (e) {
      setActionErr(String(e));
    }
  };

  // ---- Bulk open / close (bounded concurrency) ----
  const bulkRun = async (op: (id: string) => Promise<any>, pick: (p: UiProfile) => boolean) => {
    const ids = [...selected].filter((id) => { const p = profiles.find((x) => x.id === id); return p && pick(p); });
    if (!ids.length) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const issues: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await op(id);
        if (r?.ok === false) issues.push(`${id}: ${r.error || "action failed"}`);
        else if (r?.warning) issues.push(`${id}: ${actionWarning(r)}`);
      } catch (error) {
        issues.push(`${id}: ${String(error)}`);
      }
    });
    await load();
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (issues.length > 0) setActionErr(issues.join("; "));
  };
  const openSelected = () => bulkRun(openProfile, (p) => !p.running && !p.mobilePersona);
  const closeSelected = () => bulkRun(closeProfile, (p) => p.running);
  const convertSelectedMobile = async () => {
    const ids = [...selected].filter((id) => profiles.find((p) => p.id === id)?.mobilePersona);
    if (!ids.length) return;
    if (!await confirmDialog(
      t("Convert {count} selected mobile persona(s) to stable desktop personas?", { count: ids.length }) + "\n\n" +
      t("Account data, sessions, proxies, timezones and fingerprint seeds are preserved. Android keeps the Windows desktop family used by older Vela Browser; iPhone/iPad keeps macOS. A website may request device verification on first launch."),
      { confirmLabel: t("Convert") },
    )) return;
    setActionErr(null);
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => (n[id] = true)); return n; });
    const failed: string[] = [];
    await runPool(ids, 4, async (id) => {
      try {
        const r = await convertMobileProfile(id);
        if (!r.ok) failed.push(`${id}: ${r.error || "conversion failed"}`);
      } catch (e) {
        failed.push(`${id}: ${String(e)}`);
      }
    });
    await load().catch(() => {});
    setBusy((b) => { const n = { ...b }; ids.forEach((id) => delete n[id]); return n; });
    if (failed.length) setActionErr(`${ids.length - failed.length} converted; ${failed.length} failed — ${failed.join("; ")}`);
    else flash(`Converted ${ids.length} mobile persona(s) to stable desktop personas`);
  };

  // ---- Export selected → file ----
  const exportSelected = async (format: ExportFormat) => {
    setExportOpen(false);
    if (!selected.size || exportProgress) return;
    const ids = [...selected];
    setActionErr(null);
    setExportProgress({ completed: 0, total: ids.length });
    try {
      await exportProfiles(ids, format, (progress) => setExportProgress(progress));
      flash(`Exported ${ids.length.toLocaleString()} profile${ids.length === 1 ? "" : "s"} as ${format.toUpperCase()}`);
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setExportProgress(null);
    }
  };

  // ---- Transient success banner ----
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice((cur) => (cur === m ? null : cur)), 3500); };

  // ---- File-based bulk update (export → edit → re-upload, matched by id) ----
  const openUpdate = () => { setShowUpdate(true); setUpdateFile(null); setUpdateErr(null); setUpdateResult(null); };
  const submitUpdate = async () => {
    if (!updateFile) return;
    setUpdateBusy(true); setUpdateErr(null); setUpdateResult(null);
    try {
      const r = await updateFromFile([updateFile]);
      if (!r.ok) {
        setUpdateErr(r.errors?.length
          ? r.errors.map((item: { id: string; error: string }) => `${item.id}: ${item.error}`).join(" · ")
          : r.error || "update failed");
        if (typeof r.updated !== "number") return;
      }
      let m = `Updated ${r.updated} profile(s)`;
      if (r.notFound?.length) m += ` · ${r.notFound.length} id(s) in the file matched no profile`;
      if (r.skipped) m += ` · ${r.skipped} row(s) skipped (no id)`;
      setUpdateResult(m);
      await load();
    } catch (e) {
      setUpdateErr(String(e));
    } finally {
      setUpdateBusy(false);
    }
  };

  // ---- Group create / rename / delete ----
  const createSidebarGroup = async () => {
    const name = sidebarGroupName.trim();
    if (!name) return;
    if (name === "all") {
      setActionErr("This name is reserved.");
      return;
    }
    setActionErr(null);
    try {
      const result = await createGroup(name, newFolderParent);
      if (result.ok === false) {
        setActionErr(result.error || "create failed");
        return;
      }
      await Promise.all([load(), Promise.resolve()]);
      selectFolder(result.folder?.name ?? name);
      setCollapsedFolders((current) => new Set([...current].filter((folder) => folder !== newFolderParent)));
      setSidebarGroupName("");
      setAddingGroup(false);
    } catch (error) {
      setActionErr(error instanceof Error ? error.message : String(error));
    }
  };
  const startRename = (g: string) => { setRenaming(g); setRenameVal(folderLabel(g)); };
  const remapSelectedFolder = (from: string, to: string) => {
    if (folderScope(folders, from).has(group)) selectFolder(to + group.slice(from.length));
  };
  const commitFolderMove = async () => {
    if (!movingFolder) return;
    setFolderMoveBusy(true);
    setFolderMoveErr(null);
    try {
      const result = await moveGroup(movingFolder, folderParent || null);
      if (result.ok === false) throw new Error(result.error || "Move failed");
      remapSelectedFolder(movingFolder, result.folder.name);
      setMovingFolder(null);
      await Promise.all([load(), Promise.resolve()]);
    } catch (error) {
      setFolderMoveErr(error instanceof Error ? error.message : String(error));
    } finally { setFolderMoveBusy(false); }
  };
  const commitRename = async () => {
    const from = renaming, to = renameVal.trim();
    setRenaming(null);
    if (!from || !to || to === folderLabel(from)) return;
    setActionErr(null);
    try {
      const r = await renameGroup(from, to);
      if (r.ok === false) setActionErr(r.error || "rename failed");
      else {
        remapSelectedFolder(from, r.folder?.name ?? to);
        await Promise.all([load(), Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(String(e));
    }
  };
  const removeGroup = async (g: string) => {
    const n = countFor(g);
    if (!await confirmDialog(
      t("Delete group “{group}”?", { group: g }) + (n ? "\n\n" + t("Its {count} profile(s) move to Ungrouped and are not deleted.", { count: n }) : ""),
      { danger: true, confirmLabel: t("Delete") },
    )) return;
    setActionErr(null);
    try {
      const r = await deleteGroup(g);
      if (r.ok === false) setActionErr(r.error || "delete failed");
      else {
        if (group === g) setGroup("all");
        await Promise.all([load(), Promise.resolve()]);
      }
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const desktopUpdateResultSummary = desktopUpdateResult
    ? describeDesktopUpdateResult(desktopUpdateResult, t)
    : null;

  if (!appMode) {
    return <main className="onboarding"><section className="onboarding-card" aria-labelledby="onboarding-title">
      <div className="onboarding-brand"><AliasLoop />Vela Browser</div>
      <h1 id="onboarding-title">{t("Starting Vela Browser")}</h1>
      {connErr ? <><p role="alert">{connErr}</p><button className="mode-primary" type="button" onClick={() => window.location.reload()}>{t("Try again")}</button></>
        : <><p role="status">{t("Loading your configuration…")}</p><div className="startup-skeleton" aria-hidden="true"><i /><i /><i /></div></>}
    </section></main>;
  }

  const diagWhen = diag ? new Date(diag.generatedAt).toLocaleTimeString() : null;
  const shownColumns = COLUMNS.filter((column) => columnVisible(column.key));
  const visibleColumnCount = 1 + shownColumns.length;
  // Sum of what is actually on screen: below this the wrapper scrolls rather
  // than letting the browser crush Name down to "mia.h…".
  const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);
  const columnHead = (column: (typeof COLUMNS)[number]) => {
    // The Action column carries no header text: its buttons explain themselves,
    // and a floating "ACTION" label over a right-aligned cluster read as an
    // empty column. The column chooser still lists it by its registry label.
    const label = column.key === "action" ? "" : column.key === "group" && false ? t("Folder") : t(column.label);
    // Every column declares its width, so a wide window's extra space spreads
    // proportionally across all of them — an even layout, no dead gap.
    const style = { width: column.width } as CSSProperties;
    if (!column.sort) return <th key={column.key} className={`col-${column.key}`} style={style}>{label}</th>;
    const key = column.key as SortKey;
    return (
      <th
        key={column.key}
        className={`col-${column.key} sortable${sort.key === key ? " sorted" : ""}`}
        style={style}
        aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        onClick={() => toggleSort(key)}
      >
        <span className="th-inner">
          {label}
          <Icon className="sortglyph sm" name={sort.key === key ? (sort.dir === 1 ? "sortUp" : "sortDown") : "sort"} />
        </span>
      </th>
    );
  };

  return (
    <>
    <ProxyApprovalPrompts />
    <div
      className="app"
      data-view={view}
      onDragOver={(e) => { e.preventDefault();  if (!dragging) setDragging(true); }}
      onDragLeave={(e) => { e.preventDefault();  if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();

        setDragging(false);
        if (e.dataTransfer.files?.length) doUpload(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="dropzone">
          <Icon name="fileImport" />
          <span>Drop TXT, CSV, JSON, or XLSX profile exports to import</span>
        </div>
      )}

      <aside className="sidebar dock">
        <div className="brandrow" title={appVersion ? `Vela Browser · ${appVersion}` : undefined} onClick={() => setView("workbench")}>
          <div className="brand"><AliasLoop /><span className="brandlabel">Vela Browser</span></div>
          {appVersion && <span className="appversion" title={appVersion}>{appVersion}</span>}
        </div>
        <div className="newrow">
          <button className="btn primary newbtn" data-tip={t("New profile")} title={t("New profile")} disabled={false} onClick={openCreate}>
            <Icon name="plus" /><span className="navlabel">{t("New Profile")}</span>
          </button>
          <button
            className="btn importbtn tip"
            data-tip={t("Import profiles")}
            aria-label={t("Import profiles")}
            disabled={false}
            title={t("Import profiles from AdsPower, GoLogin, Multilogin, Donut, and other readable exports")}
            onClick={openBulk}
          ><Icon name="fileImport" /><span className="navlabel">{t("Import profiles")}</span></button>
        </div>

        <nav className="sidenav" aria-label={t("Sections")} ref={dockNav}>
          <DockBlob nav={dockNav} active={`${view}:${group}:${sharedOnly}`} />
          <button type="button" className={`navitem${view === "workbench" ? " active" : ""}`} data-tip={t("Multi-view workbench")} title={t("Multi-view workbench")} onClick={() => setView("workbench")}>
            <Icon name="wall" /><span className="navlabel">{t("Multi-view workbench")}</span>
          </button>
          <button
            type="button"
            className={`navitem${view === "profiles" && group === "all" && !sharedOnly ? " active" : ""}`}
            data-tip={t("All profiles")}
            title={t("All profiles")}
            onClick={() => { selectFolder("all"); setView("profiles"); }}
          >
            <Icon name="profiles" /><span className="navlabel">{t("All profiles")}</span>
            <span className="cnt">{profiles.length}</span>
          </button>

          {!appMode?.legacyRemote && <>
            <div className="navrow">
              <button type="button" className={`navitem${view === "proxies" ? " active" : ""}`} data-tip={t("Proxies")} title={t("Proxies")} onClick={() => { setView("proxies");  }}>
                <Icon name="globe" /><span className="navlabel">{t("Proxies")}</span>
              </button>

            </div>
            <button type="button" className={`navitem${view === "trash" ? " active" : ""}`} data-tip={t("Trash")} title={t("Trash")} onClick={() => setView("trash")}>
              <Icon name="trash" /><span className="navlabel">{t("Trash")}</span>
            </button>
          </>}
          <button
            type="button"
            className={`navitem${view === "scripts" ? " active" : ""}`}
            data-tip={t("Scripts")}
            title={t("Scripts")}
            onClick={() => setView("scripts")}
          >
            <Icon name="code" /><span className="navlabel">{t("Scripts")}</span>
          </button>
          <button
            type="button"
            className={`navitem${view === "extensions" ? " active" : ""}`}
            data-tip={t("Manage extensions")}
            title={t("Manage extensions")}
            onClick={() => { setExtErr(null); setView("extensions"); }}
          >
            <Icon name="puzzle" /><span className="navlabel">{t("Manage extensions")}</span>
            {extensions.length > 0 && <span className="cnt">{extensions.length}</span>}
          </button>
          <button type="button" className={`navitem dock-groups${dockGroups ? " open" : ""}`} data-tip={t("Groups")} title={t("Groups")} aria-expanded={dockGroups} onClick={() => setDockGroups((open) => !open)}>
            <Icon name="folder" /><span className="navlabel">{t("Groups")}</span>
            {group !== "all" && <span className="cnt">{group ? folderLabel(group) : t("Ungrouped")}</span>}
          </button>

        </nav>

        <div className={`sidesection${dockGroups ? " open" : ""}`} inert={!dockGroups}>
          <button className="sidehead" onClick={() => setGroupsOpen((o) => !o)}>
            <span className={`chev${groupsOpen ? " open" : ""}`}><Icon name="chevronRight" className="sm" /></span>
            <span>{t("Groups")}</span>
            <span className="grow" />
            <span className="cnt">{existingGroups.length}</span>
          </button>
          {groupsOpen && <>
            <div className="folders">
            {existingGroups.length === 0 && <div className="folders-empty">{t("No groups yet")}</div>}
            {tree.filter((folder) => !folder.ancestors.some((name) => collapsedFolders.has(name))).map(({ name: g, label, depth }) => (
              <div
                key={g}
                style={{ paddingLeft: 10 + depth * 16 }}
                className={`folder${(view === "profiles" || view === "workbench") && !sharedOnly && group === g ? " active" : ""}`}
                onClick={() => { if (renaming !== g) selectFolder(g); }}
              >
                {renaming === g ? (
                  <input
                    className="renameinput"
                    autoFocus
                    value={renameVal}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); }}
                    onBlur={commitRename}
                  />
                ) : (
                  <>
                    {folders.some((folder) => folder.parentName === g) ? <button className="folder-toggle" type="button" aria-label={t("Expand or collapse {folder}", { folder: g })} aria-expanded={!collapsedFolders.has(g)} onClick={(event) => {
                      event.stopPropagation(); setCollapsedFolders((current) => { const next = new Set(current); if (next.has(g)) next.delete(g); else next.add(g); return next; });
                    }}><Icon name={collapsedFolders.has(g) ? "chevronRight" : "chevronDown"} className="sm" /></button> : <Icon name="folder" className="sm" />}
                    <button className="fname folder-select" title={g} onClick={() => selectFolder(g)}>{label ?? g}</button>
                    {!appMode?.legacyRemote && (canEditGroup(g) ) && (
                      <span className="gactions menuwrap" ref={folderMenu === g ? folderMenuRef : undefined} onClick={(event) => event.stopPropagation()}>
                        <button type="button" title={t("Folder actions")} aria-label={t("Actions for {folder}", { folder: g })} aria-expanded={folderMenu === g} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setFolderMenuPosition({ left: rect.right + 8, top: Math.min(rect.top, window.innerHeight - 220) }); setFolderMenu(folderMenu === g ? null : g); }}><Icon name="more" className="sm" /></button>
                        {folderMenu === g && <span className="popover folder-menu" style={folderMenuPosition} onClick={() => setFolderMenu(null)}>
                          {canEditGroup(g) && <>
                            <button className="pop-item" onClick={() => { setNewFolderParent(g); setSidebarGroupName(""); setAddingGroup(true); }}><Icon name="plus" className="sm" />{t("New subfolder")}</button>
                            <button className="pop-item" onClick={() => startRename(g)}><Icon name="edit" className="sm" />{t("Rename")}</button>
                          </>}
                          {<>
                            <button className="pop-item" onClick={() => { setMovingFolder(g); setFolderParent(folders.find((folder) => folder.name === g)?.parentName ?? ""); setFolderMoveErr(null); }}><Icon name="move" className="sm" />{t("Move to…")}</button>
                            <button className="pop-item danger" disabled={folders.some((folder) => folder.parentName === g)} onClick={() => void removeGroup(g)}><Icon name="trash" className="sm" />{t("Delete")}</button>
                          </>}

                        </span>}
                      </span>
                    )}
                    <span className={`cnt${profiles.some((profile) => folderScope(folders, g).has(profile.group) && profile.proxyError) ? " has-issues" : ""}`}>{countFor(g)}</span>
                  </>
                )}
              </div>
            ))}
            </div>
            {addingGroup ? (
              <div className="newgroup" title={newFolderParent ?? undefined}>
                {newFolderParent && <small>{t("In {folder}", { folder: folderLabel(newFolderParent) })}</small>}
                <input
                  autoFocus
                  aria-label={t("New group name")}
                  value={sidebarGroupName}
                  onChange={(event) => setSidebarGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createSidebarGroup();
                    else if (event.key === "Escape") { setAddingGroup(false); setSidebarGroupName(""); }
                  }}
                />
                <button type="button" title={t("Create")} onClick={() => void createSidebarGroup()}><Icon name="check" className="sm" /></button>
                <button type="button" title={t("Cancel")} onClick={() => { setAddingGroup(false); setSidebarGroupName(""); }}><Icon name="close" className="sm" /></button>
              </div>
            ) : (
              <button className="newgroup" type="button" disabled={appMode?.legacyRemote} onClick={() => { setNewFolderParent(null); setAddingGroup(true); }}>
                <Icon name="plus" className="sm" />{t("New group")}
              </button>
            )}
          </>}
        </div>

        <div className="sidefoot">
          <button type="button" className={`navitem${view === "settings" ? " active" : ""}`} data-tip={t("Settings")} title={t("Settings")} onClick={openSettings}>
            <Icon name="settings" /><span className="navlabel">{t("Settings")}</span>
          </button>
          <div className="sidecredit">
            <div className="projectlinks">
              {PROJECT_LINKS.map((link) => (
                <a
                  key={link.label}
                  className="projectlink tip"
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  data-tip={link.label}
                  aria-label={t("Vela Browser on {name}", { name: link.label })}
                >
                  <svg className="brandmark" viewBox="0 0 24 24" aria-hidden="true"><path d={link.path} /></svg>
                </a>
              ))}
            </div>
            <p className="footer-mark" aria-hidden="true">Vela Browser</p>
          </div>
        </div>

      </aside>

      <div className="wall" inert={view !== "workbench"}>
        <WorkbenchPage profiles={profiles} groups={existingGroups} folders={folders} group={group} onGroupChange={setGroup} onOpenProfiles={() => setView("profiles")} onRefresh={refreshRoster} locateId={workbenchLocate.id} locateRevision={workbenchLocate.revision} covered={view !== "workbench"} />
      </div>

      {view !== "workbench" && <button type="button" className="sheet-dismiss" aria-label={t("Back to the workbench")} title={t("Back to the workbench")} onClick={() => setView("workbench")}><span /></button>}

      <div className="main">
      <header className="pagehead">
        <h1>{t(PAGE_TITLES[view])}</h1>
        {view === "profiles" && (
          <span className="pagesub">
            {filtered.length === profiles.length ? t("{count} total", { count: profiles.length }) : t("{filtered} of {total}", { filtered: filtered.length, total: profiles.length })}
          </span>
        )}
        <span className="spacer" />
        <div className="headactions">
          <CommandPalette profiles={profiles} groups={existingGroups}
            commands={[
              { id: "workbench", label: t("Multi-view workbench") }, { id: "profiles", label: t("All profiles") },
              { id: "new", label: t("New Profile") }, { id: "import", label: t("Import profiles") },
              { id: "proxies", label: t("Proxies") }, { id: "settings", label: t("Settings") },
              { id: "theme", label: t(theme === "dark" ? "Switch to light appearance" : "Switch to dark appearance") },
            ].filter((command) => true)}
            onChoose={(target: SearchTarget) => {
              setDetailId(null);
              if (target.kind === "profile") {
                const profile = profiles.find((item) => item.id === target.id); if (!profile) return;
                setStatusFilter("all"); setEngineFilter("all"); setTagFilter("");
                setSharedOnly(false); setGroup("all");
                if (profile.running && profile.permission !== "view") { setWorkbenchLocate((old) => ({ id: target.id, revision: old.revision + 1 })); setView("workbench"); }
                else { setQ(profile.id); setSelected(new Set([profile.id])); setView("profiles"); }
              } else if (target.kind === "group") selectFolder(target.id);
              else if (target.kind === "proxy") setView("proxies");
              else if (target.kind === "script") { setSearchScriptId(target.id); setView("scripts"); }
              else if (target.id === "new") openCreate();
              else if (target.id === "import") openBulk();
              else if (target.id === "theme") chooseTheme(theme === "dark" ? "light" : "dark");
              else if (target.id === "settings") openSettings();
              else if (["workbench", "profiles", "proxies"].includes(target.id)) setView(target.id as "workbench" | "profiles" | "proxies");
            }} />
          {view === "profiles" && <>
          {/* Health snapshots are pushed by automation workers through the hub, so
              in Local mode this list is always empty (see ui.ts: the local roster
              returns healthSources: []). Show the control only when something
              actually reports, instead of a button that can only say "none". */}
          {healthSources.length > 0 && (
          <div className="menuwrap" ref={nodesRef}>
            <button
              type="button"
              className={`iconbtn tip${nodesOpen ? " on" : ""}`}
              data-tip={t("Automation nodes")}
              aria-label={t("Automation node freshness")}
              onClick={() => setNodesOpen((o) => !o)}
            ><Icon name="activity" /></button>
            {nodesOpen && (
              <div className="popover below-right">
                <div className="pop-head">{t("Automation nodes")}</div>
                <HealthSources sources={healthSources} />
              </div>
            )}
          </div>
          )}
          <button
            type="button"
            className="iconbtn tip"
            data-tip={t("Refresh")}
            aria-label={t("Refresh profiles")}
            disabled={refreshing}
            onClick={() => void refreshRoster()}
          ><Icon name="refresh" /></button>
          <div className="menuwrap" ref={colsRef}>
            <button
              type="button"
              className={`iconbtn tip${colsOpen ? " on" : ""}`}
              data-tip={t("Columns")}
              aria-label={t("Choose visible columns")}
              onClick={() => setColsOpen((o) => !o)}
            ><Icon name="columns" /></button>
            {colsOpen && (
              <div className="popover below-right">
                <div className="pop-head">{t("Visible columns")}</div>
                {COLUMNS.map((column) => (
                  <label className="pop-item" key={column.key}>
                    <input type="checkbox" checked={columnVisible(column.key)} onChange={() => toggleColumn(column.key)} />
                    {t(column.label)}
                  </label>
                ))}
              </div>
            )}
          </div>
          </>}

        </div>
      </header>

      {(actionErr ?? connErr) && (
        <div className="error">
          <Icon name="alert" />
          <span>{actionErr ?? connErr}</span>
          <button className="dismiss" aria-label={t("Dismiss error")} onClick={() => { setActionErr(null); setConnErr(null); }}>
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          <Icon name="check" className="sm" />{notice}
        </div>
      )}
      {exportProgress && (
        <div className="notice" role="status">
          <Icon name="export" className="sm" />
          {exportProgress.completed >= exportProgress.total
            ? "Building export file…"
            : `Preparing export: ${exportProgress.completed.toLocaleString()} / ${exportProgress.total.toLocaleString()} profiles`}
        </div>
      )}
      {diskSpace?.low && diskSpace.freeBytes !== null && !diskWarningDismissed && (
        <div className="update-banner update-result warning" role="alert">
          <Icon name="warning" />
          <div className="update-copy">
            <strong>{t("Low disk space: {free} GB free on the drive that holds your profiles.", { free: (diskSpace.freeBytes / 1024 ** 3).toFixed(1) })}</strong>
            <span>{t("When the disk is almost full, browsers delete saved site data, which can log profiles out. Free up space on this drive.")}</span>
          </div>
          <button className="update-result-dismiss" type="button" aria-label={t("Dismiss disk space warning")} onClick={() => setDiskWarningDismissed(true)}>
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {desktopUpdateResultSummary && !desktopUpdateResultDismissed && (
        <div
          className={`update-banner update-result ${desktopUpdateResultSummary.tone}`}
          role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
        >
          <Icon name={desktopUpdateResultSummary.tone === "success" ? "check" : desktopUpdateResultSummary.tone === "warning" ? "warning" : "alert"} />
          <div className="update-copy">
            <strong>{desktopUpdateResultSummary.title}</strong>
            <span>{desktopUpdateResultSummary.detail}</span>
          </div>
          <button
            className="update-result-dismiss"
            type="button"
            aria-label={t("Dismiss last update result")}
            onClick={() => setDesktopUpdateResultDismissed(true)}
          >
            <Icon name="close" className="sm" />
          </button>
        </div>
      )}
      {desktopUpdate?.state === "available" && (
        <div className="update-banner">
          <Icon name="import" />
          <div className="update-copy">
            <span role="status"><strong>{t("Vela Browser {version} is available.", { version: desktopUpdate.version })}</strong> {t("The update will save active browsers and restart the app.")}</span>
            <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <span className="modal-err" role="alert">{t(desktopUpdateErr)}</span>}
          </div>
          <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
            {desktopUpdateInstalling ? t("Updating…") : t("Update now")}
          </button>
        </div>
      )}

      {!appMode?.legacyRemote && <>
        <ProxiesPage profilesWithoutProxy={profilesWithoutProxy} key="proxies"
          active={view === "proxies"} groups={[...([""]), ...groups.slice(1)]} folders={folders} onChanged={load}
           />
        <TrashPage key="trash"
          active={view === "trash"} onChanged={load} folderTree={folders} />
      </>}
      {view === "profiles" ? (
      <div className="workspace">
        {(breadcrumb || sharedOnly) && <nav className="folder-breadcrumb" aria-label={t("Folder path")}>
          <button className="btn ghost xs" onClick={() => selectFolder("all")}>{t("All profiles")}</button>
          {sharedOnly ? <span>{t("Shared with me")}</span> : [...(breadcrumb?.ancestors ?? []), group].map((name) => <span key={name}> / <button className="btn ghost xs" onClick={() => selectFolder(name)}>{folderLabel(name)}</button></span>)}
        </nav>}
        <div className="filterbar">
          <Select
            className="select group-filter"
            aria-label={"Group filter"}
            value={group}
            onChange={(e) => selectFolder(e.target.value)}
          >
            <option value="all">{t("All profiles")}</option>
            {existingGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </Select>
          <div className="searchfield">
            <Icon name="search" className="sm" />
            <input
              className="input search"
              placeholder={t("Search by No., id, name or tag…")}
              aria-label={t("Search profiles")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button type="button" className="clear" aria-label={t("Clear search")} onClick={() => setQ("")}><Icon name="close" className="sm" /></button>}
          </div>
          {runtimeDownloads.length > 0 && <RuntimeDownloadProgressView downloads={runtimeDownloads} />}
        </div>

        <div className="profile-filters" aria-label={t("Profile filters")}>
          <Select className="select quiet-select" aria-label={t("Filter by status")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as ProfileStatusFilter)}>
            <option value="all">{t("All statuses")}</option><option value="running">{t("running")}</option><option value="stopped">{t("Not started")}</option><option value="attention">{t("Needs attention")}</option>
          </Select>
          <Select className="select quiet-select" aria-label={t("Filter by browser")} value={engineFilter} onChange={(event) => setEngineFilter(event.target.value as ProfileEngineFilter)}>
            <option value="all">{t("All browsers")}</option><option value="chromium">Chromium</option><option value="firefox">Firefox</option><option value="webkit">WebKit</option>
          </Select>
          {(profileTags.length > 0 || tagFilter) && <Select className="select quiet-select" aria-label={t("Filter by tag")} value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
            <option value="">{t("All tags")}</option>{[...new Set([...profileTags, ...(tagFilter ? [tagFilter] : [])])].map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </Select>}
          <span className="profile-filter-count">{t("{count} profiles in view", { count: filtered.length })}</span>
          <SavedProfileViews key={`views:${managementScope}`} scope={managementScope} filters={profileFilters} onApply={applyProfileFilters} />
        </div>

        {filtered.length > 0 && (
          <div className="toolbar" role="status">
            <button type="button" className="btn" disabled={deleting || allFilteredSelected} onClick={selectAllFiltered}>
              {allFilteredSelected ? t("All {scope} selected", { scope: selectionScope }) : t("Select all {scope}", { scope: selectionScope })}
            </button>
            <span className="muted">{deleting ? t("Moving selected profiles…") : t("Across all pages")}</span>
            {!allFilteredSelected && selectedOutsideFilter > 0 && <span className="muted">{t("This replaces your selection, excluding {count} outside this view.", { count: selectedOutsideFilter })}</span>}
          </div>
        )}

        {/* Bulk actions only exist once there is a selection to act on — an
            always-present strip of disabled buttons read as clutter. */}
        {selected.size > 0 && (
        <div className="toolbar active">
          <span className="selcount">
            <Icon name="check" className="sm" />
            {t("{count} selected", { count: selected.size })}
          </span>
          <button type="button" className="btn ghost" aria-label={t("Clear selection")} onClick={() => setSelected(new Set())}>{t("Clear selection")}</button>
          <button className="btn primary tip" data-tip={t("Open selected browsers")} disabled={!selected.size} onClick={openSelected}>
            <Icon name="play" className="sm" />{t("Open")}
          </button>
          <button className="btn solid-danger tip" data-tip={t("Close selected browsers")} disabled={!selected.size} onClick={closeSelected}>
            <Icon name="power" className="sm" />{t("Close")}
          </button>
          {<>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setScriptRunProfiles(profiles.filter((profile) => selected.has(profile.id)));
              setScriptRunOpen(true);
            }}
          ><Icon name="play" className="sm" />{t("Run script")}</button>
          <button
            className="btn tip"
            type="button"
            data-tip={t("Open browsers get the cookies now; closed profiles at their next start")}
            onClick={() => openCookie(profiles.filter((profile) => selected.has(profile.id)))}
          ><Icon name="cookie" className="sm" />{t("Add cookies")}</button>
          <span className="vsep" />
          {selectedMobileCount > 0 && (
            <button className="btn warn" onClick={convertSelectedMobile}>
              <Icon name="laptop" className="sm" />Convert mobile ({selectedMobileCount})
            </button>
          )}
          {/* Bulk edits preserve each environment’s stored identity. */}
          <div className="menuwrap" ref={exportRef}>
            <button className="btn tip" data-tip={t("Export selected profiles")} disabled={!selected.size || !!exportProgress} onClick={() => setExportOpen((o) => !o)}>
              <Icon name="export" className="sm" />{t("Export")}<Icon name="chevronDown" className="sm" />
            </button>
            {exportOpen && selected.size > 0 && !exportProgress && (
              <div className="exportmenu popover below-left" onMouseLeave={() => setExportOpen(false)}>
                <button className="pop-item" onClick={() => exportSelected("csv")}><Icon name="file" className="sm" />{t("Export as CSV (credentials)")}</button>
                <button className="pop-item" onClick={() => exportSelected("txt")}><Icon name="file" className="sm" />{t("Export as .txt (full profile)")}</button>
                <button className="pop-item" onClick={() => exportSelected("xlsx")}><Icon name="file" className="sm" />{t("Export as Excel (full profile)")}</button>
              </div>
            )}
          </div>
          <button className="btn tip" data-tip={t("Export → edit → re-upload")} disabled={!selected.size || !!exportProgress} onClick={openUpdate} title={t("Export → edit → re-upload to change credentials in bulk")}>
            <Icon name="edit" className="sm" />{t("Edit from file")}
          </button>
          <span className="vsep" />
          <div className="movewrap">
            {newMode ? (
              <input className="input" autoFocus placeholder={t("new group name")} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
            ) : (
              <Select
                className="select move-group"
                aria-label={t("Move to group")}
                title={moveTarget || "Choose group"}
                disabled={!selected.size || !selectedMovable}
                value={moveTarget}
                onChange={(e) => (e.target.value === "__new__" ? setNewMode(true) : setMoveTarget(e.target.value))}
              >
                <option value="">{t("Move to…")}</option>
                {editableGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
                <option value="__new__">{t("+ new group…")}</option>
              </Select>
            )}
            {newMode && (
              <button className="btn ghost" onClick={() => { setNewMode(false); setNewGroup(""); }}>{t("cancel")}</button>
            )}
            <button className="btn accent" disabled={!selected.size || !selectedMovable || (newMode ? !newGroup.trim() : !moveTarget)} onClick={moveSelected}>
              <Icon name="move" className="sm" />{t("Move")}
            </button>
          </div>
          {extensions.length > 0 && selectedProfilesSupportChromeExtensions && (
            <>
              <span className="vsep" />
              <div className="extctl">
                <span className="extctl-lbl"><Icon name="puzzle" className="sm" />{t("Extension")}</span>
                <Select className="select extctl-sel" aria-label={t("Extension for bulk assignment")} disabled={!selected.size} value={bulkExt} onChange={(e) => setBulkExt(e.target.value)}>
                  <option value="">{t("choose…")}</option>
                  {extensions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("add")}>{t("Add")}</button>
                <button className="btn xs" disabled={!selected.size || !bulkExt} onClick={() => bulkAssignExt("remove")}>{t("Remove")}</button>
              </div>
            </>
          )}
          <span className="spacer" />
          {(
            <button className="btn danger tip" data-tip={appMode?.legacyRemote ? t("Delete selected profiles") : t("Move selected profiles to Trash")} disabled={!selected.size || deleting} onClick={deleteSelected}>
              <Icon name="trash" className="sm" />{deleting ? t("Processing…") : appMode?.legacyRemote ? t("Delete") : t("Move {count} to Trash", { count: selected.size.toLocaleString() })}
            </button>
          )}
          </>}
        </div>
        )}

        <div
          className={`tablewrap${tableScrolled ? " scrolled" : ""}`}
          onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}
        >
          <table className="profile-table" style={{ minWidth: tableMinWidth }}>
            <thead>
              <tr>
                <th className="chk" style={{ width: CHECKBOX_COLUMN_WIDTH }}>
                  <input type="checkbox" aria-label={t("Select all visible profiles")} checked={allVisibleSelected} onChange={toggleAll} />
                </th>
                {shownColumns.map(columnHead)}
              </tr>
            </thead>
            <tbody>
              {visibleProfiles.map((p) => {
                // The numbering memo covers every roster profile, so this
                // lookup cannot miss; a silent fallback here would renumber
                // rows wrongly if that invariant ever broke.
                const no = numbering.get(p.id)!;
                // Changes to a running browser apply on its next start.
                const canEditRow = true;
                return (
                <tr key={p.id} className={`${p.running ? "running" : ""}${selected.has(p.id) ? " selected" : ""}`} onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("button, input, select, a, [role='button']")) return;
                  setDetailId(p.id);
                }}>
                  <td className="chk">
                    <input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                  </td>
                  {columnVisible("no") && (
                    <td className="col-no">
                      <span className={`no-text${no.custom ? " custom" : ""}`} title={`${no.custom ? t("Custom NO.") : "Serial"} ${no.value}`}>{no.value}</span>
                    </td>
                  )}
                  {columnVisible("name") && (
                    <td className="col-name" title={`${p.name}\n${p.id}`}>
                      <span className="name-cell">
                        <button type="button" className="profile-name-link" aria-label={t("View details for {profile}", { profile: p.name })} onClick={() => setDetailId(p.id)}><span className="n">{p.name}<FingerprintBadge p={p} /></span></button>
                        <span className="sub">
                          {p.id}
                          <span title={p.engine === "webkit" ? t(WEBKIT_NOTE) : p.engine === "firefox" ? "Native Firefox profile · no CDP, PDF, or Chrome extensions" : `${browserLabel(p.engine, p.chromiumRuntime)} · CDP, PDF, and Chrome extensions`}>
                            {browserLabel(p.engine, p.chromiumRuntime)}
                          </span>
                          {p.running && <span className="live"><StatusDot running />{t("running")}</span>}
                          {p.lockedBy && (
                            <span className="lockedby" title={`in use by ${p.lockedBy}`}>
                              <Icon name="lock" className="sm" />{p.lockedBy}
                            </span>
                          )}

                        </span>
                        {(p.restartPending || !!p.pendingCookieCount) && (
                          <span className="status">
                            {p.restartPending && (
                              <button
                                type="button"
                                className="status-chip warn tip"
                                data-tip={t("Saved proxy or fingerprint changes apply when this browser restarts. Click to restart it now.")}
                                aria-label={t("Restart {profile} so the saved changes apply", { profile: p.name })}
                                disabled={busy[p.id]}
                                onClick={() => act(p.id, restartProfile)}
                              ><Icon name="refresh" className="sm" />{t("Applies at next start")}</button>
                            )}
                            {!!p.pendingCookieCount && (
                              <button
                                type="button"
                                className="status-chip tip"
                                data-tip={t("The browser sets these cookies the next time it starts. Click to see or remove them.")}
                                onClick={() => void openPendingCookies(p)}
                              ><Icon name="cookie" className="sm" />{t("{count} cookie(s) at next start", { count: String(p.pendingCookieCount) })}</button>
                            )}
                          </span>
                        )}
                      </span>
                    </td>
                  )}
                  {columnVisible("group") && (
                    <td className="col-group" title={p.group}>
                      {p.group ? <span className="chip">{p.group}</span> : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("platform") && <td className="col-platform"><PlatformPill platform={p.platform} /></td>}
                  {columnVisible("tags") && (
                    <td className="col-tags" title={p.tags?.length ? p.tags.join(", ") : "No tags"}>
                      {p.tags?.length ? p.tags.map((t) => <span key={t} className="chip">{t}</span>) : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("proxy") && (
                    <td className="col-proxy" title={p.proxyError || p.proxy || "no proxy"}>
                      {p.proxyError
                        ? <span className="proxy-cell bad"><Icon name="warning" className="sm" />invalid — edit</span>
                        : p.proxy
                          ? <span className="proxy-cell">{p.proxy}</span>
                          : <span className="muted">—</span>}
                    </td>
                  )}
                  {columnVisible("action") && (
                    <td className="col-action">
                      <span className="rowactions">
                        {p.has2fa && (
                          <button
                            className={`iconbtn twofa tip${twoFaFlash?.id === p.id ? " flash" : ""}`}
                            data-tip={twoFaFlash?.id === p.id ? `Copied ${twoFaFlash.code}` : "Copy current 2FA code"}
                            aria-label={t("Copy current 2FA code")}
                            onClick={() => copy2fa(p.id)}
                          >
                            <Icon name={twoFaFlash?.id === p.id ? "check" : "key"} className="sm" />
                          </button>
                        )}

                        {canEditRow && (
                          <button className="iconbtn tip" data-tip={t("Edit profile")} aria-label={`Edit ${p.name}`} onClick={() => openEdit(p.id)}>
                            <Icon name="edit" className="sm" />
                          </button>
                        )}
                        {canEditRow && (
                          <button
                            className="iconbtn tip"
                            data-tip={t("Add cookies")}
                            aria-label={t("Add cookies to {profile}", { profile: p.name })}
                            onClick={() => openCookie([p])}
                          ><Icon name="cookie" className="sm" /></button>
                        )}
                        {p.running ? (
                          <>
                            {p.engine === "chromium" && <>
                              <button
                                className="iconbtn tip"
                                data-tip={t("Bring to front")}
                                aria-label={t("Bring this browser window to the front")}
                                disabled={busy[p.id]}
                                onClick={() => act(p.id, raiseProfile)}
                              ><Icon name="raise" className="sm" /></button>
                            </>}
                            <button
                              className="iconbtn tip"
                              data-tip={t("Check fingerprint")}
                              aria-label={t("Open the fingerprint test in {profile}", { profile: p.name })}
                              disabled={busy[p.id]}
                              onClick={() => {
                                if (appMode?.legacyRemote) { void act(p.id, (id) => checkFingerprint(id, fingerprintPage)); return; }
                                const request = ++fingerprintRequest.current;
                                setFingerprintView({ profile: p, audit: null, error: null });
                                void measureFingerprint(p.id).then((audit) => {
                                  if (fingerprintRequest.current === request) setFingerprintView({ profile: p, audit, error: null });
                                }, (error) => {
                                  if (fingerprintRequest.current === request) setFingerprintView({ profile: p, audit: null, error: String(error.message ?? "Fingerprint measurement could not complete. Reopen this browser and try again.") });
                                });
                              }}
                            ><Icon name="fingerprint" className="sm" /></button>
                            <button className="btn sm solid-danger" aria-label={`Close ${p.name}`} disabled={busy[p.id]} onClick={() => act(p.id, closeProfile)}>
                              <Icon name="power" className="sm" />{t("Close")}
                            </button>
                          </>
                        ) : p.mobilePersona ? (
                          !p.lockedBy && (true) ? (
                            <button className="btn sm warn" disabled={busy[p.id]} title={t("Convert this mobile persona to a desktop device")} onClick={() => openEdit(p.id)}>
                              <Icon name="laptop" className="sm" />Convert
                            </button>
                          ) : null
                        ) : (
                          <button
                            className="btn sm primary"
                            aria-label={`Open ${p.name}`}
                            title={p.lockedBy ? `Open — session writer: ${p.lockedBy}; this browser will not save its session back` : undefined}
                            disabled={busy[p.id]}
                            onClick={() => act(p.id, openProfile)}
                          >
                            <Icon name="play" className="sm" />{openLabel(p)}
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
                );
              })}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={visibleColumnCount} className="empty">
                    <div className="emptystate">
                      <span className="glyph"><Icon name="profiles" /></span>
                      {profiles.length === 0 ? (
                        <>
                          <b>{t("No profiles yet")}</b>
                          <p>{t("Create a profile or import a readable export from another browser.")}</p>
                          <div className="empty-actions">
                            <button className="btn primary" disabled={false} onClick={openCreate}><Icon name="plus" className="sm" />{t("New Profile")}</button>
                            <button className="btn" disabled={false} onClick={openBulk}><Icon name="fileImport" className="sm" />{t("Import profiles")}</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <b>{t("No matches")}</b>
                          <p>{t("No profiles match the current filters.")}</p>
                          <button className="btn" onClick={clearProfileFilters}>{t("Clear filters")}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {showDiag && diag && (
          <div className="diagpanel">
            <div className="when">Last diagnose: {diagWhen}</div>
            {diag.analysis.verdicts.map((v, i) => (
              <div className="v" key={i}>{v}</div>
            ))}
          </div>
        )}

        <footer className="statusbar">
          <span className="stat"><b>{profiles.length}</b> {t("profiles")}</span>
          <span className="stat"><StatusDot running={runningCount > 0} /><b>{runningCount}</b> {t("running")}</span>
          {diag && (
            <span className="diag" onClick={() => setShowDiag((s) => !s)}>
              Diagnose · last {diagWhen}
              <Icon name={showDiag ? "chevronDown" : "chevronRight"} className="sm" />
            </span>
          )}
          <span className="pager">
            <button
              type="button"
              className="iconbtn"
              aria-label={t("Previous page")}
              disabled={visibleProfilePage === 0}
              onClick={() => setProfilePage(visibleProfilePage - 1)}
            ><Icon name="chevronLeft" className="sm" /></button>
            <span className="page-of">{t("Page")} <b>{visibleProfilePage + 1}</b> / {profilePageCount}</span>
            <button
              type="button"
              className="iconbtn"
              aria-label={t("Next page")}
              disabled={visibleProfilePage + 1 >= profilePageCount}
              onClick={() => setProfilePage(visibleProfilePage + 1)}
            ><Icon name="chevronRight" className="sm" /></button>
            <Select className="select" aria-label={t("Rows per page")} value={pageSize} onChange={(e) => applyPageSize(Number(e.target.value))}>
              {PAGE_SIZES.map((size) => <option key={size} value={size}>{t("{size} / page", { size })}</option>)}
            </Select>
          </span>
        </footer>
      </div>
      ) : view === "workbench" ? null : view === "scripts" ? (
      <ScriptsPage onViewRun={() => setScriptRunOpen(true)} initialScriptId={searchScriptId} />
      ) : view === "extensions" ? (
      <div className="workspace">
        <div className="settingspage">
          {extErr && <div className="modal-err"><Icon name="alert" className="sm" />{extErr}</div>}
          <section className="settings-card">
            <header><Icon name="puzzle" className="sm" /><h2>{t("Install from Chrome Web Store")}</h2></header>
            <div className="card-body">
              <p>{t("Paste a Chrome Web Store extension link or its 32-character ID.")}</p>
              <form className="fld-row" onSubmit={(event) => { event.preventDefault(); void doInstallWebStoreExtension(); }}>
                <input
                  className="input"
                  style={{ flex: 1 }}
                  aria-label={t("Chrome Web Store URL or extension ID")}
                  placeholder="https://chromewebstore.google.com/detail/…"
                  value={extSource}
                  onChange={(event) => setExtSource(event.target.value)}
                />
                <button className="btn primary" type="submit" disabled={extInstallBusy || extBusy}>
                  <Icon name="plus" className="sm" />{extInstallBusy ? t("Installing…") : t("Install")}
                </button>
              </form>
              <p className="formnote">{t("The in-browser Store button does not work in CloakBrowser. Paste the Store link above, or upload a ZIP/CRX archive. Chrome extensions apply only to CloakBrowser profiles.")}</p>
              <ol className="steps">
                <li>{t("Install the extension here. New installs stay unassigned.")}</li>
                <li>{t("Use")} <b>{t("Edit > Extensions")}</b> {t("to assign it to a profile, or assign many at once from the roster toolbar.")}</li>
                <li>{t("Reopen the profile. Vela Browser loads the extension when the browser starts.")}</li>
              </ol>
            </div>
          </section>
          <section className="settings-card">
            <header><Icon name="folder" className="sm" /><h2>{t("Group defaults")}</h2></header>
            <div className="card-body">
              <p>{t("Choose the exact extensions assigned to this group.")}</p>
              {editableDefaultGroups.length === 0 ? (
                <p className="formnote">{t("Create an editable group before setting its extension defaults.")}</p>
              ) : (
                <>
                  <label className="fld">
                    <span>{t("Group")}</span>
                    <Select
                      aria-label={t("Extension default group")}
                      value={groupDefaultName}
                      onChange={(event) => {
                        const name = event.target.value;
                        setGroupDefaultName(name);
                        setGroupDefaultExts(groupExtensionDefaults.find((item) => item.name === name)?.extensions ?? []);
                      }}
                    >
                      {editableDefaultGroups.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                    </Select>
                  </label>
                  {groupDefaultExtensionChoices.length > 0 ? (
                    <div className="extassign">
                      {groupDefaultExtensionChoices.map((item) => (
                        <label key={item.id} className="extchk">
                          <input
                            type="checkbox"
                            checked={groupDefaultExts.includes(item.id)}
                            onChange={() => toggleGroupDefaultExt(item.id)}
                          />
                          <span>{item.name}{item.missing && <span className="muted">{t(" · Not installed on this device")}</span>}</span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="formnote">{t("No extensions are installed. Apply an empty selection to clear this default.")}</p>
                  )}
                  <p className="formnote">
                    {t("Applying replaces assignments on {count} current profile(s). New and moved profiles inherit it.", { count: groupDefaultProfileCount })}
                    {t("Individual profiles can differ later. Reopen browsers to apply changes.")}
                  </p>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={groupDefaultBusy || !groupDefaultName}
                    onClick={applyGroupExtensionDefault}
                  >
                    {groupDefaultBusy ? t("Applying…") : t("Apply group default")}
                  </button>
                </>
              )}
            </div>
          </section>
          <section className="settings-card">
            <header>
              <Icon name="puzzle" className="sm" /><h2>{t("Installed extensions")}</h2>
              {extensions.length > 0 && (
                <button className="btn" type="button" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
                  <Icon name="plus" className="sm" />{extBusy ? t("Uploading…") : t("Upload ZIP/CRX")}
                </button>
              )}
            </header>
            <div className="card-body">
          {extensions.length === 0 ? (
            <div className="emptystate">
              <span className="glyph"><Icon name="puzzle" /></span>
              <b>{t("No extensions yet")}</b>
              <p>{t("Uploaded extensions appear here, ready to assign to any profile.")}</p>
              <button className="btn primary" disabled={extBusy || extInstallBusy} onClick={() => extFileRef.current?.click()}>
                <Icon name="plus" className="sm" />{extBusy ? t("Uploading…") : t("Upload ZIP/CRX")}
              </button>
            </div>
          ) : (
            <div className="extlist">
              {extensions.map((x) => (
                <div key={x.id} className="extrow">
                  <Icon name="puzzle" className="sm" />
                  <span className="extname">{x.name}</span>
                  <span className="spacer" />
                  <button className="btn xs danger" onClick={() => doRemoveExtension(x.id, x.name)}>{t("Remove")}</button>
                </div>
              ))}
            </div>
          )}
            </div>
          </section>
          <input
            ref={extFileRef}
            type="file"
            multiple
            accept=".zip,.crx,application/zip,application/x-chrome-extension"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files) doUploadExtensions(e.target.files); e.target.value = ""; }}
          />
        </div>
      </div>
      ) : view === "settings" ? (
      <div className="workspace">
        <div className="tabs" role="tablist" aria-label={t("Settings sections")}>
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={settingsTab === tab.key}
              className={`tab${settingsTab === tab.key ? " active" : ""}`}
              onClick={() => setSettingsTab(tab.key)}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
        <div className="settingspage">

          {settingsTab === "general" && (
            <>
<section className="settings-card">
            <header><Icon name="sun" className="sm" /><h2>{t("Appearance")}</h2></header>
            <div className="card-body">
              <p>{t("Choose how Vela Browser looks. System follows your operating system setting.")}</p>
              <div className="segmented" role="radiogroup" aria-label={t("Theme")}>
                {THEMES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.key}
                    className={theme === option.key ? "active" : ""}
                    onClick={() => chooseTheme(option.key)}
                  >
                    <Icon name={option.icon} className="sm" />{t(option.label)}
                  </button>
                ))}
              </div>
              <label className="fld"><span>{t("language.label")}</span>
                <Select className="select" value={language} onChange={(event) => setLanguage(event.target.value)}>
                  {availableLanguages().map((lang) => (
                    <option key={lang} value={lang}>{languageNativeName(lang)}</option>
                  ))}
                </Select>
              </label>
            </div>
          </section>
          {appMode?.taskbarModeSupported && (
            <section className="settings-card">
              <header><Icon name="wall" className="sm" /><h2>{t("Environment windows")}</h2></header>
              <div className="card-body">
                <p>{t("Hide only removes each environment's taskbar button. The window, its position and everything a page can see stay exactly the same.")}</p>
                <div className="segmented" role="radiogroup" aria-label={t("Taskbar")}>
                  {([[false, "Show in taskbar"], [true, "Hide from taskbar"]] as const).map(([hidden, label]) => (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={(appMode.hideFromTaskbar === true) === hidden}
                      className={(appMode.hideFromTaskbar === true) === hidden ? "active" : ""}
                      onClick={() => {
                        const previous = appMode.hideFromTaskbar === true;
                        setAppMode({ ...appMode, hideFromTaskbar: hidden });
                        saveTaskbarHidden(hidden)
                          .then((saved) => setAppMode((current) => current && { ...current, hideFromTaskbar: saved }))
                          .catch((error) => {
                            setAppMode((current) => current && { ...current, hideFromTaskbar: previous });
                            flash(error instanceof Error ? error.message : String(error));
                          });
                      }}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
          {appMode?.coolingSupported && appMode.cooling && (() => {
            const cooling = appMode.cooling;
            const save = (change: Partial<CoolingSettings>) => {
              const previous = cooling;
              setAppMode({ ...appMode, cooling: { ...cooling, ...change } });
              saveCooling(change)
                .then((saved) => setAppMode((current) => current && { ...current, cooling: saved }))
                .catch((error) => {
                  setAppMode((current) => current && { ...current, cooling: previous });
                  flash(error instanceof Error ? error.message : String(error));
                });
            };
            return (
              <section className="settings-card">
                <header><Icon name="snow" className="sm" /><h2>{t("Cooling")}</h2></header>
                <div className="card-body">
                  <p>{t("When memory runs short, the browser you have left alone the longest closes safely. It keeps its place on the workbench and wakes signed in, with its tabs. Browsers you are using, or that a script or AI is driving, are never cooled.")}</p>
                  <div className="segmented" role="radiogroup" aria-label={t("Cooling")}>
                    {([[true, "On"], [false, "Off"]] as const).map(([enabled, label]) => (
                      <button key={label} type="button" role="radio" aria-checked={cooling.enabled === enabled}
                        className={cooling.enabled === enabled ? "active" : ""} onClick={() => save({ enabled })}>{t(label)}</button>
                    ))}
                  </div>
                  {cooling.enabled && (
                    <div className="cooling-fields">
                      <label className="fld"><span>{t("Start cooling at memory use")}</span>
                        <Select className="select" value={cooling.threshold} onChange={(event) => save({ threshold: Number(event.target.value) })}>
                          {[...new Set([70, 75, 80, 85, 90, 95, cooling.threshold])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}%</option>)}
                        </Select>
                      </label>
                      <label className="fld"><span>{t("Only browsers left alone for")}</span>
                        <Select className="select" value={cooling.idleMinutes} onChange={(event) => save({ idleMinutes: Number(event.target.value) })}>
                          {[...new Set([5, 10, 15, 30, 60, cooling.idleMinutes])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{t("{count} min", { count: value })}</option>)}
                        </Select>
                      </label>
                    </div>
                  )}
                  {typeof appMode.memoryUse === "number" && <p className="formnote">{t("Memory in use now: {value}%", { value: Math.round(appMode.memoryUse) })}</p>}
                </div>
              </section>
            );
          })()}

            </>
          )}

          {settingsTab === "advanced" && (
            <>
              {!appMode?.legacyRemote && <PluginsCard flash={flash} />}
              <h2 className="sect-title">{t("Updates and diagnostics")}</h2>
<section className="settings-card update-settings">
            <header><Icon name="import" className="sm" /><h2>{t("Updates")}</h2></header>
            <div className="card-body">
            <div className="settings-row"><span>{t("Installed version")}</span><strong className="mono">{appVersion || desktopUpdate?.currentVersion || "—"}</strong></div>
            {desktopUpdateResultSummary && (
              <div
                className={`update-last-result ${desktopUpdateResultSummary.tone}`}
                role={desktopUpdateResultSummary.tone === "success" ? "status" : "alert"}
              >
                <strong>{t(desktopUpdateResultSummary.title)}</strong>
                <span>{t(desktopUpdateResultSummary.detail)}</span>
              </div>
            )}
            {desktopUpdate?.state === "upToDate" && <p role="status">{t("Vela Browser is up to date.")}</p>}
            {desktopUpdate?.state === "available" && (
              <>
                <p role="status">{t("Version {version} is ready. Active browsers will be saved and closed.", { version: desktopUpdate.version })}</p>
                <UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />
              </>
            )}
            {!desktopUpdate && !desktopUpdateChecking && <p>{t("Vela Browser checks for updates when it starts.")}</p>}
            {desktopUpdateProgress && <DesktopUpdateProgressView progress={desktopUpdateProgress} />}
            {desktopUpdateErr && <div className="modal-err" role="alert">{t(desktopUpdateErr)}</div>}
            <div className="update-actions">
              <button className="btn" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void checkDesktopUpdate(true)}>
                <Icon name="refresh" className="sm" />{desktopUpdateChecking ? t("Checking…") : t("Check for updates")}
              </button>
              {desktopUpdate?.state === "available" && (
                <button className="btn primary" type="button" disabled={desktopUpdateChecking || desktopUpdateInstalling} onClick={() => void installDesktopUpdate()}>
                  {desktopUpdateInstalling ? t("Updating…") : t("Update now")}
                </button>
              )}
            </div>
            </div>
          </section>


          {/* Logs and diagnostics stay on this computer. */}
          <section className="settings-card">
            <header><Icon name="logs" className="sm" /><h2>{t("Logs")}</h2></header>
            <div className="card-body">
              <p>{t("The detailed log records launches, proxy setup and browser lifecycle for this installation.")}</p>
              <button type="button" className="btn" onClick={() => {
                setLogErr(null);
                fetchLogs().then(setLogView).catch((e) => setLogErr(e instanceof Error ? e.message : String(e)));
              }}><Icon name="logs" className="sm" />{t("View detailed logs")}</button>
              {logErr && <p className="cardnote">{t("Logs")}: {t(logErr)}</p>}
              {logDir && <p className="cardnote">{t("File")}: {logDir}</p>}
            </div>
          </section>

            </>
          )}

        </div>
      </div>
      ) : null}
      </div>

      {fingerprintView && (
        <div className="modal-backdrop" onClick={() => { ++fingerprintRequest.current; setFingerprintView(null); }}>
          <div className="modal fp-audit" role="dialog" aria-modal="true" aria-labelledby="fp-audit-title" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { ++fingerprintRequest.current; setFingerprintView(null); } }}>
            <div className="modal-head"><span id="fp-audit-title">{t("Fingerprint measurement")}</span><button autoFocus className="modal-close" type="button" aria-label={t("Close")} onClick={() => { ++fingerprintRequest.current; setFingerprintView(null); }}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              <p className="hint">{fingerprintView.profile.name} · {fingerprintView.profile.engine}</p>
              {fingerprintView.error ? <p role="alert" className="modal-err">{t(fingerprintView.error)}</p> : !fingerprintView.audit ? <p className="hint" role="status">{t("Measuring in a temporary local page…")}</p> : <>
                <p className="hint">{t("Measured values show what this browser exposes. Restart stability and differences between environments require separate tests.")}</p>
                <div className="fp-audit-surfaces">
                  {fingerprintView.audit.surfaces.map((item) => <section key={item.surface} className="fp-audit-surface">
                    <div className="fp-audit-line"><b>{({ canvas: "Canvas", audio: "Audio", webgl: "WebGL", fonts: t("Fonts") })[item.surface]}</b><span className={item.measured ? "hint" : "fp-audit-missing"}>{t(item.measured ? "Measured" : "Incomplete measurement")}</span></div>
                    <p className="hint">{t(item.implementation === "kernel-seeded" ? "Profile seed applied by the engine" : item.implementation === "native" ? "Native browser values" : "Managed by the browser engine")}</p>
                    {item.repeatedRead !== "not-measured" && <p className={item.repeatedRead === "inconsistent" ? "fp-audit-missing" : "hint"}>{t(item.repeatedRead === "consistent" ? "Repeated reads are consistent" : "Repeated reads differ")}</p>}
                    {item.integrity.filter((check) => check.result !== "not-measured").map((check) => <p key={check.name} className={check.result === "inconsistent" ? "fp-audit-missing" : "hint"}>{t(({ canvasWrites: "Canvas pixel round trip", audioWrites: "Audio buffer round trip", audioSilence: "Silent audio remains silent" })[check.name])} · {t(check.result === "consistent" ? "Consistent" : "Inconsistent")}</p>)}
                    <details><summary>{t("Measurement details")}</summary><dl>{Object.entries(item.values).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value}</dd></div>)}{item.missing.map((field) => <div key={field}><dt>{field}</dt><dd>{t("Unavailable")}</dd></div>)}</dl></details>
                  </section>)}
                </div>
                <div className="fp-audit-diagnostics">
                  {fingerprintView.audit.diagnostics.map((item) => <details key={item.name}>
                    <summary><span>{t(({ identity: "Browser identity", locale: "Language and timezone", display: "Screen and input", hardware: "Hardware", webgl2: "WebGL 2", webgpu: "WebGPU", audio: "Audio properties", media: "Media devices", voices: "Speech voices", storage: "Storage quota", permissions: "Permissions" })[item.name])}</span><span className={item.measured ? "hint" : "fp-audit-missing"}>{t(item.measured ? "Measured" : "Unavailable")}</span></summary>
                    {item.measured ? <pre>{JSON.stringify(item.value, null, 2)}</pre> : <p className="hint">{item.error || t("No measurement yet")}</p>}
                  </details>)}
                </div>
                {fingerprintView.audit.capturedAt && <p className="hint">{new Date(fingerprintView.audit.capturedAt).toLocaleString()}</p>}
              </>}
            </div>
            <div className="modal-foot"><button type="button" className="btn ghost" onClick={() => { ++fingerprintRequest.current; setFingerprintView(null); }}>{t("Close")}</button></div>
          </div>
        </div>
      )}

      {(logView || logErr) && (
        <div className="modal-backdrop" onClick={() => { setLogView(null); setLogErr(null); }}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">{t("Detailed logs")}<button type="button" className="modal-close" aria-label={t("Close")} onClick={() => { setLogView(null); setLogErr(null); }}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {logErr && <p className="hint">{logErr}</p>}
              {logView && (
                <pre className="logpre">
                  {logView.file + "\n" + logView.content}
                </pre>
              )}
            </div>
            <div className="modal-foot"><button className="btn ghost" type="button" onClick={() => { setLogView(null); setLogErr(null); }}>{t("Close")}</button></div>
          </div>
        </div>
      )}


      {pendingView && (
        <div className="modal-backdrop" onClick={() => { if (!pendingView.busy) setPendingView(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pending-cookie-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head" id="pending-cookie-title">
              <Icon name="cookie" />{t("Cookies at next start")}<span className="mono muted">{pendingView.profile.name}</span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={pendingView.busy} onClick={() => setPendingView(null)}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {pendingView.error && <div className="modal-err"><Icon name="alert" className="sm" />{pendingView.error}</div>}
              <p className="hint">{t("The browser sets these cookies the next time it starts, before the first page opens.")}</p>
              {pendingView.cookies === null
                ? <p className="muted">{t("Loading…")}</p>
                : <ul className="pending-cookies">{pendingView.cookies.map((cookie, index) => (
                  <li key={index}><span className="mono">{cookie.domain}</span><span className="mono muted">{cookie.name}</span></li>
                ))}</ul>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" disabled={pendingView.busy} onClick={() => setPendingView(null)}>{t("Close")}</button>
              <button className="btn danger" type="button" disabled={pendingView.busy || !pendingView.cookies?.length} onClick={() => void removePendingCookies()}>
                <Icon name="trash" className="sm" />{t("Remove pending cookies")}
              </button>
            </div>
          </div>
        </div>
      )}

      {cookieTargets && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-cookie-title"
            onSubmit={(event) => { event.preventDefault(); void submitCookie(); }}
          >
            <div className="modal-head" id="add-cookie-title">
              <Icon name="cookie" />{t("Add cookies")}
              <span className="mono muted">{cookieTargets.length === 1 ? cookieTargets[0]!.name : t("{count} profiles", { count: String(cookieTargets.length) })}</span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={cookieSaving} onClick={closeCookie}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {cookieErr && <div className="modal-err" style={{ whiteSpace: "pre-line" }}><Icon name="alert" className="sm" />{cookieErr}</div>}
              <p className="hint">{cookieTargets.length > 1
                ? t("Open browsers get the cookies now. Closed profiles get them the next time they start, before the first page opens.")
                : cookieTargets[0]!.running
                  ? t("The open browser gets the cookies now.")
                  : t("The browser sets these cookies the next time it starts, before the first page opens.")}</p>
              <label className="fld">
                <span>{t("Paste cookies (JSON export or cookies.txt)")}</span>
                <textarea rows={5} spellCheck={false} autoComplete="off" value={cookieText} placeholder={'[{"name":"auth_token","value":"…","domain":".x.com","path":"/"}]'} onChange={(event) => setCookieText(event.target.value)} />
              </label>
              {!cookieText.trim() && <>
                <p className="hint">{t("Or add one cookie:")}</p>
                <div className="fld-row">
                  <label className="fld grow">
                    <span>{t("Name")}</span>
                    <input value={cookieForm.name} onChange={(event) => setCookieField("name", event.target.value)} />
                  </label>
                  <label className="fld grow">
                    <span>{t("Value")}</span>
                    <input type="password" autoComplete="off" value={cookieForm.value} onChange={(event) => setCookieField("value", event.target.value)} />
                  </label>
                </div>
                <div className="fld-row">
                  <label className="fld grow">
                    <span>{t("Domain")}</span>
                    <input value={cookieForm.domain} placeholder="example.com" onChange={(event) => setCookieField("domain", event.target.value)} />
                  </label>
                  <label className="fld port">
                    <span>{t("Path")}</span>
                    <input value={cookieForm.path} onChange={(event) => setCookieField("path", event.target.value)} />
                  </label>
                </div>
              </>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" type="button" disabled={cookieSaving} onClick={closeCookie}>{t("Cancel")}</button>
              <button className="btn primary" type="submit" disabled={cookieSaving || (!cookieText.trim() && (!cookieForm.name || !cookieForm.domain.trim() || !cookieForm.path.startsWith("/")))}>
                {cookieSaving ? t("Adding…") : t("Add cookies")}
              </button>
            </div>
          </form>
        </div>
      )}

      {movingFolder && <div className="modal-backdrop" onClick={() => { if (!folderMoveBusy) setMovingFolder(null); }}>
        <div className="modal mode-confirm" role="dialog" aria-modal="true" aria-labelledby="folder-move-title" onClick={(event) => event.stopPropagation()}>
          <div className="modal-head" id="folder-move-title">{t("Move {folder}", { folder: movingFolder })}</div>
          <div className="modal-body">
            <label className="fld"><span>{t("Parent folder")}</span><Select value={folderParent} disabled={folderMoveBusy} onChange={(event) => setFolderParent(event.target.value)}>
              <option value="">{t("Top level")}</option>
              {tree.filter((folder) => folder.name !== movingFolder && !folder.ancestors.includes(movingFolder)).map((folder) => <option key={folder.name} value={folder.name}>{folder.name}</option>)}
            </Select></label>

            {folderMoveErr && <div className="modal-err" role="alert">{folderMoveErr}</div>}
          </div>
          <div className="modal-foot"><button className="btn ghost" disabled={folderMoveBusy} onClick={() => setMovingFolder(null)}>{t("Cancel")}</button><button className="btn primary" disabled={folderMoveBusy} onClick={() => void commitFolderMove()}>{t("Move")}</button></div>
        </div>
      </div>}


      {detailProfile && <ProfileDetailDrawer key={`${managementScope}:${detailProfile.id}`} profile={detailProfile} number={numbering.get(detailProfile.id)?.value ?? detailProfile.id}
        browser={browserLabel(detailProfile.engine, detailProfile.chromiumRuntime)} canEdit={true}
        busy={!!busy[detailProfile.id]} onClose={() => setDetailId(null)}
        onEdit={() => { setDetailId(null); openEdit(detailProfile.id); }}
        onToggle={() => void act(detailProfile.id, detailProfile.running ? closeProfile : openProfile)}
        onCookies={() => { setDetailId(null); void openPendingCookies(detailProfile); }} />}

      {showCreate && (
        <ProfileCreationDialog onCancel={closeCreate}>
            <div className="modal-head">
              <Icon name="plus" /><span id="create-profile-title">{t("New profile")}</span>
              <button type="button" className="modal-close" aria-label={t("Close")} disabled={creating} onClick={closeCreate}><Icon name="close" className="sm" /></button>
            </div>
            <div className="profile-create-layout">
            <div className="modal-body">
              {createErr && <div className="modal-err"><Icon name="alert" className="sm" />{createErr}</div>}
              {createItems.length > 0 ? <ProfileCreationReceipt items={createItems} busy={creating} /> : <fieldset className="profile-create-fields" disabled={creating}>
              <ProfileTemplateBar key={`templates:${managementScope}`} scope={managementScope} disabled={creating}
                settings={{ engine: form.engine, chromiumRuntime: form.engine === "chromium" ? appMode?.chromiumRuntime ?? (form.chromiumRuntime || "cloakbrowser") : undefined, group: form.group, platform: form.platform, screen: form.screen, platformOs: form.platformOs }}
                available={(settings) => (settings.engine !== "webkit" || !!appMode?.webkitAvailable) &&
                  (!appMode?.legacyRemote || settings.chromiumRuntime !== "aliasmode") &&
                  (!appMode?.chromiumRuntime || settings.engine !== "chromium" || settings.chromiumRuntime === appMode.chromiumRuntime) &&
                  (true)}
                onApply={(settings) => {
                  resetCreateProxyCheck(); setProxyPaste(""); setProxyPasteOk(null); setCreateErr(null);
                  setForm((current) => ({ ...BLANK_FORM, name: current.name, engine: settings.engine ?? "chromium", chromiumRuntime: settings.chromiumRuntime === "aliasmode" ? "aliasmode" : "", group: settings.group ?? "", platform: settings.platform ?? "", screen: settings.screen ?? "", platformOs: settings.platformOs ?? "" }));
                }} />
              <ProfileBatchOptions enabled={createBatch} count={createCount} pattern={createPattern} start={createStart} disabled={creating}
                onEnabled={setCreateBatch} onCount={setCreateCount} onPattern={setCreatePattern} onStart={setCreateStart} />
              {!createBatch && <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Name")}</span>
                  <input value={form.name} placeholder={t("auto if blank")} onChange={(e) => setF("name", e.target.value)} />
                </label>
                {(
                  <label className="fld no">
                    <span>{t("Custom NO.")}</span>
                    <input
                      value={form.customNo}
                      inputMode="numeric"
                      maxLength={MAX_CUSTOM_NO}
                      placeholder={t("auto")}
                      onChange={(e) => setF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                    />
                  </label>
                )}
              </div>}
              <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Folder")}</span>
                  <GroupPicker value={form.group} onChange={(v) => setF("group", v)} groups={editableGroups} allowCreate={true} />
                </label>
                <label className="fld grow">
                  <span>{t("Platform")}</span>
                  <PlatformPicker value={form.platform} onChange={(v) => setF("platform", v)} />
                </label>
              </div>
              <div className="browser-options" role="radiogroup" aria-label={t("Browser")}>
                {([
                  {
                    engine: "chromium", label: "Chrome",
                    path: "M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z",
                  },
                  {
                    engine: "firefox", label: "Firefox",
                    path: "M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z",
                  },
                  {
                    engine: "webkit", label: "WebKit",
                    path: "M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24zm0 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm5.8 4.2-3.6 8-8 3.6 3.6-8 8-3.6zm-6.4 4.3-2.2 4.3 4.3-2.2-2.1-2.1z",
                  },
                ] as const).filter(({ engine }) => engine !== "webkit" || appMode?.webkitAvailable).map(({ engine, label, path }) => {
                  // The help text names the engine that this computer and this form create.
                  const runtime = browserLabel(engine, appMode?.legacyRemote ? "" : appMode?.chromiumRuntime ?? form.chromiumRuntime);
                  return (
                  <div className="browser-option" key={engine}>
                    <label className="browser-card">
                      <input type="radio" name="browser-engine" value={engine} checked={form.engine === engine} onChange={() => { setF("engine", engine); if (engine === "webkit") setF("platformOs", ""); }} />
                      <svg className="browser-logo" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>
                      <span>{label}{engine === "webkit" && <small className="engine-experimental">{t("Experimental")}</small>}</span>
                    </label>
                    <button type="button" className="browser-info tip" data-tip={runtime} aria-label={`${label}: ${runtime}`}><Icon name="help" className="sm" /></button>
                  </div>
                  );
                })}
              </div>
              {form.engine === "webkit" && <p className="hint webkit-note">{t(WEBKIT_NOTE)}</p>}
              {form.engine === "chromium" && !appMode?.legacyRemote && !appMode?.chromiumRuntime && (
                <label className="fld">
                  <span>{t("Chrome version")}</span>
                  <Select value={form.chromiumRuntime} onChange={(e) => setF("chromiumRuntime", e.target.value as "" | "aliasmode")}>
                    {appMode?.defaultChromiumRuntime
                      ? <><option value="aliasmode">{t("Vela Chromium 155 (default)")}</option><option value="">{t("CloakBrowser 146")}</option></>
                      : <><option value="">{t("CloakBrowser 146 (default)")}</option><option value="aliasmode">{t("Vela Chromium 155")}</option></>}
                  </Select>
                  <small>{!form.chromiumRuntime
                    ? t(CLOAKBROWSER_NOTE)
                    : t("Downloads once (about 190 MB) on each computer that opens it.")}</small>
                </label>
              )}
              <details className="fingerprint-settings" open={createProxyOpen} onToggle={(event) => setCreateProxyOpen(event.currentTarget.open)}>
                <summary>
                  <span>{t("Proxy")}</span>
                  <span className="automatic-badge">{createHasProxy ? `${form.host}${form.port ? `:${form.port}` : ""}` : t("Optional")}</span>
                </summary>
                <div className="proxy-settings">
                  <div className="proxy-paste-row">
                    <label className="fld grow">
                      <span>{t("Paste proxy to autofill")} <span className="muted">{t("(select type first · host:port:username:password)")}</span></span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={proxyPaste}
                        placeholder={t("Paste here — credentials stay hidden")}
                        onChange={(e) => { setProxyPaste(e.target.value); setProxyPasteOk(null); }}
                        onPaste={(e) => {
                          const pasted = e.clipboardData.getData("text");
                          if (pasted) { e.preventDefault(); applyProxyPaste(pasted); }
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyProxyPaste(proxyPaste); } }}
                      />
                    </label>
                    <button type="button" className="btn accent" disabled={!proxyPaste.trim()} onClick={() => applyProxyPaste(proxyPaste)}>{t("Autofill")}</button>
                  </div>
                  {proxyPasteOk && <div className="proxy-paste-ok"><Icon name="check" className="sm" />{proxyPasteOk}</div>}
                  <div className="fld-row">
                    <label className="fld type">
                      <span>{t("Proxy type")}</span>
                      <Select value={form.proxyType} onChange={(e) => setF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="https">https</option>
                        <option value="socks5">socks5</option>
                      </Select>
                    </label>
                    <label className="fld grow">
                      <span>{t("Host")}</span>
                      <input value={form.host} placeholder={t("blank = no proxy")} onChange={(e) => setF("host", e.target.value)} />
                    </label>
                    <label className="fld port">
                      <span>{t("Port")}</span>
                      <input value={form.port} inputMode="numeric" placeholder="8080" onChange={(e) => setF("port", e.target.value)} />
                    </label>
                  </div>
                  <div className="fld-row">
                    <label className="fld grow"><span>{t("Proxy user")}</span><input value={form.user} onChange={(e) => setF("user", e.target.value)} /></label>
                    <label className="fld grow"><span>{t("Proxy pass")}</span><input type="password" value={form.pass} onChange={(e) => setF("pass", e.target.value)} /></label>
                  </div>
                  <div className="proxy-check-actions">
                    <button
                      type="button"
                      className="btn proxy-check-btn"
                      disabled={createProxyCheck.checking || !createHasProxy}
                      aria-busy={createProxyCheck.checking}
                      onClick={checkCreateProxy}
                    >
                      <Icon name="activity" className="sm" />
                      {createProxyCheck.checking ? t("Checking…") : t("Check proxy")}
                    </button>
                  </div>
                </div>
              </details>
              <ProxyCheckFeedback hasProxy={createHasProxy} state={createProxyCheck} />
              <FingerprintSettings engine={form.engine} chromiumRuntime={appMode?.legacyRemote ? "" : appMode?.chromiumRuntime ?? form.chromiumRuntime} screen={form.screen} onScreenChange={(value) => setF("screen", value)} platformOs={form.platformOs} onPlatformOsChange={(value) => setF("platformOs", value)} />
              </fieldset>}
            </div>
            <ProfileCreateSummary browser={browserLabel(form.engine, appMode?.chromiumRuntime ?? form.chromiumRuntime)} screen={form.screen} platformOs={form.platformOs} group={form.group} hasProxy={createHasProxy} count={createBatch ? Number(createCount) : 1} />
            </div>
            <div className="modal-foot">
              {creating ? <><span className="management-note" role="status">{createStopping ? t("Finishing the current request…") : t("Each profile is created separately.")}</span><button className="btn" disabled={createStopping} onClick={() => { createStopRequested.current = true; setCreateStopping(true); }}>{t("Stop after this profile")}</button></> : createItems.length > 0 ? <>
                <button className="btn ghost" onClick={closeCreate}>{t("Done")}</button>
                {!createItems.some((item) => item.state === "created" || item.state === "uncertain") && <button className="btn" onClick={() => { setCreateItems([]); setCreateErr(null); }}>{t("Edit settings")}</button>}
                {!createItems.some((item) => item.state === "uncertain") && <>
                  {createItems.some((item) => item.state === "failed") && <button className="btn" onClick={() => void submitCreate(true, true)}>{t("Retry failed")}</button>}
                  {createItems.some((item) => item.state === "queued") && <button className="btn primary" onClick={() => void submitCreate(true)}>{t("Continue remaining")}</button>}
                </>}
              </> : <><button className="btn ghost" onClick={closeCreate}>{t("Cancel")}</button><button className="btn primary" disabled={creating} onClick={() => void submitCreate()}>{createBatch ? t("Create {count} profiles", { count: Number(createCount) || 0 }) : t("Create profile")}</button></>}
            </div>
        </ProfileCreationDialog>
      )}

      {editId && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-profile-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head" id="edit-profile-title">
              <Icon name="edit" />{t("Edit profile")}<span className="mono muted">{editId}</span>
              <button type="button" className="modal-close" aria-label="Close" onClick={closeEdit}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {editErr && <div className="modal-err"><Icon name="alert" className="sm" />{editErr}</div>}
              {editLoading ? (
                <p className="hint" role="status">{t("Loading profile…")}</p>
              ) : (
                <>
                  {editForm.proxyError && <div className="modal-err"><Icon name="alert" className="sm" />Stored proxy quarantined: {editForm.proxyError}. Replace it below or clear the field.</div>}
                  {((editRunning)) && (
                    <p className="hint" role="status">
                      {t("This browser is open. Changes save now. Proxy and fingerprint changes apply at the next start.")}
                    </p>
                  )}
                  {editMobile && (
                    <div className="persona-warning">
                      <strong><Icon name="warning" className="sm" />{t("Imported mobile persona cannot open safely")}</strong>
                      <span>
                        Older Vela Browser opened it as a desktop browser anyway: Android became Windows; iPhone/iPad became macOS. That looked usable, but it was not coherent mobile emulation.
                      </span>
                      <span>
                        Convert it once to {editMobile.platform === "macos" ? "macOS" : "Windows"} desktop. Cookies, login/session, proxy, timezone, credentials and fingerprint seed stay intact
                        {editMobile.screenChanged ? `; the mobile-sized screen becomes ${editMobile.resolution}` : t("; the existing desktop-sized screen stays intact")}.
                      </span>
                      <button className="btn persona-convert" disabled={editSaving} onClick={convertEditedMobile}>
                        {editSaving ? t("Converting…") : `Convert to ${editMobile.platform === "macos" ? "macOS" : "Windows"} desktop`}
                      </button>
                    </div>
                  )}
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>{t("Name")}</span>
                      <input value={editForm.name ?? ""} onChange={(e) => setEF("name", e.target.value)} />
                    </label>
                    {(
                      <label className="fld no">
                        <span>{t("Custom NO.")}</span>
                        <input
                          value={editForm.customNo ?? ""}
                          inputMode="numeric"
                          maxLength={MAX_CUSTOM_NO}
                          placeholder={editSerial != null ? String(editSerial) : "auto"}
                          onChange={(e) => setEF("customNo", e.target.value.replace(/\D/g, "").slice(0, MAX_CUSTOM_NO))}
                        />
                        <small>{t("Digits only · blank uses the serial")}</small>
                      </label>
                    )}
                  </div>
                  <div className="fld-row">
                    <label className="fld grow">
                      <span>{t("Folder")}</span>
                      {canEditGroup(profiles.find((profile) => profile.id === editId)?.group ?? "")
                        ? <GroupPicker value={editForm.group ?? ""} onChange={(v) => setEF("group", v)} groups={editableGroups} allowCreate={true} />
                        : <input value={editForm.group ?? ""} readOnly />}
                    </label>
                    <label className="fld grow">
                      <span>{t("Platform")}</span>
                      <PlatformPicker value={editForm.platform ?? ""} onChange={(v) => setEF("platform", v)} />
                    </label>
                  </div>
                  <label className="fld">
                    <span>{t("Browser")}</span>
                    <input value={editEngine ? browserLabel(editEngine, editChromiumRuntime) : ""} readOnly className="ro" />
                    {editEngine && <small>{editEngine === "webkit" ? t(WEBKIT_NOTE) : editEngine === "firefox"
                      ? t("Native Firefox profile · no CDP, PDF, or Chrome extensions.")
                      : t("CDP, PDF, and Chrome extensions are available.")}</small>}
                    {editEngine === "chromium" && !editChromiumRuntime && <small>{t(CLOAKBROWSER_NOTE)}</small>}
                  </label>
                  <label className="fld">
                    <span>{t("Tags")} <span className="muted">{t("(comma-separated)")}</span></span>
                    <input value={editForm.tags ?? ""} placeholder="warmup, us, priority" onChange={(e) => setEF("tags", e.target.value)} />
                  </label>
                  {editForm.proxyType === "pool" ? <PoolNodeField nodeId={editForm.proxy ?? ""} onManual={() => { setEF("proxyType", "http"); setEF("proxy", ""); }} /> : <div className="fld-row">
                    <label className="fld type">
                      <span>{t("Proxy type")}</span>
                      <Select value={editForm.proxyType ?? "http"} onChange={(e) => setEF("proxyType", e.target.value)}>
                        <option value="http">http</option>
                        <option value="https">https</option>
                        <option value="socks5">socks5</option>
                      </Select>
                    </label>
                    <label className="fld grow">
                      <span>Proxy</span>
                      <input value={editForm.proxy ?? ""} placeholder="host:port:username:password" onChange={(e) => setEF("proxy", e.target.value)} />
                      <small>{t("Leave blank to launch on a direct connection.")}</small>
                    </label>
                  </div>}
                  <div className="proxy-check-actions">
                    {editForm.proxyType !== "pool" && <button
                      type="button"
                      className="btn proxy-check-btn"
                      disabled={editProxyCheck.checking || timezoneBusy || !editHasProxy}
                      aria-busy={editProxyCheck.checking}
                      onClick={checkEditedProxy}
                    >
                      <Icon name="activity" className="sm" />
                      {editProxyCheck.checking ? "Checking…" : t("Check proxy")}
                    </button>}
                    {editId && <PoolProxyPicker profileId={editId} running={!!profiles.find((p) => p.id === editId)?.running} onAssigned={() => {
                      // The server saved the pool proxy and its exit's timezone; show what it saved,
                      // and treat it as the form's starting point so a later save does not undo it.
                      const id = editId;
                      void fetchProfileEdit(id).then((p) => {
                        if (editFetchId.current !== id) return;
                        setEditForm((form) => ({ ...form, proxyType: p.proxyType || "http", proxy: p.proxy, proxyError: p.proxyError ?? "", timezone: p.timezone }));
                        setEditInitialProxy({ proxy: p.proxy, proxyType: p.proxyType || "http" });
                        setEditInitialFingerprint((initial) => ({ ...initial, timezone: p.timezone ?? "" }));
                      }).catch(() => {});
                      void load();
                    }} />}
                  </div>
                  <ProxyCheckFeedback hasProxy={editHasProxy} state={editProxyCheck} />
                  {!appMode?.legacyRemote && (
                    <>
                      <div className="proxy-check-actions">
                        <button
                          type="button"
                          className="btn proxy-check-btn"
                          disabled={timezoneBusy || editSaving || editProxyChanged || !!editForm.proxyError }
                          onClick={refreshEditedTimezone}
                        >
                          <Icon name="activity" className="sm" />
                          {timezoneBusy ? t("Looking up timezone and language…") : editHasProxy ? t("Set timezone and language from proxy") : t("Use current connection timezone and language")}
                        </button>
                      </div>
                      <p className="hint">{editProxyChanged
                        ? t("Save proxy changes before setting the timezone.")
                        : t("This action saves the timezone immediately. It applies the next time this profile opens.")}</p>
                    </>
                  )}
                  {editForm.locale && localeTimezoneMismatch(editForm.locale, editForm.timezone ?? "") && (
                    <p className="hint">{t("This language does not match the timezone's country. Use “Set timezone and language from proxy” to match them.")}</p>
                  )}
                  <div className="fld-row">
                    <CopyField label={t("Username")} value={editForm.username ?? ""} onChange={(value) => setEF("username", value)} />
                    <CopyField label={t("Password")} value={editForm.password ?? ""} onChange={(value) => setEF("password", value)} />
                  </div>
                  <div className="fld-row">
                    <CopyField label={t("Email")} value={editForm.email ?? ""} onChange={(value) => setEF("email", value)} />
                    <CopyField label={t("Email password")} value={editForm.emailPassword ?? ""} onChange={(value) => setEF("emailPassword", value)} />
                  </div>
                  <CopyField label={t("2FA secret")} value={editForm.twofa ?? ""} onChange={(value) => setEF("twofa", value)} />
                  {editTotp && (
                    <div className="authrow">
                      <span className="authlabel">{t("Authenticator")}</span>
                      <span className="authcode">{editTotp.code.slice(0, 3)} {editTotp.code.slice(3)}</span>
                      <span className="authsecs" title={t("seconds until it refreshes")}>{editTotp.secs}s</span>
                      <button className="btn xs" onClick={() => navigator.clipboard?.writeText(editTotp.code)}>
                        <Icon name="copy" className="sm" />Copy
                      </button>
                    </div>
                  )}
                  {editEngine && <FingerprintSettings
                    engine={editEngine} chromiumRuntime={editChromiumRuntime} screen={editForm.resolution ?? ""} onScreenChange={(value) => setEF("resolution", value)}
                    platformOs={editForm.platformOs ?? ""} onPlatformOsChange={editEngine === "chromium" ? (value) => setEF("platformOs", value) : undefined}
                    timezone={editForm.timezone ?? ""} onTimezoneChange={(value) => setEF("timezone", value)}
                    locale={editForm.locale ?? ""} onLocaleChange={(value) => setEF("locale", value)}
                    cores={editForm.cores ?? ""} onCoresChange={(value) => setEF("cores", value)}
                    seed={editForm.fingerprintSeed ?? ""} onSeedChange={(value) => setEF("fingerprintSeed", value)}
                    disabled={editSaving || timezoneBusy}
                    onUndo={() => setEditForm((form) => ({ ...form, ...editInitialFingerprint }))}
                    hardware={editHardware}
                  />}
                  {editEngine === "chromium" && editExtensionChoices.length > 0 && (
                    <div className="fld">
                      <span>{t("Extensions")}</span>
                      <div className="extassign">
                        {editExtensionChoices.map((x) => (
                          <label key={x.id} className="extchk">
                            <input type="checkbox" checked={editExts.includes(x.id)} onChange={() => toggleEditExt(x.id)} />
                            <span>{x.name}{x.missing && <span className="muted">{t(" · Not installed on this device")}</span>}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="formnote">
                    {t("Cookies and locked fingerprint values are preserved. Only editable fields change.")}
                    {editEngine === "chromium" && t(" Extensions load when the browser opens.")}
                  </p>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeEdit}>{t("Cancel")}</button>
              <button className="btn primary" disabled={editSaving || editLoading || timezoneBusy} onClick={saveEdit}>{editSaving ? t("Saving…") : t("Save changes")}</button>
            </div>
          </div>
        </div>
      )}

      {showBulk && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <Icon name="fileImport" />{t("Import profiles")}
              <button type="button" className="modal-close" aria-label={t("Close")} onClick={closeBulk}><Icon name="close" className="sm" /></button>
            </div>
            <div className="modal-body">
              {bulkErr && <div className="modal-err"><Icon name="alert" className="sm" />{bulkErr}</div>}
              <ol className="steps">
                <li>{t("Export profiles from your previous browser as TXT, CSV, JSON, or XLSX.")}</li>
                <li>{t("Add the files below and choose a destination group.")}</li>
                <li>{t("Click Import profiles. Only data included in the export can transfer.")}</li>
              </ol>
              <p className="hint">{t("Encrypted or proprietary profile archives cannot be imported. Use a readable export instead.")}</p>

              <div className="segmented" role="tablist" aria-label={t("Import source")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "file"}
                  className={bulkSource === "file" ? "active" : ""}
                  onClick={() => { setBulkSource("file"); setBulkText(""); }}
                >
                  <Icon name="fileImport" className="sm" />{t("From file")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={bulkSource === "paste"}
                  className={bulkSource === "paste" ? "active" : ""}
                  onClick={() => { setBulkSource("paste"); setBulkFiles([]); }}
                >
                  <Icon name="copy" className="sm" />{t("Paste text")}
                </button>
              </div>

              {bulkSource === "file" ? (
                <>
                  <div
                    className={`bulkdrop${bulkOver ? " over" : ""}`}
                    onClick={() => bulkFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); if (!bulkOver) setBulkOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setBulkOver(false); }}
                    onDrop={(e) => { e.preventDefault(); setBulkOver(false); if (e.dataTransfer.files?.length) setBulkFiles(Array.from(e.dataTransfer.files)); }}
                  >
                    <Icon name="fileImport" />
                    <b>{t("Drag &amp; drop files, or click to choose")}</b>
                    <div className="sub">{t("Readable TXT, CSV, JSON, or XLSX exports from AdsPower, GoLogin, Multilogin, Dolphin Anty, HideMyAcc, Incogniton, Donut, and similar browsers")}</div>
                  </div>
                  {bulkFiles.length > 0 && (
                    <div className="filelist">
                      {bulkFiles.map((file) => (
                        <span className="filechip" key={file.name}>
                          <Icon name="file" className="sm" />
                          <span className="fname">{file.name}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => setBulkFiles((files) => files.filter((candidate) => candidate !== file))}
                          ><Icon name="close" className="sm" /></button>
                        </span>
                      ))}
                      <button type="button" className="btn xs ghost" onClick={() => setBulkFiles([])}>{t("Clear all")}</button>
                    </div>
                  )}
                </>
              ) : (
                <label className="fld">
                  <span>{t("AdsPower TXT records")}</span>
                  <textarea
                    rows={9}
                    value={bulkText}
                    placeholder={"id=k1example01\ngroup=Warmup\nname=alice\n…"}
                    onChange={(event) => setBulkText(event.target.value)}
                  />
                  <small>{pastedRecordCount === null
                    ? t("Paste one or more key=value records, separated by a line of asterisks.")
                    : pastedRecordCount === 1
                      ? t("1 record detected — each one starts with its own id= line.")
                      : t("{count} records detected — each one starts with its own id= line.", { count: pastedRecordCount })}</small>
                </label>
              )}

              <input
                ref={bulkFileRef}
                type="file"
                multiple
                accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files) setBulkFiles(Array.from(e.target.files)); e.target.value = ""; }}
              />

              <div className="fld-row">
                <label className="fld grow">
                  <span>{t("Assign to group")}</span>
                  <GroupPicker value={bulkGroup} onChange={setBulkGroup} groups={existingGroups} allowCreate={true} />
                </label>
                <label className="fld grow">
                  <span>{t("Platform")}</span>
                  <Select value={bulkPlatform} onChange={(e) => setBulkPlatform(e.target.value)}>
                    {KNOWN_PLATFORMS.map((platform) => <option key={platform.value} value={platform.value}>{platform.value ? platform.label : t(platform.label)}</option>)}
                  </Select>
                </label>
              </div>
              <p className="formnote">
                {t("Anything chosen above overrides that field on every imported record, including provider exports that already carry a group.")}
              </p>
              <p className="formnote">
                {t("An Vela Browser export also carries")} <code>seed</code>{t("(seed)")}、<code>timezone</code>{t("(timezone)")}{t(" and ")}{" "}
                <code>platform_os</code>{t("(operating system)")}{t(", which recreate the exact browser fingerprint. Its")}{" "}
                <code>fp_*</code> {t("columns are a")} <b>{t("record")}</b>{" "}
                {t("of the fingerprint that was measured, not settings — they are checked after the browser opens, never applied to it.")}
              </p>
            </div>
            <div className="modal-foot">
              <button className="tlink" onClick={() => downloadText("vela-template.csv", CSV_TEMPLATE, "text/csv")}>
                <Icon name="export" className="sm" />{t("CSV template")}
              </button>
              <button className="tlink" onClick={() => downloadText("vela-example.txt", TXT_EXAMPLE, "text/plain")}>
                <Icon name="export" className="sm" />{t(".txt example")}
              </button>
              <span className="spacer" />
              <button className="btn ghost" onClick={closeBulk}>{t("Cancel")}</button>
              <button className="btn primary" disabled={bulkBusy || (!bulkFiles.length && !bulkText.trim()) || (false)} onClick={submitBulk}>
                <Icon name="fileImport" className="sm" />{bulkBusy ? t("Importing…") : t("Import profiles")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpdate && (
        /* Form dialog: a stray backdrop click must not discard typed input —
           close via Cancel, the X, or Escape (the backdrop has no onClick). */
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">{t("Update profiles from file")}<button type="button" className="modal-close" aria-label={t("Close")} onClick={() => setShowUpdate(false)}><Icon name="close" className="sm" /></button></div>
            <div className="modal-body">
              {updateErr && <div className="modal-err"><Icon name="alert" className="sm" />{updateErr}</div>}
              {updateResult && <div className="modal-ok"><Icon name="check" className="sm" />{updateResult}</div>}
              <ol className="steps">
                <li><b>{t("Export")}</b> {t("the profiles you want to change — that gives you a file with each profile's")} — that gives you a file with each profile's <code>id</code> {t("(how rows are matched).")}</li>
                <li><b>{t("Edit")}</b> {t("the columns you want (name, username, password, 2FA, proxy…). Keep the")} <code>id</code> {t("column; delete any column you don't want to touch.")}</li>
                {<li>{t("Add a")} <code>custom_no</code> {t("column to renumber profiles in bulk — that number shows in the roster and in the launched browser's window title.")}</li>}
                <li><b>{t("Re-upload")}</b> {t("the edited file below. IDs in the file determine which profiles change, not the current selection. Cookies &amp; fingerprints are preserved — editing a")} <code>cookie</code> or <code>ua</code> {t("column has no effect.")}</li>

              </ol>
              <div className="updexport">
                {selected.size > 0 ? (
                  <span>
                    {t("Export {count} selected:", { count: selected.size })}&nbsp;
                    <button className="tlink" onClick={() => exportSelected("csv")}><Icon name="export" className="sm" />{t("CSV")}</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("txt")}><Icon name="export" className="sm" />{t(".txt")}</button>
                    &nbsp;·&nbsp;
                    <button className="tlink" onClick={() => exportSelected("xlsx")}><Icon name="export" className="sm" />{t("Excel")}</button>
                  </span>
                ) : (
                  <span className="hint">{t("Tip: select profiles first, then export here to get an editable file.")}</span>
                )}
                <span className="grow" />
                <button className="tlink" onClick={() => downloadText("vela-update-template.csv", UPDATE_TEMPLATE_CSV, "text/csv")}><Icon name="export" className="sm" />{t("example sheet")}</button>
              </div>
              <div
                className={`bulkdrop${updateOver ? " over" : ""}`}
                onClick={() => updateFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!updateOver) setUpdateOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setUpdateOver(false); }}
                onDrop={(e) => { e.preventDefault(); setUpdateOver(false); if (e.dataTransfer.files?.[0]) setUpdateFile(e.dataTransfer.files[0]); }}
              >
                <Icon name="export" />
                <b>{t("Drag &amp; drop the edited file, or click to choose")}</b>
                <div className="sub">CSV, <code>.txt</code> or Excel <code>.xlsx</code> with an <code>id</code> column</div>
              </div>
              <input
                ref={updateFileRef}
                type="file"
                accept=".csv,.txt,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                onChange={(e) => { if (e.target.files?.[0]) setUpdateFile(e.target.files[0]); e.target.value = ""; }}
              />
              {updateFile && <div className="bulkfiles"><Icon name="file" className="sm" />{t("Selected:")} <b>{updateFile.name}</b></div>}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setShowUpdate(false)}>Close</button>
              <button className="btn primary" disabled={updateBusy || !updateFile} onClick={submitUpdate}>{updateBusy ? t("Updating…") : t("Update profiles")}</button>
            </div>
          </div>
        </div>
      )}
      <ScriptRunPanel
        open={scriptRunOpen}
        selectedProfiles={scriptRunProfiles}
        onClose={() => setScriptRunOpen(false)}
      />
    </div>
    </>
  );
}

const rootElement = document.getElementById("root")!;
// The desktop shell opens outside links itself, from its allowlist. Its shell plugin also listens on
// <body>: it cancels the click and asks for a command that Vela Browser does not grant, so the link does
// nothing. Stop the click here, so every outside link takes the allowlist path.
rootElement.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('a[target="_blank"]')) event.stopPropagation();
});
guardContextMenu();
const root = createRoot(rootElement);
root.render(
  <I18nProvider>
    {usesOwnTitleBar() && <TitleBar />}
    <App />
    <DialogHost />
    <Tooltips />
  </I18nProvider>
);

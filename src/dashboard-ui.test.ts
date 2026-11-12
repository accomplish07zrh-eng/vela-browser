import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localeTimezoneMismatch } from "./profile-locale.ts";
import { EMPTY_PROFILE_FILTERS, matchesProfileFilters } from "../web/profile-management.ts";

const app = readFileSync(join(import.meta.dir, "..", "web", "app.tsx"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(join(import.meta.dir, "..", "web", "styles.css"), "utf8").replaceAll("\r\n", "\n");
const shell = readFileSync(join(import.meta.dir, "..", "web", "shell.css"), "utf8").replaceAll("\r\n", "\n");
const logo = readFileSync(join(import.meta.dir, "..", "web", "alias-loop.svg"), "utf8").replaceAll("\r\n", "\n");
const notice = readFileSync(join(import.meta.dir, "..", "NOTICE"), "utf8");
const managementControls = readFileSync(join(import.meta.dir, "..", "web", "profile-management-controls.tsx"), "utf8");

test("dashboard renders the approved Alias Loop logo and it survives dark mode", () => {
  // The mark is inlined so the dark arm can ride currentColor: the packaged
  // SVG's #09090b stroke is invisible on a dark surface.
  expect(app).toContain("function AliasLoop(");
  expect(app).toContain('stroke="currentColor"');
  expect(app).toContain('<div className="brand"><AliasLoop /><span className="brandlabel">Vela Browser</span></div>');
  expect(app).toContain('<div className="onboarding-brand"><AliasLoop />Vela Browser');
  expect(styles).toContain(".alias-loop .loop-accent { stroke: var(--accent); }");
  expect(styles).not.toContain(".brand::before");
  // Both marks draw the same Vela Playfair Display Bold Italic glyph paths as the packaged asset.
  const paths = [
    'd="M76 156C76 102 110 68 164 68H348"',
    'd="M171.1 218.7Q177.5 209.1',
  ];
  for (const path of paths) {
    expect(app).toContain(path);
    expect(logo).toContain(path);
  }
});

test("dashboard offers HTTPS proxies in both profile forms", () => {
  expect(app.match(/<option value="https">https<\/option>/g)).toHaveLength(2);
});

test("dashboard shows curated desktop update notes and live progress", () => {
  expect(app).toContain('import { Channel } from "@tauri-apps/api/core"');
  expect(app).toContain('type DesktopUpdateStatus =');
  expect(app).toContain('invoke("check_for_updates")');
  expect(app).toContain('invoke("update_now", { onProgress })');
  expect(app).toContain('message.phase === "ready"');
  expect(app).toContain('{ ...status, version: message.version, highlights: message.highlights }');
  expect(app).not.toContain('invoke("check_for_updates",');
  expect(app).toContain("desktopUpdateCheckStarted.current = true");
  expect(app).toContain("Vela Browser checks for updates when it starts.");
  expect(app).toContain('className="update-highlights"');
  expect(app).toContain('<summary>What’s new in {version}</summary>');
  expect(app).toContain('<progress max={100} value={percent ?? undefined}');
  expect(app).toContain("Preparing update…");
  expect(app).toContain("Downloading update…");
  expect(app).toContain("Verifying update…");
  expect(app).toContain("Saving and closing browsers…");
  expect(app).toContain("Installing and restarting…");
  expect(app).toContain('{desktopUpdateErr && <span className="modal-err" role="alert">{t(desktopUpdateErr)}</span>}');
  expect(app).toContain('progress.phase === "reconnecting"');
  expect(app).toContain("Connection lost. Reconnecting…");
  expect(app).toContain('t("{downloaded} of {total} MB"');
  expect(app).toContain('disabled={desktopUpdateChecking || desktopUpdateInstalling}');
  expect(app).toContain('className="update-banner"');
  expect(styles).toContain(".update-banner");
  expect(styles).toContain(".update-highlights");
  expect(styles).toContain(".update-progress progress");
  expect(styles).toContain("accent-color: var(--accent)");
});

test("dashboard shows the durable result in its banner and Updates panel", () => {
  expect(app).toContain('parseDesktopUpdateResult');
  expect(app).toContain('invoke("last_update_result")');
  expect(app).toContain('setDesktopUpdateResult(parseDesktopUpdateResult(value))');
  expect(app).toContain('className={`update-banner update-result ${desktopUpdateResultSummary.tone}`}');
  expect(app).toContain('aria-label={t("Dismiss last update result")}');
  expect(app).toContain('className={`update-last-result ${desktopUpdateResultSummary.tone}`}');
  expect(app).toContain('{desktopUpdateResultSummary.title}');
  expect(app).toContain('{desktopUpdateResultSummary.detail}');
  expect(styles).toContain('.update-banner.update-result.success');
  expect(styles).toContain('.update-last-result.warning');
  expect(styles).toContain('.update-last-result.error');
});

test("dashboard warns about low disk space without blocking anything", () => {
  expect(app).toContain("const timer = setInterval(check, 60_000);");
  expect(app).toContain("{diskSpace?.low && diskSpace.freeBytes !== null && !diskWarningDismissed && (");
  expect(app).toContain('<div className="update-banner update-result warning" role="alert">');
  expect(app).toContain('aria-label={t("Dismiss disk space warning")}');
  // The warning never disables an action.
  expect(app).not.toMatch(/disabled=\{[^}]*diskSpace/);
});

test("dashboard contains long roster labels inside the window", () => {
  expect(app).toContain('className="profile-table"');
  // The name sits in its own truncatable span; the fingerprint badge rides
  // alongside it inside that span, so match the wrapper rather than the whole
  // element (which changes whenever anything is added next to the name).
  expect(app).toContain('<span className="n">{p.name}');
  expect(app).toContain('<td className="col-group" title={p.group}>');
  expect(app).toContain('className="select move-group"');
  // Every truncatable cell carries its full value as a title, so hovering shows
  // what the ellipsis hid.
  expect(app).toContain('title={`${p.name}\\n${p.id}`}');
  expect(app).toContain('title={p.tags?.length ? p.tags.join(", ") : "No tags"}');
  expect(app).toContain('title={p.proxyError || p.proxy || "no proxy"}');
  // Fixed layout plus per-column clipping keeps a long value inside its cell.
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain("td.col-no, td.col-name, td.col-group, td.col-tags, td.col-proxy { overflow: hidden; text-overflow: ellipsis; }");
});

test("dashboard shows close warnings without an open-only prefix", () => {
  expect(app).toContain("else if (r && r.warning) setActionErr(actionWarning(r));");
  expect(app).toContain("const actionWarning = (r: any): string => r.warning");
  expect(app).not.toContain("Opened — ${r.warning}");
  expect(app).toContain("if (r?.ok === false) issues.push");
  expect(app).toContain("else if (r?.warning) issues.push");
});

test("dashboard lists the supported profile platforms", () => {
  for (const platform of [
    "x.com",
    "instagram.com",
    "facebook.com",
    "tiktok.com",
    "linkedin.com",
    "reddit.com",
    "telegram.org",
  ]) {
    expect(app).toContain(`value: "${platform}"`);
  }
});

test("New and Edit profile dialogs check proxies and suppress provider offers", () => {
  const createModal = app.slice(app.indexOf("{showCreate && ("), app.indexOf("{editId && ("));
  const editModal = app.slice(app.indexOf("{editId && ("), app.indexOf("{showBulk && ("));

  expect(app).not.toContain("<ProxyProviderOffer");
  expect(app).not.toContain("outreachproxy.com");
  expect(app).not.toContain("OutreachProxy");
  for (const modal of [createModal, editModal]) {
    expect(modal).toContain("Check proxy");
    expect(modal).toContain("<ProxyCheckFeedback");
  }
  expect(app).toContain("if (!result) return null;");
  expect(app).toContain(`if (event.target instanceof Element && event.target.closest('a[target="_blank"]')) event.stopPropagation();`);
  expect(app).toContain('if (k === "proxyType" || k === "host" || k === "port" || k === "user" || k === "pass")');
  expect(app).toContain('if (k === "proxy" || k === "proxyType") {\n      resetEditProxyCheck();');
  expect(app).toContain("generation === createProxyCheckGeneration.current");
  expect(app).toContain("generation === editProxyCheckGeneration.current");
  expect(app).toContain("createProxyCheckGeneration.current++");
  expect(app).toContain("editProxyCheckGeneration.current++");
  expect(createModal).toContain('className="btn primary" disabled={creating}');
  expect(editModal).toContain('className="btn primary" disabled={editSaving || editLoading || timezoneBusy}');
  for (const tone of ["working", "unstable", "failed", "unavailable"]) {
    expect(styles).toContain(`.proxy-check-result.${tone}`);
  }
  const proxiesPage = readFileSync(join(import.meta.dir, "..", "web", "proxies.tsx"), "utf8");
  expect(proxiesPage).not.toContain("<ProxyProviderOffer");
  expect(app).not.toContain("import-no-proxy");
});

test("dashboard selects browser for new profiles", () => {
  const createModal = app.slice(app.indexOf("{showCreate && ("), app.indexOf("{editId && ("));
  const editModal = app.slice(app.indexOf("{editId && ("), app.indexOf("{showBulk && ("));
  expect(createModal).toContain('className="browser-options"');
  expect(createModal).toContain('engine: "chromium", label: "Chrome"');
  expect(createModal).toContain('engine: "firefox", label: "Firefox"');
  expect(createModal).toContain('engine: "webkit", label: "WebKit"');
  expect(createModal).toContain('appMode?.webkitAvailable');
  // The help text follows the engine that this computer creates, such as Chromium 155 on a Mac.
  expect(createModal).toContain('const runtime = browserLabel(engine, appMode?.legacyRemote ? "" : appMode?.chromiumRuntime ?? form.chromiumRuntime);');
  expect(createModal).toContain('type="radio" name="browser-engine"');
  expect(createModal).toContain('checked={form.engine === engine}');
  expect(createModal).toContain('setF("engine", engine)');
  expect(createModal).toContain('aria-label={`${label}: ${runtime}`}');
  expect(createModal).toContain('data-tip={runtime}');
  expect(createModal).not.toContain('<select value={form.engine}');
  // The browser choice comes before the optional Proxy and Fingerprint sections.
  expect(createModal.indexOf('className="browser-options"')).toBeLessThan(createModal.indexOf('open={createProxyOpen}'));
  expect(createModal.indexOf('open={createProxyOpen}')).toBeLessThan(createModal.indexOf('<FingerprintSettings'));
  expect(createModal.indexOf('className="browser-options"')).toBeLessThan(createModal.indexOf('className="modal-foot"'));
  expect(styles).toContain('.browser-info:focus-visible::after');
  expect(styles).toContain('.browser-card:has(input:focus-visible)');
  expect(styles).toContain('.browser-card:has(input:checked) { background: var(--browser-selected);');
  expect(styles).not.toContain('.browser-option:has(input:checked) { color: var(--browser-surface); }');
  expect(app).toContain("engine: form.engine,");
  expect(editModal).toContain('value={editEngine ? browserLabel(editEngine, editChromiumRuntime) : ""} readOnly');
  expect(editModal).not.toContain('setEF("engine"');
  expect(editModal).not.toContain('setEF("chromiumRuntime"');
  // New profiles start on this computer's default engine: Vela Chromium on Windows, Vela Browser
  // Firefox on macOS and Linux. Chromium 155 is Vela Chromium on every computer.
  expect(app).toContain('return chromiumRuntime ? "Vela Chromium" : "CloakBrowser";');
  expect(app).not.toContain("155 beta");
  expect(app).toContain('setForm({ ...BLANK_FORM, engine: appMode?.defaultEngine ?? "chromium", chromiumRuntime: appMode?.defaultChromiumRuntime ?? "", group:');
  // Chrome version: 155 is the default where this computer can run it, and 146 stays the default
  // elsewhere. 155 works in Local and Cloud, not legacy Remote. Choosing 146 asks for CloakBrowser.
  expect(createModal).toContain('{form.engine === "chromium" && !appMode?.legacyRemote && !appMode?.chromiumRuntime && (');
  expect(createModal).toContain('? <><option value="aliasmode">{t("Vela Chromium 155 (default)")}</option><option value="">{t("CloakBrowser 146")}</option></>');
  expect(createModal).toContain(': <><option value="">{t("CloakBrowser 146 (default)")}</option><option value="aliasmode">{t("Vela Chromium 155")}</option></>}');
  expect(app).toContain('chromiumRuntime: "" as "" | "aliasmode"');
  expect(app).toContain('...(form.engine === "chromium" && !appMode?.legacyRemote ? { chromiumRuntime: appMode?.chromiumRuntime ?? (form.chromiumRuntime || "cloakbrowser") } : {}),');
  // A CloakBrowser choice or profile shows the linkability note, in every bundled language.
  const note = "CloakBrowser profiles on one computer can be linked to each other. Use Vela Chromium or Vela Firefox for separate identities.";
  expect(app).toContain(`const CLOAKBROWSER_NOTE = "${note}";`);
  expect(createModal).toMatch(/<small>\{!form\.chromiumRuntime\s+\? t\(CLOAKBROWSER_NOTE\)/);
  expect(editModal).toContain('{editEngine === "chromium" && !editChromiumRuntime && <small>{t(CLOAKBROWSER_NOTE)}</small>}');
  // The browser stays unknown until the profile loads, so a failed load never claims CloakBrowser.
  expect(app).toContain('useState<"chromium" | "firefox" | "webkit" | null>(null)');
  expect(app).not.toContain('setEditEngine("chromium")');
  expect(editModal).toContain("{editEngine && <FingerprintSettings");
  // The fingerprint hints hold for every engine, so they name none.
  const hints = [
    "The browser keeps the locked values coordinated. Screen and operating system are the only fingerprint settings you can override.",
    "Leave a field blank to keep it automatic. A timezone you type stays when the proxy changes.",
    "We recommend keeping every setting automatic. Custom values can make the browser look inconsistent, easier to detect, and can trigger account checks.",
  ];
  for (const hint of hints) expect(app).toContain(`t("${hint}")`);
  expect(app).not.toContain("CloakBrowser keeps the locked values");
  expect(app).not.toContain("CloakBrowser controls the other values");
  for (const locale of ["ru-RU", "zh-CN"]) {
    const catalog = JSON.parse(readFileSync(join(import.meta.dir, "..", "web", "locales", `${locale}.json`), "utf8"));
    expect(catalog[note]).toContain("Vela Chromium");
    for (const hint of hints) expect(catalog[hint]).toBeTruthy();
  }
  expect(app).toContain('Native Firefox profile · no CDP, PDF, or Chrome extensions');
  expect(app).toContain('{p.engine === "chromium" && <>');
  expect(app).toContain('selectedProfilesSupportChromeExtensions');
});

test("Chromium and Firefox offer OS choices; WebKit preserves native OS and only Chromium allows later OS edits", () => {
  const settings = app.slice(app.indexOf("function FingerprintSettings("), app.indexOf("function FingerprintSettings(") + 3300);
  expect(settings).not.toMatch(/\{engine === "chromium" && \(\s*<label className="fld">\s*<span>Operating system/);
  for (const os of ["windows", "macos", "linux"]) expect(settings).toContain(`<option value="${os}">`);
  expect(settings).toContain('{onPlatformOsChange && engine !== "webkit" ? (');
  expect(settings).toContain("onPlatformOsChange(event.target.value)");
  expect(settings).toContain('readOnly tabIndex={-1} className="ro"');
  expect(app).toContain('platformOs={form.platformOs} onPlatformOsChange={(value) => setF("platformOs", value)}');
  expect(app).toContain('platformOs={editForm.platformOs ?? ""} onPlatformOsChange={editEngine === "chromium" ? (value) => setEF("platformOs", value) : undefined}');
});

test("Local timezone follows the proxy and can be refreshed on request", () => {
  expect(app).toContain("Stored · set from the proxy automatically");
  expect(app).toContain("refreshProfileTimezone(id)");
  expect(app).toContain("Set timezone and language from proxy");
});

test("Edit shows the profile language and flags one that does not match the timezone", () => {
  expect(app).toContain("localeTimezoneMismatch(editForm.locale, editForm.timezone ?? \"\")");
  expect(localeTimezoneMismatch("en-GB", "America/New_York")).toBe(true);
  expect(localeTimezoneMismatch("en-US", "America/New_York")).toBe(false);
  expect(localeTimezoneMismatch("en", "America/New_York")).toBe(false);
  expect(localeTimezoneMismatch("en-GB", "Not/AZone")).toBe(false);
});

test("every editable row and the selection bar can add cookies; closed profiles get them at next start", () => {
  expect(app).toContain('data-tip={t("Add cookies")}');
  expect(app).toContain('aria-label={t("Add cookies to {profile}", { profile: p.name })}');
  expect(app).toContain("onClick={() => openCookie([p])}");
  expect(app).toContain("onClick={() => openCookie(profiles.filter((profile) => selected.has(profile.id)))}");
  // The row button is not limited to running browsers.
  const runningBranch = app.slice(app.indexOf("{p.running ? ("), app.indexOf(") : p.mobilePersona ? ("));
  expect(runningBranch).not.toContain("openCookie");
  expect(app.indexOf("onClick={() => openCookie([p])}")).toBeLessThan(app.indexOf("{p.running ? ("));

  expect(app).toContain('aria-labelledby="add-cookie-title"');
  expect(app).toContain('<span>{t("Paste cookies (JSON export or cookies.txt)")}</span>');
  expect(app).toContain('<span>{t("Name")}</span>');
  expect(app).toContain('<span>{t("Value")}</span>');
  expect(app).toContain('<span>{t("Domain")}</span>');
  expect(app).toContain('<span>{t("Path")}</span>');
  expect(app).toContain('type="password" autoComplete="off"');
  expect(app).toContain("await addProfileCookies(cookieTargets.map((profile) => profile.id), cookieText.trim() ? { text: cookieText } : cookieForm);");
  expect(app).toContain('t("The browser sets these cookies the next time it starts, before the first page opens.")');
  expect(app).toContain('{t("{count} cookie(s) at next start", { count: String(p.pendingCookieCount) })}');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeCookie}');
});

test("bulk import uploads provider files unchanged", () => {
  expect(app).toContain('const list = Array.from(files);');
  expect(app).toContain('const uploads = [...bulkFiles];');
  expect(app).not.toContain("prepUploads");
  expect(app).not.toContain("csvToBlocks");
  expect(app).toContain('accept=".csv,.txt,.json,.xlsx,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"');
  for (const provider of ["AdsPower", "GoLogin", "Multilogin", "Dolphin Anty", "HideMyAcc", "Incogniton", "Donut"]) {
    expect(app).toContain(provider);
  }
});

test("the complete dashboard has no product account or mode-switching interface", () => {
  expect(app).toContain('{ key: "general", label: "General" }');
  expect(app).toContain('{ key: "advanced", label: "Advanced" }');
  for (const retired of ['className="account-button"', 'key: "account"', 'key: "team"', 'signInCloud', 'restoreCloudSession', 'selectAppMode', 'cloudAuth', 'restart_after_mode_change', 'credential_get']) {
    expect(app.includes(retired)).toBe(false);
  }
  expect(app).toContain('t("Appearance")');
  expect(app).toContain('t("Updates")');
  expect(app).toContain('fetchAppMode()');
});

test("the roster numbers every profile and prefers a custom NO. over the serial", () => {
  // Mirrors profileDisplayNo in launcher.ts so the row, the browser window title
  // and the identity bookmark all show the same number.
  expect(app).toContain("function displayNo(profile: UiProfile, fallbackIndex: number)");
  expect(app).toContain('const custom = (profile.customNo ?? "").trim();');
  expect(app).toContain("if (custom) return { value: custom, custom: true };");
  expect(app).toContain("if (profile.serial != null) return { value: String(profile.serial), custom: false };");
  // Numbering is resolved against the unsorted roster, so sorting cannot renumber rows.
  expect(app).toContain("profiles.forEach((profile, index) => map.set(profile.id, displayNo(profile, index)));");
  expect(app).toContain('className={`no-text${no.custom ? " custom" : ""}`}');
  // The number stands alone — the colored identity disc was removed on request.
  expect(app).not.toContain("ProfileAvatar");
  expect(styles).not.toContain(".no-avatar");
});

test("the custom NO. editor preserves digits-only environment numbering", () => {
  expect(app).toContain("const MAX_CUSTOM_NO = 12;"); // matches MAX_CUSTOM_NO_LENGTH in parse.ts
  expect(app).toContain("<span>{t(\"Custom NO.\")}</span>");
  expect(app).toContain("<small>{t(\"Digits only · blank uses the serial\")}</small>");
  // The placeholder shows the serial that would be used instead, so an empty
  // field is never ambiguous about what the browser window will display.
  expect(app).toContain('placeholder={editSerial != null ? String(editSerial) : "auto"}');
  expect(app).toContain('setEF("customNo", e.target.value.replace(/\\D/g, "").slice(0, MAX_CUSTOM_NO))');
  // Cloud profiles round-trip through the portable-profile contract, which has
  // no custom NO. field — so it is never offered or sent in Cloud mode.
  expect(app).toContain('customNo: editForm.customNo ?? "",');
  expect(app).toContain('customNo: form.customNo,');
});

test("the roster is sortable, pageable and its columns are selectable", () => {
  expect(app).toContain("const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: \"no\", dir: 1 });");
  expect(app).toContain("current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }");
  // A running browser is the row an operator acts on next, so it outranks the sort column.
  expect(app).toContain("if (a.running !== b.running) return a.running ? -1 : 1;");
  expect(app).toContain('aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}');
  expect(app).toContain('aria-label={t("Choose visible columns")}');
  expect(app).toContain('aria-label={t("Rows per page")}');
  expect(app).toContain("const PAGE_SIZES = [25, 50, 100, 200];");
  expect(app).toContain('const DEFAULT_HIDDEN_COLUMNS: ColumnKey[] = ["tags"];');
  // Layout preferences are a convenience; disabled storage must not break the roster.
  expect(app).toContain("catch { return new Set(DEFAULT_HIDDEN_COLUMNS); }");
  expect(app).toContain("catch { /* private mode / disabled storage */ }");
});

test("tag search shares the existing folder, number, name, and ID filter", () => {
  const source = app.slice(app.indexOf("    const matched = profiles.filter"), app.indexOf("    // Running profiles stay on top"));
  const evaluate = new Function("profiles", "group", "numbering", "sharedOnly", "sharedProfiles", "selectedScope", "matchesProfileFilters", "profileFilters", `${source}\nreturn matched;`);
  const filter = (profiles: any[], group: string, q: string, numbering: Map<string, { value: string }>, sharedOnly = false, sharedProfiles: any[] = [], selectedScope = new Set([group])) =>
    evaluate(profiles, group, numbering, sharedOnly, sharedProfiles, selectedScope, matchesProfileFilters, { ...EMPTY_PROFILE_FILTERS, query: q, group, sharedOnly });
  const profiles = [
    { id: "alpha", name: "First", group: "A", tags: ["Warm", "Priority"] },
    { id: "beta", name: "Second", group: "B", tags: ["warm"] },
    { id: "gamma", name: "Third", group: "A", tags: [] },
    { id: "delta", name: "Fourth", group: "A" },
  ];
  const numbering = new Map(profiles.map((p, i) => [p.id, { value: String(i + 101) }]));
  const ids = (q: string, group = "all") => filter(profiles, group, q, numbering).map((p: { id: string }) => p.id);
  expect(ids("WARM")).toEqual(["alpha", "beta"]);
  expect(ids("warm", "A")).toEqual(["alpha"]);
  expect(ids("rior")).toEqual(["alpha"]);
  expect(ids("GAMMA")).toEqual(["gamma"]);
  expect(ids("FOURTH")).toEqual(["delta"]);
  expect(ids("103")).toEqual(["gamma"]);
  expect(ids("missing")).toEqual([]);
  expect(ids("", "A")).toEqual(["alpha", "gamma", "delta"]);
  expect(filter(profiles, "Parent", "warm", numbering, false, [], new Set(["Parent", "A"])).map((p: { id: string }) => p.id)).toEqual(["alpha"]);
  expect(filter(profiles, "all", "warm", numbering, true, [profiles[1]]).map((p: { id: string }) => p.id)).toEqual(["beta"]);

  const tagged = Array.from({ length: 60 }, (_, i) => ({ id: `p-${i}`, name: "Profile", group: "A", tags: ["Warm"] }));
  const matched = filter(tagged, "A", "warm", new Map());
  const selection = rosterSelection(matched, new Set(["other-folder"]), "A", "warm");
  selection.selectAllFiltered();
  expect(selection.selected().size).toBe(60);
  expect(selection.selected().has("other-folder")).toBe(false);
  const page = rosterSelection(matched, new Set(), "A", "warm", 1);
  page.toggleAll();
  expect(page.selected().size).toBe(10);
});

test("local import entry points remain available with collapsed labels", () => {
  const sidebar = app.slice(app.indexOf('className="newrow"'), app.indexOf('className="sidenav"'));
  const empty = app.slice(app.indexOf('className="empty-actions"'), app.indexOf('className="empty-actions"') + 450);
  for (const entry of [sidebar, empty]) {
    expect(entry).toContain("onClick={openBulk}");
    expect(entry.includes("canEditCloud")).toBe(false);
  }
  expect(sidebar).toContain('aria-label={t("Import profiles")}');
  expect(sidebar).toContain('<span className="navlabel">{t("Import profiles")}</span>');
});

function rosterSelection(filtered: { id: string }[], selected = new Set<string>(), group = "all", q = "", page = 0) {
  const source = app.slice(app.indexOf("  const allVisibleSelected ="), app.indexOf("  const moveSelected ="));
  const controls = new Function("visibleProfiles", "filtered", "selected", "group", "q", "setSelected", "t", `${source}
    return { toggleAll, selectAllFiltered, allFilteredSelected, selectedOutsideFilter, selectionScope };`)(
    filtered.slice(page * 50, (page + 1) * 50), filtered, selected, group, q,
    (next: Set<string> | ((current: Set<string>) => Set<string>)) => {
      selected = typeof next === "function" ? next(selected) : next;
    },
    (s: string, values?: Record<string, string>) => values ? s.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match) : s,
  );
  return { ...controls, selected: () => selected };
}

test("page selection stays page-only and scope selection reaches all 1600 profiles", () => {
  const profiles = Array.from({ length: 1600 }, (_, i) => ({ id: `profile-${i}` }));
  const page = rosterSelection(profiles);
  page.toggleAll();
  expect([...page.selected()]).toEqual(profiles.slice(0, 50).map((p) => p.id));
  const scope = rosterSelection(profiles, page.selected());
  expect(scope.allFilteredSelected).toBe(false);
  scope.selectAllFiltered();
  expect([...scope.selected()]).toEqual(profiles.map((p) => p.id));
  expect(rosterSelection(profiles, scope.selected(), "all", "", 12).allFilteredSelected).toBe(true);
});

test("folder and search scope selection replaces unrelated hidden selections", () => {
  const profiles = Array.from({ length: 1600 }, (_, i) => ({ id: `folder-${i}` }));
  const scope = rosterSelection(profiles, new Set(["other-folder"]), "Imported");
  expect(scope.selectedOutsideFilter).toBe(1);
  expect(scope.selectionScope).toContain("Imported");
  scope.selectAllFiltered();
  expect([...scope.selected()]).toEqual(profiles.map((p) => p.id));
  expect(scope.selected().has("other-folder")).toBe(false);

  const matches = profiles.filter((_, i) => i % 2 === 0);
  const search = rosterSelection(matches, scope.selected(), "Imported", "search");
  expect(search.selectedOutsideFilter).toBe(800);
  expect(search.allFilteredSelected).toBe(false);
  search.selectAllFiltered();
  expect([...search.selected()]).toEqual(matches.map((p) => p.id));
  expect(rosterSelection([], new Set()).allFilteredSelected).toBe(false);
});

test("selection controls expose scope selection and clearing without changing export permissions", () => {
  expect(app).not.toContain("allVisibleSelected && !allFilteredSelected");
  expect(app).toContain("disabled={deleting || allFilteredSelected}");
  expect(app).toContain("onClick={selectAllFiltered}");
  expect(app).toContain('aria-label={t("Clear selection")} onClick={() => setSelected(new Set())}');
  expect(app).toContain('q ? t("{count} matching profiles"');
  expect(app).toContain('group === "all" ? scopeCount : t("{scope} in “{group}”"');
  expect(app).toContain("const ids = [...selected];");
  expect(app).toContain("await exportProfiles(ids, format, (progress) => setExportProgress(progress));");
});

test("export shows live progress, blocks duplicate exports, and always clears busy state", async () => {
  const source = app
    .slice(app.indexOf("const exportSelected = async"), app.indexOf("// ---- Transient success banner"))
    .replace("(format: ExportFormat)", "(format)"); // strip the one TS annotation for plain-JS evaluation
  expect(source).toContain("exportProfiles(ids, format, (progress) => setExportProgress(progress))");
  const makeExportSelected = new Function(
    "selected", "exportProgress", "exportProfiles", "setExportOpen", "setActionErr", "setExportProgress", "flash",
    `${source}\nreturn (format) => exportSelected(format);`,
  );
  const ids = new Set(["a", "b", "c"]);
  const progress: unknown[] = [];
  let opened = false;
  let err: string | null = "stale";
  const flashes: string[] = [];
  type ExportFn = (ids: string[], format: string, onProgress?: (p: { completed: number; total: number }) => void) => Promise<void>;
  const run = (busy: unknown, impl: ExportFn): ((format: string) => Promise<void>) =>
    makeExportSelected(ids, busy, impl, () => { opened = false; }, (e: string | null) => { err = e; }, (p: unknown) => { progress.push(p); }, (m: string) => { flashes.push(m); }) as (format: string) => Promise<void>;

  await run(null, async (_ids, _format, onProgress) => {
    onProgress?.({ completed: 3, total: 3 });
    await new Promise((resolve) => setTimeout(resolve, 1));
  })("txt");
  expect(progress).toEqual([{ completed: 0, total: 3 }, { completed: 3, total: 3 }, null]); // seeded → live → cleared
  expect(opened).toBe(false); // the format menu closes before the request starts
  expect(err).toBeNull(); // a stale action error is cleared, not left visible
  expect(flashes).toEqual(["Exported 3 profiles as TXT"]);

  progress.length = 0;
  let called = 0;
  await run({ completed: 0, total: 3 }, async () => { called++; })("txt"); // already exporting
  expect(called).toBe(0); // a second export never starts while one is in flight

  await run(null, async () => { throw new Error("Export interrupted"); })("txt");
  expect(progress.at(-1)).toBeNull(); // busy state clears on failure too
  expect(err).toBe("Error: Export interrupted");
  expect(flashes).toEqual(["Exported 3 profiles as TXT"]); // no success banner for the failure
});

test("export progress banner renders counts, the build phase, and disables competing actions", () => {
  expect(app).toContain('const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);');
  expect(app).toContain('exportProgress.completed >= exportProgress.total');
  expect(app).toContain('"Building export file…"');
  expect(app).toContain("`Preparing export: ${exportProgress.completed.toLocaleString()} / ${exportProgress.total.toLocaleString()} profiles`");
  expect(app).toContain('disabled={!selected.size || !!exportProgress}'); // export menu + file-update dialog
  expect(app).toContain("{exportOpen && selected.size > 0 && !exportProgress && (");
});

test("header controls stay reachable and dismissable", () => {
  expect(app).toContain("function useDismiss<T extends HTMLElement>(open: boolean, close: () => void)");
  expect(app).toContain('document.addEventListener("mousedown", onDown);');
  expect(app).toContain('if (event.key === "Escape") onClose.current();');
  expect(app).toContain('aria-label={t("Refresh profiles")}');
  expect(app).toContain('aria-label="Automation node freshness"');
  expect(app).not.toContain('className="account-button"');
});

test("the dashboard typeface is bundled, never fetched at runtime", () => {
  // Vela Browser is local-first and must render correctly with no network, so the
  // face ships with the app. A CDN @import or an https font URL is a regression.
  const typography = styles + readFileSync(join(import.meta.dir, "..", "web", "design-tokens.css"), "utf8");
  expect(typography).not.toContain("fonts.googleapis.com");
  expect(typography).not.toContain("fonts.gstatic.com");
  expect(typography).not.toMatch(/@import\s+url\(/);

  for (const file of ["manrope-variable.woff2", "noto-sans-sc-variable.woff2", "noto-serif-sc-variable.woff2"]) {
    expect(typography).toContain(`src: url("./fonts/${file}") format("woff2")`);
    const bytes = readFileSync(join(import.meta.dir, "..", "web", "fonts", file));
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2"); // real woff2, not an error page
  }

  // Real variable weights cover Chinese and Latin without synthetic bold.
  expect(typography).toContain("font-weight: 100 900;");
  expect(typography).toContain("font-display: swap;");
  expect(typography).toContain('--font: "Manrope", "Noto Sans SC"');

  // SIL OFL requires the license to travel with the font.
  for (const family of ["Manrope", "NotoSansSC", "NotoSerifSC"]) {
    expect(readFileSync(join(import.meta.dir, "..", "web", "fonts", `${family}-LICENSE.txt`), "utf8")).toContain("SIL OPEN FONT LICENSE");
  }
  expect(notice).toContain("Manrope");
  expect(notice).toContain("Noto Sans SC");
  expect(notice).toContain("Noto Serif SC");
});

test("New profile and Edit are instant dialogs; Scripts, Settings and Extensions are pages", () => {
  // The wall is the home screen; the other sections open over it as sheets.
  expect(app).toContain('useState<"profiles" | "workbench" | "scripts" | "settings" | "extensions" | "proxies" | "trash">("workbench")');
  expect(app).toContain("const [showCreate, setShowCreate] = useState(false);");
  expect(app).toContain('<ProfileCreationDialog onCancel={closeCreate}>');
  expect(managementControls).toContain('aria-labelledby="create-profile-title"');
  expect(managementControls).toContain('dialog.current?.showModal()');
  expect(app).toContain('aria-labelledby="edit-profile-title"');
  expect(app).toContain('const closeCreate = () => {\n    if (createInFlight.current) return;\n    resetCreateProxyCheck();\n    setShowCreate(false);');
  expect(app).toContain("PAGE_TITLES[view]");
  // Edit opens on the click — the detail fetch fills the dialog in when it
  // lands, and a stale response for an abandoned dialog is discarded.
  expect(app).toContain("editFetchId.current = id;");
  expect(app).toContain("if (editFetchId.current !== id) return;");
  expect(app).toContain('<p className="hint" role="status">{t("Loading profile…")}</p>');
  expect(app).toContain("disabled={editSaving || editLoading || timezoneBusy}");
});

test("a running row with saved proxy or fingerprint changes offers a restart", () => {
  expect(app).toContain("{p.restartPending && (");
  expect(app).toContain('{t("Applies at next start")}');
  expect(app).toContain("onClick={() => act(p.id, restartProfile)}");
  expect(app).toContain("if (r.restartRequired) flash(");
  // The restart is the status chip on its own line in the name cell, so the row actions keep their width.
  expect(app).toContain('className="status-chip warn tip"');
  expect(app).not.toContain('{t("Restart now")}');
});

test("pending cookies of a closed profile can be seen (domain and name) and removed", () => {
  expect(app).toContain("onClick={() => void openPendingCookies(p)}");
  expect(app).toContain("await fetchPendingCookies(profile.id)");
  expect(app).toContain("await clearPendingCookies(pendingView.profile.id)");
  expect(app).toContain('<li key={index}><span className="mono">{cookie.domain}</span><span className="mono muted">{cookie.name}</span></li>');
  expect(app).toContain('{t("Remove pending cookies")}');
});

test("the dock keeps a label element and a hover name for every destination", () => {
  expect(app).not.toContain("sidebarCollapsed");
  expect(app).not.toContain("rail-toggle");
  // Labels must be elements, not bare text, or they cannot be hidden on the rail.
  expect(app).toContain('<Icon name="plus" /><span className="navlabel">{t("New Profile")}</span>');
  expect(app).toContain('<Icon name="profiles" /><span className="navlabel">{t("All profiles")}</span>');
  // Every rail item needs a hover label once its text is gone.
  expect(app).toContain('data-tip={t("All profiles")}');
  expect(app).toContain('data-tip={t("Settings")}');
});

test("short sidebars keep folder space and let navigation scroll without clipping rail tooltips", () => {
  const navigation = styles.match(/\n\.sidenav \{([^}]+)\}/)?.[1] ?? "";
  expect(navigation).toContain("min-height: 0");
  expect(navigation).toContain("overflow-y: auto");
  expect(styles.includes(".sidesection:has(.folders) { min-height: 140px; }")).toBe(true);
  const compact = styles.slice(styles.indexOf("@media (max-height: 720px)"), styles.indexOf("@media (max-width: 920px)"));
  expect(compact).toContain(".sidecredit { display: none; }");
  expect(compact).toContain(".sidebar .navitem { padding-top: 6px; padding-bottom: 6px; }");
  expect(compact).not.toMatch(/\.sidefoot\s*\{[^}]*display:\s*none/);
});

test("roster columns declare their own width and never collapse", () => {
  // One registry drives the header cells and the table's min-width, so a column
  // cannot be squeezed below a readable size.
  expect(app).toContain('{ key: "name", label: "Name", sort: true, width: 220 }');
  expect(app).toContain("const CHECKBOX_COLUMN_WIDTH = 44;");
  expect(app).toContain("const tableMinWidth = CHECKBOX_COLUMN_WIDTH + shownColumns.reduce((total, column) => total + column.width, 0);");
  expect(app).toContain('style={{ minWidth: tableMinWidth }}');
  // Every column declares a width, so a wide window's extra space spreads
  // proportionally across all of them — no single column hoards it.
  expect(app).toContain("const style = { width: column.width } as CSSProperties;");
  // The Action column shows no header text — its buttons explain themselves.
  expect(app).toContain('const label = column.key === "action" ? ""');
  // Widths live in the registry only — a stray CSS width would silently win.
  expect(styles).not.toMatch(/th\.col-\w+, td\.col-\w+ \{ width:/);
  expect(styles).toContain("table-layout: fixed");
  expect(styles).toContain(".tablewrap { flex: 1; min-height: 0; overflow: auto; }");
});

test("the roster keeps only the columns that matter and stays compact", () => {
  // Health, Created and Last opened were removed on request; what is left is
  // identity, grouping, connectivity — and the one button every row needs.
  for (const key of ["health", "created", "opened"]) {
    expect(app).not.toContain(`key: "${key}"`);
  }
  expect(app).toContain('{ key: "proxy", label: "Proxy", sort: true, width: 160 }');
  expect(app).toContain('{ key: "action", label: "Action", sort: false, width: 230 }');
  expect(app).not.toContain("healthFilter");
});

test("every row action sits beside Open in the Action cell — nothing hides on hover", () => {
  expect(app).toContain('<span className="rowactions">');
  expect(app).toContain('aria-label={`Open ${p.name}`}');
  expect(app).toContain('aria-label={`Close ${p.name}`}');
  expect(app).toContain('aria-label={`Edit ${p.name}`}');
  expect(app).toContain('aria-label={t("Copy current 2FA code")}');
  // The hover-revealed overlay is gone: it overlapped the profile name.
  expect(app).not.toContain("rowquick");
  expect(styles).not.toContain(".rowquick");
  expect(styles).toContain(".rowactions { display: inline-flex; align-items: center; justify-content: flex-end;");
});

test("the Action column stays reachable while the roster scrolls sideways", () => {
  expect(styles).toContain("position: sticky; right: 0;");
  // A sticky cell has no row behind it, so every row state repaints its own.
  expect(styles).toContain(".profile-table tbody tr.selected td.col-action { background: var(--accent-soft); }");
  expect(styles).toContain(".profile-table thead th.col-action { z-index: 3; background: var(--surface-sunken); }");
  // Hover labels must paint above the next row's sticky Action cell.
  expect(styles).toContain(".profile-table tbody tr:hover td.col-action { background: var(--surface-sunken); z-index: 2; }");
  // The edge shadow only appears once there is content underneath it.
  expect(app).toContain("onScroll={(event) => setTableScrolled(event.currentTarget.scrollLeft > 0)}");
  expect(styles).toContain(".tablewrap.scrolled td.col-action::before");
});

test("small windows keep navigation and dialogs keep typed input", () => {
  // Navigation is a dock over the wall at every window size; it never
  // disappears — a resizable desktop app must never lose its navigation.
  expect(app).toContain('<aside className="sidebar dock">');
  expect(app).toContain('<div className="wall" inert={view !== "workbench"}>');
  expect(shell).toContain(".app .sidebar.dock {");
  expect(shell).not.toContain(".sidebar.dock { display: none");
  expect(styles).not.toContain(".sidebar { display: none; }");
  // On a big monitor the WHOLE shell caps and centers as one frame — sidebar,
  // header and roster together — a six-column app cannot fill 2500px gracefully.
  expect(styles).toContain("width: min(1440px, 100% - 32px);");
  // Escape closes the open dialog; a stray backdrop click never discards a form.
  expect(app).toContain('if (event.key !== "Escape") return;');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeCreate}');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeEdit}');
  expect(app).not.toContain('className="modal-backdrop" onClick={closeBulk}');
});

test("import offers one source at a time and counts what was pasted", () => {
  // Two full-height inputs stacked left it ambiguous which one Import would read.
  expect(app).toContain('const [bulkSource, setBulkSource] = useState<"file" | "paste">("file");');
  expect(app).toContain('aria-label={t("Import source")}');
  // Switching sources clears the other, so a stale value cannot be submitted.
  expect(app).toContain('onClick={() => { setBulkSource("file"); setBulkText(""); }}');
  expect(app).toContain('onClick={() => { setBulkSource("paste"); setBulkFiles([]); }}');
  // Every AdsPower record opens with its own id= line, so this count is exact.
  expect(app).toContain("function countPastedRecords(text: string): number {");
  expect(app).toContain('return (text.match(/^id=/gm) ?? []).length;');
  expect(app).toContain('t("1 record detected — each one starts with its own id= line.")');
  expect(app).toContain('t("{count} records detected — each one starts with its own id= line.", { count: pastedRecordCount })');
  // Chosen files are individually removable rather than a comma-joined string.
  expect(app).toContain('aria-label={`Remove ${file.name}`}');
  expect(app).toContain(">{t(\"Clear all\")}</button>");
  expect(styles).toContain(".filechip");
  expect(styles).toContain(".segmented");
});

test("no legacy arrow glyphs survive in place of icons", () => {
  // These predate the icon set; a stray one means a control was missed.
  for (const glyph of ["⤓", "⤒", "↩", "🧩", "📄", "▸", "▾"]) {
    expect(app).not.toContain(glyph);
  }
});

test("the second accent marks identity, and the credit matches the website", () => {
  // Two accents only work if each means something: architectural black
  // (#09090b) marks primary actions, refined graphite (#52525b) marks identity.
  expect(styles).toContain("--accent: #09090b;");
  expect(styles).toContain("--accent-2: #52525b;");
  expect(styles).toContain("td.col-no .no-text.custom { color: var(--accent-2-ink); }");
  expect(styles).not.toMatch(/\.btn\.primary \{[^}]*--accent-2/);
  // The logo uses the monochrome palette, and no trace of the old violet survives.
  expect(logo).toContain('stroke="#09090b"');
  expect(logo).toContain('stroke="#71717a"');
  expect(styles).not.toContain("#6d4aff");
  expect(styles).not.toContain("#8b6dff");

  // The footer wordmark is Vela Browser without upstream Xreacher credits.
  expect(app).not.toContain("Xreacher");
  expect(app).toContain('<p className="footer-mark" aria-hidden="true">Vela Browser</p>');
  expect(styles).toContain("-webkit-background-clip: text; background-clip: text; color: transparent;");
  // It is a credit, not a control: it must not survive into the icon rail.
});

test("the project links match this repository", () => {
  expect(app).not.toContain('href: "https://github.com/aliasmode/aliasmode"');
  expect(app).toContain('href: "https://github.com/accomplish07zrh-eng/vela-browser"');
  const links = app.slice(app.indexOf("const PROJECT_LINKS"), app.indexOf("] as const;", app.indexOf("const PROJECT_LINKS")));
  expect(links).toContain("github.com/accomplish07zrh-eng/vela-browser");
  expect(app).toContain('aria-label={t("Vela Browser on {name}", { name: link.label })}');
  expect(styles).toContain(".projectlink");
});

test("Extensions is a page, consistent with the rest of the shell", () => {
  // It was the last modal among pages, and opening it from Settings stacked a
  // dialog over a page.
  expect(app).toContain('setView("extensions")');
  expect(app).not.toContain("showExts");
  expect(app).toContain('view === "extensions" ? (');
  expect(app).toContain('className={`navitem${view === "extensions" ? " active" : ""}`}');
  expect(app).toContain('extensions: "Extensions",');
});

test("the dark theme is a token swap, and native controls follow it", () => {
  expect(styles).toContain(':root[data-theme="dark"] {');
  // Without color-scheme the browser keeps painting checkboxes and scrollbars light.
  expect(styles).toContain("color-scheme: dark;");
  expect(styles).toContain("color-scheme: light;");
  // Nothing may hardcode a light surface, or it survives into the dark theme —
  // this is exactly how the modal header stayed white.
  const rules = styles.slice(styles.indexOf("\n}", styles.indexOf(":root {")));
  expect(rules).not.toContain("linear-gradient(180deg, #ffffff");
  expect(rules).not.toMatch(/background: #fff/);
  // Two near-black brand tiles would vanish on a dark row.
  expect(styles).toContain(':root[data-theme="dark"] .platform-pill .glyph.pm-x');
  // Light is the out-of-the-box default; Dark and follow-the-OS System are
  // opt-in from Settings. A host-only cookie survives the desktop app's changing port.
  expect(app).toContain('import { THEME_KEY, readThemeChoice, themeCookie, type ThemeChoice } from "./theme.ts";');
  expect(app).toContain("return readThemeChoice(cookies, stored);");
  expect(app).toContain("document.cookie = themeCookie(choice);");
  // The app resolves "system" itself rather than duplicating the palette.
  expect(app).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
  expect(app).toContain("document.documentElement.dataset.theme =");
  expect(app).toContain('media.addEventListener("change", apply)');
});

test("the dock offers extension management in both modes and no upstream support link", () => {
  // The extension registry is local in both modes; Cloud profiles carry their
  // assignments and load matching local uploads at launch.
  expect(app).toContain('<Icon name="puzzle" /><span className="navlabel">{t("Manage extensions")}</span>');
  const nav = app.slice(app.indexOf('className="sidenav"'), app.indexOf("</nav>"));
  expect(nav).not.toMatch(/\{isCloudMode\s*&&\s*\(?\s*<button[^>]*setView\("extensions"\)/);
  const extensions = nav.slice(nav.lastIndexOf("<button", nav.indexOf('data-tip={t("Manage extensions")}')), nav.indexOf("</button>", nav.indexOf('data-tip={t("Manage extensions")}')));
  expect(extensions).not.toContain("isCloudMode");
  expect(app).not.toContain("/support/");
});

test("file update results retain partial counts and per-profile failures before refreshing", () => {
  const submit = app.slice(app.indexOf("const submitUpdate ="), app.indexOf("// ---- Group create"));
  expect(submit).toContain('if (typeof r.updated !== "number") return;');
  expect(submit).toContain("r.errors.map(");
  expect(submit).toContain("${item.id}: ${item.error}");
  expect(submit).toContain("setUpdateResult(m);\n      await load();");
  const modal = app.slice(app.indexOf("{showUpdate && ("));
  expect(modal).toContain("{updateErr &&");
  expect(modal).toContain("{updateResult &&");
  expect(modal).toContain("<code>custom_no</code>");
});

test("the existing Extensions page installs from a Web Store URL and keeps archive upload", () => {
  expect(app).toContain("Install from Chrome Web Store");
  expect(app).toContain('aria-label={t("Chrome Web Store URL or extension ID")}');
  expect(app).toContain("installWebStoreExtension(source)");
  expect(app).toContain("The in-browser Store button does not work in CloakBrowser");
  expect(app).toContain('t("Edit > Extensions")');
  expect(app).toContain("Upload ZIP/CRX");
  expect(app).toContain('accept=".zip,.crx,application/zip,application/x-chrome-extension"');
  expect(app).not.toContain("Chrome Web Store installs are not supported in Vela Browser");
  expect(app.match(/setView\("extensions"\)/g)).toHaveLength(1);
});

test("the update banner shows release highlights and native install progress", () => {
  expect(app).toContain("<UpdateHighlights version={desktopUpdate.version} highlights={desktopUpdate.highlights} />");
  expect(app).toContain("function DesktopUpdateProgressView(");
  expect(app).toContain('invoke("update_now", { onProgress })');
  expect(styles).toContain(".update-progress progress");
});

test("Firefox shows its screen, editable at creation and when editing", () => {
  const settings = app.slice(app.indexOf("function FingerprintSettings("), app.indexOf("function FingerprintSettings(") + 3600);
  expect(settings).not.toMatch(/\{engine === "chromium" && \(\s*<label className="fld">\s*<span>Screen/);
  expect(settings).toContain("onChange={(event) => onScreenChange(event.target.value)}");
  expect(app).not.toContain("screenReadOnly");
  expect(app).toContain("screen: form.screen,");
  expect(app).toContain('t("Leave a field blank to keep it automatic. A timezone you type stays when the proxy changes.")');
});


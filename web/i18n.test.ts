import { test, expect } from "bun:test";
import { availableLanguages, detectLanguage, languageNativeName, translate } from "./i18n.tsx";
import enUS from "./locales/en-US.json";
import ruRU from "./locales/ru-RU.json";
import zhCN from "./locales/zh-CN.json";

const tables = {
  "en-US": enUS as Record<string, string>,
  "ru-RU": ruRU as Record<string, string>,
  "zh-CN": zhCN as Record<string, string>,
};

// Keys are the English source strings, so en-US only carries the keys whose
// value differs from the key. Every translated key must still exist in the UI
// source, or the translation is dead.
test("every bundled locale key is an English string used in the web source", async () => {
  const sources = await Promise.all(
    ["app.tsx", "proxies.tsx", "scripts.tsx", "trash.tsx", "approval-queue.tsx", "code-approvals.tsx", "desktop-update-result.ts", "command-palette.tsx", "workbench.tsx", "workbench-client.ts", "profile-management.ts", "profile-management-controls.tsx", "profile-detail.tsx", "titlebar.tsx", "select.tsx", "dialog.tsx", "tasks.tsx", "../src/tasks.ts", "proxy-pool.tsx", "recording-dialog.tsx", "tags.tsx", "ai-settings.tsx", "snapshots.tsx", "health.tsx", "../src/workbench.ts", "../src/snapshots.ts", "../src/health.ts", "../src/store.ts", "../src/ui.ts"]
      .map((file) => Bun.file(new URL(`./${file}`, import.meta.url)).text()),
  );
  const source = sources.join("\n").replaceAll("\r\n", "\n");
  for (const [locale, table] of Object.entries(tables)) {
    const stale = Object.keys(table).filter((key) => !key.startsWith("language.") && !source.includes(key));
    expect({ locale, stale }).toEqual({ locale, stale: [] });
  }
});

test("zh-CN covers all literal translation keys in the approval, script, and pool panels", async () => {
  const files = ["approval-queue.tsx", "code-approvals.tsx", "scripts.tsx", "proxy-pool.tsx", "recording-dialog.tsx", "workbench.tsx", "tags.tsx", "tasks.tsx", "ai-settings.tsx", "snapshots.tsx", "health.tsx"];
  const missing: string[] = [];
  for (const file of files) {
    const text = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
    for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      const key = match[1]!;
      if (!(key in tables["zh-CN"]!)) missing.push(`${file}: ${key}`);
    }
  }
  for (const key of ["Scripts and plugins written by AI", "Ask each time", "Save directly", "Not allowed", "Could not save"]) {
    if (!(key in tables["zh-CN"]!)) missing.push(`app.tsx: ${key}`);
  }
  expect(missing).toEqual([]);
});

test("t() returns the translation for the active language", () => {
  expect(translate(tables, "zh-CN", "Appearance")).toBe(tables["zh-CN"]!["Appearance"]!);
  expect(translate(tables, "en-US", "Appearance")).toBe("Appearance");
});

test("t() falls back to English for missing keys", () => {
  const partial = {
    "en-US": { hello: "Hello" },
    "xx-YY": {} as Record<string, string>,
  };
  // Missing in xx-YY → English catalog value.
  expect(translate(partial, "xx-YY", "hello")).toBe("Hello");
  // Missing everywhere → the key itself.
  expect(translate(partial, "xx-YY", "unknown.key")).toBe("unknown.key");
  // Unknown language → English catalog.
  expect(translate(partial, "zz-ZZ", "hello")).toBe("Hello");
});

test("t() interpolates {name} and {{name}} placeholders", () => {
  const partial = { "en-US": { greeting: "Hello {name}", formal: "Hi {{name}}" } };
  expect(translate(partial, "en-US", "greeting", { name: "Ada" })).toBe("Hello Ada");
  expect(translate(partial, "en-US", "formal", { name: "Ada" })).toBe("Hi Ada");
  expect(translate(partial, "en-US", "greeting")).toBe("Hello {name}");
});

test("availableLanguages lists bundled locales with native names", () => {
  expect(availableLanguages()).toContain("en-US");
  expect(availableLanguages()).toContain("zh-CN");
  expect(languageNativeName("en-US")).toBe("English");
  expect(languageNativeName("zh-CN")).toBe("简体中文");
  expect(languageNativeName("xx-YY")).toBe("xx-YY");
});

test("detectLanguage matches the system language exactly, then by primary tag", () => {
  const known = ["en-US", "zh-CN", "ru-RU"];
  expect(detectLanguage(["zh-CN", "en"], known)).toBe("zh-CN");
  expect(detectLanguage(["zh-Hans-CN", "en-GB"], known)).toBe("zh-CN");
  expect(detectLanguage(["ru"], known)).toBe("ru-RU");
  expect(detectLanguage(["en-GB", "zh"], known)).toBe("en-US");
  expect(detectLanguage(["fr-FR", "de"], known)).toBeNull();
  expect(detectLanguage([], known)).toBeNull();
});

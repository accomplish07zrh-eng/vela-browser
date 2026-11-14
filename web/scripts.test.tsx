import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { GuideMarkdown, ScriptGuideDrawer, ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
import { GUIDE_TOPICS, guideText } from "../agent/guides.mjs";

test("script run panel defaults to 10 parallel browsers without an upper limit", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => "test-capability" } },
  });
  try {
    const html = renderToStaticMarkup(<I18nProvider><ScriptRunPanel open selectedProfiles={[]} onClose={() => {}} /></I18nProvider>);
    const field = html.match(/<input[^>]*type="number"[^>]*>/)?.[0];
    expect(field).toBeDefined();
    expect(field).toContain('value="10"');
    expect(field).toContain('min="1"');
    expect(field).toContain('step="1"');
    expect(field).not.toContain('max=');
    expect(field).not.toContain('disabled=');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("scripts page toolbar shows the writing guide button and GuideMarkdown renders guides without raw HTML", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { __TAURI_INTERNALS__: { invoke: async () => "test-capability" } },
  });
  try {
    const html = renderToStaticMarkup(<I18nProvider><ScriptsPage onViewRun={() => {}} /></I18nProvider>);
    expect(html).toContain("Writing guide");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  for (const topic of GUIDE_TOPICS) {
    for (const lang of ["zh-CN", "en"] as const) {
      const mdHtml = renderToStaticMarkup(<GuideMarkdown markdown={guideText(topic, lang)} />);
      expect(mdHtml).toContain("<h1>");
      expect(mdHtml).toContain("<h2>");
      expect(mdHtml).toContain("<code>");
    }
  }
  const scriptsHtml = renderToStaticMarkup(<GuideMarkdown markdown={guideText("scripts", "zh-CN")} />);
  expect(scriptsHtml).toContain("<table>");
  expect(scriptsHtml).toContain("<ul>");
  expect(scriptsHtml).toContain("WebKit");
  expect(scriptsHtml).toContain("<li>在应用里：");
  expect(scriptsHtml).toContain('class="script-code guide-code"');

  const edgeHtml = renderToStaticMarkup(
    <GuideMarkdown markdown={"| Name | Desc |\n| --- | --- |\n| `a | b` | **Uses `boldCode`** |\n\n中文第一句\n中文第二句"} />,
  );
  expect(edgeHtml).toContain("<code>a | b</code>");
  expect(edgeHtml).toContain("<strong>Uses <code>boldCode</code></strong>");
  expect(edgeHtml).toContain("<p>中文第一句中文第二句</p>");

  const drawerHtml = renderToStaticMarkup(<I18nProvider><ScriptGuideDrawer onClose={() => {}} /></I18nProvider>);
  expect(drawerHtml).toContain('role="tablist"');
  expect(drawerHtml).toContain('role="tabpanel"');
  expect(drawerHtml).toContain('aria-controls="guide-drawer-panel"');

  const safeHtml = renderToStaticMarkup(<GuideMarkdown markdown={"# Title\n\nParagraph with `<script>alert(1)</script>`"} />);
  expect(safeHtml).not.toContain("<script>alert(1)</script>");
  expect(safeHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

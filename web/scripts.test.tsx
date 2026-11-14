import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "./i18n.tsx";
import { GuideMarkdown, ScriptRunPanel, ScriptsPage } from "./scripts.tsx";
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
    const mdHtml = renderToStaticMarkup(<GuideMarkdown markdown={guideText(topic, "zh-CN")} />);
    expect(mdHtml).toContain("<h1>");
    expect(mdHtml).toContain("<h2>");
    expect(mdHtml).toContain("<code>");
  }
  const scriptsHtml = renderToStaticMarkup(<GuideMarkdown markdown={guideText("scripts", "zh-CN")} />);
  expect(scriptsHtml).toContain("<table>");
  expect(scriptsHtml).toContain("<ul>");
  expect(scriptsHtml).toContain('class="script-code guide-code"');

  const safeHtml = renderToStaticMarkup(<GuideMarkdown markdown={"# Title\n\nParagraph with `<script>alert(1)</script>`"} />);
  expect(safeHtml).not.toContain("<script>alert(1)</script>");
  expect(safeHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

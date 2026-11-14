import { expect, test } from "bun:test";
import { addStep, recordingSource, type RecordedStep } from "./recording.ts";

test("a recording becomes a script with role locators, input placeholders and no typed text", () => {
  const steps: RecordedStep[] = [];
  addStep(steps, { kind: "click", x: 300, y: 200, clicks: 1, button: "left", target: { role: "textbox", name: "Email" } });
  addStep(steps, { kind: "type", length: 5 });
  addStep(steps, { kind: "type", length: 7 });
  addStep(steps, { kind: "press", key: "Tab" });
  addStep(steps, { kind: "type", length: 9 });
  addStep(steps, { kind: "click", x: 412.4, y: 330.6, clicks: 1, button: "left", target: null, navigated: true });
  addStep(steps, { kind: "scroll", dy: 300 });
  addStep(steps, { kind: "scroll", dy: 300 });
  const source = recordingSource({ startUrl: "https://example.com/login", steps, viewport: { width: 1280, height: 800 } });
  expect(source).toContain(`await page.goto("https://example.com/login");`);
  expect(source).toContain(`await page.getByRole("textbox", { name: "Email", exact: true }).first().click();`);
  expect(source).toContain(`await page.keyboard.type(String(inputs.text1 ?? ""));`);
  expect(source).toContain(`await page.keyboard.type(String(inputs.text2 ?? ""));`);
  expect(source).toContain(`"text1":"… (12 characters were typed)"`);
  expect(source).toContain(`await page.keyboard.press("Tab");`);
  expect(source).toContain(`await page.mouse.click(412, 331);\n  await page.waitForLoadState();`);
  expect(source).toContain(`await page.mouse.wheel(0, 600);`);
  expect(source).toContain("recorded on a 1280×800 page");
  // The script is valid JavaScript with a default export.
  expect(() => new Function(source.replace("export default", "return"))).not.toThrow();
});

test("a second click on the same spot is a double click, and names are quoted safely", () => {
  const steps: RecordedStep[] = [];
  addStep(steps, { kind: "click", x: 10, y: 10, clicks: 1, button: "left", target: { role: "button", name: 'Say "hi"\n' } });
  addStep(steps, { kind: "click", x: 11, y: 10, clicks: 2, button: "left", target: { role: "button", name: 'Say "hi"\n' } });
  expect(steps.length).toBe(1);
  const source = recordingSource({ steps });
  expect(source).toContain(`getByRole("button", { name: "Say \\"hi\\"\\n", exact: true }).first().dblclick()`);
  expect(source).not.toContain("page.goto");
});

test("the notes at the top follow the recorder's language", () => {
  const source = recordingSource({ steps: [{ kind: "type", length: 3 }, { kind: "click", x: 1, y: 2, clicks: 1, button: "left" }], viewport: { width: 800, height: 600 }, language: "zh-CN" });
  expect(source).toContain("…（当时输入了 3 个字）");
  expect(source).toContain("录制时页面大小为 800×600");
});

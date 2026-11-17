import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { describeForms } from "./form-inspection.mjs";
import { draftFormWorkflow, formPageUrl } from "./form-workflow.mjs";
import { matchPixels } from "./visual-match.mjs";

const profileUrl = "http://127.0.0.1:4321/signup";
const stage = {
  id: "signup", pageUrl: profileUrl, fields: [{ input: "email", selector: "#email", action: "fill" }],
  submit: "#next", verify: { selector: "#receipt", text: "Created" },
};

test("recognizes login and code inputs and leaves ambiguous bindings for review", () => {
  const base = { tag: "input", type: "text", label: "", name: "", id: "", placeholder: "", autocomplete: "",
    required: true, disabled: false, readOnly: false, button: false };
  const view = describeForms({ truncated: false, groups: [{ label: "Sign up", selector: "#form", controls: [
    { ...base, type: "password", label: "Password", selector: "#password" },
    { ...base, type: "password", label: "确认密码", autocomplete: "new-password", selector: "#confirm" },
    { ...base, label: "Security code", autocomplete: "one-time-code", selector: "#otp" },
    { ...base, type: "email", selector: "#email1" },
    { ...base, type: "email", selector: "#email2" },
    { ...base, type: "button", button: true, label: "Next", selector: "#next" },
  ] }] }, { pageUrl: profileUrl, frameUrl: undefined, frameName: undefined });
  expect(view.forms[0]!.needsSelection).toBe(true);
  expect(view.forms[0]!.suggestedStage?.fields).toEqual([
    { input: "password", selector: "#password", action: "fill", required: true },
    { input: "password", selector: "#confirm", action: "fill", required: true },
    { input: "oneTimeCode", selector: "#otp", action: "fill", required: true },
  ]);
  expect(view.forms[0]!.suggestedStage?.submit).toBe("#next");
});

test("requires a useful receipt for each submit and removes URL query and fragment data", () => {
  expect(formPageUrl("https://user:pass@example.invalid/signup")).toBeUndefined();
  expect(formPageUrl(profileUrl + "?token=private#panel")).toBe(profileUrl);
  expect(() => draftFormWorkflow({ stages: [{ ...stage, verify: undefined }] })).toThrow("success condition");
  expect(() => draftFormWorkflow({ stages: [{ ...stage, verify: { pageUrl: profileUrl + "?ready=1" } }] })).toThrow("distinct destination URL");
  const draft = draftFormWorkflow({ exampleInputs: true, stages: [{ ...stage, pageUrl: profileUrl + "?token=private" }] });
  expect(draft.script.source).not.toContain("private");
  expect(draft.exampleInputs?.email).toMatch(/@example\.invalid$/);
  expect(draft.script.source).not.toContain(String(draft.exampleInputs?.email));
  expect(draft.task?.steps[0]?.verify).toBeTruthy();
});

test("a generated step refuses missing and ambiguous targets, and its verifier checks only positive receipts", async () => {
  const draft = draftFormWorkflow({ stages: [stage] });
  const step = draft.task!.steps[0]!;
  const frame = { locator: () => ({ count: async () => 1, isVisible: async () => true, textContent: async () => "Created" }) };
  const page = { isClosed: () => false, url: () => profileUrl, mainFrame: () => frame };
  const run = runInNewContext("(" + step.run + ")", { URL });
  const verify = runInNewContext("(" + step.verify + ")", { URL });
  expect((await verify({ context: { pages: () => [] } })).state).toBe("unknown");
  expect((await verify({ context: { pages: () => [page] } })).state).toBe("applied");
  expect((await run({ context: { pages: () => [page] }, argument: {} })).alreadyApplied).toBe(true);
  await expect(run({ context: { pages: () => [page, page] }, argument: {} })).rejects.toThrow("Multiple open tabs");
  await expect(run({ context: { pages: () => [] }, argument: {} })).rejects.toThrow("Missing or invalid workflow input: email");
});

test("visual matching finds a distinctive pattern and reports duplicate matches", () => {
  const template = { width: 6, height: 5, data: new Uint8Array(6 * 5 * 4) };
  for (let i = 0; i < 30; i++) template.data.set([i * 37 % 255, i * 59 % 255, i * 71 % 255, 255], i * 4);
  const image = { width: 40, height: 20, data: new Uint8Array(40 * 20 * 4) };
  expect(matchPixels(image, template, 0).status).toBe("missing");
  const place = (x: number, y: number) => {
    for (let row = 0; row < template.height; row++) {
      image.data.set(template.data.subarray(row * 24, (row + 1) * 24), ((y + row) * image.width + x) * 4);
    }
  };
  place(19, 6);
  expect(matchPixels(image, template, 0)).toEqual({ status: "unique", candidates: [{ x: 19, y: 6, width: 6, height: 5, similarity: 1 }] });
  place(6, 13);
  expect(matchPixels(image, template, 0).status).toBe("ambiguous");
});

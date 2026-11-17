import { randomBytes } from "node:crypto";

const text = (maxLength = 500) => ({ type: "string", minLength: 1, maxLength });
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const binding = object({
  input: text(64), selector: text(), action: { type: "string", enum: ["fill", "type", "select", "check"] }, required: { type: "boolean" },
}, ["input", "selector", "action"]);
const receipt = object({ pageUrl: text(2048), selector: text(), text: text() }, []);
const code = object({
  input: text(64), pageUrl: text(2048), selector: text(), digits: { type: "integer", minimum: 4, maximum: 10 },
  timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
}, ["input", "pageUrl", "selector"]);
export const formWorkflowStages = { type: "array", minItems: 1, maxItems: 8, items: object({
  id: text(64), pageUrl: text(2048), frameUrl: text(2048), frameName: text(160),
  fields: { type: "array", maxItems: 32, items: binding }, submit: text(), verify: receipt, code,
}, ["id", "pageUrl", "fields"]) };

export function formPageUrl(value) {
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.origin + url.pathname;
  } catch {}
  return undefined;
}

function checkedText(value, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("A workflow string is missing or too long");
  return value;
}

function checkedUrl(value) {
  const url = formPageUrl(checkedText(value, 2048));
  if (!url) throw new Error("Workflow page URLs must be HTTP or HTTPS addresses without credentials");
  return url;
}

function checkedInput(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(value)) {
    throw new Error("Input names use up to 64 letters, digits or underscores and cannot start with a digit");
  }
  return value;
}

function checkedStage(raw) {
  if (!raw || !Array.isArray(raw.fields) || raw.fields.length > 32) throw new Error("Each stage needs a fields array of at most 32 bindings");
  const pageUrl = checkedUrl(raw.pageUrl);
  const fields = raw.fields.map(field => {
    if (!field || !["fill", "type", "select", "check"].includes(field.action)) throw new Error("Choose fill, type, select or check for each field");
    if (field.required !== undefined && typeof field.required !== "boolean") throw new Error("Field required must be a boolean");
    return { input: checkedInput(field.input), selector: checkedText(field.selector), action: field.action, required: field.required !== false };
  });
  if (new Set(fields.map(field => field.selector)).size !== fields.length) throw new Error("A stage can bind each field selector once");
  const submit = raw.submit === undefined ? undefined : checkedText(raw.submit);
  if ((!fields.length && !submit) || (!!submit !== !!raw.verify)) throw new Error("A stage needs fields or a submit control, and a submit needs a success condition");
  let verify;
  if (raw.verify) {
    if (typeof raw.verify !== "object" || Array.isArray(raw.verify)) throw new Error("A success condition must be an object");
    const destination = raw.verify.pageUrl === undefined ? undefined : checkedUrl(raw.verify.pageUrl);
    const selector = raw.verify.selector === undefined ? undefined : checkedText(raw.verify.selector);
    const text = raw.verify.text === undefined ? undefined : checkedText(raw.verify.text);
    if ((!selector && (!destination || destination === pageUrl)) || (text && !selector)) {
      throw new Error("Success needs a visible selector or a distinct destination URL. Text requires a selector.");
    }
    verify = { ...(destination ? { pageUrl: destination } : {}), ...(selector ? { selector } : {}), ...(text ? { text } : {}) };
  }
  let code;
  if (raw.code !== undefined) {
    const input = checkedInput(raw.code?.input);
    const digits = raw.code.digits ?? 6, timeoutMs = raw.code.timeoutMs ?? 30000;
    if (!fields.some(field => field.input === input && ["fill", "type"].includes(field.action))
      || !Number.isInteger(digits) || digits < 4 || digits > 10
      || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      throw new Error("A code source needs a text input, 4 to 10 digits, and a timeout of 1 to 120 seconds");
    }
    code = { input, pageUrl: checkedUrl(raw.code.pageUrl), selector: checkedText(raw.code.selector), digits, timeoutMs };
  }
  if (raw.frameName !== undefined && raw.frameUrl === undefined) throw new Error("A frame name requires a frame URL");
  return {
    id: checkedText(raw.id, 64), pageUrl, fields, ...(submit ? { submit, verify } : {}),
    ...(raw.frameUrl === undefined ? {} : { frameUrl: checkedUrl(raw.frameUrl) }),
    ...(raw.frameName === undefined ? {} : { frameName: checkedText(raw.frameName, 160) }),
    ...(code ? { code } : {}),
  };
}

/** Serialized into drafts so saved scripts and durable steps have no runtime import dependency. */
async function runFormWorkflow({ context, inputs = {}, log = () => {} }, stages, mode = "script") {
  const urlPath = value => {
    const url = new URL(value);
    return url.origin + url.pathname;
  };
  const samePage = (target, path) => !target.isClosed() && urlPath(target.url()) === path;
  const choosePage = path => {
    const pages = context.pages().filter(page => samePage(page, path));
    if (pages.length > 1) throw new Error("Multiple open tabs match the workflow page");
    return pages[0];
  };
  const chooseFrame = (page, stage) => {
    if (!stage.frameUrl) return page.mainFrame();
    const frames = page.frames().filter(frame => !frame.isDetached() && frame !== page.mainFrame()
      && urlPath(frame.url()) === stage.frameUrl && (stage.frameName === undefined || frame.name() === stage.frameName));
    if (frames.length > 1) throw new Error("Multiple frames match the workflow stage");
    return frames[0];
  };
  const assertScope = (page, frame, stage) => {
    if (!samePage(page, stage.pageUrl) || !frame || frame.isDetached() || (stage.frameUrl && urlPath(frame.url()) !== stage.frameUrl)) {
      throw new Error("The form page or frame changed");
    }
  };
  const receiptVisible = async (page, stage) => {
    const verify = stage.verify;
    if (!page || !verify || !samePage(page, verify.pageUrl ?? stage.pageUrl)) return false;
    if (!verify.selector) return true;
    const frame = verify.pageUrl ? page.mainFrame() : chooseFrame(page, stage);
    const locator = frame?.locator("css=" + verify.selector);
    if (!locator || await locator.count() !== 1 || !(await locator.isVisible())) return false;
    return verify.text === undefined || (await locator.textContent({ timeout: 600 }))?.trim() === verify.text;
  };
  const waitFor = async (page, read, timeout, message) => {
    const deadline = Date.now() + timeout;
    let delay = 80;
    do {
      const value = await read();
      if (value) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForTimeout(Math.min(remaining, delay));
      delay = Math.min(1000, Math.ceil(delay * 1.5));
    } while (Date.now() < deadline);
    throw new Error(message);
  };
  const readCode = async (page, source) => {
    if (!samePage(page, source.pageUrl)) throw new Error("The code source tab changed");
    const locator = page.locator("css=" + source.selector);
    const count = await locator.count();
    if (count > 1) throw new Error("The code source matched more than one element");
    if (!count || !(await locator.isVisible())) return undefined;
    const value = (await locator.textContent({ timeout: 600 }))?.trim();
    return new RegExp("^\\d{" + source.digits + "}$").test(value ?? "") ? value : undefined;
  };
  const validateField = ({ input, action, required }, value) => {
    if (value === undefined && !required) return;
    const valid = action === "check" ? typeof value === "boolean" : typeof value === "string" && (!required || value.length > 0)
      && (action !== "type" || value.length <= 256)
      || (action === "select" && Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"));
    if (!valid) throw new Error("Missing or invalid workflow input: " + input);
  };

  if (mode === "verify") {
    try {
      const stage = stages[0];
      const page = choosePage(stage.verify?.pageUrl ?? stage.pageUrl);
      return await receiptVisible(page, stage) ? { state: "applied", value: { stage: stage.id } } : { state: "unknown" };
    } catch { return { state: "unknown" }; }
  }

  let page = choosePage(stages[0].pageUrl);
  const last = stages.at(-1);
  if (await receiptVisible(page ?? choosePage(last.verify?.pageUrl ?? last.pageUrl), last)) {
    return { stage: last.id, verified: true, alreadyApplied: true };
  }
  const codeReaders = new Map();
  for (const stage of stages) {
    for (const field of stage.fields) {
      if (!Object.hasOwn(inputs, field.input) && stage.code?.input === field.input) continue;
      validateField(field, Object.hasOwn(inputs, field.input) ? inputs[field.input] : undefined);
    }
    if (stage.code && !Object.hasOwn(inputs, stage.code.input)) {
      const page = choosePage(stage.code.pageUrl);
      if (!page) throw new Error("Open the configured code source tab before starting the workflow");
      codeReaders.set(stage, { page, baseline: await readCode(page, stage.code) });
    }
  }
  if (!page) {
    if (mode === "step") throw new Error("Open the workflow page before running this step");
    page = await context.newPage();
    await page.goto(stages[0].pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  }

  for (const stage of stages) {
    if (await receiptVisible(page, stage)) { log(stage.id, "already verified"); continue; }
    log(stage.id, "starting");
    try {
      await page.waitForURL(url => urlPath(url.href) === stage.pageUrl, { waitUntil: "commit", timeout: 10000 });
      const frame = await waitFor(page, () => chooseFrame(page, stage), 5000, "The form frame did not become available");
      const reader = codeReaders.get(stage);
      const verificationCode = reader && await waitFor(reader.page, async () => {
        const current = await readCode(reader.page, stage.code);
        return current !== reader.baseline ? current : undefined;
      }, stage.code.timeoutMs, "A fresh verification code did not appear");
      for (const field of stage.fields) {
        const value = Object.hasOwn(inputs, field.input) ? inputs[field.input] : field.input === stage.code?.input ? verificationCode : undefined;
        if (value === undefined) continue;
        const element = await frame.locator("css=" + field.selector).elementHandle({ timeout: 5000 });
        try {
          assertScope(page, frame, stage);
          if (field.action === "check") await element.setChecked(value, { timeout: 5000 });
          else if (field.action === "select") await element.selectOption(value, { timeout: 5000 });
          else if (field.action === "type") {
            await element.fill("", { timeout: 5000 });
            await element.type(value, { delay: 12, timeout: 5000 });
          }
          else await element.fill(value, { timeout: 5000 });
        } catch { throw new Error("Could not use form field " + field.input); }
        finally { await element.dispose().catch(() => {}); }
      }
      if (stage.submit) {
        const control = await frame.locator("css=" + stage.submit).elementHandle({ timeout: 5000 });
        try {
          assertScope(page, frame, stage);
          await control.click({ timeout: 5000 });
        } finally { await control.dispose().catch(() => {}); }
        await waitFor(page, () => receiptVisible(page, stage), 10000, "The success condition did not appear");
      }
    } catch (error) {
      throw new Error(stage.id + " failed: " + (error instanceof Error ? error.message.split("\n")[0] : "unknown error"));
    }
    log(stage.id, stage.verify ? "verified" : "filled");
  }
  return { stage: last.id, verified: !!last.verify };
}

/** @param {{ name?: string, stages: unknown[], exampleInputs?: boolean }} options */
export function draftFormWorkflow({ name, stages, exampleInputs }) {
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 8) throw new Error("Provide 1 to 8 workflow stages");
  const plan = stages.map(checkedStage);
  if (new Set(plan.map(stage => stage.id)).size !== plan.length) throw new Error("Workflow stage IDs must be unique");
  if (plan[0].code) throw new Error("Place fresh code retrieval after a stage that requests the code, or pass the code as a run input");
  const fields = new Map();
  for (const stage of plan) for (const field of stage.fields) {
    const previous = fields.get(field.input), fromCode = stage.code?.input === field.input;
    const action = field.action === "type" ? "fill" : field.action;
    if (previous && previous.action !== action) throw new Error("Each input must use the same value type throughout the workflow");
    fields.set(field.input, { name: field.input, action, required: !!previous?.required || (field.required && !fromCode),
      ...(previous?.fromCode || fromCode ? { fromCode: true } : {}) });
  }
  const args = [...fields.values()];
  const run = runFormWorkflow.toString();
  const literal = value => JSON.stringify(value, null, 2);
  const source = "const stages = " + literal(plan) + ";\n\n" + run
    + "\n\nexport default async function workflow(runtime) {\n  return runFormWorkflow(runtime, stages);\n}\n";
  const task = plan.some(stage => stage.code) ? undefined : { steps: plan.map((stage, index) => ({
    id: stage.id, timeoutMs: 120000,
    run: "async ({ context, argument }) => (" + run + ")({ context, inputs: argument.input ?? {} }, "
      + literal([stage]) + ", " + literal(index ? "step" : "script") + ")",
    ...(stage.verify ? { verify: "async ({ context }) => (" + run + ")({ context }, " + literal([stage]) + ', "verify")' } : {}),
  })) };
  const suffix = exampleInputs ? randomBytes(6).toString("hex") : undefined;
  const samples = {
    givenName: "Avery", familyName: "Test", fullName: "Avery Test",
    email: "vela-" + suffix + "@example.invalid", username: "vela_test_" + suffix,
    password: "T!" + suffix + "a7", confirmPassword: "T!" + suffix + "a7", oneTimeCode: "314159",
  };
  return {
    script: { name: name === undefined ? "Form workflow" : checkedText(name, 120), language: "javascript",
      description: "Fill and verify the selected form stages.", source },
    inputs: args,
    ...(task ? { task } : {}),
    ...(exampleInputs ? { exampleInputs: Object.fromEntries(args.filter(arg => !arg.fromCode && arg.action !== "select")
      .map(arg => [arg.name, arg.action === "check" ? true : Object.hasOwn(samples, arg.name) ? samples[arg.name] : "Test value"])) } : {}),
  };
}

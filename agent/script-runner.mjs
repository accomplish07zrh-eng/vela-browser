import { pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright-core";
import { BrowserDevtools } from "./devtools.mjs";

/** The developer record a script reads: what this browser logged and requested since the script started. */
function scriptDevtools(context) {
  // A script that never reads the record must not fail because the record could not start.
  let observer, failure;
  try { observer = new BrowserDevtools(context); } catch (error) { failure = error; }
  return {
    observer,
    api: Object.freeze({
      /** Calls a developer tool by its short or full name, such as "console" or "network". */
      call: async (tool, args = {}) => {
        if (!observer) throw new Error(`The developer record is unavailable: ${failure instanceof Error ? failure.message : String(failure)}`);
        const name = String(tool).startsWith("browser_devtools_") ? String(tool) : `browser_devtools_${tool}`;
        return (await observer.call(name, args)).structuredContent;
      },
    }),
  };
}

const scriptPath = process.argv[2];
if (!scriptPath) throw new Error("script path is missing");

process.stdin.setEncoding("utf8");
process.stdin.once("end", () => process.exit(1));
process.stdin.resume();

function firstInputLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      process.stdin.off("data", onData);
      resolve(buffer.slice(0, newline).replace(/\r$/, ""));
    };
    const onEnd = () => {
      process.stdin.off("data", onData);
      reject(new Error("runner input is missing"));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

async function run(input) {
  if (typeof input?.endpoint !== "string" || !input.endpoint) throw new Error("runner input is missing");
  if (input.endpoint.startsWith("firefox://")) throw new Error("Firefox scripts require a private Playwright endpoint");
  if (input.engine !== undefined && input.engine !== "firefox") throw new Error("runner input is invalid");
  let browser, devtools;
  try {
    browser = input.engine === "firefox"
      ? await firefox.connect(input.endpoint, { timeout: 30_000 })
      : await chromium.connectOverCDP(input.endpoint, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Vela Browser browser context is unavailable");
    const page = context.pages()[0] ?? await context.newPage();
    const module = await import(pathToFileURL(scriptPath).href);
    if (typeof module.default !== "function") {
      throw new Error("Playwright script must export a default async function");
    }
    devtools = scriptDevtools(context);
    await module.default({
      browser,
      context,
      page,
      devtools: devtools.api,
      profile: input.profile,
      inputs: input.inputs,
      credentials: input.credentials ?? null,
      log: (...values) => console.log(...values),
    });
  } finally {
    devtools?.observer?.dispose();
    await browser?.close().catch(() => {});
  }
}

function errorText(error, input) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return input?.engine === "firefox" && typeof input.endpoint === "string"
    ? text.replaceAll(input.endpoint, "private Firefox endpoint")
    : text;
}

let input;
try {
  input = JSON.parse(await firstInputLine());
  await run(input);
} catch (error) {
  process.exitCode = 1;
  console.error(errorText(error, input));
} finally {
  process.stdin.pause();
}

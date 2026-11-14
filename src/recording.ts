/**
 * Turning what a person did on a workbench card into a script. The steps are taken from the input
 * Vela Browser forwards to the browser, never from the page: nothing is injected to record them.
 * Typed text is never written into the script; each run of typing becomes an input to fill in.
 */

export interface RecordedTarget { role: string; name: string }

export type RecordedStep =
  | { kind: "click"; x: number; y: number; clicks: number; button: "left" | "middle" | "right"; target?: RecordedTarget | null; navigated?: boolean }
  | { kind: "type"; length: number }
  | { kind: "press"; key: string }
  | { kind: "scroll"; dy: number };

/** Keys worth a step of their own; letters and digits arrive as typed text. */
export const RECORDED_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Delete"]);

/** Adds one step, folding typing and scrolling into the step before when they continue it. */
export function addStep(steps: RecordedStep[], step: RecordedStep): void {
  const last = steps.at(-1);
  if (step.kind === "type" && last?.kind === "type") { last.length += step.length; return; }
  if (step.kind === "scroll" && last?.kind === "scroll") { last.dy += step.dy; return; }
  if (step.kind === "click" && step.clicks > 1 && last?.kind === "click" && Math.abs(last.x - step.x) < 4 && Math.abs(last.y - step.y) < 4) {
    last.clicks = step.clicks; return;
  }
  steps.push(step);
  if (steps.length > 500) steps.shift();
}

const quote = (value: string) => JSON.stringify(value);

/** The comments at the top of a recorded script, in the language of whoever recorded it. */
const NOTES = {
  en: { recorded: (date: string) => `// Recorded in Vela Browser${date ? ` on ${date}` : ""}. Runs once in every profile you choose.`, typed: "// Typed text is not recorded. Give it as inputs when you run the script:", count: (n: number) => `… (${n} characters were typed)`, positions: (w: number, h: number) => `// Some clicks are page positions, recorded on a ${w}×${h} page.` },
  zh: { recorded: (date: string) => `// 在 Vela Browser 录制${date ? `于 ${date}` : ""}。在你选中的每个环境里各运行一次。`, typed: "// 输入的文字没有录下来，运行时在输入里填上：", count: (n: number) => `…（当时输入了 ${n} 个字）`, positions: (w: number, h: number) => `// 有些点击是页面坐标，录制时页面大小为 ${w}×${h}。` },
  ru: { recorded: (date: string) => `// Записано в Vela Browser${date ? ` ${date}` : ""}. Выполняется по разу в каждом выбранном окружении.`, typed: "// Введённый текст не записан. Укажите его во входных данных при запуске:", count: (n: number) => `… (введено символов: ${n})`, positions: (w: number, h: number) => `// Часть кликов — координаты на странице ${w}×${h}.` },
};

/** The script for a recording, ready to save and run in any number of profiles. */
export function recordingSource(input: { startUrl?: string; steps: RecordedStep[]; viewport?: { width: number; height: number }; recordedAt?: Date; language?: string }): string {
  const notes = NOTES[input.language?.startsWith("zh") ? "zh" : input.language?.startsWith("ru") ? "ru" : "en"];
  const lines: string[] = [];
  const inputs: Array<{ name: string; length: number }> = [];
  let positional = false;
  for (const step of input.steps) {
    if (step.kind === "click") {
      const method = step.clicks >= 2 ? "dblclick" : "click";
      const options = step.button !== "left" ? `{ button: ${quote(step.button)} }` : "";
      if (step.target) {
        lines.push(`await page.getByRole(${quote(step.target.role)}, { name: ${quote(step.target.name)}, exact: true }).first().${method}(${options});`);
      } else {
        positional = true;
        const position = options ? `{ button: ${quote(step.button)}${step.clicks >= 2 ? ", clickCount: 2" : ""} }` : step.clicks >= 2 ? "{ clickCount: 2 }" : "";
        lines.push(`await page.mouse.click(${Math.round(step.x)}, ${Math.round(step.y)}${position ? `, ${position}` : ""});`);
      }
      if (step.navigated) lines.push(`await page.waitForLoadState();`);
    } else if (step.kind === "type") {
      const name = `text${inputs.length + 1}`;
      inputs.push({ name, length: step.length });
      lines.push(`await page.keyboard.type(String(inputs.${name} ?? ""));`);
    } else if (step.kind === "press") {
      lines.push(`await page.keyboard.press(${quote(step.key)});`);
    } else if (step.dy) {
      lines.push(`await page.mouse.wheel(0, ${Math.round(step.dy)});`);
    }
  }
  const header = [
    notes.recorded(input.recordedAt ? input.recordedAt.toISOString().slice(0, 10) : ""),
    ...(inputs.length ? [notes.typed, `//   ${JSON.stringify(Object.fromEntries(inputs.map((item) => [item.name, notes.count(item.length)])))}`] : []),
    ...(positional && input.viewport ? [notes.positions(input.viewport.width, input.viewport.height)] : []),
  ];
  return [
    ...header,
    "export default async ({ page, inputs, log }) => {",
    ...(input.startUrl && /^https?:/i.test(input.startUrl) ? [`  await page.goto(${quote(input.startUrl)});`] : []),
    ...lines.map((line) => `  ${line}`),
    `  log("done", await page.title());`,
    "};",
    "",
  ].join("\n");
}

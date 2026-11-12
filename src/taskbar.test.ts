import { expect, test } from "bun:test";
import { parseAppConfig } from "./app-config.ts";
import { applyTaskbarMode, TaskbarMode } from "./taskbar.ts";

test("the taskbar setting is saved only as an explicit opt-in", () => {
  expect(parseAppConfig({ version: 1, mode: "local", localAnalytics: false, hideFromTaskbar: true }).hideFromTaskbar).toBe(true);
  expect(parseAppConfig({ version: 1, mode: "local", localAnalytics: false, hideFromTaskbar: "yes" })).not.toHaveProperty("hideFromTaskbar");
  expect(parseAppConfig({ version: 1, mode: "local", localAnalytics: false })).not.toHaveProperty("hideFromTaskbar");
});

test("nothing is touched without a running browser process", async () => {
  expect(await applyTaskbarMode([], true)).toBe(0);
  expect(await applyTaskbarMode([0, -1, Number.NaN], true)).toBe(0);
});

test("with the mode off from the start, a sweep reads no launches", async () => {
  let reads = 0;
  const mode = new TaskbarMode({ store: { listLaunches: () => { reads++; return []; } } as never, enabled: () => false });
  await mode.sweep();
  expect(reads).toBe(0);
});

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepDownloads, safeFileName, systemDownloadsDir, uniquePath } from "./downloads.mjs";

test("the site's file name is kept, made safe on every system", () => {
  expect(safeFileName("报告 2026.pdf")).toBe("报告 2026.pdf");
  expect(safeFileName("../../etc/passwd")).toBe("passwd");
  expect(safeFileName("C:\\Windows\\evil.exe")).toBe("evil.exe");
  expect(safeFileName('a<b>c:"d|e?f*.txt')).toBe("a_b_c__d_e_f_.txt");
  expect(safeFileName("trailing. . ")).toBe("trailing");
  expect(safeFileName("CON.txt")).toBe("_CON.txt");
  expect(safeFileName("nul")).toBe("_nul");
  expect(safeFileName("")).toBe("download");
  expect(safeFileName("..")).toBe("download");
  const long = safeFileName(`${"x".repeat(300)}.zip`);
  expect(long.length).toBe(180);
  expect(long.endsWith(".zip")).toBe(true);
});

test("a name already used, on disk or by a save in progress, gets a number", () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-downloads-"));
  writeFileSync(join(dir, "a.pdf"), "");
  const taken = new Set<string>();
  expect(uniquePath(dir, "a.pdf", taken)).toBe(join(dir, "a (1).pdf"));
  expect(uniquePath(dir, "a.pdf", taken)).toBe(join(dir, "a (2).pdf"));
  expect(uniquePath(dir, "b", taken)).toBe(join(dir, "b"));
  // Windows and macOS compare names without case.
  expect(uniquePath(dir, "A.PDF", taken)).toBe(join(dir, "A (3).PDF"));
});

test("the Downloads folder is the one the system names, wherever the user moved it", () => {
  const reg = () => "\r\nHKEY_CURRENT_USER\\...\\Shell Folders\r\n    {374DE290-123F-4565-9164-39C4925E467B}    REG_SZ    D:\\用户\\下载\r\n\r\n";
  expect(systemDownloadsDir({ platform: "win32", home: "C:\\Users\\u", run: reg as any })).toBe("D:\\用户\\下载");
  expect(systemDownloadsDir({ platform: "linux", home: "/home/u", run: (() => "/home/u/下载\n") as any })).toBe("/home/u/下载");
  const failing = () => { throw new Error("not found"); };
  expect(systemDownloadsDir({ platform: "win32", home: "C:\\Users\\u", run: failing as any })).toBe(join("C:\\Users\\u", "Downloads"));
  expect(systemDownloadsDir({ platform: "darwin", home: "/Users/u", run: failing as any })).toBe(join("/Users/u", "Downloads"));
  // On Linux, xdg-user-dir answers the home folder when no Downloads folder is configured.
  expect(systemDownloadsDir({ platform: "linux", home: "/home/u", run: (() => "/home/u\n") as any })).toBe(join("/home/u", "Downloads"));
});

class FakeDownload {
  constructor(readonly name: string, readonly body: string, readonly fail = false) {}
  suggestedFilename() { return this.name; }
  async saveAs(path: string) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (this.fail) throw new Error("download failed: network");
    writeFileSync(path, this.body);
  }
}

test("every page's downloads, including pages opened later, are saved under their own names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vela-downloads-"));
  const first = new EventEmitter(), later = new EventEmitter();
  const context: any = Object.assign(new EventEmitter(), { pages: () => [first] });
  const logs: string[] = [];
  const stop = keepDownloads(context, { dir, log: (line: string) => logs.push(line) });
  first.emit("download", new FakeDownload("报告.pdf", "one"));
  first.emit("download", new FakeDownload("报告.pdf", "two"));
  context.emit("page", later);
  later.emit("download", new FakeDownload("../photo.jpg", "three"));
  later.emit("download", new FakeDownload("broken.zip", "", true));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(readdirSync(dir).sort()).toEqual(["photo.jpg", "报告 (1).pdf", "报告.pdf"].sort());
  expect([readFileSync(join(dir, "报告.pdf"), "utf8"), readFileSync(join(dir, "报告 (1).pdf"), "utf8")].sort()).toEqual(["one", "two"]);
  expect(logs.some(line => line.includes("not saved") && line.includes("network"))).toBe(true);
  stop();
  first.emit("download", new FakeDownload("after-stop.txt", "x"));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(readdirSync(dir)).not.toContain("after-stop.txt");
});

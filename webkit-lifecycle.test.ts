import { expect, test } from "bun:test";
import { win32 } from "node:path";
import { matchWebKitProcesses } from "./webkit-lifecycle.ts";
import type { HostProcessSnapshot } from "./launcher.ts";

const identity = { binaryPath: "D:\\Vela Browser\\runtimes\\webkit-2388-win64\\Playwright.exe", userDataDir: "D:\\Vela Browser\\profiles\\one", ownerBinaryPath: "D:\\node\\node.exe", generation: "generation-one", browserPid: 102 };
const records = (): HostProcessSnapshot["records"] => [
  { pid: 101, executablePath: identity.ownerBinaryPath, argv: [identity.ownerBinaryPath, "webkit-worker.mjs", `--aliasmode-webkit-owner=${identity.generation}`] },
  { pid: 102, parentPid: 101, executablePath: identity.binaryPath, commandLine: `"${identity.binaryPath}" --inspector-pipe --user-data-dir="${identity.userDataDir}"` },
  ...["WebKitGPUProcess.exe", "WebKitNetworkProcess.exe", "WebKitWebProcess.exe"].map((name, index) => ({ pid: 103 + index, parentPid: 102, executablePath: win32.join(win32.dirname(identity.binaryPath), name) })),
  { pid: 106, parentPid: 103, executablePath: win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "conhost.exe") },
];

test("WebKit owns exact roots and descendants while leaving Windows console hosts alone", () => {
  expect(matchWebKitProcesses(identity, { records: records(), incomplete: false })).toEqual({ browsers: [102, 103, 104, 105], owners: [101] });
  const other = records().map((record) => ({ ...record, pid: record.pid + 100, parentPid: record.parentPid ? record.parentPid + 100 : undefined, argv: record.argv?.map((arg) => arg.replace("generation-one", "generation-two")), commandLine: record.commandLine?.replace("profiles\\one", "profiles\\two") }));
  expect(matchWebKitProcesses(identity, { records: [...records(), ...other], incomplete: false })!.browsers).toEqual([102, 103, 104, 105]);
});

test("WebKit rejects incomplete, ambiguous or changed process identities", () => {
  expect(matchWebKitProcesses(identity, { records: records(), incomplete: true })).toBeNull();
  for (const index of [0, 1, 2]) for (const executablePath of [null, "D:\\unrelated\\other.exe"]) {
    const current = records(); current[index] = { ...current[index]!, executablePath };
    expect(matchWebKitProcesses(identity, { records: current, incomplete: false })).toBeNull();
  }
  const impostor = records(); impostor[5]!.executablePath = "D:\\unrelated\\conhost.exe";
  expect(matchWebKitProcesses(identity, { records: impostor, incomplete: false })).toBeNull();
});

test("recycled PIDs and stale owner generations never authorize WebKit termination", () => {
  const current = records(); current[0]!.argv = [identity.ownerBinaryPath, "--aliasmode-webkit-owner=generation-two"];
  expect(matchWebKitProcesses(identity, { records: current, incomplete: false })!.owners).toEqual([]);
  expect(matchWebKitProcesses(identity, { records: current.filter((r) => r.pid !== 102), incomplete: false })).toBeNull();
  const absent = current.filter((r) => r.pid === 101 || r.pid === 106);
  expect(matchWebKitProcesses(identity, { records: absent, incomplete: false })).toEqual({ browsers: [], owners: [] });
  const prefix = [{ pid: 777, executablePath: identity.binaryPath, argv: [identity.binaryPath, `--user-data-dir=${identity.userDataDir}-other`] }];
  expect(matchWebKitProcesses(identity, { records: prefix, incomplete: false })).toEqual({ browsers: [], owners: [] });
});

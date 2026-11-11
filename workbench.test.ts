import { expect, test } from "bun:test";
import type { Launcher } from "./launcher.ts";
import type { ProfileStore } from "./store.ts";
import type { LaunchInfo } from "./types.ts";
import type { WorkbenchAdapter, WorkbenchInput } from "./workbench-protocol.ts";
import { validWorkbenchInput } from "./workbench-protocol.ts";
import { WorkbenchHub, validWorkbenchAuthorization, workbenchGeneration } from "./workbench.ts";

function fixture() {
  const launches = new Map<string, LaunchInfo>(["a", "b"].map((id, index) => [id, { profileId: id, pid: 10 + index, startedAt: 123, debugPort: 9000 + index, ws: `ws://127.0.0.1:${9000 + index}/browser` }]));
  const inputs = new Map<string, WorkbenchInput[]>(), disposed: string[] = [];
  let allowed = true;
  const hub = new WorkbenchHub({
    store: { getProfile: (id: string) => launches.has(id) ? { id } : null, getLaunch: (id: string) => launches.get(id) ?? null } as unknown as ProfileStore,
    launcher: { certifiedActive: async (id: string) => launches.has(id) } as unknown as Launcher,
    canControl: () => allowed,
    adapter: (launch): WorkbenchAdapter => {
      inputs.set(launch.profileId, []);
      let selected = "tab-1";
      return { tabs: async () => [{ id: "tab-1", title: "one", url: "https://example.test" }, { id: "tab-2", title: "two", url: "about:blank" }],
        select: async (id) => { selected = id; }, newTab: async () => "tab-2", closeTab: async () => {},
        frame: async () => ({ data: selected, width: 1280, height: 720 }),
        input: async (input) => { inputs.get(launch.profileId)!.push(input); }, dispose: () => { disposed.push(launch.profileId); } };
    },
  });
  return { hub, launches, inputs, disposed, revoke: () => { allowed = false; } };
}
const text: WorkbenchInput = { kind: "text", text: "只发往当前环境" };
const enable = async (connection: Awaited<ReturnType<WorkbenchHub["connect"]>>) => connection.enqueue({ action: "visibility", generation: connection.generation, visible: true });

test("workbench requires both the exact dashboard origin and a desktop capability", () => {
  const nonce = "a".repeat(64);
  const request = (origin: string, token: string) => new Request("http://127.0.0.1:50400/ui/api/workbench/connect", { headers: { origin, "sec-websocket-protocol": `vela-workbench-v1, vela-capability.${token}` } });
  expect(validWorkbenchAuthorization(request("http://127.0.0.1:50400", nonce), nonce)).toBe(true);
  expect(validWorkbenchAuthorization(request("https://evil.test", nonce), nonce)).toBe(false);
  expect(validWorkbenchAuthorization(request("http://127.0.0.1:50400", "b".repeat(64)), nonce)).toBe(false);
  expect(validWorkbenchAuthorization(request("http://127.0.0.1:50400", "!".repeat(64)), nonce)).toBe(false);
});

test("inputs stay in their own browser, and stale tabs and generations cannot receive them", async () => {
  const f = fixture(); const a = await f.hub.connect("a"), b = await f.hub.connect("b");
  try {
    await a.start(() => {}); await b.start(() => {}); await enable(a); await enable(b);
    await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
    expect(f.inputs.get("a")).toEqual([text]); expect(f.inputs.get("b")).toEqual([]);
    await a.enqueue({ action: "select", generation: a.generation, targetId: "tab-2" });
    await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
    expect(f.inputs.get("a")).toHaveLength(1);
    f.launches.get("a")!.pid++;
    await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-2", input: text });
    expect(f.inputs.get("a")).toHaveLength(1); expect(f.disposed).toContain("a");
    await b.enqueue({ action: "input", generation: b.generation, targetId: "tab-1", input: text });
    expect(f.inputs.get("b")).toEqual([text]);
  } finally { await a.dispose(); await b.dispose(); }
});

test("hidden views suspend input and revocation detaches only control resources", async () => {
  const f = fixture(); const a = await f.hub.connect("a");
  await a.start(() => {});
  await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
  expect(f.inputs.get("a")).toEqual([]);
  await enable(a); f.revoke();
  await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
  expect(f.inputs.get("a")).toEqual([]); expect(f.disposed).toEqual(["a"]); expect(f.launches.size).toBe(2);
});

test("disconnect releases pressed keys and leaves both browser launches intact", async () => {
  const f = fixture(); const a = await f.hub.connect("a");
  await a.start(() => {}); await enable(a);
  const key: WorkbenchInput = { kind: "key", event: "down", key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: 8 };
  await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: key });
  await a.dispose(); await a.dispose();
  expect(f.inputs.get("a")).toEqual([key, { ...key, event: "up", modifiers: 0 }]);
  expect(f.disposed).toEqual(["a"]); expect(f.launches.size).toBe(2);
});

test("a restart during an asynchronous permission check rejects the queued input", async () => {
  const f = fixture(); const a = await f.hub.connect("a");
  await a.start(() => {}); await enable(a);
  let resolvePermission!: (allowed: boolean) => void;
  f.hub.options.canControl = () => new Promise<boolean>((resolve) => { resolvePermission = resolve; });
  const pending = a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
  await Promise.resolve();
  f.launches.get("a")!.startedAt++;
  resolvePermission(true); await pending;
  expect(f.inputs.get("a")).toEqual([]);
  expect(f.disposed).toEqual(["a"]);
});

test("launch generations include PID, start time and browser endpoint", () => {
  const f = fixture(), launch = f.launches.get("a")!;
  expect(workbenchGeneration(launch)).not.toEqual(workbenchGeneration({ ...launch, startedAt: launch.startedAt + 1 }));
  expect(workbenchGeneration(launch)).not.toEqual(workbenchGeneration({ ...launch, ws: launch.ws + "-new" }));
});

test("input boundary rejects arbitrary commands, oversized text and invalid coordinates", () => {
  expect(validWorkbenchInput(text)).toBe(true);
  expect(validWorkbenchInput({ kind: "evaluate", script: "alert(1)" })).toBe(false);
  expect(validWorkbenchInput({ kind: "text", text: "x".repeat(65_537) })).toBe(false);
  expect(validWorkbenchInput({ kind: "wheel", x: NaN, y: 0, dx: 0, dy: 10, modifiers: 0 })).toBe(false);
});

test("rotation freezes capture and rejects a frame already in flight", async () => {
  const f = fixture();
  const original = f.hub.options.adapter!;
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  f.hub.options.adapter = (launch) => ({ ...original(launch), frame: async () => { enter(); await pending; return { data: "frame", width: 1280, height: 800 }; } });
  const a = await f.hub.connect("a"), messages: any[] = [];
  try {
    await a.start((message) => messages.push(message));
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "interactive" });
    await entered;
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "interactive", frozen: true });
    finish(); await Bun.sleep(70);
    expect(messages.filter((message) => message.type === "frame")).toHaveLength(0);
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "interactive", frozen: false });
    await Bun.sleep(70);
    expect(messages.filter((message) => message.type === "frame")).toHaveLength(1);
  } finally { finish(); await a.dispose(); }
});

test("explicit synchronization can control an offscreen follower without capturing it", async () => {
  const f = fixture(), a = await f.hub.connect("a"), messages: any[] = [];
  try {
    await a.start((message) => messages.push(message));
    await a.enqueue({ action: "visibility", generation: a.generation, visible: false, following: true });
    await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
    expect(f.inputs.get("a")).toEqual([text]);
    expect(messages.some((message) => message.type === "frame")).toBe(false);
    await a.enqueue({ action: "visibility", generation: a.generation, visible: false, following: false });
    await a.enqueue({ action: "input", generation: a.generation, targetId: "tab-1", input: text });
    expect(f.inputs.get("a")).toEqual([text]);
    expect(f.launches.size).toBe(2);
  } finally { await a.dispose(); }
});

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

test("a live stream replaces polling, sized to the card, and restarts when the card changes", async () => {
  const f = fixture();
  const original = f.hub.options.adapter!;
  const streams: any[] = [], polled: Array<number | undefined> = [];
  let push: (data: string) => void = () => {};
  f.hub.options.adapter = (launch) => ({
    ...original(launch),
    frame: async (_focused: boolean, maxWidth?: number) => { polled.push(maxWidth); return { data: "polled", width: 1280, height: 720 }; },
    stream: async (options: any, onFrame: any) => {
      const record = { options, stopped: false };
      streams.push(record);
      push = (data) => { if (!record.stopped) onFrame({ data, width: 1280, height: 720 }); };
      push("first");
      return async () => { record.stopped = true; };
    },
  });
  const a = await f.hub.connect("a"), messages: any[] = [];
  try {
    await a.start((message) => messages.push(message));
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "visible", width: 500 });
    await Bun.sleep(30);
    expect(streams).toHaveLength(1);
    // Frames are asked for at the card's width, in 64-pixel steps, at the calm rate of the wall.
    expect(streams[0].options).toMatchObject({ maxWidth: 512, minInterval: 160, quality: 65 });
    push("second");
    expect(messages.filter((message) => message.type === "frame").map((message) => message.data)).toEqual(["first", "second"]);
    await Bun.sleep(400);
    expect(polled).toEqual([]);
    // Working in the browser: the stream restarts at the interactive rate.
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "interactive", focused: true, width: 1500 });
    await Bun.sleep(30);
    expect(streams).toHaveLength(2);
    expect(streams[0].stopped).toBe(true);
    expect(streams[1].options).toMatchObject({ maxWidth: 1536, minInterval: 33, quality: 80 });
    // Hidden: the stream stops, and nothing is polled either.
    await a.enqueue({ action: "visibility", generation: a.generation, visible: false });
    await Bun.sleep(30);
    expect(streams[1].stopped).toBe(true);
    expect(polled).toEqual([]);
  } finally { await a.dispose(); }
});

test("a stream that falls silent, as a minimized browser's does, is backed by a capture every two seconds", async () => {
  const f = fixture();
  const original = f.hub.options.adapter!;
  const polled: Array<number | undefined> = [];
  f.hub.options.adapter = (launch) => ({
    ...original(launch),
    frame: async (_focused: boolean, maxWidth?: number) => { polled.push(maxWidth); return { data: "polled", width: 1280, height: 720 }; },
    stream: async (_options: any, onFrame: any) => { onFrame({ data: "live", width: 1280, height: 720 }); return async () => {}; },
  });
  const a = await f.hub.connect("a"), messages: any[] = [];
  try {
    await a.start((message) => messages.push(message));
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "visible", width: 300 });
    await Bun.sleep(1000);
    expect(polled).toEqual([]);
    await Bun.sleep(2600);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled[0]).toBe(320);
    expect(messages.filter((message) => message.type === "frame").map((message) => message.data)).toContain("polled");
  } finally { await a.dispose(); }
});

test("a tab that streams nothing is polled instead, at its card's size", async () => {
  const f = fixture();
  const original = f.hub.options.adapter!;
  const polled: Array<number | undefined> = [];
  f.hub.options.adapter = (launch) => ({
    ...original(launch),
    frame: async (_focused: boolean, maxWidth?: number) => { polled.push(maxWidth); return { data: "polled", width: 1280, height: 720 }; },
    stream: async () => async () => {},
  });
  const a = await f.hub.connect("a"), messages: any[] = [];
  try {
    await a.start((message) => messages.push(message));
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "interactive", focused: true, width: 900 });
    await Bun.sleep(1500);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled[0]).toBe(960);
    expect(messages.some((message) => message.type === "frame" && message.data === "polled")).toBe(true);
  } finally { await a.dispose(); }
});

test("the AI's pointer reaches only the cards showing that browser, with the tab it is on", async () => {
  const f = fixture();
  const a = await f.hub.connect("a"), b = await f.hub.connect("b"), seen: any[] = [], other: any[] = [];
  try {
    await a.start((message) => seen.push(message));
    await b.start((message) => other.push(message));
    // A card that is not shown draws nothing.
    f.hub.pointer("a", { x: 10, y: 20, phase: "move" });
    expect(seen.filter((message) => message.type === "pointer")).toEqual([]);
    await a.enqueue({ action: "visibility", generation: a.generation, visible: true, tier: "visible" });
    await b.enqueue({ action: "visibility", generation: b.generation, visible: true, tier: "visible" });
    f.hub.pointer("a", { x: 10, y: 20, phase: "down" });
    expect(seen.filter((message) => message.type === "pointer")).toEqual([{ type: "pointer", targetId: "tab-1", x: 10, y: 20, phase: "down", profileId: "a", generation: a.generation }]);
    expect(other.some((message) => message.type === "pointer")).toBe(false);
    await a.dispose();
    f.hub.pointer("a", { x: 1, y: 1, phase: "up" });
    expect(seen.filter((message) => message.type === "pointer")).toHaveLength(1);
  } finally { await a.dispose(); await b.dispose(); }
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

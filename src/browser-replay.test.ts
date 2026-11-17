import { expect, test } from "bun:test";
import { BrowserReplay } from "./browser-replay.ts";
import { browserReplayView } from "./browser-replay-view.ts";
import type { WorkbenchAdapter, WorkbenchFrame } from "./workbench-protocol.ts";

type ReplayResult = {
  playbackUrl?: string;
  frameTotal: number;
  earlyEvictions: number;
  samples: { secondsAgo: number; data: string }[];
};

function fixture() {
  let now = 0;
  let current = true;
  let allowed = true;
  let stops = 0;
  let push: ((frame: WorkbenchFrame) => void) | undefined;
  const adapter = {
    tabs: async () => [{ id: "tab-a", title: "Fixture A", url: "http://example.test/a" }],
    select: async () => {},
    frame: async () => { throw new Error("No fallback frame"); },
    async stream(_options, onFrame) {
      push = onFrame;
      return async () => { stops++; };
    },
    dispose() {},
  } satisfies Pick<WorkbenchAdapter, "tabs" | "select" | "frame" | "stream" | "dispose">;
  const replay = new BrowserReplay(async () => ({ adapter, current: () => current }), () => "http://127.0.0.1:50400", () => now);
  const controller = new AbortController();
  const call = (action: string, options: Record<string, unknown> = {}, owner = controller.signal, profileId = "profile-a") =>
    replay.call(owner, profileId, { action, ...options }, () => allowed);
  const frame = (at: number, size = 12) => {
    now = at;
    const pixels = Buffer.alloc(size);
    pixels.set([0xff, 0xd8, (now / 1000) % 256]);
    push?.({ data: pixels.toString("base64"), width: 480, height: 360 });
  };
  const fetchFrame = (path: string, token?: string) => browserReplayView(
    new Request("http://127.0.0.1:50400" + path, { headers: token ? { Authorization: "Bearer " + token } : {} }),
    path, replay,
  );
  return { replay, call, frame, fetchFrame, controller, setNow: (value: number) => { now = value; },
    replaceLaunch: () => { current = false; }, revoke: () => { allowed = false; }, stops: () => stops };
}

test("replay selects a time range and the link inherits each frame's original expiration", async () => {
  const { replay, call, frame, fetchFrame, setNow } = fixture();
  try {
    expect(await call("tabs")).toEqual({ profileId: "profile-a", tabs: [{ tabId: "tab-a", title: "Fixture A", url: "http://example.test/a" }] });
    await expect(call("play")).rejects.toThrow("Start a replay");
    await call("start");
    for (const at of [0, 1000, 2000, 3000]) frame(at);
    const result = await call("play", { fromSecondsAgo: 3, toSecondsAgo: 1 }) as ReplayResult;
    expect(result.frameTotal).toBe(3);
    expect(result.samples.map(sample => sample.secondsAgo)).toEqual([3, 2, 1]);
    const token = new URL(result.playbackUrl!).hash.slice(1);
    const manifest = await fetchFrame("/ui/replay/frames", token).json() as { id: number; offsetMs: number }[];
    expect(manifest.map(item => item.offsetMs)).toEqual([0, 1000, 2000]);
    expect(fetchFrame("/ui/replay/frames/1").status).toBe(404);
    const jpeg = fetchFrame("/ui/replay/frames/1", token);
    expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
    expect(jpeg.headers.get("cache-control")).toBe("no-store");
    expect(fetchFrame("/ui/replay/frames/4", token).status).toBe(404);
    setNow(60_000);
    expect(fetchFrame("/ui/replay/frames/1", token).status).toBe(404);
    expect(fetchFrame("/ui/replay/frames/2", token).status).toBe(200);
    setNow(62_000);
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(404);
  } finally { replay.close(); }
});

test("replay bounds frame bytes, isolates MCP connections, and erases frames on disconnect", async () => {
  const { replay, call, frame, fetchFrame, controller } = fixture();
  try {
    await call("start");
    for (let i = 0; i < 49; i++) frame(i * 200, 512 * 1024);
    const result = await call("play") as ReplayResult;
    expect(result.frameTotal).toBe(48);
    expect(result.earlyEvictions).toBe(1);
    expect(result.samples).toHaveLength(1);
    const token = new URL(result.playbackUrl!).hash.slice(1);
    const other = new AbortController().signal;
    await expect(call("play", {}, other)).rejects.toThrow("Start a replay");
    await expect(call("start", {}, other)).rejects.toThrow("another MCP connection");
    await call("stop", {}, other);
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(200);
    controller.abort();
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(404);
    await call("start", {}, other);
    expect((await call("play", {}, other) as ReplayResult).frameTotal).toBe(0);
  } finally { replay.close(); }
});

test.each(["permissions", "launch", "stop"] as const)("a replay link is revoked after a change to %s", async (reason) => {
  const { replay, call, frame, fetchFrame, revoke, replaceLaunch } = fixture();
  try {
    await call("start");
    frame(0);
    const result = await call("play") as ReplayResult;
    const token = new URL(result.playbackUrl!).hash.slice(1);
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(200);
    if (reason === "permissions") revoke();
    else if (reason === "launch") replaceLaunch();
    else await call("stop");
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(404);
  } finally { replay.close(); }
});

test("the recording deadline releases capture while retained frames keep their 60-second expiry", async () => {
  const { replay, call, frame, fetchFrame, setNow, stops } = fixture();
  try {
    await expect(call("start", { durationSeconds: 0 })).rejects.toThrow("durationSeconds");
    await call("start", { durationSeconds: 1 });
    frame(0);
    await Bun.sleep(1100);
    expect(stops()).toBe(1);
    frame(1100);
    const result = await call("play") as ReplayResult;
    expect(result).toMatchObject({ active: false, frameTotal: 1 });
    const token = new URL(result.playbackUrl!).hash.slice(1);
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(200);
    setNow(60_000);
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(404);
  } finally { replay.close(); }
});

test("starting profiles concurrently cannot reserve more than four buffers", async () => {
  const { replay, call, controller } = fixture();
  try {
    const starts = [1, 2, 3, 4].map(id => call("start", {}, controller.signal, "profile-" + id));
    await expect(call("start", {}, controller.signal, "profile-5")).rejects.toThrow("four profiles");
    await Promise.all(starts);
    await call("stop", {}, controller.signal, "profile-1");
    expect(await call("start", {}, controller.signal, "profile-5")).toMatchObject({ active: true, profileId: "profile-5" });
  } finally { replay.close(); }
});

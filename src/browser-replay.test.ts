import { expect, test } from "bun:test";
import { BrowserReplay } from "./browser-replay.ts";
import { browserReplayView } from "./browser-replay-view.ts";
import type { WorkbenchAdapter, WorkbenchFrame } from "./workbench-protocol.ts";
import { ReplayNetworkObserver } from "./replay-network.ts";

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
  let network: ReplayNetworkObserver | undefined;
  const adapter = {
    tabs: async () => [{ id: "tab-a", title: "Fixture A", url: "http://example.test/a" }],
    select: async () => {},
    frame: async () => { throw new Error("No fallback frame"); },
    viewport: async () => ({ width: 1096, height: 810, devicePixelRatio: 1.5 }),
    async observeNetwork(emit) {
      const observer = network = new ReplayNetworkObserver("root", async () => ({}), emit);
      await observer.start();
      return () => observer.stop();
    },
    async stream(_options, onFrame) {
      push = onFrame;
      return async () => { stops++; };
    },
    dispose() {},
  } satisfies Pick<WorkbenchAdapter, "tabs" | "select" | "frame" | "stream" | "viewport" | "observeNetwork" | "dispose">;
  const replay = new BrowserReplay(async () => ({ adapter, generation: "generation-a", current: () => current }), () => "http://127.0.0.1:50400", () => now);
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
    receive: (at: number, sessionId: string, method: string, params: object) => { now = at; network?.receive({ method, sessionId, params }); },
    replaceLaunch: () => { current = false; }, revoke: () => { allowed = false; }, stops: () => stops };
}

test("diagnose pairs a failed step with its frames and worker redirects and expires all evidence on time", async () => {
  const { replay, call, frame, receive, setNow, fetchFrame } = fixture();
  try {
    const start = await call("start") as { captureEndsAt: string; nativeNetwork: boolean };
    expect(start.nativeNetwork).toBe(true);
    const origin = Date.parse(start.captureEndsAt) - 60_000;
    const at = (elapsed: number) => new Date(origin + elapsed).toISOString();
    frame(400);
    receive(600, "root", "Target.attachedToTarget", { sessionId: "worker", targetInfo: { type: "worker" } });
    const request = { requestId: "same", request: { url: "https://fixture.test/first?secret=1", method: "GET" }, timestamp: 1,
      initiator: { type: "script", stack: { callFrames: [{ url: "https://fixture.test/worker.js?secret=2", lineNumber: 2, columnNumber: 4 }] } } };
    receive(700, "worker", "Network.requestWillBeSent", request);
    receive(750, "other-tab", "Network.requestWillBeSent", { ...request, request: { url: "https://unrelated.test/", method: "GET" } });
    receive(800, "root", "Network.requestWillBeSent", { ...request, request: { url: "https://fixture.test/page", method: "GET" } });
    receive(900, "worker", "Network.requestWillBeSent", { ...request, timestamp: 1.2, redirectResponse: { status: 302 },
      request: { url: "https://fixture.test/second", method: "GET" } });
    receive(1100, "worker", "Network.responseReceived", { requestId: "same", response: { status: 503 } });
    receive(1200, "worker", "Network.loadingFinished", { requestId: "same", timestamp: 1.5 });
    frame(1800);
    const step = { profileId: "profile-a", tabId: "tab-a", generation: "generation-a", runId: "run-a", stepId: "fixture",
      sequence: 1, attempt: 1, phase: "run" as const, startedAt: at(500), endedAt: at(1850), receipt: {
        completed: false, error: "Failed to submit", events: { records: [{ kind: "console", type: "error", text: "Fixture error", timestamp: at(1650) }] },
        network: { records: [{ status: 503, url: "https://fixture.test/second?secret=3", finishedAt: at(1200), timing: { responseEnd: 300 } }] },
      } };
    setNow(1900);
    replay.noteTaskStep({ ...step, runId: "other-run", generation: "old-generation" });
    replay.noteTaskStep(step);
    const args = { runId: "run-a", tabId: "tab-a" };
    const result = await call("diagnose", args) as ReplayResult & { requests: any[]; events: any[]; step: any; focusOffsetMs: number };
    expect(result.step).toMatchObject({ stepId: "fixture", sequence: 1, completed: false });
    expect(result.focusOffsetMs).toBe(1400);
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0]).toMatchObject({ status: 302, redirectedTo: 3, origin: { target: "worker",
      location: { url: "https://fixture.test/worker.js", line: 3, column: 5 } } });
    expect(result.requests[2]).toMatchObject({ status: 503, redirectedFrom: 1, durationMs: 300 });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: "console", message: "Fixture error" }));
    expect(JSON.stringify(result)).not.toContain("secret=");
    expect(await call("diagnose", { ...args, runId: "other-run" })).not.toHaveProperty("step");
    await expect(call("diagnose", args, new AbortController().signal)).rejects.toThrow("Start a replay");
    const token = new URL(result.playbackUrl!).hash.slice(1);
    expect(await fetchFrame("/ui/replay/frames", token).json()).toContainEqual(expect.objectContaining({ focus: true, viewport: { width: 1096, height: 810, devicePixelRatio: 1.5 } }));
    setNow(61_700);
    const remaining = await call("diagnose", { ...args, frameCount: 0 });
    expect(remaining).toMatchObject({ requests: [], events: [expect.objectContaining({ kind: "step-error" })] });
    setNow(62_000);
    expect(await call("diagnose", args)).not.toHaveProperty("step");
    expect(fetchFrame("/ui/replay/frames", token).status).toBe(404);
  } finally { replay.close(); }
});

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

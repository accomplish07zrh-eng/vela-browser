import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AndroidDevices, androidControls } from "./android.ts";
import { BrowserTaskSupervisor } from "./browser-tasks.ts";
import { buildNewProfile } from "./create.ts";
import { KernelUpgrades } from "./kernel-upgrades.ts";
import type { Launcher } from "./launcher.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { compareNetworkIdentity } from "./network-identity.ts";
import { openPortableProfile, PortableProfiles, sealPortableProfile } from "./portable-profiles.ts";
import { ProfileWrites } from "./profile-writes.ts";
import { ProfileStore } from "./store.ts";
import { TaskRunner, TaskStore } from "./tasks.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, "vela-production-test-"));
  try { await run(root); }
  finally {
    if (dirname(realpathSync(root)) === parent) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("profile writes are FIFO, cancellable while waiting, and parallel across profiles", async () => {
  const writes = new ProfileWrites(), first = await writes.acquire("same"), events: string[] = [];
  const abort = new AbortController();
  const second = writes.run("same", async () => { events.push("second"); }, abort.signal).catch(error => error.name);
  const third = writes.run("same", async () => { events.push("third"); });
  await writes.run("different", async () => { events.push("different"); });
  expect(events).toEqual(["different"]);
  abort.abort();
  expect(await second).toBe("AbortError");
  expect(writes.tryAcquire("same")).toBeUndefined();
  first.release();
  await third;
  expect(events).toEqual(["different", "third"]);
  expect(writes.busy("same")).toBe(false);
});

test("kernel rollback restores the previous native directory, even after a failed candidate", async () => fixture(async root => {
  const store = new ProfileStore(join(root, "test.sqlite"));
  const initial = buildNewProfile({ name: "Kernel fixture", chromiumRuntime: "aliasmode" }, () => false);
  store.upsertProfile(initial);
  const native = join(root, "native", initial.id);
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "checkpoint"), "original");
  const earlier = "155.0.8059.85-aliasmode.4";
  let fails = true;
  const launcher = {
    kernelRevisions: () => [earlier], prepareKernel: async () => {}, userDataDir: () => native,
    stopForStateTransfer: async () => true, cacheCleanupSettled: async () => {}, certifiedActive: async () => true,
    start: async () => {
      writeFileSync(join(native, "checkpoint"), "candidate");
      if (fails) throw new Error("candidate failed");
    },
  } as unknown as Launcher;
  const service = new KernelUpgrades({ root: join(root, "kernels"), launcher, store, writes: new ProfileWrites(), admission: new LifecycleAdmissionController() });
  try {
    await expect(service.upgrade(initial.id, earlier)).rejects.toThrow("candidate failed");
    expect(readFileSync(join(native, "checkpoint"), "utf8")).toBe("original");
    expect(store.getProfile(initial.id)?.kernelRevision).toBeUndefined();
    fails = false;
    await service.upgrade(initial.id, earlier);
    expect(store.getProfile(initial.id)?.kernelRevision).toBe(earlier);
    await service.rollback(initial.id);
    expect(readFileSync(join(native, "checkpoint"), "utf8")).toBe("original");
    expect(store.getProfile(initial.id)?.kernelRevision).toBeUndefined();
  } finally { store.close(); }
}));

test("portable profile handoff freezes the source and imports authenticated state exactly once", async () => fixture(async root => {
  const source = new ProfileStore(join(root, "source.sqlite")), destination = new ProfileStore(join(root, "destination.sqlite"));
  const profile = buildNewProfile({ name: "Portable fixture", chromiumRuntime: "aliasmode" }, () => false);
  source.upsertProfile(profile);
  function service(side: string, store: ProfileStore) {
    const base = join(root, side);
    const launcher = {
      userDataDir: (id: string) => join(base, id), stopForStateTransfer: async () => true, cacheCleanupSettled: async () => {},
      kernelRevisions: () => [],
    } as unknown as Launcher;
    return new PortableProfiles({ root: join(base, "sealed"), store, launcher, writes: new ProfileWrites(), admission: new LifecycleAdmissionController() });
  }
  const from = service("from", source), to = service("to", destination);
  const native = join(root, "from", profile.id, "Default");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "Bookmarks"), "private-fixture-data");
  const passphrase = randomBytes(32).toString("hex"), name = "fixture.vela-profile";
  try {
    const exported = await from.export(profile.id, name, passphrase, true);
    const packet = from.read(name);
    expect(packet.includes(Buffer.from("private-fixture-data"))).toBe(false);
    expect(source.profileHandoff(profile.id)).toBe(exported.digest);
    renameSync(exported.file, exported.file + ".pending");
    expect(await from.export(profile.id, name, passphrase, true)).toEqual(exported);
    await expect(openPortableProfile(packet, "incorrect passphrase")).rejects.toThrow("could not be decrypted");
    const forged = await sealPortableProfile({
      profile, platform: process.platform, arch: process.arch,
      files: [{ path: "Default/IndexedDB/../../outside", data: "aGVsbG8=" }],
    }, passphrase);
    await expect(to.restore(forged, passphrase, () => {})).rejects.toThrow("Invalid path");
    expect((await to.restore(packet, passphrase, () => {})).imported).toBe(true);
    expect((await to.restore(packet, passphrase, () => {})).imported).toBe(false);
    expect(readFileSync(join(root, "to", profile.id, "Default", "Bookmarks"), "utf8")).toBe("private-fixture-data");
  } finally { source.close(); destination.close(); }
}));

test("a schedule dispatches a site skill through the durable task service and can be read after service restart", async () => fixture(async root => {
  const service = new BrowserTaskSupervisor({
    root: join(root, "browser"), authorize() {},
    async open() {
      return { async bindTab() { return { id: "tab", generation: "generation" }; },
        async program(input) { return { completed: true, value: input.argument }; }, async close() {} };
    },
  });
  const original = service.start("source", "agent", { startUrl: "https://example.test", steps: [{ id: "read", run: "read", readOnly: true }] });
  const deadline = Date.now() + 1500;
  while (service.status(original.runId).state !== "completed" && Date.now() < deadline) await Bun.sleep(10);
  const skill = service.saveSkill(original.runId, "agent", {});
  const taskFile = new TaskStore(join(root, "schedules.json"));
  const options = { store: taskFile, browserTasks: service, resolveProfiles: () => ["destination"], scriptName: async () => "",
    runner: { start() { throw new Error("A site skill must use the browser task supervisor"); }, async settled() {}, status() { return null; } } };
  try {
    const schedule = new TaskRunner(options);
    const definition = schedule.save({ name: "Nightly", target: { profileIds: ["destination"] },
      schedule: { kind: "manual" }, skill: { id: skill.id, inputs: { proof: true } } }, "agent");
    const run = await schedule.run(definition.id, "manual", "agent");
    expect(run.browser?.runs[0]?.runId).toBeString();
    expect(schedule.list("other").tasks).toEqual([]);
    const restored = new TaskRunner(options);
    const stepDeadline = Date.now() + 1500;
    while (restored.list("agent").history[0]?.outcome === "running" && Date.now() < stepDeadline) {
      await Bun.sleep(10);
      await restored.tick();
    }
    expect(restored.list("agent").history[0]?.outcome).toBe("succeeded");
    expect(service.list(() => true).tasks.length).toBe(2);
  } finally { await service.shutdown(); }
}));

test("network drift compares canonical IPv6 and reports a stale browser timezone and WebRTC address", () => {
  const measured = { egress: { ip: "2001:4860::1", timezone: "Asia/Taipei" }, login: null,
    fingerprint: { timezone: "UTC" }, webrtcIps: ["2001:4860::2"] } as Parameters<typeof compareNetworkIdentity>[0];
  expect(compareNetworkIdentity(measured, { ip: "2001:4860:0000:0000:0000:0000:0000:0001" }, true, false).differences)
    .toEqual(["timezone", "webrtc"]);
});

test("ADB control filters devices, removes the UI snapshot, and sends app input through the selected serial", async () => {
  const calls: string[][] = [];
  const xml = '<hierarchy><node text="private" password="true" class="android.widget.EditText" enabled="true" bounds="[1,3][21,43]"/></hierarchy>';
  const android = new AndroidDevices(new ProfileWrites(), "adb", new Set(["device-1"]), async args => {
    calls.push(args);
    if (args[0] === "devices") return Buffer.from("List of devices attached\ndevice-1 device model:Fixture\nother device model:Excluded");
    if (args.includes("cat")) return Buffer.from(xml);
    return Buffer.alloc(0);
  });
  expect(await android.call({ action: "devices" })).toEqual({ devices: [{ serial: "device-1", state: "device", model: "Fixture" }] });
  expect(androidControls(xml)[0]).toMatchObject({ text: "", x: 11, y: 23, editable: true });
  await android.call({ action: "observe", serial: "device-1" });
  expect(calls.find(args => args.includes("dump"))?.at(-1)).toBe(calls.find(args => args.includes("rm"))?.at(-1));
  await android.call({ action: "tap", serial: "device-1", x: 11, y: 23 });
  expect(calls.at(-1)).toEqual(["-s", "device-1", "shell", "input", "tap", "11", "23"]);
  await expect(android.call({ action: "tap", serial: "other", x: 0, y: 0 })).rejects.toThrow("authorized");
});

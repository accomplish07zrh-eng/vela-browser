import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntimeClient,
  RUNTIME_PROTOCOL,
  defaultRuntimeDescriptorPath,
  discoverRuntime,
  validateRuntimeDescriptor,
  windowsProcessIdentityCommand,
} from "./runtime-client.mjs";

const CURRENT_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function descriptor() {
  return {
    protocol: RUNTIME_PROTOCOL,
    appVersion: CURRENT_VERSION,
    generation: "a".repeat(64),
    nonce: "b".repeat(64),
    port: 50400,
    desktopPid: 11,
    desktopStartedAt: "123456",
    sidecarPid: 12,
    readiness: "local",
    createdAt: 1_700_000_000,
  };
}

test("runtime descriptor validation binds protocol, version, process, and nonce", () => {
  expect(validateRuntimeDescriptor(descriptor())).toEqual(descriptor());
  expect(() => validateRuntimeDescriptor({ ...descriptor(), appVersion: "other" }))
    .toThrow("did not match");
  expect(() => validateRuntimeDescriptor({ ...descriptor(), nonce: "public" }))
    .toThrow("did not match");
  for (const readiness of ["starting", "cloud_authenticated", "sign_in_required"]) {
    expect(() => validateRuntimeDescriptor({ ...descriptor(), readiness }))
      .toThrow("did not match");
  }
  expect(() => validateRuntimeDescriptor({ ...descriptor(), desktopStartedAt: "" }))
    .toThrow("did not match");
});

test("invalid agent responses terminate their WebSocket", () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    terminated = 0;
    terminate() { this.terminated++; this.readyState = 3; }
    close() { this.readyState = 2; }
    send() {}
  }
  const socket = new FakeSocket();
  const client = new AgentRuntimeClient(socket as any);
  socket.emit("message", Buffer.from("not-json"));
  expect(socket.terminated).toBe(1);
  client.close();
  expect(socket.readyState).toBe(3);
});

test("Windows process identity does not depend on PowerShell modules or PATH", () => {
  expect(windowsProcessIdentityCommand(123, { SYSTEMROOT: "C:\\Windows" } as any)).toEqual({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Diagnostics.Process]::GetProcessById(123).StartTime.ToFileTimeUtc()",
    ],
  });
});

test("runtime descriptor path uses the Tauri application data directory", () => {
  expect(defaultRuntimeDescriptorPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" } as any, "win32"))
    .toBe(join("C:\\Users\\me\\AppData\\Roaming", "com.velabrowser.desktop", "agent-runtime.json"));
  expect(defaultRuntimeDescriptorPath({ HOME: "/Users/me" } as any, "darwin"))
    .toBe("/Users/me/Library/Application Support/com.velabrowser.desktop/agent-runtime.json");
  // Linux follows Tauri's data folder: XDG_DATA_HOME when it is absolute, else ~/.local/share.
  // Linux paths use "/" whatever system runs the code.
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me" } as any, "linux"))
    .toBe("/home/me/.local/share/com.velabrowser.desktop/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me", XDG_DATA_HOME: "/data/me" } as any, "linux"))
    .toBe("/data/me/com.velabrowser.desktop/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({ HOME: "/home/me", XDG_DATA_HOME: "relative" } as any, "linux"))
    .toBe("/home/me/.local/share/com.velabrowser.desktop/agent-runtime.json");
  expect(defaultRuntimeDescriptorPath({
    ALIASMODE_RUNTIME_DESCRIPTOR: "C:\\fixture\\runtime.json",
  } as any)).toBe("C:\\fixture\\runtime.json");
});

test("the Bun helper authenticates and negotiates the local agent protocol over a real socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vela-local-agent-"));
  let client: AgentRuntimeClient | undefined;
  const runtime = { ...descriptor(), desktopPid: process.pid, sidecarPid: process.pid };
  if (process.platform === "win32") {
    const command = windowsProcessIdentityCommand(process.pid);
    runtime.desktopStartedAt = execFileSync(command.executable, command.args, { encoding: "utf8", windowsHide: true }).trim();
  } else if (process.platform === "darwin") {
    runtime.desktopStartedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" } }).trim();
  } else {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    runtime.desktopStartedAt = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]!;
  }
  let authenticated = false;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (new URL(request.url).pathname === "/ui/api/health") {
        return Response.json({ ok: true, version: runtime.appVersion, instance: runtime.generation });
      }
      authenticated = request.headers.get("authorization") === `Bearer ${runtime.nonce}`
        && request.headers.get("sec-websocket-protocol") === "aliasmode-agent-v1";
      if (!authenticated) return new Response("Agent handshake rejected", { status: 426 });
      if (server.upgrade(request)) return;
      return new Response("Upgrade failed", { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const request = JSON.parse(String(data));
        socket.send(JSON.stringify({ protocol: "aliasmode-agent-v1", id: request.id, ok: true, result: { profiles: [{ id: "local-profile" }] } }));
      },
    },
  });
  try {
    runtime.port = server.port!;
    const path = join(directory, "agent-runtime.json");
    writeFileSync(path, JSON.stringify(runtime));
    ({ client } = await discoverRuntime({ descriptorPath: path, version: runtime.appVersion, desktopExecutable: join(directory, "must-not-launch.exe"), waitMs: 2000 }));
    expect(await client.call("profiles.list")).toEqual({ profiles: [{ id: "local-profile" }] });
    expect(authenticated).toBe(true);
  } finally {
    client?.close();
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

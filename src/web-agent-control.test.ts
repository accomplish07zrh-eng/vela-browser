import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
} from "./agent-control.ts";
import { AGENT_CREDENTIALS_PATH } from "./agent-credentials.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ensureStateDirectories, statePaths } from "./paths.ts";
import { ProfileStore } from "./store.ts";
import { serveDashboard } from "./web.ts";

function openSocket(url: string, nonce: string, token?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, AGENT_CONTROL_PROTOCOL, {
    headers: { Authorization: `Bearer ${nonce}`, ...(token ? { "X-Vela-Agent-Token": token } : {}) },
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function callAgent(socket: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = new Promise((resolve) => {
    socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8"))));
  });
  socket.send(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: 9, method, params }));
  return response;
}

test("agent WebSocket requires its separate nonce and serves protocol requests", async () => {
  const nonce = "a".repeat(64);
  const store = new ProfileStore(":memory:");
  const launcher = {
    reconcileOrphans: async () => {},
  };
  const server = serveDashboard({
    launcher: launcher as any,
    store,
    port: 0,
    agentNonce: nonce,
    lifecycleAdmission: new LifecycleAdmissionController(),
    log: () => {},
  });
  const endpoint = `http://127.0.0.1:${server.port}${AGENT_CONTROL_PATH}`;

  try {
    const missing = await fetch(endpoint, {
      headers: { "sec-websocket-protocol": AGENT_CONTROL_PROTOCOL },
    });
    expect(missing.status).toBe(401);

    const socket = await openSocket(endpoint.replace("http:", "ws:"), nonce);
    expect(await callAgent(socket, "profiles.list")).toEqual({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 9,
      ok: true,
      result: { profiles: [] },
    });
    socket.close();
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("desktop owner issues, rotates and revokes MCP credentials across real loopback connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "vela-credential-admin-test-"));
  const paths = statePaths(root);
  ensureStateDirectories(paths);
  const agentNonce = "a".repeat(64), desktopAdminNonce = "b".repeat(64);
  const store = new ProfileStore(":memory:");
  const server = serveDashboard({
    launcher: { reconcileOrphans: async () => {} } as any,
    store, paths, agentNonce, desktopAdminNonce, port: 0,
    lifecycleAdmission: new LifecycleAdmissionController(), log: () => {},
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const endpoint = `${origin}${AGENT_CREDENTIALS_PATH}`;
  const ws = origin.replace("http:", "ws:") + AGENT_CONTROL_PATH;
  const agentHeaders = { Authorization: `Bearer ${agentNonce}`, "Sec-WebSocket-Protocol": AGENT_CONTROL_PROTOCOL };
  const ownerHeaders = { Authorization: `Bearer ${desktopAdminNonce}`, "Content-Type": "application/json" };
  const change = (body: unknown) => fetch(endpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify(body) });
  const sockets: WebSocket[] = [];
  const connect = async (token?: string) => {
    const socket = await openSocket(ws, agentNonce, token);
    sockets.push(socket);
    return socket;
  };
  try {
    expect((await fetch(endpoint, { headers: agentHeaders })).status).toBe(401);
    expect((await fetch(endpoint, { headers: { ...ownerHeaders, Origin: "https://other.example" } })).status).toBe(403);
    const legacy = await connect();
    const issue = await change({ action: "issue", name: "Release Agent" });
    expect(issue.status).toBe(200);
    expect(issue.headers.get("cache-control")).toContain("no-store");
    const minted = await issue.json() as { issued: { name: string; token: string } };
    const name = minted.issued.name;
    const firstToken = minted.issued.token;
    expect(name).toBe("release agent");
    expect(firstToken).toHaveLength(43);
    expect((await change({ action: "issue", name })).status).toBe(409);
    expect(await (await fetch(endpoint, { headers: ownerHeaders })).json()).toEqual({
      ok: true, requireCredentials: false, credentials: [{ name, revoked: false }],
    });
    expect(readFileSync(join(root, "agent-credentials.json"), "utf8")).not.toContain(firstToken);

    const first = await connect(firstToken);
    expect(await callAgent(first, "session.identify", { name: "another" })).toMatchObject({ ok: true, result: { agent: name } });
    expect((await change({ action: "policy", required: true })).status).toBe(200);
    expect((await fetch(`${origin}${AGENT_CONTROL_PATH}`, { headers: agentHeaders })).status).toBe(401);
    expect(await callAgent(legacy, "profiles.list")).toMatchObject({ ok: false });

    const rotated = await (await change({ action: "rotate", name })).json() as { issued: { name: string; token: string } };
    expect(rotated.issued.name).toBe(name);
    expect(rotated.issued.token).not.toBe(firstToken);
    expect(await callAgent(first, "profiles.list")).toMatchObject({ ok: false });
    const replacement = await connect(rotated.issued.token);
    expect(await callAgent(replacement, "profiles.list")).toMatchObject({ ok: true });
    expect((await change({ action: "revoke", name })).status).toBe(200);
    expect(await callAgent(replacement, "profiles.list")).toMatchObject({ ok: false });
    expect((await change({ action: "policy", required: false })).status).toBe(200);
    const other = await connect();
    expect(await callAgent(other, "session.identify", { name })).toMatchObject({ ok: false, error: { code: "not_permitted" } });
  } finally {
    for (const socket of sockets) socket.close();
    await server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

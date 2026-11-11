import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  PLAYWRIGHT_MAX_MESSAGE_BYTES,
  PLAYWRIGHT_PROTOCOL_VERSION,
  playwrightWorkerEnvironment,
  resolvePlaywrightRuntime,
} from "./playwright-runtime.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ContextOwner {
  endpoint: string;
  token: string;
  pid: number;
  browserPid: number;
  generation: string;
  binaryPath?: string;
}

export interface ContextReservation {
  endpoint: string;
  token: string;
  generation: string;
}

export interface StartContextOwnerInput {
  profileId: string;
  executablePath: string;
  executableSha256: string;
  userDataDir: string;
  sessionGeneration?: string;
  config: Record<string, JsonValue>;
  /** Preferences the engine applies at startup (CAMOU_PREFS_n). */
  prefs?: Record<string, JsonValue>;
  proxy?: { server: string; username?: string; password?: string; bypass?: string };
  headless?: boolean;
  args?: string[];
  timeoutMs?: number;
}

export interface ContextOwnerCallbacks {
  reservation?: ContextReservation;
  onSpawn?: (owner: ContextOwner) => void | Promise<void>;
  onReady?: (owner: ContextOwner) => void | Promise<void>;
}

export interface ContextOwnerErrorDetails {
  operation?: string;
  outcome?: string;
}

export class ContextOwnerError extends Error {
  constructor(
    readonly code: "invalid_request" | "invalid_response" | "operation_failed" | "runtime_unavailable" | "timeout",
    message: string,
    readonly details?: ContextOwnerErrorDetails,
  ) {
    super(message);
    this.name = "ContextOwnerError";
  }
}

export function createContextOwnerRuntime(engine: "firefox" | "webkit", ErrorType: typeof ContextOwnerError = ContextOwnerError) {
  const label = engine === "firefox" ? "Firefox" : "WebKit";
const owners = new Map<string, ContextOwner>();

function endpointUrl(endpoint: string): URL {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new ErrorType("invalid_request", `${label} owner endpoint is invalid`); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/"
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ErrorType("invalid_request", `${label} owner endpoint is invalid`);
  }
  return parsed;
}

function endpointKey(endpoint: string, generation: string): string {
  const parsed = endpointUrl(endpoint);
  return `${engine}://127.0.0.1:${parsed.port}/${encodeURIComponent(generation)}`;
}

function responseError(code: string, message: string, details?: ContextOwnerErrorDetails): ContextOwnerError {
  const valid = ["invalid_request", "invalid_response", "operation_failed", "runtime_unavailable", "timeout"] as const;
  return new ErrorType(valid.includes(code as typeof valid[number]) ? code as typeof valid[number] : "operation_failed", message, details);
}

function requestSignal(options: { signal?: AbortSignal; timeoutMs?: number }) {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new ErrorType("invalid_request", `${label} owner timeout is invalid`);
  }
  if (!options.signal && options.timeoutMs === undefined) return { signal: undefined, dispose() {}, timedOut: () => false };
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    },
    timedOut: () => timedOut,
  };
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PLAYWRIGHT_MAX_MESSAGE_BYTES) throw new ErrorType("invalid_response", `${label} owner response exceeded its limit`);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) {
    throw new ErrorType("runtime_unavailable", `${label} owner port is unavailable`);
  }
  return address.port;
}

async function reserveContextOwner(): Promise<ContextReservation> {
  const port = await freeLoopbackPort();
  return {
    endpoint: `http://127.0.0.1:${port}/`,
    token: randomBytes(32).toString("hex"),
    generation: randomBytes(16).toString("hex"),
  };
}

function contextOwnerReady(response: unknown): ContextOwner {
  const value: any = response;
  if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION) {
    throw new ErrorType("invalid_response", `${label} owner readiness is invalid`);
  }
  if (value.ok === false) {
    throw responseError(value.error?.code, `${label} owner failed before ready`);
  }
  if (value.ok !== true
    || typeof value.result?.endpoint !== "string" || typeof value.result?.generation !== "string"
    || !Number.isSafeInteger(value.result?.pid) || value.result.pid <= 0
    || !Number.isSafeInteger(value.result?.browserPid) || value.result.browserPid <= 0) {
    throw new ErrorType("invalid_response", `${label} owner readiness is invalid`);
  }
  return value.result;
}

function readReady(child: ChildProcess, timeoutMs?: number): Promise<ContextOwner> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      try { child.kill(); } catch {}
      fail(new ErrorType("timeout", `${label} owner readiness timed out`));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const succeed = (owner: ContextOwner) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(owner);
    };
    child.once("error", () => fail(new ErrorType("runtime_unavailable", `${label} owner could not start`)));
    child.once("close", () => fail(new ErrorType("runtime_unavailable", `${label} owner stopped before ready`)));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
        fail(new ErrorType("invalid_response", `${label} owner readiness exceeded its limit`));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      let response: any;
      try { response = JSON.parse(output.slice(0, newline)); } catch { fail(new ErrorType("invalid_response", `${label} owner readiness is invalid`)); return; }
      try { succeed(contextOwnerReady(response)); }
      catch (error) { fail(error instanceof Error ? error : new ErrorType("invalid_response", `${label} owner readiness is invalid`)); }
    });
  });
}

async function startContextOwner(
  input: StartContextOwnerInput,
  callbacks: ContextOwnerCallbacks = {},
): Promise<ContextOwner> {
  if (!input || typeof input.profileId !== "string" || !input.profileId
    || typeof input.executablePath !== "string" || !input.executablePath
    || typeof input.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.executableSha256)
    || typeof input.userDataDir !== "string" || !input.userDataDir
    || !input.config || typeof input.config !== "object" || Array.isArray(input.config)
    || (input.prefs !== undefined && (!input.prefs || typeof input.prefs !== "object" || Array.isArray(input.prefs)))
    || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1))) {
    throw new ErrorType("invalid_request", `${label} owner input is invalid`);
  }
  try { JSON.stringify([input.config, input.prefs]); } catch { throw new ErrorType("invalid_request", `${label} owner input is invalid`); }
  if (await sha256File(input.executablePath) !== input.executableSha256) {
    throw new ErrorType("operation_failed", `${label} executable changed before launch`);
  }
  const reservation = callbacks.reservation ?? await reserveContextOwner();
  endpointUrl(reservation.endpoint);
  if (typeof reservation.token !== "string" || !reservation.token || typeof reservation.generation !== "string" || !reservation.generation) {
    throw new ErrorType("invalid_request", `${label} owner reservation is invalid`);
  }
  const runtime = resolvePlaywrightRuntime();
  if (engine === "webkit") {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(runtime.root, "node_modules", "playwright-webkit-core", "package.json"), "utf8")); } catch {}
    if (manifest?.name !== "playwright-core" || manifest?.version !== "1.65.0") throw new ErrorType("runtime_unavailable", "WebKit requires its pinned Playwright 1.65.0 runtime");
  }
  const workerPath = runtime.kind === "source"
    ? join(import.meta.dir, `${engine}-worker.mjs`)
    : join(runtime.root, `${engine}-worker.mjs`);
  let child: ChildProcess;
  try {
    child = spawn(runtime.nodeExecutable, [workerPath, `--aliasmode-${engine}-owner=${reservation.generation}`], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: playwrightWorkerEnvironment(),
    });
  } catch {
    throw new ErrorType("runtime_unavailable", `${label} owner could not start`);
  }
  if (!child.pid || !child.stdin) {
    child.kill();
    throw new ErrorType("runtime_unavailable", `${label} owner could not start`);
  }
  const provisional: ContextOwner = {
    endpoint: reservation.endpoint,
    token: reservation.token,
    generation: reservation.generation,
    pid: child.pid,
    browserPid: 0,
    binaryPath: child.spawnfile,
  };
  try {
    await callbacks.onSpawn?.(provisional);
  } catch {
    child.kill();
    throw new ErrorType("operation_failed", `${label} owner reservation was not saved`);
  }
  const ready = readReady(child, input.timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify({ version: PLAYWRIGHT_PROTOCOL_VERSION, ...input, owner: reservation }));
  let owner: ContextOwner;
  try {
    const result = await ready;
    if (result.endpoint !== reservation.endpoint || result.generation !== reservation.generation || result.pid !== child.pid) {
      throw new ErrorType("invalid_response", `${label} owner readiness is invalid`);
    }
    owner = { ...provisional, browserPid: result.browserPid };
    contextEndpoint(owner);
    await callbacks.onReady?.(owner);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
  (child.stdout as any)?.unref?.();
  return owner;
}

function contextEndpoint(owner: ContextOwner): string {
  const endpoint = endpointKey(owner.endpoint, owner.generation);
  owners.set(endpoint, owner);
  return endpoint;
}

function contextOwnerForEndpoint(endpoint: string): ContextOwner | undefined {
  return owners.get(endpoint);
}

function forgetContextOwner(owner: ContextOwner): void {
  owners.delete(endpointKey(owner.endpoint, owner.generation));
}

async function callContextOwner<T>(
  owner: ContextOwner,
  operation: string,
  payload: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (typeof operation !== "string" || !operation || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ErrorType("invalid_request", `${label} owner request is invalid`);
  }
  endpointUrl(owner.endpoint);
  const request = JSON.stringify({
    version: PLAYWRIGHT_PROTOCOL_VERSION,
    operation,
    payload: { ...(payload as Record<string, unknown>), ownerGeneration: owner.generation },
  });
  if (Buffer.byteLength(request) > PLAYWRIGHT_MAX_MESSAGE_BYTES) {
    throw new ErrorType("invalid_request", `${label} owner request exceeded its limit`);
  }
  const abort = requestSignal(options);
  let response: Response;
  try {
    response = await fetch(owner.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: request,
      signal: abort.signal,
      redirect: "error",
    });
    const body = await readResponse(response);
    let value: any;
    try { value = JSON.parse(body); } catch { throw new ErrorType("invalid_response", `${label} owner response is invalid`); }
    if (value?.version !== PLAYWRIGHT_PROTOCOL_VERSION || typeof value.ok !== "boolean") {
      throw new ErrorType("invalid_response", `${label} owner response is invalid`);
    }
    if (!value.ok) throw responseError(value.error?.code, value.error?.message || `${label} owner operation failed`, value.error?.details);
    if (!response.ok) throw new ErrorType("operation_failed", `${label} owner operation failed`);
    return value.result as T;
  } catch (error) {
    if (error instanceof ContextOwnerError) throw error;
    if (abort.timedOut()) throw new ErrorType("timeout", `${label} owner operation timed out`);
    throw new ErrorType("runtime_unavailable", `${label} owner is unavailable`);
  } finally { abort.dispose(); }
}

async function closeContextOwner(owner: ContextOwner, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  await callContextOwner(owner, "close", {}, options);
  forgetContextOwner(owner);
}

  return {
    reserve: reserveContextOwner, ready: contextOwnerReady, start: startContextOwner,
    endpoint: contextEndpoint, ownerForEndpoint: contextOwnerForEndpoint,
    forget: forgetContextOwner, call: callContextOwner, close: closeContextOwner,
  };
}

import { randomUUID } from "node:crypto";
import type { ProfileWrites } from "./profile-writes.ts";

type Adb = (args: string[], limit?: number) => Promise<Buffer>;

async function readOutput(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(parts, size);
      size += value.byteLength;
      if (size > limit) throw new Error("Android replied with too much data");
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
}

function adbCommand(executable: string): Adb {
  return async (args, limit = 1024 * 1024) => {
    const process = Bun.spawn([executable, ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(30_000),
    });
    try {
      const [stdout, status] = await Promise.all([readOutput(process.stdout, limit), process.exited]);
      if (status !== 0) throw new Error("ADB operation failed. Check the device connection and debugging permission.");
      return stdout;
    } catch (error) {
      process.kill();
      await process.exited.catch(() => {});
      throw error;
    }
  };
}

function coordinate(value: unknown, name: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 16384) {
    throw new Error("Invalid Android coordinate " + name);
  }
  return String(value);
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const token = entity.slice(1, -1);
    if (token[0] !== "#") return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[token] ?? entity;
    const code = token[1]?.toLowerCase() === "x" ? Number.parseInt(token.slice(2), 16) : Number(token.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

export function androidControls(xml: string) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]+)/g)) {
    const attributes = new Map(Array.from(match[1]!.matchAll(/([\w-]+)="([^"]*)"/g), ([, name, value]) => [name!, decodeXml(value!)] as const));
    if (attributes.get("visible-to-user") === "false") continue;
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attributes.get("bounds") ?? "");
    if (!bounds) continue;
    const [left, top, right, bottom] = bounds.slice(1).map(Number) as [number, number, number, number];
    if (left >= right || top >= bottom) continue;
    const clickable = attributes.get("clickable") === "true", editable = (attributes.get("class") ?? "").endsWith("EditText");
    const text = attributes.get("password") === "true" || editable ? "" : attributes.get("text") ?? "";
    const label = attributes.get("content-desc") ?? "";
    if (!clickable && !editable && !text && !label) continue;
    nodes.push({
      id: attributes.get("resource-id") ?? "", text: text.slice(0, 160), label: label.slice(0, 160),
      clickable, editable, enabled: attributes.get("enabled") === "true",
      bounds: { left, top, right, bottom }, x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2),
    });
    if (nodes.length === 150) break;
  }
  return nodes;
}

export class AndroidDevices {
  private readonly adb: Adb;
  constructor(private readonly writes: ProfileWrites, executable: string, private readonly allowed?: Set<string>, execute?: Adb) {
    this.adb = execute ?? adbCommand(executable);
  }

  async call(params: Record<string, unknown>, signal?: AbortSignal): Promise<object> {
    const action = params.action;
    if (action === "devices") return { devices: await this.devices() };
    const serial = params.serial;
    if (typeof serial !== "string" || !/^[\w.:[\]-]{1,128}$/.test(serial) || (this.allowed && !this.allowed.has(serial))) {
      throw new Error("Choose an authorized Android device serial");
    }
    return this.writes.run("android:" + serial, async () => {
      if (!(await this.devices()).some(device => device.serial === serial && device.state === "device")) {
        throw new Error("The selected Android device is offline or has not authorized ADB");
      }
      const run = (args: string[], limit?: number) => this.adb(["-s", serial, ...args], limit);
      if (action === "screenshot") {
        const png = await run(["exec-out", "screencap", "-p"], 4 * 1024 * 1024);
        if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("The Android device did not return a PNG");
        return { serial, mimeType: "image/png", data: png.toString("base64") };
      }
      if (action === "observe") {
        const file = "/data/local/tmp/vela-" + randomUUID() + ".xml";
        try {
          await run(["shell", "uiautomator", "dump", file]);
          const data = await run(["exec-out", "cat", file]);
          const xml = data.toString("utf8");
          if (!xml.includes("<hierarchy")) throw new Error("Android UI hierarchy is unavailable");
          return { serial, controls: androidControls(xml) };
        } finally { await run(["shell", "rm", "-f", file]).catch(() => {}); }
      }
      if (action === "launch") {
        const app = params.package;
        if (typeof app !== "string" || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(app)) throw new Error("Provide an Android package name");
        const answer = await run(["shell", "am", "start", "-W", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-p", app]);
        if (/Error:|Exception/i.test(answer.toString())) throw new Error("The Android app could not be opened");
      } else if (action === "tap" || action === "swipe") {
        const args = [coordinate(params.x, "x"), coordinate(params.y, "y")];
        if (action === "swipe") args.push(coordinate(params.toX, "toX"), coordinate(params.toY, "toY"), "320");
        await run(["shell", "input", action, ...args]);
      } else if (action === "key") {
        const keys = { back: "BACK", home: "HOME", enter: "ENTER", delete: "DEL", recent: "APP_SWITCH" };
        const key = typeof params.key === "string" && Object.hasOwn(keys, params.key) ? keys[params.key as keyof typeof keys] : undefined;
        if (!key) throw new Error("Choose a supported Android key");
        await run(["shell", "input", "keyevent", "KEYCODE_" + key]);
      } else if (action === "text") {
        const value = params.text;
        if (typeof value !== "string" || !value.length || value.length > 1024 || !/^[\x20-\x7e]+$/.test(value)) {
          throw new Error("ADB text requires 1 to 1024 printable ASCII characters");
        }
        const quoted = "'" + value.replaceAll("'", "'\\''").replaceAll(" ", "%s") + "'";
        await run(["shell", "input text " + quoted]);
      } else throw new Error("Unknown Android operation");
      return { serial, action, completed: true };
    }, signal);
  }

  private async devices() {
    const response = await this.adb(["devices", "-l"]);
    return response.toString("utf8").split(/\r?\n/).flatMap(line => {
      const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload)\b(.*)$/.exec(line);
      if (!match || (this.allowed && !this.allowed.has(match[1]!))) return [];
      return [{ serial: match[1]!, state: match[2]!, model: /\bmodel:(\S+)/.exec(match[3]!)?.[1] }];
    });
  }
}

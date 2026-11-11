/** Isolated QA manager. Its exit intentionally leaves the owned browser workers alive. */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";

const lines = createInterface({ input: process.stdin, terminal: false });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) throw new Error("missing QA configuration");
const input = JSON.parse(first.value);
const store = new ProfileStore(join(input.root, "profiles.sqlite"));
const launcher = new Launcher({ store, dataRoot: join(input.root, "profiles"), chromiumRuntimeRoot: join(input.root, "runtimes"), headless: input.headless, log: () => {} });
try {
  for (const { id, url } of input.profiles) await launcher.start(id, [url]);
  process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid })}\n`);
  const command = await iterator.next();
  if (!command.done && command.value !== "exit") throw new Error("invalid QA command");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  store.close();
  // Reproduce manager termination, including OS release of all proxy sockets.
  // The acceptance parent owns cleanup of the detached browser workers.
  process.exit(process.exitCode ?? 0);
}

import { expect, test } from "bun:test";
import { configureClients, type CommandRunner } from "./setup.ts";

test("setup uses each client's supported MCP registration command", async () => {
  const calls: Array<[string, string[]]> = [];
  const inputs: Array<[string, string[], string | undefined]> = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push([command, args]);
    inputs.push([command, args, input]);
    return { found: true, code: 0 };
  };
  const helper = "C:\\Program Files\\Vela Browser\\vela-browser-mcp.exe";
  const command = "C:\\Program Files\\Vela Browser\\playwright\\node\\node.exe";
  const host = "C:\\Program Files\\Vela Browser\\playwright\\agent\\mcp-host.mjs";
  const result = await configureClients({ helper, command, args: [host], run });

  expect(result.clients).toEqual([
    { client: "claude", status: "configured", restartRequired: true },
    { client: "codex", status: "configured", restartRequired: true },
    { client: "openclaw", status: "configured", restartRequired: true },
    { client: "hermes", status: "configured", restartRequired: true },
  ]);
  expect(calls).toContainEqual([
    "claude",
    ["mcp", "remove", "aliasmode", "--scope", "user"],
  ]);
  expect(calls).toContainEqual(["codex", ["mcp", "remove", "aliasmode"]]);
  expect(calls).toContainEqual(["openclaw", ["mcp", "unset", "aliasmode"]]);
  expect(calls).toContainEqual(["hermes", ["mcp", "remove", "aliasmode"]]);
  expect(calls).toContainEqual([
    "claude",
    ["mcp", "add", "--scope", "user", "vela-browser", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "codex",
    ["mcp", "add", "vela-browser", "--", command, host],
  ]);
  expect(calls).toContainEqual([
    "openclaw",
    ["mcp", "add", "vela-browser", "--command", command, "--arg", host],
  ]);
  expect(calls).toContainEqual([
    "hermes",
    ["mcp", "add", "vela-browser", "--command", command, "--args", host],
  ]);
  expect(inputs).toContainEqual([
    "hermes",
    ["mcp", "remove", "aliasmode"],
    "y\n",
  ]);
  expect(inputs).toContainEqual([
    "hermes",
    ["mcp", "add", "vela-browser", "--command", command, "--args", host],
    "y\n",
  ]);
  expect(inputs.filter(([client]) => client !== "hermes").every(([, , input]) => input === undefined)).toBe(true);
  expect(result.generic.mcpServers["vela-browser"]).toEqual({ command, args: [host] });
});

test("setup reports a detected client registration failure", async () => {
  const run: CommandRunner = async (_command, args) => ({
    found: true,
    code: args[1] === "add" ? 1 : 0,
  });
  const result = await configureClients({
    helper: "C:\\Vela Browser\\vela-browser-mcp.exe",
    clients: ["claude"],
    run,
  });
  expect(result.clients).toEqual([{
    client: "claude",
    status: "failed",
    restartRequired: false,
    reason: "registration_failed",
  }]);
});

test("setup is repeatable and reports clients that are not installed", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "codex") return { found: false, code: 1 };
    return { found: true, code: 0 };
  };
  const options = {
    helper: "C:\\Vela Browser\\vela-browser-mcp.exe",
    clients: ["claude", "codex"] as const,
    run,
  };

  const first = await configureClients({ ...options, clients: [...options.clients] });
  const firstCalls = [...calls];
  calls.length = 0;
  const second = await configureClients({ ...options, clients: [...options.clients] });

  expect(second).toEqual(first);
  expect(first.mcp).toEqual({ command: options.helper, args: ["serve"] });
  expect(calls).toEqual(firstCalls);
  expect(first.clients[1]).toEqual({
    client: "codex",
    status: "not_installed",
    restartRequired: false,
    reason: "command_not_found",
  });
  expect(calls.some((call) => call.startsWith("codex mcp add"))).toBe(false);
});

test("setup replaces the pre-0.1.7 aliasmode registration with vela-browser", async () => {
  const calls: Array<[string, string[]]> = [];
  const run: CommandRunner = async (command, args) => { calls.push([command, args]); return { found: true, code: 0 }; };
  await configureClients({ helper: "/opt/vela/vela-browser-mcp", clients: ["codex"], run });
  expect(calls.map(([, args]) => args.slice(0, 3).join(" "))).toEqual([
    "--version",
    "mcp remove aliasmode",
    "mcp remove vela-browser",
    "mcp add vela-browser",
  ]);
});

import spawn from "cross-spawn";

export type SetupClient = "claude" | "codex" | "openclaw" | "hermes";

export interface CommandResult {
  found: boolean;
  code: number;
}

export type CommandRunner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

/** The name the MCP server is registered under in each AI client. */
export const MCP_SERVER_NAME = "vela-browser";
/** The name earlier versions used. Setting up again removes it, so the client lists the server once. */
export const LEGACY_MCP_SERVER_NAMES = ["aliasmode"];

const CLIENTS: Record<SetupClient, {
  command: string;
  remove: (name: string) => string[];
  add: (name: string, command: string, args: string[]) => string[];
  input?: string;
}> = {
  claude: {
    command: "claude",
    remove: (name) => ["mcp", "remove", name, "--scope", "user"],
    add: (name, command, args) => ["mcp", "add", "--scope", "user", name, "--", command, ...args],
  },
  codex: {
    command: "codex",
    remove: (name) => ["mcp", "remove", name],
    add: (name, command, args) => ["mcp", "add", name, "--", command, ...args],
  },
  openclaw: {
    command: "openclaw",
    remove: (name) => ["mcp", "unset", name],
    add: (name, command, args) => [
      "mcp", "add", name, "--command", command,
      ...args.flatMap((arg) => ["--arg", arg]),
    ],
  },
  hermes: {
    command: "hermes",
    remove: (name) => ["mcp", "remove", name],
    add: (name, command, args) => ["mcp", "add", name, "--command", command, "--args", ...args],
    input: "y\n",
  },
};

export const defaultCommandRunner: CommandRunner = async (command, args, input) => {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false,
    });
    if (input !== undefined) child.stdin?.end(input);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ found: error.code !== "ENOENT", code: 1 });
    });
    child.once("exit", (code) => resolve({ found: true, code: code ?? 1 }));
  });
};

export async function configureClients(options: {
  helper: string;
  command?: string;
  args?: string[];
  clients?: SetupClient[];
  run?: CommandRunner;
}) {
  const run = options.run ?? defaultCommandRunner;
  const command = options.command ?? options.helper;
  const commandArgs = options.args ?? ["serve"];
  const clients = options.clients ?? (Object.keys(CLIENTS) as SetupClient[]);
  const statuses: Array<{
    client: SetupClient;
    status: "configured" | "not_installed" | "failed";
    restartRequired: boolean;
    reason?: "command_not_found" | "registration_failed";
  }> = [];

  for (const client of clients) {
    const config = CLIENTS[client];
    const detected = await run(config.command, ["--version"]);
    if (!detected.found) {
      statuses.push({
        client,
        status: "not_installed",
        restartRequired: false,
        reason: "command_not_found",
      });
      continue;
    }
    for (const name of [...LEGACY_MCP_SERVER_NAMES, MCP_SERVER_NAME]) await run(config.command, config.remove(name), config.input);
    const added = await run(config.command, config.add(MCP_SERVER_NAME, command, commandArgs), config.input);
    statuses.push({
      client,
      status: added.code === 0 ? "configured" : "failed",
      restartRequired: added.code === 0,
      ...(added.code === 0 ? {} : { reason: "registration_failed" as const }),
    });
  }

  return {
    helper: options.helper,
    mcp: { command, args: commandArgs },
    clients: statuses,
    generic: {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command,
          args: commandArgs,
        },
      },
    },
  };
}

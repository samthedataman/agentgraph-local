#!/usr/bin/env node

import { VERSION } from "./version.js";
import { writeError, writeLine } from "./util/output.js";

type LazyCommand = () => Promise<{ run: (args: string[], json: boolean) => Promise<number> }>;

const commands: Record<string, LazyCommand> = {
  daemon: () => import("./commands/daemon.js"),
  run: () => import("./commands/run.js"),
  codex: () => import("./commands/codex.js"),
  claude: () => import("./commands/claude.js"),
  ps: () => import("./commands/ps.js"),
  attach: () => import("./commands/attach.js"),
  hook: () => import("./commands/hook.js"),
  setup: () => import("./commands/setup.js"),
  init: () => import("./commands/setup.js"),
  doctor: () => import("./commands/doctor.js"),
  mcp: () => import("./commands/mcp.js"),
  memory: () => import("./commands/memory.js"),
  handoff: () => import("./commands/handoff.js"),
  delegate: () => import("./commands/delegate.js"),
  fleet: () => import("./commands/fleet.js"),
  remote: () => import("./commands/remote.js"),
  a2a: () => import("./commands/a2a.js")
};

function help(): void {
  writeLine(`AgentGraph ${VERSION}\n`);
  writeLine("Shared presence, memory, handoffs, and bounded fleets for coding agents.\n");
  writeLine("Usage: agentgraph <command> [options]\n");
  writeLine("Commands:");
  writeLine("  setup       Configure hooks, MCP, daemon, and optional transparent shims");
  writeLine("  doctor      Check the local installation");
  writeLine("  daemon      Run or manage the background daemon");
  writeLine("  codex       Run an ordinary Codex session with presence supervision");
  writeLine("  claude      Run an ordinary Claude session with presence supervision");
  writeLine("  run         Supervise an arbitrary agent process");
  writeLine("  ps          List live and recent agent sessions");
  writeLine("  attach      Attach presence tracking to an existing process");
  writeLine("  memory      Search or record shared memory");
  writeLine("  handoff     Create and manage agent handoffs");
  writeLine("  delegate    Run a managed Codex, Claude, or opted-in Kimi task");
  writeLine("  fleet       Validate or run a bounded cross-provider task DAG");
  writeLine("  remote      Run the opt-in remote team-memory hub or sync client");
  writeLine("  mcp         Start the stdio MCP server");
  writeLine("  a2a         Start the experimental local A2A façade");
  writeLine("  hook        Internal hook ingestion command");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const json = jsonIndex !== -1;
  if (json) args.splice(jsonIndex, 1);
  const name = args.shift();

  if (!name || name === "help" || name === "--help" || name === "-h") {
    help();
    return 0;
  }
  if (name === "--version" || name === "-V" || name === "version") {
    writeLine(VERSION);
    return 0;
  }

  const load = commands[name];
  if (!load) {
    writeError(`Unknown command: ${name}`);
    help();
    return 2;
  }
  const command = await load();
  return command.run(args, json);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    writeError(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

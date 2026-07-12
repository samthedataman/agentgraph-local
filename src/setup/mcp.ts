import type { HookProvider } from "../hooks/types.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getPaths } from "../config/paths.js";
import {
  findVendorExecutable,
  runCommand,
  type CommandResult,
  type CommandRunner
} from "./process.js";

export interface McpInstallOptions {
  provider: HookProvider;
  nodePath: string;
  cliPath: string;
  vendorPath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export interface McpCommandPlan {
  executable: string;
  args: string[];
  purpose: "inspect" | "remove" | "add";
}

export interface McpInstallResult {
  provider: HookProvider;
  installed: boolean;
  skipped: boolean;
  changed: boolean;
  reason?: string;
  commands: McpCommandPlan[];
  results: CommandResult[];
}

export interface McpUninstallOptions {
  provider: HookProvider;
  vendorPath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export interface McpUninstallResult {
  provider: HookProvider;
  removed: boolean;
  skipped: boolean;
  reason?: string;
  commands: McpCommandPlan[];
  results: CommandResult[];
}

interface McpOwnershipRecord {
  provider: HookProvider;
  executable: string;
  nodePath: string;
  cliPath: string;
  args: string[];
}

function ownershipPath(provider: HookProvider, env: NodeJS.ProcessEnv): string {
  return join(getPaths(env).homeDir, "integrations", `mcp-${provider}.json`);
}

async function readOwnership(provider: HookProvider, env: NodeJS.ProcessEnv): Promise<McpOwnershipRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(ownershipPath(provider, env), "utf8")) as McpOwnershipRecord;
    return parsed.provider === provider && Array.isArray(parsed.args) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeOwnership(record: McpOwnershipRecord, env: NodeJS.ProcessEnv): Promise<void> {
  const path = ownershipPath(record.provider, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function inspectionMatches(record: McpOwnershipRecord, result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes(record.nodePath)
    && output.includes(record.cliPath)
    && output.includes("mcp")
    && output.includes(record.provider);
}

export function mcpCommandPlans(
  provider: HookProvider,
  executable: string,
  nodePath: string,
  cliPath: string
): McpCommandPlan[] {
  if (provider === "codex") {
    return [
      { executable, args: ["mcp", "get", "agentgraph", "--json"], purpose: "inspect" },
      {
        executable,
        args: ["mcp", "add", "agentgraph", "--", nodePath, cliPath, "mcp", "--provider", provider],
        purpose: "add"
      }
    ];
  }
  return [
    { executable, args: ["mcp", "get", "agentgraph"], purpose: "inspect" },
    {
      executable,
      args: [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "agentgraph",
        "--",
        nodePath,
        cliPath,
        "mcp",
        "--provider",
        provider
      ],
      purpose: "add"
    }
  ];
}

export async function installMcpServer(options: McpInstallOptions): Promise<McpInstallResult> {
  const executable = options.vendorPath
    ?? await findVendorExecutable(options.provider, options.env ?? process.env);
  if (!executable) {
    return {
      provider: options.provider,
      installed: false,
      skipped: true,
      changed: false,
      reason: `${options.provider} executable was not found`,
      commands: [],
      results: []
    };
  }
  const plans = mcpCommandPlans(options.provider, executable, options.nodePath, options.cliPath);
  if (options.dryRun) {
    return {
      provider: options.provider,
      installed: false,
      skipped: false,
      changed: true,
      commands: plans,
      results: []
    };
  }

  const runner = options.runner ?? runCommand;
  const env = options.env ?? process.env;
  const inspect = await runner(executable, plans[0]?.args ?? [], {
    timeoutMs: 5_000,
    env
  });
  const results = [inspect];
  if (inspect.code === 0) {
    const ownership = await readOwnership(options.provider, env);
    if (!ownership || !inspectionMatches(ownership, inspect)) {
      return {
        provider: options.provider,
        installed: false,
        skipped: true,
        changed: false,
        reason: "An MCP entry named agentgraph already exists but is not verified as AgentGraph-owned",
        commands: plans,
        results
      };
    }
    return {
      provider: options.provider,
      installed: true,
      skipped: false,
      changed: false,
      commands: plans,
      results
    };
  }
  const addition = plans[1];
  if (!addition) throw new Error("Internal error: missing MCP add plan");
  const added = await runner(executable, addition.args, {
    timeoutMs: 10_000,
    env
  });
  results.push(added);
  if (added.code === 0) {
    await writeOwnership({
      provider: options.provider,
      executable,
      nodePath: options.nodePath,
      cliPath: options.cliPath,
      args: addition.args
    }, env);
  }
  return {
    provider: options.provider,
    installed: added.code === 0,
    skipped: false,
    changed: added.code === 0,
    ...(added.code === 0 ? {} : { reason: added.stderr.trim() || added.stdout.trim() || "MCP add failed" }),
    commands: plans,
    results
  };
}

export async function uninstallMcpServer(options: McpUninstallOptions): Promise<McpUninstallResult> {
  const executable = options.vendorPath
    ?? await findVendorExecutable(options.provider, options.env ?? process.env);
  if (!executable) {
    return {
      provider: options.provider,
      removed: false,
      skipped: true,
      reason: `${options.provider} executable was not found`,
      commands: [],
      results: []
    };
  }
  const inspect: McpCommandPlan = {
    executable,
    args: options.provider === "codex"
      ? ["mcp", "get", "agentgraph", "--json"]
      : ["mcp", "get", "agentgraph"],
    purpose: "inspect"
  };
  const remove: McpCommandPlan = {
    executable,
    args: options.provider === "codex"
      ? ["mcp", "remove", "agentgraph"]
      : ["mcp", "remove", "agentgraph", "--scope", "user"],
    purpose: "remove"
  };
  const commands = [inspect, remove];
  if (options.dryRun) {
    return { provider: options.provider, removed: false, skipped: false, commands, results: [] };
  }
  const runner = options.runner ?? runCommand;
  const env = options.env ?? process.env;
  const ownership = await readOwnership(options.provider, env);
  if (!ownership) {
    return {
      provider: options.provider,
      removed: false,
      skipped: true,
      reason: "No AgentGraph ownership record exists; preserving the named MCP entry",
      commands,
      results: []
    };
  }
  const inspected = await runner(executable, inspect.args, {
    timeoutMs: 5_000,
    env
  });
  if (inspected.code !== 0) {
    return {
      provider: options.provider,
      removed: false,
      skipped: false,
      reason: "AgentGraph MCP entry was not present",
      commands,
      results: [inspected]
    };
  }
  if (!inspectionMatches(ownership, inspected)) {
    return {
      provider: options.provider,
      removed: false,
      skipped: true,
      reason: "The current MCP entry no longer matches AgentGraph's installed definition; preserving it",
      commands,
      results: [inspected]
    };
  }
  const removed = await runner(executable, remove.args, {
    timeoutMs: 5_000,
    env
  });
  if (removed.code === 0) await rm(ownershipPath(options.provider, env), { force: true });
  return {
    provider: options.provider,
    removed: removed.code === 0,
    skipped: false,
    ...(removed.code === 0
      ? {}
      : { reason: removed.stderr.trim() || removed.stdout.trim() || "MCP removal failed" }),
    commands,
    results: [inspected, removed]
  };
}

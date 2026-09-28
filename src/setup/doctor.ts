import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { rpc } from "../ipc/client.js";
import type { HookProvider } from "../hooks/types.js";
import { defaultHookConfigPath, countInstalledAgentGraphHooks, CODEX_HOOK_EVENTS, CLAUDE_HOOK_EVENTS } from "./hooks.js";
import { launchAgentPath, LAUNCHD_LABEL } from "./launchd.js";
import { findVendorExecutable, runCommand, type CommandRunner } from "./process.js";
import { defaultShimDirectory, isUsableTransparentShim } from "./shims.js";
import { readJsonObject } from "./files.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  requireTransparent?: boolean;
  runner?: CommandRunner;
  health?: () => Promise<unknown>;
}

function providerEvents(provider: HookProvider): readonly string[] {
  return provider === "codex" ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS;
}

async function hookCheck(provider: HookProvider, home: string): Promise<DoctorCheck> {
  const path = defaultHookConfigPath(provider, home);
  try {
    const { value } = await readJsonObject(path);
    const installed = countInstalledAgentGraphHooks(value, provider);
    const expected = providerEvents(provider).length;
    return installed >= expected
      ? { name: `${provider}.hooks`, status: "pass", message: `${installed} AgentGraph hooks installed` }
      : {
          name: `${provider}.hooks`,
          status: "fail",
          message: `Only ${installed}/${expected} AgentGraph hooks are installed`,
          details: { path }
        };
  } catch (error) {
    return {
      name: `${provider}.hooks`,
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      details: { path }
    };
  }
}

async function mcpCheck(
  provider: HookProvider,
  executable: string | undefined,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  if (!executable) {
    return { name: `${provider}.mcp`, status: "warn", message: `${provider} is not installed` };
  }
  const args = provider === "codex"
    ? ["mcp", "get", "agentgraph", "--json"]
    : ["mcp", "get", "agentgraph"];
  try {
    const result = await runner(executable, args, { timeoutMs: 5_000, env });
    return result.code === 0
      ? { name: `${provider}.mcp`, status: "pass", message: "AgentGraph MCP server is registered" }
      : {
          name: `${provider}.mcp`,
          status: "fail",
          message: "AgentGraph MCP server is not registered",
          details: result.stderr.trim() || result.stdout.trim()
        };
  } catch (error) {
    return {
      name: `${provider}.mcp`,
      status: "fail",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function supportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").slice(0, 2).map((part) => Number.parseInt(part, 10));
  return major > 20 || (major === 20 && minor >= 19);
}

/** The Node binary pinned as the first ProgramArguments entry of the LaunchAgent. */
export function launchAgentNode(content: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(content);
  return match?.[1]?.replaceAll("&amp;", "&") ?? null;
}

/**
 * The daemon and hooks run on the Node pinned at setup, not on whatever `node`
 * the current shell resolves. Only fail when the pinned runtime is too old.
 */
async function nodeCheck(
  home: string,
  platform: NodeJS.Platform,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv
): Promise<DoctorCheck> {
  const current = process.versions.node;
  if (supportedNode(current)) return { name: "runtime.node", status: "pass", message: `Node ${current}` };
  const pinned = platform === "darwin"
    ? await readFile(launchAgentPath(home), "utf8").then(launchAgentNode, () => null)
    : null;
  if (pinned) {
    try {
      const result = await runner(pinned, ["--version"], { timeoutMs: 5_000, env });
      const version = result.stdout.trim();
      if (result.code === 0 && supportedNode(version)) {
        return {
          name: "runtime.node",
          status: "warn",
          message: `This shell runs Node ${current}; the daemon and hooks use ${version} at ${pinned}. `
            + `Run CLI commands with that Node (for example \`${pinned} $(command -v agentgraph)\`).`
        };
      }
    } catch {
      // Fall through to the failure below.
    }
  }
  return { name: "runtime.node", status: "fail", message: `AgentGraph requires Node 20.19 or newer (found ${current})` };
}

/** Warns when hooks record sessions that presence cannot attach to a live process. */
function presenceCheck(details: unknown): DoctorCheck {
  const gaps = details && typeof details === "object" && Array.isArray((details as { presenceGaps?: unknown }).presenceGaps)
    ? (details as { presenceGaps: unknown[] }).presenceGaps
    : null;
  if (gaps === null) {
    return { name: "presence.coverage", status: "warn", message: "Daemon does not report presence coverage; restart it after upgrading" };
  }
  return gaps.length === 0
    ? { name: "presence.coverage", status: "pass", message: "Every recently active session has live presence" }
    : {
        name: "presence.coverage",
        status: "warn",
        message: `${gaps.length} session(s) active in the last 10 minutes have no live presence`,
        details: gaps
      };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runCommand;
  const checks: DoctorCheck[] = [];

  checks.push(await nodeCheck(home, platform, runner, env));

  const [codexPath, claudePath] = await Promise.all([
    findVendorExecutable("codex", env),
    findVendorExecutable("claude", env)
  ]);
  checks.push(codexPath
    ? { name: "vendor.codex", status: "pass", message: codexPath }
    : { name: "vendor.codex", status: "warn", message: "Codex executable not found" });
  checks.push(claudePath
    ? { name: "vendor.claude", status: "pass", message: claudePath }
    : { name: "vendor.claude", status: "warn", message: "Claude executable not found" });

  const health = options.health ?? (async () => await rpc("health", undefined, { timeoutMs: 500 }));
  try {
    const details = await health();
    checks.push({ name: "daemon", status: "pass", message: "Daemon is responding", details });
    checks.push(presenceCheck(details));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "daemon",
      status: "fail",
      message: message.includes("EPERM")
        ? "Daemon socket access denied. Run this command in your normal user terminal (not a sandbox), then run `agentgraph daemon restart`."
        : `Daemon is not responding: ${message}`
    });
  }

  const [codexHooks, claudeHooks, codexMcp, claudeMcp] = await Promise.all([
    hookCheck("codex", home),
    hookCheck("claude", home),
    mcpCheck("codex", codexPath, runner, env),
    mcpCheck("claude", claudePath, runner, env)
  ]);
  checks.push(codexHooks, claudeHooks, codexMcp, claudeMcp);

  if (platform === "darwin") {
    const path = launchAgentPath(home);
    try {
      const content = await readFile(path, "utf8");
      checks.push(content.includes(LAUNCHD_LABEL) && content.includes("daemon")
        ? { name: "daemon.launchd", status: "pass", message: path }
        : { name: "daemon.launchd", status: "fail", message: `Unexpected launchd file at ${path}` });
    } catch {
      checks.push({ name: "daemon.launchd", status: "fail", message: `LaunchAgent not found at ${path}` });
    }
  } else {
    checks.push({
      name: "daemon.service",
      status: "warn",
      message: "Automatic service checks currently support macOS only"
    });
  }

  if (options.requireTransparent) {
    const shimDir = defaultShimDirectory(home);
    const [codexShim, claudeShim] = await Promise.all([
      isUsableTransparentShim(join(shimDir, "codex")),
      isUsableTransparentShim(join(shimDir, "claude"))
    ]);
    checks.push(codexShim
      ? { name: "shim.codex", status: "pass", message: join(shimDir, "codex") }
      : { name: "shim.codex", status: "fail", message: "Transparent Codex shim is not installed" });
    checks.push(claudeShim
      ? { name: "shim.claude", status: "pass", message: join(shimDir, "claude") }
      : { name: "shim.claude", status: "fail", message: "Transparent Claude shim is not installed" });
  }

  // A readable home catches a surprising number of malformed test/container setups.
  try {
    await access(home);
  } catch {
    checks.push({ name: "home", status: "fail", message: `Home directory is not accessible: ${home}` });
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

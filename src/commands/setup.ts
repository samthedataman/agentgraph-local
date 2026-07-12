import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookProvider } from "../hooks/types.js";
import {
  installAgentGraphHooks,
  createHookCommand,
  uninstallAgentGraphHooks
} from "../setup/hooks.js";
import { installLaunchAgent, uninstallLaunchAgent } from "../setup/launchd.js";
import { installMcpServer, uninstallMcpServer } from "../setup/mcp.js";
import { installTransparentShim, uninstallTransparentShim } from "../setup/shims.js";
import { installCoordinationSkill, uninstallCoordinationSkill } from "../setup/skills.js";
import { takeFlag, takeOption } from "../util/args.js";
import { writeJson, writeLine } from "../util/output.js";

interface SetupSummary {
  dryRun: boolean;
  hooks: Array<{
    provider: HookProvider;
    path: string;
    changed: boolean;
    added: number;
    updated: number;
    removedDuplicates: number;
    backupPath?: string;
  }>;
  mcp: Array<{
    provider: HookProvider;
    installed: boolean;
    skipped: boolean;
    changed: boolean;
    reason?: string;
    commands: Array<{ executable: string; args: string[]; purpose: string }>;
  }>;
  daemon?: {
    supported: boolean;
    loaded: boolean;
    reason?: string;
    path?: string;
    changed?: boolean;
  };
  shims: Array<{
    provider: HookProvider;
    path: string;
    vendorPath?: string;
    installed: boolean;
    skipped: boolean;
    onPath: boolean;
    reason?: string;
  }>;
  skills: Array<{
    provider: HookProvider;
    path: string;
    installed: boolean;
    changed: boolean;
    skipped: boolean;
    reason?: string;
  }>;
  nextSteps: string[];
}

function selectedProviders(noCodex: boolean, noClaude: boolean): HookProvider[] {
  const providers: HookProvider[] = [];
  if (!noCodex) providers.push("codex");
  if (!noClaude) providers.push("claude");
  return providers;
}

function compactHook(result: Awaited<ReturnType<typeof installAgentGraphHooks>>) {
  return {
    provider: result.provider,
    path: result.path,
    changed: result.changed,
    added: result.added,
    updated: result.updated,
    removedDuplicates: result.removedDuplicates,
    ...(result.backupPath ? { backupPath: result.backupPath } : {})
  };
}

async function runUninstall(options: {
  providers: HookProvider[];
  home: string;
  shimDir?: string;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  hooksOnly: boolean;
  noHooks: boolean;
  noMcp: boolean;
  noSkills: boolean;
  noDaemon: boolean;
  json: boolean;
}): Promise<number> {
  const report: {
    uninstall: true;
    dryRun: boolean;
    hooks: Array<{ provider: HookProvider; path: string; removed: number; changed: boolean }>;
    mcp: Array<{ provider: HookProvider; removed: boolean; skipped: boolean; reason?: string }>;
    daemon?: { removed: boolean; skipped: boolean; path: string; reason?: string };
    shims: Array<{ provider: HookProvider; path: string; removed: boolean; skipped: boolean; reason?: string }>;
    skills: Array<{ provider: HookProvider; path: string; removed: boolean; skipped: boolean; reason?: string }>;
    dataPreserved: string;
  } = {
    uninstall: true,
    dryRun: options.dryRun,
    hooks: [],
    mcp: [],
    shims: [],
    skills: [],
    dataPreserved: resolve(options.home, ".agentgraph")
  };
  if (!options.noHooks) {
    for (const provider of options.providers) {
      const result = await uninstallAgentGraphHooks({
        provider,
        home: options.home,
        dryRun: options.dryRun
      });
      report.hooks.push({
        provider,
        path: result.path,
        removed: result.removed,
        changed: result.changed
      });
    }
  }
  if (!options.hooksOnly && !options.noMcp) {
    for (const provider of options.providers) {
      const result = await uninstallMcpServer({
        provider,
        env: options.env,
        dryRun: options.dryRun
      });
      report.mcp.push({
        provider,
        removed: result.removed,
        skipped: result.skipped,
        ...(result.reason ? { reason: result.reason } : {})
      });
    }
  }
  if (!options.hooksOnly && !options.noSkills) {
    for (const provider of options.providers) {
      report.skills.push(await uninstallCoordinationSkill({
        provider,
        home: options.home,
        dryRun: options.dryRun
      }));
    }
  }
  if (!options.hooksOnly && !options.noDaemon) {
    const result = await uninstallLaunchAgent({
      home: options.home,
      dryRun: options.dryRun
    });
    report.daemon = {
      removed: result.removed,
      skipped: result.skipped,
      path: result.path,
      ...(result.reason ? { reason: result.reason } : {})
    };
  }
  if (!options.hooksOnly) {
    for (const provider of options.providers) {
      const result = await uninstallTransparentShim({
        provider,
        home: options.home,
        ...(options.shimDir ? { shimDir: resolve(options.shimDir) } : {}),
        env: options.env,
        dryRun: options.dryRun
      });
      report.shims.push(result);
    }
  }
  if (options.json) {
    writeJson(report);
  } else {
    writeLine(options.dryRun ? "AgentGraph uninstall plan (nothing was changed):" : "AgentGraph integration removed:");
    for (const hook of report.hooks) {
      writeLine(`  ${hook.provider} hooks: ${hook.removed} AgentGraph handler(s) ${options.dryRun ? "would be removed" : "removed"}`);
    }
    for (const mcp of report.mcp) {
      writeLine(`  ${mcp.provider} MCP: ${mcp.removed ? "removed" : mcp.reason ?? "not present"}`);
    }
    for (const skill of report.skills) {
      writeLine(`  ${skill.provider} skill: ${skill.removed ? "removed" : skill.reason ?? (options.dryRun ? "would be removed" : "not present")}`);
    }
    if (report.daemon) writeLine(`  daemon: ${report.daemon.removed ? "removed" : report.daemon.reason ?? "not present"}`);
    for (const shim of report.shims) {
      writeLine(`  ${shim.provider} shim: ${shim.removed ? "removed" : shim.reason ?? (options.dryRun ? "would be removed" : "not present")}`);
    }
    writeLine(`\nShared memory and database data were preserved at ${report.dataPreserved}.`);
  }
  return 0;
}

export async function run(args: string[], json: boolean): Promise<number> {
  const uninstall = takeFlag(args, "--uninstall");
  const dryRun = takeFlag(args, "--dry-run");
  const hooksOnly = takeFlag(args, "--hooks-only");
  const transparent = takeFlag(args, "--transparent");
  const noHooks = takeFlag(args, "--no-hooks");
  const noMcp = takeFlag(args, "--no-mcp");
  const noSkills = takeFlag(args, "--no-skills");
  const noDaemon = takeFlag(args, "--no-daemon");
  const noCodex = takeFlag(args, "--no-codex");
  const noClaude = takeFlag(args, "--no-claude");
  const home = resolve(takeOption(args, "--home") ?? process.env.HOME ?? homedir());
  const shimDir = takeOption(args, "--shim-dir");
  const cliPath = resolve(takeOption(args, "--cli-path") ?? process.argv[1] ?? "dist/cli.js");
  if (args.length > 0) throw new Error(`Unknown setup option: ${args[0]}`);
  const nodePath = resolve(process.execPath);
  const providers = selectedProviders(noCodex, noClaude);
  if (providers.length === 0) throw new Error("Both providers were disabled; nothing to set up");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (uninstall) {
    return await runUninstall({
      providers,
      home,
      ...(shimDir ? { shimDir } : {}),
      env,
      dryRun,
      hooksOnly,
      noHooks,
      noMcp,
      noSkills,
      noDaemon,
      json
    });
  }
  const summary: SetupSummary = { dryRun, hooks: [], mcp: [], shims: [], skills: [], nextSteps: [] };

  if (!noHooks) {
    for (const provider of providers) {
      const result = await installAgentGraphHooks({
        provider,
        command: createHookCommand(provider, nodePath, cliPath),
        home,
        dryRun
      });
      summary.hooks.push(compactHook(result));
    }
  }

  if (!hooksOnly && !noMcp) {
    for (const provider of providers) {
      const result = await installMcpServer({
        provider,
        nodePath,
        cliPath,
        dryRun,
        env
      });
      summary.mcp.push({
        provider: result.provider,
        installed: result.installed,
        skipped: result.skipped,
        changed: result.changed,
        ...(result.reason ? { reason: result.reason } : {}),
        commands: result.commands
      });
    }
  }

  if (!hooksOnly && !noSkills) {
    const sourceDirectory = fileURLToPath(new URL("../../skills/coordinate-agentgraph/", import.meta.url));
    for (const provider of providers) {
      summary.skills.push(await installCoordinationSkill({
        provider,
        sourceDirectory,
        home,
        dryRun
      }));
    }
  }

  if (!hooksOnly && !noDaemon) {
    const result = await installLaunchAgent({ nodePath, cliPath, home, dryRun });
    summary.daemon = {
      supported: result.supported,
      loaded: result.loaded,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.write ? { path: result.write.path, changed: result.write.changed } : {})
    };
  }

  if (!hooksOnly && transparent) {
    for (const provider of providers) {
      const result = await installTransparentShim({
        provider,
        nodePath,
        cliPath,
        home,
        ...(shimDir ? { shimDir: resolve(shimDir) } : {}),
        env,
        dryRun
      });
      summary.shims.push({
        provider: result.provider,
        path: result.path,
        installed: result.installed,
        skipped: result.skipped,
        onPath: result.onPath,
        ...(result.vendorPath ? { vendorPath: result.vendorPath } : {}),
        ...(result.reason ? { reason: result.reason } : {})
      });
      if (!result.onPath) {
        const directory = resolve(result.path, "..");
        summary.nextSteps.push(`Add ${directory} to PATH before the original vendor binary directory.`);
      }
    }
  }

  if (providers.includes("codex") && !noHooks) {
    summary.nextSteps.push("Open `/hooks` once in Codex and trust the new AgentGraph hooks.");
  }
  summary.nextSteps.push(dryRun
    ? "Run `agentgraph setup` without --dry-run to apply this plan."
    : "Run `agentgraph doctor` to verify the installation.");

  if (json) {
    writeJson(summary);
  } else {
    writeLine(dryRun ? "AgentGraph setup plan (nothing was changed):" : "AgentGraph setup complete:");
    for (const hook of summary.hooks) {
      writeLine(`  ${hook.provider} hooks: ${hook.changed ? `${hook.added} added, ${hook.updated} updated` : "already current"}`);
      if (hook.backupPath) writeLine(`    backup: ${hook.backupPath}`);
    }
    for (const mcp of summary.mcp) {
      writeLine(`  ${mcp.provider} MCP: ${mcp.installed ? "registered" : mcp.skipped ? "skipped" : dryRun ? "will register" : "failed"}`);
      if (mcp.reason) writeLine(`    ${mcp.reason}`);
    }
    for (const skill of summary.skills) {
      writeLine(`  ${skill.provider} skill: ${skill.installed ? "installed" : skill.skipped ? "skipped" : dryRun ? "will install" : "not installed"} at ${skill.path}`);
      if (skill.reason) writeLine(`    ${skill.reason}`);
    }
    if (summary.daemon) {
      writeLine(`  daemon: ${summary.daemon.loaded ? "loaded" : dryRun && summary.daemon.supported ? "will install" : summary.daemon.reason ?? "not loaded"}`);
    }
    for (const shim of summary.shims) {
      writeLine(`  ${shim.provider} transparent command: ${shim.skipped ? "skipped" : dryRun ? "will install" : "installed"} at ${shim.path}`);
      if (shim.reason) writeLine(`    ${shim.reason}`);
    }
    writeLine("\nNext:");
    for (const step of [...new Set(summary.nextSteps)]) writeLine(`  - ${step}`);
  }

  const failedMcp = summary.mcp.some((item) => !item.installed && !item.skipped && !dryRun);
  const failedDaemon = summary.daemon && summary.daemon.supported && !summary.daemon.loaded && !dryRun;
  return failedMcp || failedDaemon ? 1 : 0;
}

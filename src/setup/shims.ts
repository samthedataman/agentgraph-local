import { constants } from "node:fs";
import { access, chmod, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { HookProvider } from "../hooks/types.js";
import { writeConfigFile, type WritePlan } from "./files.js";
import { findVendorExecutable } from "./process.js";

export const SHIM_MARKER = "agentgraph-transparent-shim:v1";

export interface ShimInstallOptions {
  provider: HookProvider;
  nodePath: string;
  cliPath: string;
  home?: string;
  shimDir?: string;
  vendorPath?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  now?: Date;
}

export interface ShimInstallResult {
  provider: HookProvider;
  installed: boolean;
  skipped: boolean;
  path: string;
  vendorPath?: string;
  onPath: boolean;
  reason?: string;
  write?: WritePlan;
}

export interface ShimUninstallOptions {
  provider: HookProvider;
  home?: string;
  shimDir?: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}

export interface ShimUninstallResult {
  provider: HookProvider;
  path: string;
  removed: boolean;
  skipped: boolean;
  reason?: string;
}

export function defaultShimDirectory(home = homedir()): string {
  return join(home, ".local", "bin");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderTransparentShim(options: {
  provider: HookProvider;
  nodePath: string;
  cliPath: string;
  vendorPath: string;
}): string {
  return `#!/bin/sh
# ${SHIM_MARKER}
# Real ${options.provider} binary captured during AgentGraph setup:
# ${options.vendorPath}
export AGENTGRAPH_TRANSPARENT_SHIM=1
exec ${shellQuote(resolve(options.nodePath))} ${shellQuote(resolve(options.cliPath))} run --provider ${options.provider} -- ${shellQuote(resolve(options.vendorPath))} "$@"
`;
}

async function existingShimText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function directoryOnPath(directory: string, env: NodeJS.ProcessEnv): boolean {
  const target = resolve(directory);
  return (env.PATH ?? "").split(delimiter).some((entry) => entry && resolve(entry) === target);
}

export async function installTransparentShim(options: ShimInstallOptions): Promise<ShimInstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const shimDir = options.shimDir ?? defaultShimDirectory(home);
  const path = join(shimDir, options.provider);
  const before = await existingShimText(path);
  if (before !== null && !before.includes(SHIM_MARKER)) {
    return {
      provider: options.provider,
      installed: false,
      skipped: true,
      path,
      onPath: directoryOnPath(shimDir, env),
      reason: `Refusing to overwrite non-AgentGraph file at ${path}`
    };
  }
  const vendorPath = options.vendorPath
    ?? await findVendorExecutable(options.provider, env, [path]);
  if (!vendorPath) {
    return {
      provider: options.provider,
      installed: false,
      skipped: true,
      path,
      onPath: directoryOnPath(shimDir, env),
      reason: `Could not find a real ${options.provider} executable outside the shim directory`
    };
  }
  const after = renderTransparentShim({
    provider: options.provider,
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    vendorPath
  });
  const write = await writeConfigFile(path, before, after, {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.now ? { now: options.now } : {})
  });
  if (!options.dryRun) await chmod(path, 0o755);
  return {
    provider: options.provider,
    installed: true,
    skipped: false,
    path,
    vendorPath,
    onPath: directoryOnPath(shimDir, env),
    write
  };
}

export async function isUsableTransparentShim(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await readFile(path, "utf8")).slice(0, 1_024).includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

export async function uninstallTransparentShim(
  options: ShimUninstallOptions
): Promise<ShimUninstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const path = join(options.shimDir ?? defaultShimDirectory(home), options.provider);
  const content = await existingShimText(path);
  if (content === null) {
    return {
      provider: options.provider,
      path,
      removed: false,
      skipped: false,
      reason: "AgentGraph shim was not present"
    };
  }
  if (!content.includes(SHIM_MARKER)) {
    return {
      provider: options.provider,
      path,
      removed: false,
      skipped: true,
      reason: `Refusing to remove non-AgentGraph file at ${path}`
    };
  }
  if (!options.dryRun) await rm(path);
  return {
    provider: options.provider,
    path,
    removed: !options.dryRun,
    skipped: false
  };
}

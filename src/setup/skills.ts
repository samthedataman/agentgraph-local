import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HookProvider } from "../hooks/types.js";

const MARKER = ".agentgraph-owned.json";

export interface SkillInstallOptions {
  provider: HookProvider;
  sourceDirectory: string;
  home: string;
  dryRun?: boolean;
}

export interface SkillInstallResult {
  provider: HookProvider;
  path: string;
  installed: boolean;
  changed: boolean;
  skipped: boolean;
  reason?: string;
}

export interface SkillUninstallOptions {
  provider: HookProvider;
  home: string;
  dryRun?: boolean;
}

export interface SkillUninstallResult {
  provider: HookProvider;
  path: string;
  removed: boolean;
  skipped: boolean;
  reason?: string;
}

export function skillInstallPath(provider: HookProvider, home: string): string {
  return join(home, provider === "codex" ? ".codex" : ".claude", "skills", "coordinate-agentgraph");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isOwned(path: string, provider: HookProvider): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(path, MARKER), "utf8")) as Record<string, unknown>;
    return marker.owner === "agentgraph" && marker.provider === provider;
  } catch {
    return false;
  }
}

async function directorySignature(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name !== MARKER)
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      hash.update(relative(root, path));
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(await readFile(path));
    }
  };
  await visit(root);
  return hash.digest("hex");
}

export async function installCoordinationSkill(options: SkillInstallOptions): Promise<SkillInstallResult> {
  const path = skillInstallPath(options.provider, options.home);
  if (!await exists(join(options.sourceDirectory, "SKILL.md"))) {
    return {
      provider: options.provider,
      path,
      installed: false,
      changed: false,
      skipped: true,
      reason: `Bundled skill was not found at ${options.sourceDirectory}`
    };
  }
  const destinationExists = await exists(path);
  const owned = destinationExists && await isOwned(path, options.provider);
  if (destinationExists && !owned) {
    return {
      provider: options.provider,
      path,
      installed: false,
      changed: false,
      skipped: true,
      reason: "A non-AgentGraph skill already uses the coordinate-agentgraph name"
    };
  }
  if (owned && await directorySignature(options.sourceDirectory) === await directorySignature(path)) {
    return { provider: options.provider, path, installed: true, changed: false, skipped: false };
  }
  if (options.dryRun) {
    return { provider: options.provider, path, installed: false, changed: true, skipped: false };
  }
  if (destinationExists) await rm(path, { recursive: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
  await cp(options.sourceDirectory, path, { recursive: true, force: true });
  await writeFile(
    join(path, MARKER),
    `${JSON.stringify({ owner: "agentgraph", provider: options.provider, version: 1 }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { provider: options.provider, path, installed: true, changed: true, skipped: false };
}

export async function uninstallCoordinationSkill(options: SkillUninstallOptions): Promise<SkillUninstallResult> {
  const path = skillInstallPath(options.provider, options.home);
  if (!await exists(path)) {
    return {
      provider: options.provider,
      path,
      removed: false,
      skipped: false,
      reason: "Coordination skill was not present"
    };
  }
  if (!await isOwned(path, options.provider)) {
    return {
      provider: options.provider,
      path,
      removed: false,
      skipped: true,
      reason: "Skill is not marked as AgentGraph-owned; preserving it"
    };
  }
  if (!options.dryRun) await rm(path, { recursive: true });
  return { provider: options.provider, path, removed: !options.dryRun, skipped: false };
}

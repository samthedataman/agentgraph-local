import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookProvider } from "../hooks/types.js";
import { prettyJson, readJsonObject, writeConfigFile, type JsonObject, type WritePlan } from "./files.js";

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop"
] as const;

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "PreCompact",
  "PostCompact",
  "Notification",
  "CwdChanged"
] as const;

type HookHandler = Record<string, unknown> & { type?: unknown; command?: unknown };
type HookGroup = Record<string, unknown> & { hooks?: unknown };

export interface HookInstallOptions {
  provider: HookProvider;
  command: string;
  path?: string;
  home?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface HookInstallResult extends WritePlan {
  provider: HookProvider;
  added: number;
  updated: number;
  removedDuplicates: number;
}

export interface HookUninstallOptions {
  provider: HookProvider;
  path?: string;
  home?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface HookUninstallResult extends WritePlan {
  provider: HookProvider;
  removed: number;
}

export function defaultHookConfigPath(provider: HookProvider, home = homedir()): string {
  return provider === "codex"
    ? join(home, ".codex", "hooks.json")
    : join(home, ".claude", "settings.json");
}

export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createHookCommand(
  provider: HookProvider,
  nodePath: string,
  cliPath: string
): string {
  return `AGENTGRAPH_HOOK=1 ${quoteShellArgument(resolve(nodePath))} ${quoteShellArgument(resolve(cliPath))} hook ${provider}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAgentGraphHookHandler(value: unknown, provider?: HookProvider): boolean {
  if (!isObject(value) || value.type !== "command" || typeof value.command !== "string") return false;
  if (!value.command.includes("AGENTGRAPH_HOOK=1")) return false;
  return provider ? value.command.includes(`hook ${provider}`) : true;
}

function hooksObject(config: JsonObject): Record<string, unknown> {
  if (config.hooks === undefined) {
    const hooks: Record<string, unknown> = {};
    config.hooks = hooks;
    return hooks;
  }
  if (!isObject(config.hooks)) throw new Error("Refusing to replace a non-object `hooks` setting");
  return config.hooks;
}

function eventGroups(hooks: Record<string, unknown>, event: string): HookGroup[] {
  const existing = hooks[event];
  if (existing === undefined) {
    const groups: HookGroup[] = [];
    hooks[event] = groups;
    return groups;
  }
  if (!Array.isArray(existing)) {
    throw new Error(`Refusing to replace non-array hooks.${event}`);
  }
  for (const group of existing) {
    if (!isObject(group)) throw new Error(`Refusing to modify invalid hooks.${event} group`);
    if (group.hooks !== undefined && !Array.isArray(group.hooks)) {
      throw new Error(`Refusing to replace non-array hooks.${event}[].hooks`);
    }
  }
  return existing as HookGroup[];
}

export function mergeAgentGraphHooks(
  original: JsonObject,
  provider: HookProvider,
  command: string
): { config: JsonObject; added: number; updated: number; removedDuplicates: number } {
  const config = structuredClone(original);
  const hooks = hooksObject(config);
  const events: readonly string[] = provider === "codex" ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS;
  let added = 0;
  let updated = 0;
  let removedDuplicates = 0;

  for (const event of events) {
    const groups = eventGroups(hooks, event);
    let found = false;
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex -= 1) {
      const group = groups[groupIndex];
      if (!group) continue;
      const handlers = Array.isArray(group.hooks) ? group.hooks as HookHandler[] : [];
      for (let handlerIndex = handlers.length - 1; handlerIndex >= 0; handlerIndex -= 1) {
        const handler = handlers[handlerIndex];
        if (!handler) continue;
        if (!isAgentGraphHookHandler(handler, provider)) continue;
        if (found) {
          handlers.splice(handlerIndex, 1);
          removedDuplicates += 1;
          continue;
        }
        found = true;
        if (handler.command !== command || handler.timeout !== 5 || handler.type !== "command") {
          handler.type = "command";
          handler.command = command;
          handler.timeout = 5;
          updated += 1;
        }
      }
      group.hooks = handlers;
      if (handlers.length === 0 && Object.keys(group).every((key) => key === "hooks")) {
        groups.splice(groupIndex, 1);
      }
    }
    if (!found) {
      groups.push({
        hooks: [{ type: "command", command, timeout: 5 }]
      });
      added += 1;
    }
  }
  return { config, added, updated, removedDuplicates };
}

export async function installAgentGraphHooks(options: HookInstallOptions): Promise<HookInstallResult> {
  const path = options.path
    ?? defaultHookConfigPath(options.provider, options.home ?? process.env.HOME ?? homedir());
  const { value, text } = await readJsonObject(path);
  const merged = mergeAgentGraphHooks(value, options.provider, options.command);
  const write = await writeConfigFile(path, text, prettyJson(merged.config), {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.now ? { now: options.now } : {})
  });
  return {
    ...write,
    provider: options.provider,
    added: merged.added,
    updated: merged.updated,
    removedDuplicates: merged.removedDuplicates
  };
}

export function removeAgentGraphHooks(
  original: JsonObject,
  provider: HookProvider
): { config: JsonObject; removed: number } {
  const config = structuredClone(original);
  if (!isObject(config.hooks)) return { config, removed: 0 };
  let removed = 0;
  for (const [event, value] of Object.entries(config.hooks)) {
    if (!Array.isArray(value)) continue;
    for (let groupIndex = value.length - 1; groupIndex >= 0; groupIndex -= 1) {
      const group = value[groupIndex];
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      const handlers = group.hooks;
      const before = handlers.length;
      const remaining = handlers.filter((handler) => !isAgentGraphHookHandler(handler, provider));
      group.hooks = remaining;
      removed += before - remaining.length;
      if (remaining.length === 0 && Object.keys(group).every((key) => key === "hooks")) {
        value.splice(groupIndex, 1);
      }
    }
    if (value.length === 0) delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  return { config, removed };
}

export async function uninstallAgentGraphHooks(
  options: HookUninstallOptions
): Promise<HookUninstallResult> {
  const path = options.path
    ?? defaultHookConfigPath(options.provider, options.home ?? process.env.HOME ?? homedir());
  const { value, text } = await readJsonObject(path);
  const removal = removeAgentGraphHooks(value, options.provider);
  if (text === null || removal.removed === 0) {
    return {
      provider: options.provider,
      removed: 0,
      path,
      changed: false,
      created: false,
      before: text,
      after: text ?? ""
    };
  }
  const write = await writeConfigFile(path, text, prettyJson(removal.config), {
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.now ? { now: options.now } : {})
  });
  return { ...write, provider: options.provider, removed: removal.removed };
}

export function countInstalledAgentGraphHooks(config: JsonObject, provider: HookProvider): number {
  if (!isObject(config.hooks)) return 0;
  let count = 0;
  for (const value of Object.values(config.hooks)) {
    if (!Array.isArray(value)) continue;
    for (const group of value) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      count += group.hooks.filter((handler) => isAgentGraphHookHandler(handler, provider)).length;
    }
  }
  return count;
}

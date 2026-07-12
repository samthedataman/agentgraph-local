import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentGraphPaths } from "./paths.js";
import { ensureDirectories, getPaths } from "./paths.js";

export interface AgentGraphConfig {
  schemaVersion: 1;
  hostId: string;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  reconciliationIntervalMs: number;
  recentProcessSeconds: number;
}

export const DEFAULT_CONFIG: Omit<AgentGraphConfig, "hostId"> = {
  schemaVersion: 1,
  heartbeatIntervalMs: 3_000,
  leaseDurationMs: 15_000,
  reconciliationIntervalMs: 3_000,
  recentProcessSeconds: 3_600
};

function validConfig(value: unknown): value is AgentGraphConfig {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AgentGraphConfig>;
  return candidate.schemaVersion === 1 && typeof candidate.hostId === "string" && candidate.hostId.length > 0;
}

export function loadConfig(paths: AgentGraphPaths = getPaths()): AgentGraphConfig {
  ensureDirectories(paths);
  if (existsSync(paths.configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(paths.configPath, "utf8"));
    if (!validConfig(parsed)) throw new Error(`Invalid AgentGraph config: ${paths.configPath}`);
    return { ...DEFAULT_CONFIG, ...parsed };
  }

  const config: AgentGraphConfig = {
    ...DEFAULT_CONFIG,
    hostId: `host_${randomUUID().replaceAll("-", "")}`
  };
  const temporary = `${paths.configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.configPath);
  return config;
}


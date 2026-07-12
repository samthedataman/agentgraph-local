import { spawnSync } from "node:child_process";

export function commandPath(command: string): string | undefined {
  const result = spawnSync("/usr/bin/env", ["which", command], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) return undefined;
  const path = result.stdout.trim();
  return path || undefined;
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { rpc } from "../ipc/client.js";
import { getPaths, type AgentGraphPaths } from "../config/paths.js";
import { daemonPidRecordMatches, readDaemonPidRecord } from "./pid-file.js";

export interface DaemonHealth {
  ok: true;
  version: string;
  pid: number;
  uptimeSeconds: number;
  databasePath: string;
  socketPath: string;
  liveProcesses: number;
  now: string;
}

export async function daemonHealth(paths: AgentGraphPaths = getPaths(), timeoutMs = 500): Promise<DaemonHealth> {
  return await rpc<DaemonHealth>("health", undefined, { socketPath: paths.socketPath, timeoutMs });
}

function cliInvocation(): { executable: string; args: string[] } {
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("Cannot determine the AgentGraph CLI path");
  return { executable: process.execPath, args: [...process.execArgv, cliPath, "daemon", "serve"] };
}

export function spawnDaemonDetached(): number {
  const invocation = cliInvocation();
  const child = spawn(invocation.executable, invocation.args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
    shell: false
  });
  child.unref();
  if (!child.pid) throw new Error("Failed to start AgentGraph daemon");
  return child.pid;
}

export async function ensureDaemonRunning(paths: AgentGraphPaths = getPaths()): Promise<DaemonHealth> {
  try {
    return await daemonHealth(paths);
  } catch {
    spawnDaemonDetached();
  }
  const deadline = Date.now() + 4_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      return await daemonHealth(paths);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`AgentGraph daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export function daemonPid(paths: AgentGraphPaths = getPaths()): number | null {
  if (!existsSync(paths.pidPath)) return null;
  const record = readDaemonPidRecord(paths.pidPath);
  return record && daemonPidRecordMatches(record) ? record.pid : null;
}

export async function stopDaemon(paths: AgentGraphPaths = getPaths()): Promise<boolean> {
  try {
    await rpc("daemon.shutdown", undefined, { socketPath: paths.socketPath, timeoutMs: 1_000 });
  } catch {
    const pid = daemonPid(paths);
    if (!pid) return false;
    process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!daemonPid(paths)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !daemonPid(paths);
}

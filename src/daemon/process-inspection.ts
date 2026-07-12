import { existsSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { sha256 } from "../util/ids.js";
import type { DiscoveredProcess, Provider, TerminalFingerprint } from "../protocol/types.js";

function ps(args: string[]): string | null {
  const result = spawnSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function getProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = ps(["-p", String(pid), "-o", "lstart="]);
  if (!started) return null;
  return `ps_${sha256(started).slice(0, 32)}`;
}

export function processMatches(pid: number, processStartToken: string): boolean {
  return getProcessStartToken(pid) === processStartToken;
}

export function getProcessExecutable(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return ps(["-p", String(pid), "-o", "comm="]);
}

export function currentTty(pid = process.pid): string | null {
  const value = ps(["-p", String(pid), "-o", "tty="]);
  if (!value || value === "??" || value === "?") return null;
  return value.startsWith("/") ? value : `/dev/${value}`;
}

export function terminalFingerprint(env: NodeJS.ProcessEnv = process.env, pid = process.pid): TerminalFingerprint {
  const parent = pid === process.pid ? process.ppid : null;
  return {
    tty: currentTty(pid),
    termProgram: env.TERM_PROGRAM ?? null,
    termSessionId: env.TERM_SESSION_ID ?? null,
    itermSessionId: env.ITERM_SESSION_ID ?? null,
    tmuxPane: env.TMUX_PANE ?? null,
    parentPid: parent
  };
}

function providerForCommand(command: string): Provider | null {
  if (/agentgraph(?:\.js)?(?:\s|$)/i.test(command)) return null;
  if (/(?:^|[\s/])codex(?:\.js)?(?:[\s/]|$)/i.test(command)) return "codex";
  if (/(?:^|[\s/])claude(?:-code)?(?:\.js)?(?:[\s/]|$)/i.test(command)) return "claude";
  return null;
}

function cwdForPid(pid: number): string | null {
  const procPath = `/proc/${pid}/cwd`;
  if (existsSync(procPath)) {
    try {
      return readlinkSync(procPath);
    } catch {
      return null;
    }
  }
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  const pathLine = result.stdout.split("\n").find((line) => line.startsWith("n"));
  return pathLine ? pathLine.slice(1) : null;
}

export function discoverAgentProcesses(): DiscoveredProcess[] {
  const output = ps(["-axo", "pid=,ppid=,tty=,command="]);
  if (!output) return [];
  const results: DiscoveredProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || pid === process.ppid) continue;
    const command = match[4]!;
    const provider = providerForCommand(command);
    if (!provider) continue;
    const processStartToken = getProcessStartToken(pid);
    if (!processStartToken) continue;
    const rawTty = match[3]!;
    results.push({
      pid,
      parentPid: Number(match[2]),
      provider,
      command,
      cwd: cwdForPid(pid),
      tty: rawTty === "??" || rawTty === "?" ? null : rawTty.startsWith("/") ? rawTty : `/dev/${rawTty}`,
      processStartToken
    });
  }
  return results.sort((left, right) => left.pid - right.pid);
}

export function executableName(command: string): string {
  const first = command.trim().split(/\s+/, 1)[0];
  return first ? basename(first) : command;
}

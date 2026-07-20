import { existsSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { sha256 } from "../util/ids.js";
import type { DiscoveredProcess, Provider, TerminalFingerprint } from "../protocol/types.js";

const PROCESS_PROBE_TIMEOUT_MS = 500;

function ps(args: string[]): string | null {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL"
  });
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

export function providerForCommand(command: string): Provider | null {
  const tokens = command.trim().split(/\s+/);
  const executable = basename(tokens[0] ?? "").toLowerCase();
  const launched = ["node", "nodejs", "bun", "deno"].includes(executable)
    ? basename(tokens[1] ?? "").toLowerCase()
    : executable;
  if (launched === "codex" || launched === "codex.js") return "codex";
  if (launched === "claude" || launched === "claude.js" || launched === "claude-code" || launched === "claude-code.js") {
    return "claude";
  }
  return null;
}

export interface DiscoverAgentProcessOptions {
  provider?: Provider;
  tty?: string;
  cwd?: string;
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
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROCESS_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL"
  });
  if (result.status !== 0) return null;
  const pathLine = result.stdout.split("\n").find((line) => line.startsWith("n"));
  return pathLine ? pathLine.slice(1) : null;
}

export function discoverAgentProcesses(options: DiscoverAgentProcessOptions = {}): DiscoveredProcess[] {
  const output = options.tty
    ? ps(["-t", options.tty.replace(/^\/dev\//, ""), "-o", "pid=,ppid=,tty=,command="])
    : ps(["-axo", "pid=,ppid=,tty=,command="]);
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
    if (options.provider && provider !== options.provider) continue;
    const rawTty = match[3]!;
    const tty = rawTty === "??" || rawTty === "?" ? null : rawTty.startsWith("/") ? rawTty : `/dev/${rawTty}`;
    if (options.tty && tty !== options.tty) continue;
    const processStartToken = getProcessStartToken(pid);
    if (!processStartToken) continue;
    results.push({
      pid,
      parentPid: Number(match[2]),
      provider,
      command,
      cwd: options.cwd ?? cwdForPid(pid),
      tty,
      processStartToken
    });
  }
  return preferProviderLeafProcesses(results).sort((left, right) => left.pid - right.pid);
}

/**
 * Provider CLIs commonly have a tiny Node launcher whose child is the actual
 * native agent process. Counting both makes an otherwise exact TTY/repository
 * match look ambiguous, so presence attaches only the leaf process.
 */
export function preferProviderLeafProcesses(processes: DiscoveredProcess[]): DiscoveredProcess[] {
  const providerParents = new Set(
    processes.flatMap((candidate) =>
      processes.some((parent) =>
        parent.pid === candidate.parentPid
        && parent.provider === candidate.provider
        && parent.tty === candidate.tty
      )
        ? [candidate.parentPid]
        : []
    )
  );
  return processes.filter((candidate) => !providerParents.has(candidate.pid));
}

export function executableName(command: string): string {
  const first = command.trim().split(/\s+/, 1)[0];
  return first ? basename(first) : command;
}

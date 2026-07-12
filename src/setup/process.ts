import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (executable, args, options = {}) =>
  await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      shell: false
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    const timeout = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : undefined;
    timeout?.unref();
    child.once("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isAgentGraphShim(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return content.slice(0, 1_024).includes("agentgraph-transparent-shim:v1");
  } catch {
    return false;
  }
}

/** Find the actual vendor program while deliberately walking past our shims. */
export async function findVendorExecutable(
  name: "codex" | "claude",
  env: NodeJS.ProcessEnv = process.env,
  excludedPaths: string[] = []
): Promise<string | undefined> {
  const excluded = new Set(excludedPaths.map((path) => resolve(path)));
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = resolve(join(entry, name));
    if (excluded.has(candidate) || seen.has(candidate) || !(await isExecutable(candidate))) continue;
    seen.add(candidate);
    if (await isAgentGraphShim(candidate)) continue;
    try {
      return await realpath(candidate);
    } catch {
      return candidate;
    }
  }
  return undefined;
}

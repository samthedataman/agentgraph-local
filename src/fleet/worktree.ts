import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { getPaths } from "../config/paths.js";
import { getProcessStartToken, processMatches } from "../daemon/process-inspection.js";
import { FleetSafetyError, FleetValidationError } from "./errors.js";
import type {
  FleetPlan,
  FleetTask,
  FleetWriterLease,
  ResolvedFleetWorktree
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface GitWorktreeInfo {
  topLevel: string;
  commonDir: string;
}

export async function inspectGitWorktree(cwd: string): Promise<GitWorktreeInfo | undefined> {
  try {
    const topResult = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    const commonResult = await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    const topRaw = topResult.stdout.trim();
    const commonRaw = commonResult.stdout.trim();
    if (!topRaw || !commonRaw) return undefined;
    const topLevel = await realpath(topRaw);
    const commonDir = await realpath(isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw));
    return { topLevel, commonDir };
  } catch {
    return undefined;
  }
}

export function pathIsInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolveFleetRoot(rootCwd: string, baseCwd: string): Promise<string> {
  const candidate = resolve(baseCwd, rootCwd);
  const canonical = await realpath(candidate).catch(() => {
    throw new FleetValidationError([`root.cwd does not exist or cannot be resolved: ${candidate}`]);
  });
  const details = await stat(canonical);
  if (!details.isDirectory()) throw new FleetValidationError([`root.cwd is not a directory: ${canonical}`]);
  return canonical;
}

export async function resolveTaskWorktree(task: FleetTask, rootCwd: string): Promise<ResolvedFleetWorktree> {
  const candidate = resolve(rootCwd, task.worktree ?? ".");
  const canonical = await realpath(candidate).catch(() => {
    throw new FleetValidationError([`task '${task.id}' worktree does not exist or cannot be resolved: ${candidate}`]);
  });
  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new FleetValidationError([`task '${task.id}' worktree is not a directory: ${canonical}`]);
  }
  return { cwd: canonical, ownershipKey: canonical };
}

function transitivelyDependsOn(taskId: string, possibleAncestor: string, byId: ReadonlyMap<string, FleetTask>): boolean {
  const visited = new Set<string>();
  const pending = [...(byId.get(taskId)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === possibleAncestor) return true;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

export function validateWriterOrdering(
  plan: FleetPlan,
  worktrees: ReadonlyMap<string, ResolvedFleetWorktree>
): void {
  const issues: string[] = [];
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const tasks = [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id));
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex];
      if (!right) continue;
      if (left.mode !== "writer" && right.mode !== "writer") continue;
      const leftKey = worktrees.get(left.id)?.ownershipKey;
      const rightKey = worktrees.get(right.id)?.ownershipKey;
      if (!leftKey || !rightKey || leftKey !== rightKey) continue;
      const ordered = transitivelyDependsOn(right.id, left.id, byId) || transitivelyDependsOn(left.id, right.id, byId);
      if (!ordered) {
        issues.push(
          `tasks '${left.id}' and '${right.id}' share worktree '${leftKey}' with writer access but no dependency ordering them`
        );
      }
    }
  }
  if (issues.length > 0) throw new FleetValidationError(issues);
}

export async function acquireFileWriterLease(
  worktree: ResolvedFleetWorktree,
  task: FleetTask,
  environment: NodeJS.ProcessEnv = process.env
): Promise<FleetWriterLease> {
  const lockDirectory = resolve(getPaths(environment).homeDir, "fleet-locks");
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(worktree.ownershipKey).digest("hex");
  const lockPath = resolve(lockDirectory, `${key}.lock`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const record = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
          processStartToken?: unknown;
        };
        stale = Number.isInteger(record.pid) && Number(record.pid) > 0 &&
          typeof record.processStartToken === "string" && record.processStartToken.length > 0 &&
          !processMatches(Number(record.pid), record.processStartToken);
      } catch {
        stale = false;
      }
      if (stale && attempt === 0) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      throw new FleetSafetyError(
        `writer worktree '${worktree.ownershipKey}' is already owned by another fleet; refusing task '${task.id}'`
      );
    }
  }
  if (!handle) throw new FleetSafetyError(`could not acquire writer ownership for task '${task.id}'`);

  try {
    const processStartToken = getProcessStartToken(process.pid);
    if (!processStartToken) throw new FleetSafetyError("could not determine fleet coordinator process identity");
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      processStartToken,
      taskId: task.id,
      worktree: worktree.ownershipKey,
      acquiredAt: new Date().toISOString()
    }), "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}

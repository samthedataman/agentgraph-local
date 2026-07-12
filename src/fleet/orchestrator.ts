import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { delegate } from "../adapters/index.js";
import { collectDeclaredArtifacts } from "./artifacts.js";
import { FleetSafetyError } from "./errors.js";
import { boundTaskOutput, buildFleetTaskPrompt } from "./prompt.js";
import type {
  FleetOptions,
  FleetPlan,
  FleetPreview,
  FleetPreviewTask,
  FleetRunResult,
  FleetRuntime,
  FleetTask,
  FleetTaskResult,
  FleetWriterLease,
  ResolvedFleetWorktree
} from "./types.js";
import { parseFleetPlan } from "./validate.js";
import {
  acquireFileWriterLease,
  inspectGitWorktree,
  pathIsInside,
  resolveFleetRoot,
  resolveTaskWorktree,
  validateWriterOrdering
} from "./worktree.js";

interface PreparedFleet {
  plan: FleetPlan;
  worktrees: Map<string, ResolvedFleetWorktree>;
  preview: FleetPreview;
  runtime: FleetRuntime;
}

type StopReason = "external" | "root-timeout" | "fail-fast";
type Isolation = FleetPreviewTask["isolation"];

function runtimeFor(options: FleetOptions): FleetRuntime {
  const environment = options.environment ?? process.env;
  const defaults: FleetRuntime = {
    delegate,
    resolveWorktree: resolveTaskWorktree,
    acquireWriterLease: (worktree, task) => acquireFileWriterLease(worktree, task, environment),
    collectArtifacts: collectDeclaredArtifacts,
    now: () => new Date()
  };
  return { ...defaults, ...options.runtime };
}

function assertRootLaunch(environment: NodeJS.ProcessEnv): void {
  const managedDepth = Number(environment.AGENTGRAPH_MANAGED_DEPTH ?? (environment.AGENTGRAPH_MANAGED === "1" ? "1" : "0"));
  const fleetDepth = Number(environment.AGENTGRAPH_FLEET_DEPTH ?? (environment.AGENTGRAPH_FLEET === "1" ? "1" : "0"));
  if ((Number.isFinite(managedDepth) && managedDepth > 0) || (Number.isFinite(fleetDepth) && fleetDepth > 0)) {
    throw new FleetSafetyError(
      "Nested or self-spawned fleets are disabled. Start a fleet only from a human-controlled root CLI process."
    );
  }
}

function previewTask(task: FleetTask, worktree: ResolvedFleetWorktree, isolation: Isolation): FleetPreviewTask {
  return {
    id: task.id,
    provider: task.provider,
    mode: task.mode,
    depth: task.depth,
    dependsOn: [...task.dependsOn],
    cwd: worktree.cwd,
    ...(task.mode === "writer" ? { ownershipKey: worktree.ownershipKey } : {}),
    timeoutMs: task.timeoutMs,
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}),
    ...(task.allowProviderAutoPermissions !== undefined
      ? { allowProviderAutoPermissions: task.allowProviderAutoPermissions }
      : {}),
    ...(task.allowUnenforcedReadOnly !== undefined
      ? { allowUnenforcedReadOnly: task.allowUnenforcedReadOnly }
      : {}),
    maxOutputBytes: task.maxOutputBytes,
    maxArtifactBytes: task.maxArtifactBytes,
    isolation
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fleet";
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function autoWorktree(rootAnchor: string, planName: string, taskId: string): string {
  return resolve(
    dirname(rootAnchor),
    `${basename(rootAnchor)}-agentgraph-worktrees`,
    slug(planName),
    taskId
  );
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function prepareFleet(value: unknown, options: FleetOptions, allowMissing: boolean): Promise<PreparedFleet> {
  const plan = parseFleetPlan(value);
  const runtime = runtimeFor(options);
  const rootCwd = await resolveFleetRoot(plan.root.cwd, resolve(options.baseCwd ?? process.cwd()));
  const rootGit = await inspectGitWorktree(rootCwd);
  const rootAnchor = rootGit?.topLevel ?? rootCwd;
  const worktrees = new Map<string, ResolvedFleetWorktree>();
  const isolation = new Map<string, Isolation>();
  const missing = new Set<string>();
  const preparationCommands: string[] = [];
  for (const id of plan.topologicalOrder) {
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (!task) continue;
    const requested = task.worktree === "auto"
      ? autoWorktree(rootAnchor, plan.name, task.id)
      : resolve(rootCwd, task.worktree ?? ".");
    if (!(await directoryExists(requested))) {
      if (!allowMissing) {
        throw new FleetSafetyError(
          `task '${task.id}' worktree does not exist: ${requested}. Run fleet --dry-run for a safe git worktree preparation command.`
        );
      }
      if (!rootGit) {
        throw new FleetSafetyError(
          `task '${task.id}' worktree does not exist and root.cwd is not a Git worktree, so AgentGraph cannot scaffold it safely`
        );
      }
      if (pathIsInside(rootGit.topLevel, requested)) {
        throw new FleetSafetyError(
          `task '${task.id}' worktree path is inside the root Git worktree; choose a sibling path or use worktree: 'auto'`
        );
      }
      worktrees.set(task.id, { cwd: requested, ownershipKey: requested });
      isolation.set(task.id, "requires-preparation");
      missing.add(task.id);
      const command = `git -C ${quoteShell(rootGit.topLevel)} worktree add --detach ${quoteShell(requested)} HEAD`;
      if (!preparationCommands.includes(command)) preparationCommands.push(command);
      continue;
    }
    const resolvedTask = task.worktree === "auto" ? { ...task, worktree: requested } : task;
    const worktree = await runtime.resolveWorktree(resolvedTask, rootCwd);
    const taskGit = await inspectGitWorktree(worktree.cwd);

    if (rootGit) {
      const sameRoot = taskGit?.topLevel === rootGit.topLevel;
      const verifiedLinked = taskGit !== undefined &&
        taskGit.topLevel !== rootGit.topLevel &&
        taskGit.commonDir === rootGit.commonDir;
      if (sameRoot) {
        if (task.mode === "read-only") {
          throw new FleetSafetyError(
            `read-only task '${task.id}' resolves inside the root Git worktree '${rootGit.topLevel}'; use a distinct linked worktree`
          );
        }
        if (!plan.root.allowRootWorktreeWrite) {
          throw new FleetSafetyError(
            `writer task '${task.id}' resolves inside the root Git worktree; use a distinct linked worktree or explicitly set root.allowRootWorktreeWrite to true`
          );
        }
        worktrees.set(task.id, { cwd: worktree.cwd, ownershipKey: rootGit.topLevel });
        isolation.set(task.id, "root-write-override");
        continue;
      }
      if (verifiedLinked) {
        if (worktree.cwd !== taskGit.topLevel) {
          throw new FleetSafetyError(
            `task '${task.id}' worktree must point at its Git worktree root '${taskGit.topLevel}', not subdirectory '${worktree.cwd}'`
          );
        }
        worktrees.set(task.id, { cwd: taskGit.topLevel, ownershipKey: taskGit.topLevel });
        isolation.set(task.id, "verified-git-worktree");
        continue;
      }
      if (!plan.root.allowNonGitIsolation) {
        throw new FleetSafetyError(
          `task '${task.id}' path is not a linked worktree of '${rootGit.topLevel}'; create one or explicitly set root.allowNonGitIsolation to true`
        );
      }
      if (pathIsInside(rootGit.topLevel, worktree.cwd)) {
        throw new FleetSafetyError(
          `task '${task.id}' non-Git isolation path is inside the root worktree and cannot be treated as isolated`
        );
      }
      worktrees.set(task.id, worktree);
      isolation.set(task.id, "non-git-override");
      continue;
    }

    if (worktree.cwd === rootCwd) {
      if (task.mode === "read-only") {
        throw new FleetSafetyError(
          `read-only task '${task.id}' resolves to root.cwd; use a distinct isolated directory`
        );
      }
      if (!plan.root.allowRootWorktreeWrite) {
        throw new FleetSafetyError(
          `writer task '${task.id}' resolves to root.cwd; use an isolated directory or explicitly set root.allowRootWorktreeWrite to true`
        );
      }
      worktrees.set(task.id, worktree);
      isolation.set(task.id, "root-write-override");
      continue;
    }
    if (!plan.root.allowNonGitIsolation) {
      throw new FleetSafetyError(
        `root.cwd is not a Git worktree, so isolation cannot be verified; explicitly set root.allowNonGitIsolation to true to accept path-based isolation`
      );
    }
    if (pathIsInside(rootCwd, worktree.cwd)) {
      throw new FleetSafetyError(
        `task '${task.id}' path is inside root.cwd and cannot be treated as isolated`
      );
    }
    worktrees.set(task.id, worktree);
    isolation.set(task.id, "non-git-override");
  }
  validateWriterOrdering(plan, worktrees);
  const warnings = [...plan.warnings];
  if (plan.tasks.some((task) => task.mode === "read-only")) {
    warnings.push("Read-only is a declared worker policy, not an operating-system sandbox. It requires an isolated non-root worktree and allowUnenforcedReadOnly: true.");
  }
  if (plan.root.allowNonGitIsolation) {
    warnings.push("root.allowNonGitIsolation is enabled: path separation is accepted without linked Git worktree verification.");
  }
  if (plan.root.allowRootWorktreeWrite) {
    warnings.push("root.allowRootWorktreeWrite is enabled: a writer may mutate the root checkout when its task selects that path.");
  }
  const preview: FleetPreview = {
    schema: "agentgraph.fleet-preview/1",
    version: plan.version,
    name: plan.name,
    root: { ...plan.root, cwd: rootCwd },
    waves: plan.waves.map((wave) => [...wave]),
    tasks: plan.topologicalOrder.map((id) => {
      const task = plan.tasks.find((candidate) => candidate.id === id);
      const worktree = worktrees.get(id);
      if (!task || !worktree) throw new FleetSafetyError(`internal fleet preparation failure for task '${id}'`);
      return previewTask(task, worktree, isolation.get(id) ?? "non-git-override");
    }),
    warnings,
    preparationCommands,
    executionNotes: [
      "fleet run consumes existing worktrees only.",
      "AgentGraph will not create, merge, or delete Git worktrees.",
      ...(missing.size > 0 ? ["Run every preparation command, inspect the worktrees, then run the fleet again."] : [])
    ]
  };
  return { plan, worktrees, preview, runtime };
}

export async function previewFleet(value: unknown, options: FleetOptions = {}): Promise<FleetPreview> {
  return (await prepareFleet(value, options, true)).preview;
}

function emptyResult(
  task: FleetTask,
  status: "cancelled" | "skipped",
  error: string
): FleetTaskResult {
  return {
    id: task.id,
    provider: task.provider,
    mode: task.mode,
    status,
    finalResponse: "",
    stderr: "",
    outputTruncated: false,
    artifacts: [],
    error,
    durationMs: 0
  };
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= 4_096 ? value : buffer.subarray(0, 4_096).toString("utf8");
}

async function executeTask(
  task: FleetTask,
  worktree: ResolvedFleetWorktree,
  dependencyResults: FleetTaskResult[],
  rootSignal: AbortSignal,
  runtime: FleetRuntime
): Promise<FleetTaskResult> {
  const started = runtime.now().getTime();
  let lease: FleetWriterLease | undefined;
  let taskTimedOut = false;
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(rootSignal.reason);
  if (rootSignal.aborted) forwardAbort();
  else rootSignal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    taskTimedOut = true;
    controller.abort(new Error(`task '${task.id}' exceeded timeoutMs ${task.timeoutMs}`));
  }, task.timeoutMs);
  timeout.unref();

  try {
    if (task.mode === "writer") lease = await runtime.acquireWriterLease(worktree, task);
    if (controller.signal.aborted) {
      if (taskTimedOut) {
        return {
          id: task.id,
          provider: task.provider,
          mode: task.mode,
          status: "timed-out",
          finalResponse: "",
          stderr: "",
          outputTruncated: false,
          artifacts: [],
          error: `task exceeded timeoutMs ${task.timeoutMs}`,
          durationMs: Math.max(0, runtime.now().getTime() - started)
        };
      }
      return emptyResult(task, "cancelled", message(controller.signal.reason ?? "cancelled"));
    }
    const result = await runtime.delegate({
      provider: task.provider,
      prompt: buildFleetTaskPrompt(task, worktree, dependencyResults),
      cwd: worktree.cwd,
      timeoutMs: task.timeoutMs,
      ...(task.model ? { model: task.model } : {}),
      ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
      ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}),
      ...(task.allowProviderAutoPermissions !== undefined
        ? { allowProviderAutoPermissions: task.allowProviderAutoPermissions }
        : {}),
      maxCapturedBytes: task.maxOutputBytes,
      signal: controller.signal
    });
    const bounded = boundTaskOutput(result.finalResponse, result.stderr, task.maxOutputBytes);
    if (taskTimedOut) {
      return {
        id: task.id,
        provider: task.provider,
        mode: task.mode,
        status: "timed-out",
        exitCode: result.exitCode,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        finalResponse: bounded.finalResponse,
        stderr: bounded.stderr,
        outputTruncated: bounded.truncated,
        artifacts: [],
        error: `task exceeded timeoutMs ${task.timeoutMs}`,
        durationMs: Math.max(0, runtime.now().getTime() - started)
      };
    }
    if (rootSignal.aborted) {
      return {
        ...emptyResult(task, "cancelled", message(rootSignal.reason ?? "fleet cancelled")),
        exitCode: result.exitCode,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        finalResponse: bounded.finalResponse,
        stderr: bounded.stderr,
        outputTruncated: bounded.truncated,
        durationMs: Math.max(0, runtime.now().getTime() - started)
      };
    }
    if (result.exitCode !== 0) {
      return {
        id: task.id,
        provider: task.provider,
        mode: task.mode,
        status: "failed",
        exitCode: result.exitCode,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        finalResponse: bounded.finalResponse,
        stderr: bounded.stderr,
        outputTruncated: bounded.truncated,
        artifacts: [],
        error: `managed ${task.provider} process exited with code ${result.exitCode}`,
        durationMs: Math.max(0, runtime.now().getTime() - started)
      };
    }
    const artifacts = await runtime.collectArtifacts(worktree, task.artifacts, task.maxArtifactBytes);
    return {
      id: task.id,
      provider: task.provider,
      mode: task.mode,
      status: "succeeded",
      exitCode: result.exitCode,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      finalResponse: bounded.finalResponse,
      stderr: bounded.stderr,
      outputTruncated: bounded.truncated,
      artifacts,
      durationMs: Math.max(0, runtime.now().getTime() - started)
    };
  } catch (error) {
    const status = taskTimedOut ? "timed-out" : rootSignal.aborted ? "cancelled" : "failed";
    return {
      id: task.id,
      provider: task.provider,
      mode: task.mode,
      status,
      finalResponse: "",
      stderr: "",
      outputTruncated: false,
      artifacts: [],
      error: message(error),
      durationMs: Math.max(0, runtime.now().getTime() - started)
    };
  } finally {
    clearTimeout(timeout);
    rootSignal.removeEventListener("abort", forwardAbort);
    await lease?.release();
  }
}

function isDependencyFailure(result: FleetTaskResult | undefined): boolean {
  return result !== undefined && result.status !== "succeeded";
}

export async function runFleet(value: unknown, options: FleetOptions = {}): Promise<FleetRunResult> {
  assertRootLaunch(options.environment ?? process.env);
  const prepared = await prepareFleet(value, options, false);
  const { plan, worktrees, runtime } = prepared;
  const startedDate = runtime.now();
  const rootController = new AbortController();
  let stopReason: StopReason | undefined;
  const abortFromCaller = (): void => {
    stopReason = "external";
    rootController.abort(options.signal?.reason ?? new Error("fleet cancelled by caller"));
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const rootTimeout = setTimeout(() => {
    if (rootController.signal.aborted) return;
    stopReason = "root-timeout";
    rootController.abort(new Error(`fleet exceeded root.timeoutMs ${plan.root.timeoutMs}`));
  }, plan.root.timeoutMs);
  rootTimeout.unref();

  const results = new Map<string, FleetTaskResult>();
  const running = new Map<string, Promise<{ id: string; result: FleetTaskResult }>>();

  const launch = (task: FleetTask): void => {
    const worktree = worktrees.get(task.id);
    if (!worktree) throw new FleetSafetyError(`missing worktree for task '${task.id}'`);
    const dependencies = task.dependsOn
      .map((id) => results.get(id))
      .filter((result): result is FleetTaskResult => result !== undefined);
    const promise = executeTask(task, worktree, dependencies, rootController.signal, runtime)
      .then((result) => ({ id: task.id, result }))
      .catch((error: unknown) => ({
        id: task.id,
        result: {
          id: task.id,
          provider: task.provider,
          mode: task.mode,
          status: rootController.signal.aborted ? "cancelled" as const : "failed" as const,
          finalResponse: "",
          stderr: "",
          outputTruncated: false,
          artifacts: [],
          error: `task orchestration failure: ${message(error)}`,
          durationMs: 0
        }
      }));
    running.set(task.id, promise);
  };

  try {
    while (results.size < plan.tasks.length) {
      if (rootController.signal.aborted && running.size === 0) {
        for (const task of [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
          if (results.has(task.id)) continue;
          results.set(task.id, emptyResult(
            task,
            stopReason === "fail-fast" ? "skipped" : "cancelled",
            stopReason === "fail-fast" ? "not started because fail-fast stopped the fleet" : "not started because the fleet was cancelled"
          ));
        }
        break;
      }

      for (const task of [...plan.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
        if (results.has(task.id) || running.has(task.id)) continue;
        const dependencies = task.dependsOn.map((id) => results.get(id));
        if (dependencies.some(isDependencyFailure)) {
          results.set(task.id, emptyResult(task, "skipped", "one or more dependencies did not succeed"));
        }
      }

      if (!rootController.signal.aborted) {
        const ready = plan.tasks
          .filter((task) => !results.has(task.id) && !running.has(task.id))
          .filter((task) => task.dependsOn.every((id) => results.get(id)?.status === "succeeded"))
          .sort((a, b) => a.id.localeCompare(b.id));
        while (running.size < plan.root.maxConcurrency && ready.length > 0) {
          const task = ready.shift();
          if (task) launch(task);
        }
      }

      if (running.size === 0) {
        if (results.size < plan.tasks.length) {
          for (const task of plan.tasks) {
            if (!results.has(task.id)) results.set(task.id, emptyResult(task, "skipped", "task could not be scheduled"));
          }
        }
        break;
      }

      const completed = await Promise.race(running.values());
      running.delete(completed.id);
      results.set(completed.id, completed.result);
      if (
        plan.root.failFast &&
        !rootController.signal.aborted &&
        (completed.result.status === "failed" || completed.result.status === "timed-out")
      ) {
        stopReason = "fail-fast";
        rootController.abort(new Error(`task '${completed.id}' failed; fail-fast cancelled the remaining fleet`));
      }
    }
    if (running.size > 0) {
      const settled = await Promise.all(running.values());
      for (const completed of settled) results.set(completed.id, completed.result);
    }
  } finally {
    clearTimeout(rootTimeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  const orderedResults = [...results.values()].sort((left, right) => left.id.localeCompare(right.id));
  const summary = {
    total: orderedResults.length,
    succeeded: orderedResults.filter((task) => task.status === "succeeded").length,
    failed: orderedResults.filter((task) => task.status === "failed").length,
    cancelled: orderedResults.filter((task) => task.status === "cancelled").length,
    timedOut: orderedResults.filter((task) => task.status === "timed-out").length,
    skipped: orderedResults.filter((task) => task.status === "skipped").length
  };
  const finishedDate = runtime.now();
  const status: FleetRunResult["status"] = stopReason === "root-timeout"
    ? "timed-out"
    : stopReason === "external"
      ? "cancelled"
      : summary.failed + summary.timedOut + summary.skipped + summary.cancelled > 0
        ? "failed"
        : "succeeded";
  return {
    schema: "agentgraph.fleet-result/1",
    version: plan.version,
    name: plan.name,
    status,
    startedAt: startedDate.toISOString(),
    finishedAt: finishedDate.toISOString(),
    durationMs: Math.max(0, finishedDate.getTime() - startedDate.getTime()),
    summary,
    tasks: orderedResults,
    warnings: prepared.preview.warnings
  };
}

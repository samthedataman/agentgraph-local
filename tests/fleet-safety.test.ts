import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegateOptions, DelegateResult } from "../src/adapters/index.js";
import { collectDeclaredArtifacts } from "../src/fleet/artifacts.js";
import { previewFleet, runFleet } from "../src/fleet/index.js";
import { acquireFileWriterLease } from "../src/fleet/worktree.js";
import type { FleetTask, ResolvedFleetWorktree } from "../src/fleet/types.js";

function delegateResult(options: DelegateOptions, exitCode = 0): DelegateResult {
  return {
    provider: options.provider,
    finalResponse: "done",
    exitCode,
    durationMs: 1,
    events: [],
    stderr: ""
  };
}

function writer(id: string, worktree: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    objective: `Complete ${id}`,
    provider: "claude",
    mode: "writer",
    worktree,
    ...overrides
  };
}

function plan(root: string, tasks: Record<string, unknown>[], overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    name: "safety-test",
    root: { cwd: root, allowNonGitIsolation: true, ...overrides },
    tasks
  };
}

describe("fleet safety boundaries", () => {
  it("captures declared artifacts within the byte boundary and rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentgraph-artifacts-"));
    await writeFile(join(root, "report.txt"), "hello", "utf8");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 2]));
    const worktree = { cwd: root, ownershipKey: root };
    const captured = await collectDeclaredArtifacts(worktree, ["binary.bin", "report.txt"], 100);
    expect(captured.map((artifact) => artifact.path)).toEqual(["binary.bin", "report.txt"]);
    expect(captured.find((artifact) => artifact.path === "report.txt")?.encoding).toBe("utf8");
    expect(captured.find((artifact) => artifact.path === "binary.bin")?.encoding).toBe("base64");

    await expect(collectDeclaredArtifacts(worktree, ["/etc/passwd"], 100)).rejects.toThrow("must be relative");
    await expect(collectDeclaredArtifacts(worktree, ["../outside"], 100)).rejects.toThrow("does not exist");
    await expect(collectDeclaredArtifacts(worktree, ["report.txt"], 4)).rejects.toThrow("maxArtifactBytes");
    await symlink(join(root, "report.txt"), join(root, "link.txt"));
    await expect(collectDeclaredArtifacts(worktree, ["link.txt"], 100)).rejects.toThrow("symbolic-link");
  });

  it("uses an exclusive cross-process writer lease and permits reacquisition after release", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-lock-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "agentgraph-lock-worktree-"));
    const worktree: ResolvedFleetWorktree = { cwd, ownershipKey: cwd };
    const task = {
      id: "writer",
      objective: "Write",
      provider: "claude",
      dependsOn: [],
      mode: "writer",
      worktree: cwd,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      maxArtifactBytes: 1_024,
      artifacts: [],
      depth: 1
    } satisfies FleetTask;
    const first = await acquireFileWriterLease(worktree, task, { AGENTGRAPH_HOME: home });
    await expect(acquireFileWriterLease(worktree, task, { AGENTGRAPH_HOME: home }))
      .rejects.toThrow("already owned by another fleet");
    await first.release();
    const second = await acquireFileWriterLease(worktree, task, { AGENTGRAPH_HOME: home });
    await second.release();
  });

  it("recovers a writer lease only when PID birth identity proves it is stale", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentgraph-stale-lock-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "agentgraph-stale-lock-worktree-"));
    const worktree: ResolvedFleetWorktree = { cwd, ownershipKey: cwd };
    const task = {
      id: "writer",
      objective: "Write",
      provider: "claude",
      dependsOn: [],
      mode: "writer",
      worktree: cwd,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      maxArtifactBytes: 1_024,
      artifacts: [],
      depth: 1
    } satisfies FleetTask;
    const lockDirectory = join(home, "fleet-locks");
    await mkdir(lockDirectory, { recursive: true });
    const key = createHash("sha256").update(cwd).digest("hex");
    await writeFile(join(lockDirectory, `${key}.lock`), JSON.stringify({
      pid: 999_999_999,
      processStartToken: "ps_definitely-stale",
      taskId: "dead"
    }), "utf8");
    const lease = await acquireFileWriterLease(worktree, task, { AGENTGRAPH_HOME: home });
    await lease.release();
  });

  it("rejects root writes by default and requires the explicit root override", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentgraph-root-write-"));
    const value = plan(root, [writer("root-write", ".")]);
    await expect(previewFleet(value, { environment: {} })).rejects.toThrow("allowRootWorktreeWrite");
    const preview = await previewFleet(plan(root, [writer("root-write", ".")], {
      allowRootWorktreeWrite: true,
      allowNonGitIsolation: false
    }), { environment: {} });
    expect(preview.tasks[0]?.isolation).toBe("root-write-override");
  });

  it("never permits an unenforced read-only task to use root.cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentgraph-root-read-"));
    const value = plan(root, [{
      id: "audit",
      objective: "Audit",
      provider: "claude",
      mode: "read-only",
      worktree: ".",
      allowUnenforcedReadOnly: true
    }], { allowRootWorktreeWrite: true });
    await expect(previewFleet(value, { environment: {} })).rejects.toThrow("read-only task 'audit' resolves to root.cwd");
  });

  it("cancels active siblings and skips pending tasks on fail-fast", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentgraph-failfast-"));
    const root = join(parent, "root");
    const bad = join(parent, "bad");
    const slow = join(parent, "slow");
    const pending = join(parent, "pending");
    await Promise.all([mkdir(root), mkdir(bad), mkdir(slow), mkdir(pending)]);
    const output = await runFleet(plan(root, [
      writer("bad", bad),
      writer("slow", slow),
      writer("pending", pending, { dependsOn: ["slow"] })
    ], { maxConcurrency: 2, failFast: true }), {
      environment: {},
      runtime: {
        acquireWriterLease: async () => ({ release: async () => undefined }),
        collectArtifacts: async () => [],
        delegate: async (options) => {
          if (options.prompt.includes("Fleet task: bad")) return delegateResult(options, 2);
          return await new Promise<DelegateResult>((resolvePromise) => {
            options.signal?.addEventListener("abort", () => resolvePromise(delegateResult(options, 130)), { once: true });
          });
        }
      }
    });
    expect(output.status).toBe("failed");
    expect(output.tasks.find((task) => task.id === "bad")?.status).toBe("failed");
    expect(output.tasks.find((task) => task.id === "slow")?.status).toBe("cancelled");
    expect(output.tasks.find((task) => task.id === "pending")?.status).toBe("skipped");
  });

  it("passes Claude per-task turn and budget ceilings to the managed adapter", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentgraph-provider-limits-"));
    const root = join(parent, "root");
    const worktree = join(parent, "worktree");
    await Promise.all([mkdir(root), mkdir(worktree)]);
    let observed: DelegateOptions | undefined;
    const output = await runFleet(plan(root, [writer("limited", worktree, {
      maxTurns: 3,
      maxBudgetUsd: 1.25,
      timeoutMs: 2345
    })], { maxBudgetUsd: 1.25 }), {
      environment: {},
      runtime: {
        acquireWriterLease: async () => ({ release: async () => undefined }),
        collectArtifacts: async () => [],
        delegate: async (options) => {
          observed = options;
          return delegateResult(options);
        }
      }
    });
    expect(output.status).toBe("succeeded");
    expect(observed?.maxTurns).toBe(3);
    expect(observed?.maxBudgetUsd).toBe(1.25);
    expect(observed?.timeoutMs).toBe(2345);
  });
});

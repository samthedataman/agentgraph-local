import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { DelegateOptions, DelegateResult } from "../src/adapters/index.js";
import {
  FleetSafetyError,
  FleetValidationError,
  previewFleet,
  runFleet,
  type FleetArtifact,
  type FleetOptions,
  type FleetRuntime
} from "../src/fleet/index.js";

const execFileAsync = promisify(execFile);

interface Layout {
  root: string;
  worktrees: Record<string, string>;
}

async function layout(ids: string[]): Promise<Layout> {
  const parent = await mkdtemp(join(tmpdir(), "agentgraph-fleet-"));
  const root = join(parent, "root");
  await mkdir(root);
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const path = join(parent, id);
    await mkdir(path);
    worktrees[id] = path;
  }
  return { root, worktrees };
}

function task(id: string, path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    objective: `Complete ${id}`,
    provider: "claude",
    mode: "writer",
    worktree: path,
    timeoutMs: 1_000,
    ...overrides
  };
}

function plan(root: string, tasks: Record<string, unknown>[], overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    name: "orchestrator-test",
    root: {
      cwd: root,
      timeoutMs: 5_000,
      maxConcurrency: 3,
      allowNonGitIsolation: true,
      ...overrides
    },
    tasks
  };
}

function result(options: DelegateOptions, response = options.prompt, exitCode = 0): DelegateResult {
  return {
    provider: options.provider,
    finalResponse: response,
    exitCode,
    durationMs: 1,
    events: [],
    stderr: ""
  };
}

function options(delegate: FleetRuntime["delegate"], extra: Partial<FleetRuntime> = {}): FleetOptions {
  return {
    environment: {},
    runtime: {
      delegate,
      acquireWriterLease: async () => ({ release: async () => undefined }),
      collectArtifacts: async () => [],
      ...extra
    }
  };
}

describe("fleet orchestration", () => {
  it("honors dependencies, caps concurrency, and aggregates results in task-id order", async () => {
    const paths = await layout(["a", "b", "c"]);
    let active = 0;
    let peak = 0;
    const prompts = new Map<string, string>();
    const delegate = async (input: DelegateOptions): Promise<DelegateResult> => {
      active += 1;
      peak = Math.max(peak, active);
      const id = input.cwd.split("/").at(-1) ?? "unknown";
      prompts.set(id, input.prompt);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      active -= 1;
      return result(input, `result-${id}`);
    };
    const output = await runFleet(plan(paths.root, [
      task("c", paths.worktrees.c as string, { dependsOn: ["a", "b"] }),
      task("b", paths.worktrees.b as string),
      task("a", paths.worktrees.a as string)
    ], { maxConcurrency: 2 }), options(delegate));

    expect(peak).toBe(2);
    expect(output.status).toBe("succeeded");
    expect(output.tasks.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(prompts.get("c")).toContain("result-a");
    expect(prompts.get("c")).toContain("result-b");
    expect(prompts.get("c")).toContain("Do not spawn, delegate to, or launch another agent");
  });

  it("rejects unordered writers sharing one ownership key", async () => {
    const paths = await layout(["shared"]);
    const value = plan(paths.root, [
      task("a", paths.worktrees.shared as string),
      task("b", paths.worktrees.shared as string)
    ]);
    await expect(previewFleet(value, options(async (input) => result(input))))
      .rejects.toThrow("share worktree");
  });

  it("rejects an unordered reader and writer sharing one ownership key", async () => {
    const paths = await layout(["shared"]);
    const value = plan(paths.root, [
      task("writer", paths.worktrees.shared as string),
      task("reader", paths.worktrees.shared as string, {
        mode: "read-only",
        allowUnenforcedReadOnly: true
      })
    ]);
    await expect(previewFleet(value, options(async (input) => result(input))))
      .rejects.toThrow("writer access but no dependency");
  });

  it("allows dependency-ordered writers to share a worktree and never overlaps leases", async () => {
    const paths = await layout(["shared"]);
    let leased = false;
    const order: string[] = [];
    const output = await runFleet(plan(paths.root, [
      task("a", paths.worktrees.shared as string),
      task("b", paths.worktrees.shared as string, { dependsOn: ["a"] })
    ]), options(
      async (input) => {
        order.push(input.prompt.includes("Fleet task: a") ? "a" : "b");
        return result(input, "done");
      },
      {
        acquireWriterLease: async () => {
          expect(leased).toBe(false);
          leased = true;
          return { release: async () => { leased = false; } };
        }
      }
    ));
    expect(output.status).toBe("succeeded");
    expect(order).toEqual(["a", "b"]);
    expect(leased).toBe(false);
  });

  it("skips failed dependents while continuing unrelated work when failFast is false", async () => {
    const paths = await layout(["bad", "dependent", "independent"]);
    const output = await runFleet(plan(paths.root, [
      task("bad", paths.worktrees.bad as string),
      task("dependent", paths.worktrees.dependent as string, { dependsOn: ["bad"] }),
      task("independent", paths.worktrees.independent as string)
    ], { failFast: false }), options(async (input) => {
      const failed = input.prompt.includes("Fleet task: bad");
      return result(input, failed ? "failed" : "ok", failed ? 2 : 0);
    }));

    expect(output.status).toBe("failed");
    expect(output.tasks.find((entry) => entry.id === "bad")?.status).toBe("failed");
    expect(output.tasks.find((entry) => entry.id === "dependent")?.status).toBe("skipped");
    expect(output.tasks.find((entry) => entry.id === "independent")?.status).toBe("succeeded");
  });

  it("propagates caller cancellation to running tasks", async () => {
    const paths = await layout(["slow"]);
    const controller = new AbortController();
    const run = runFleet(plan(paths.root, [task("slow", paths.worktrees.slow as string)]), {
      ...options(async (input) => await new Promise<DelegateResult>((resolvePromise) => {
        input.signal?.addEventListener("abort", () => resolvePromise(result(input, "cancelled", 130)), { once: true });
      })),
      signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 20);
    const output = await run;
    expect(output.status).toBe("cancelled");
    expect(output.tasks[0]?.status).toBe("cancelled");
  });

  it("enforces per-task and root timeouts through abort propagation", async () => {
    const paths = await layout(["task-timeout", "root-timeout"]);
    const waitForAbort = async (input: DelegateOptions): Promise<DelegateResult> => await new Promise((resolvePromise) => {
      input.signal?.addEventListener("abort", () => resolvePromise(result(input, "stopped", 143)), { once: true });
    });
    const taskOutput = await runFleet(plan(paths.root, [
      task("task-timeout", paths.worktrees["task-timeout"] as string, { timeoutMs: 20 })
    ]), options(waitForAbort));
    expect(taskOutput.tasks[0]?.status).toBe("timed-out");

    const rootOutput = await runFleet(plan(paths.root, [
      task("root-timeout", paths.worktrees["root-timeout"] as string, { timeoutMs: 500 })
    ], { timeoutMs: 20 }), options(waitForAbort));
    expect(rootOutput.status).toBe("timed-out");
    expect(rootOutput.tasks[0]?.status).toBe("cancelled");
  });

  it("bounds returned text and collects only through the injected artifact contract", async () => {
    const paths = await layout(["bounded"]);
    const artifact: FleetArtifact = {
      path: "report.txt",
      sizeBytes: 2,
      capturedBytes: 2,
      encoding: "utf8",
      content: "ok",
      sha256: "hash"
    };
    const output = await runFleet(plan(paths.root, [
      task("bounded", paths.worktrees.bounded as string, {
        maxOutputBytes: 1_024,
        artifacts: ["report.txt"]
      })
    ], { maxOutputBytes: 1_024 }), options(
      async (input) => result(input, "x".repeat(4_096)),
      { collectArtifacts: async () => [artifact] }
    ));
    const taskOutput = output.tasks[0];
    expect(Buffer.byteLength(taskOutput?.finalResponse ?? "")).toBeLessThanOrEqual(1_024);
    expect(taskOutput?.outputTruncated).toBe(true);
    expect(taskOutput?.artifacts).toEqual([artifact]);
  });

  it("refuses nested managed or fleet launches before delegating", async () => {
    const paths = await layout(["nested"]);
    let calls = 0;
    const delegate = async (input: DelegateOptions): Promise<DelegateResult> => {
      calls += 1;
      return result(input);
    };
    await expect(runFleet(plan(paths.root, [task("nested", paths.worktrees.nested as string)]), {
      ...options(delegate),
      environment: { AGENTGRAPH_MANAGED_DEPTH: "1" }
    })).rejects.toBeInstanceOf(FleetSafetyError);
    await expect(runFleet(plan(paths.root, [task("nested", paths.worktrees.nested as string)]), {
      ...options(delegate),
      environment: { AGENTGRAPH_FLEET_DEPTH: "2" }
    })).rejects.toThrow("Nested or self-spawned fleets");
    expect(calls).toBe(0);
  });

  it("requires Kimi permission opt-in and passes it to delegation", async () => {
    const paths = await layout(["kimi"]);
    let observed: boolean | undefined;
    const output = await runFleet(plan(paths.root, [
      task("kimi", paths.worktrees.kimi as string, {
        provider: "kimi",
        allowProviderAutoPermissions: true
      })
    ]), options(async (input) => {
      observed = input.allowProviderAutoPermissions;
      return result(input, "kimi done");
    }));
    expect(output.status).toBe("succeeded");
    expect(observed).toBe(true);
  });

  it("dry-runs missing auto worktrees as commands and never creates them", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentgraph-git-fleet-"));
    const root = join(parent, "repo");
    await mkdir(root);
    await execFileAsync("git", ["init", "-q", root]);
    await writeFile(join(root, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "README.md"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=AgentGraph", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
    const value = plan(root, [task("auto-task", "auto")], { allowNonGitIsolation: false });

    const preview = await previewFleet(value, { environment: {} });
    expect(preview.tasks[0]?.isolation).toBe("requires-preparation");
    expect(preview.preparationCommands).toHaveLength(1);
    expect(preview.preparationCommands[0]).toContain("worktree add --detach");
    expect(preview.executionNotes.join(" ")).toContain("will not create, merge, or delete");
    await expect(runFleet(value, { environment: {} })).rejects.toThrow("does not exist");
  });

  it("verifies an existing path is a distinct linked Git worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentgraph-linked-fleet-"));
    const root = join(parent, "repo");
    const linked = join(parent, "linked");
    await mkdir(root);
    await execFileAsync("git", ["init", "-q", root]);
    await writeFile(join(root, "README.md"), "fixture\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "README.md"]);
    await execFileAsync("git", ["-C", root, "-c", "user.name=AgentGraph", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);
    await execFileAsync("git", ["-C", root, "worktree", "add", "--detach", linked, "HEAD"]);
    const preview = await previewFleet(plan(root, [task("linked", linked)], { allowNonGitIsolation: false }), { environment: {} });
    expect(preview.tasks[0]?.isolation).toBe("verified-git-worktree");
    expect(preview.preparationCommands).toEqual([]);
  });

  it("rejects a root subdirectory presented as an isolated worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agentgraph-root-subdir-"));
    const root = join(parent, "repo");
    const subdir = join(root, "subdir");
    await mkdir(root);
    await mkdir(subdir);
    await execFileAsync("git", ["init", "-q", root]);
    await expect(previewFleet(plan(root, [task("unsafe", subdir)], { allowNonGitIsolation: true }), { environment: {} }))
      .rejects.toThrow("inside the root Git worktree");
  });
});

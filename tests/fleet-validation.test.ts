import { describe, expect, it } from "vitest";
import { FleetValidationError, parseFleetPlan } from "../src/fleet/index.js";

function writer(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    objective: `Complete ${id}`,
    provider: "claude",
    mode: "writer",
    worktree: `/tmp/${id}`,
    ...overrides
  };
}

function plan(tasks: Record<string, unknown>[], root: Record<string, unknown> = {}): unknown {
  return { version: 1, name: "test-fleet", root, tasks };
}

function issues(value: unknown): string {
  try {
    parseFleetPlan(value);
    return "";
  } catch (error) {
    expect(error).toBeInstanceOf(FleetValidationError);
    return (error as Error).message;
  }
}

describe("fleet plan validation", () => {
  it("normalizes a DAG into deterministic topological waves", () => {
    const parsed = parseFleetPlan(plan([
      writer("implement", { dependsOn: ["design"] }),
      writer("verify", { dependsOn: ["implement"] }),
      writer("design", { mode: "read-only", allowUnenforcedReadOnly: true })
    ], { maxConcurrency: 2 }));

    expect(parsed.topologicalOrder).toEqual(["design", "implement", "verify"]);
    expect(parsed.waves).toEqual([["design"], ["implement"], ["verify"]]);
    expect(parsed.tasks.map((task) => task.depth)).toEqual([2, 3, 1]);
    expect(parsed.tasks.reduce((total, task) => total + task.maxOutputBytes, 0))
      .toBeLessThanOrEqual(parsed.root.maxOutputBytes);
  });

  it("rejects duplicate ids, unknown dependencies, self-dependencies, and cycles", () => {
    expect(issues(plan([writer("same"), writer("same")]))).toContain("duplicate task id 'same'");
    expect(issues(plan([writer("one", { dependsOn: ["missing"] })]))).toContain("unknown task 'missing'");
    expect(issues(plan([writer("one", { dependsOn: ["one"] })]))).toContain("cannot depend on itself");
    expect(issues(plan([
      writer("one", { dependsOn: ["two"] }),
      writer("two", { dependsOn: ["one"] })
    ]))).toContain("contains a cycle");
  });

  it("enforces task count, depth, concurrency, timeout, and capture hard limits", () => {
    expect(issues(plan([writer("one"), writer("two")], { maxTasks: 1 }))).toContain("exceeding root.maxTasks 1");
    expect(issues(plan([
      writer("one"),
      writer("two", { dependsOn: ["one"] })
    ], { maxDepth: 1 }))).toContain("depth 2 exceeds root.maxDepth 1");
    expect(issues(plan([writer("one")], { maxConcurrency: 17 }))).toContain("hard limit");
    expect(issues(plan([writer("one", { timeoutMs: 99_999_999 })]))).toContain("timeoutMs exceeds");
    expect(issues(plan([writer("one", { maxOutputBytes: 99_999_999 })]))).toContain("maxOutputBytes exceeds");
  });

  it("requires explicit unenforced read-only acknowledgement and a worktree", () => {
    expect(issues(plan([{
      id: "audit",
      objective: "Audit",
      provider: "claude",
      mode: "read-only"
    }]))).toContain("allowUnenforcedReadOnly must be true");
    expect(issues(plan([{
      id: "audit",
      objective: "Audit",
      provider: "claude",
      mode: "read-only",
      allowUnenforcedReadOnly: true
    }]))).toContain("worktree is required for read-only tasks");
  });

  it("requires an explicit Kimi auto-permission acknowledgement", () => {
    expect(issues(plan([writer("kimi-task", { provider: "kimi" })])))
      .toContain("allowProviderAutoPermissions must be true for Kimi");
    const parsed = parseFleetPlan(plan([
      writer("kimi-task", { provider: "kimi", allowProviderAutoPermissions: true })
    ]));
    expect(parsed.tasks[0]?.provider).toBe("kimi");
    expect(parsed.warnings.join(" ")).toContain("Kimi non-interactive");
  });

  it("fails closed when a provider cannot enforce turns or USD budgets", () => {
    expect(issues(plan([writer("codex-task", { provider: "codex", maxTurns: 2 })])))
      .toContain("cannot be guaranteed by the current Codex CLI adapter");
    expect(issues(plan([
      writer("kimi-task", { provider: "kimi", allowProviderAutoPermissions: true, maxBudgetUsd: 1 })
    ]))).toContain("cannot be guaranteed by the current Kimi CLI adapter");
  });

  it("treats a root budget as the sum of mandatory provider-enforced task ceilings", () => {
    expect(issues(plan([writer("one")], { maxBudgetUsd: 2 }))).toContain("requires every task");
    expect(issues(plan([
      writer("one", { maxBudgetUsd: 2 }),
      writer("two", { maxBudgetUsd: 2 })
    ], { maxBudgetUsd: 3 }))).toContain("exceeds root.maxBudgetUsd");
    const parsed = parseFleetPlan(plan([
      writer("one", { maxBudgetUsd: 1 }),
      writer("two", { maxBudgetUsd: 2 })
    ], { maxBudgetUsd: 3 }));
    expect(parsed.root.maxBudgetUsd).toBe(3);
  });

  it("rejects unsupported fields rather than silently ignoring them", () => {
    expect(issues({
      version: 1,
      name: "bad",
      surprise: true,
      tasks: [writer("one", { mystery: 1 })]
    })).toContain("unsupported field 'surprise'");
    expect(issues({
      version: 1,
      name: "bad",
      surprise: true,
      tasks: [writer("one", { mystery: 1 })]
    })).toContain("unsupported field 'mystery'");
  });
});

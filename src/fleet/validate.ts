import { FleetValidationError } from "./errors.js";
import {
  FLEET_PLAN_VERSION,
  type FleetPlan,
  type FleetRoot,
  type FleetTask,
  type FleetTaskInput
} from "./types.js";

export const FLEET_HARD_LIMITS = Object.freeze({
  maxTasks: 64,
  maxDepth: 16,
  maxConcurrency: 16,
  timeoutMs: 24 * 60 * 60 * 1_000,
  taskTimeoutMs: 12 * 60 * 60 * 1_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 32 * 1024 * 1024,
  maxObjectiveBytes: 32 * 1024,
  maxArtifactsPerTask: 64
});

const DEFAULTS = Object.freeze({
  maxTasks: 32,
  maxDepth: 8,
  maxConcurrency: 4,
  timeoutMs: 30 * 60 * 1_000,
  taskTimeoutMs: 15 * 60 * 1_000,
  maxOutputBytes: 1024 * 1024,
  maxArtifactBytes: 4 * 1024 * 1024,
  taskOutputBytes: 64 * 1024,
  taskArtifactBytes: 512 * 1024
});

const TASK_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositiveInteger(value: unknown, label: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push(`${label} must be a positive integer`);
    return undefined;
  }
  return value;
}

function finitePositiveNumber(value: unknown, label: string, issues: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`${label} must be a positive finite number`);
    return undefined;
  }
  return value;
}

function optionalString(value: unknown, label: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function requiredString(value: unknown, label: string, issues: string[]): string | undefined {
  if (value === undefined) {
    issues.push(`${label} is required`);
    return undefined;
  }
  return optionalString(value, label, issues);
}

function unknownKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string, issues: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${label} contains unsupported field '${key}'`);
  }
}

function parseTask(value: unknown, index: number, issues: string[]): FleetTaskInput | undefined {
  const label = `tasks[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${label} must be an object`);
    return undefined;
  }
  unknownKeys(value, new Set([
    "id", "objective", "provider", "dependsOn", "mode", "worktree", "model", "timeoutMs",
    "maxTurns", "maxBudgetUsd", "allowProviderAutoPermissions", "allowUnenforcedReadOnly",
    "maxOutputBytes", "maxArtifactBytes", "artifacts"
  ]), label, issues);

  const id = requiredString(value.id, `${label}.id`, issues);
  if (id && !TASK_ID.test(id)) {
    issues.push(`${label}.id must match ${TASK_ID.source}`);
  }
  const objective = requiredString(value.objective, `${label}.objective`, issues);
  if (objective && Buffer.byteLength(objective, "utf8") > FLEET_HARD_LIMITS.maxObjectiveBytes) {
    issues.push(`${label}.objective exceeds ${FLEET_HARD_LIMITS.maxObjectiveBytes} UTF-8 bytes`);
  }

  const providerValue = requiredString(value.provider, `${label}.provider`, issues);
  if (providerValue !== "codex" && providerValue !== "claude" && providerValue !== "kimi") {
    issues.push(`${label}.provider must be 'codex', 'claude', or 'kimi'`);
  }

  const modeValue = value.mode ?? "read-only";
  if (modeValue !== "read-only" && modeValue !== "writer") {
    issues.push(`${label}.mode must be 'read-only' or 'writer'`);
  }
  const worktree = optionalString(value.worktree, `${label}.worktree`, issues);
  if (modeValue === "writer" && !worktree) {
    issues.push(`${label}.worktree is required for writer tasks (fail-closed writer ownership)`);
  }
  const allowUnenforcedReadOnly = typeof value.allowUnenforcedReadOnly === "boolean"
    ? value.allowUnenforcedReadOnly
    : undefined;
  if (value.allowUnenforcedReadOnly !== undefined && allowUnenforcedReadOnly === undefined) {
    issues.push(`${label}.allowUnenforcedReadOnly must be a boolean`);
  }
  if (modeValue === "read-only" && allowUnenforcedReadOnly !== true) {
    issues.push(`${label}.allowUnenforcedReadOnly must be true because provider-native read-only enforcement is not wired through the managed adapters yet`);
  }
  if (modeValue === "read-only" && !worktree) {
    issues.push(`${label}.worktree is required for read-only tasks and must resolve to an isolated non-root worktree`);
  }
  if (modeValue === "writer" && allowUnenforcedReadOnly === true) {
    issues.push(`${label}.allowUnenforcedReadOnly is only valid for read-only tasks`);
  }

  let dependsOn: string[] | undefined;
  if (value.dependsOn !== undefined) {
    if (!Array.isArray(value.dependsOn) || value.dependsOn.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      issues.push(`${label}.dependsOn must be an array of non-empty task ids`);
    } else {
      dependsOn = value.dependsOn.map((entry) => String(entry).trim());
      if (new Set(dependsOn).size !== dependsOn.length) issues.push(`${label}.dependsOn contains duplicates`);
    }
  }

  let artifacts: string[] | undefined;
  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      issues.push(`${label}.artifacts must be an array of non-empty relative paths`);
    } else {
      artifacts = value.artifacts.map((entry) => String(entry).trim());
      if (artifacts.length > FLEET_HARD_LIMITS.maxArtifactsPerTask) {
        issues.push(`${label}.artifacts exceeds the hard limit of ${FLEET_HARD_LIMITS.maxArtifactsPerTask}`);
      }
      if (new Set(artifacts).size !== artifacts.length) issues.push(`${label}.artifacts contains duplicates`);
    }
  }

  const timeoutMs = finitePositiveInteger(value.timeoutMs, `${label}.timeoutMs`, issues);
  const maxTurns = finitePositiveInteger(value.maxTurns, `${label}.maxTurns`, issues);
  const maxBudgetUsd = finitePositiveNumber(value.maxBudgetUsd, `${label}.maxBudgetUsd`, issues);
  const allowProviderAutoPermissions = typeof value.allowProviderAutoPermissions === "boolean"
    ? value.allowProviderAutoPermissions
    : undefined;
  if (value.allowProviderAutoPermissions !== undefined && allowProviderAutoPermissions === undefined) {
    issues.push(`${label}.allowProviderAutoPermissions must be a boolean`);
  }
  const maxOutputBytes = finitePositiveInteger(value.maxOutputBytes, `${label}.maxOutputBytes`, issues);
  const maxArtifactBytes = finitePositiveInteger(value.maxArtifactBytes, `${label}.maxArtifactBytes`, issues);
  const model = optionalString(value.model, `${label}.model`, issues);

  if (timeoutMs !== undefined && timeoutMs > FLEET_HARD_LIMITS.taskTimeoutMs) {
    issues.push(`${label}.timeoutMs exceeds the hard limit of ${FLEET_HARD_LIMITS.taskTimeoutMs}`);
  }
  if (maxOutputBytes !== undefined && maxOutputBytes > FLEET_HARD_LIMITS.maxOutputBytes) {
    issues.push(`${label}.maxOutputBytes exceeds the hard limit of ${FLEET_HARD_LIMITS.maxOutputBytes}`);
  }
  if (maxArtifactBytes !== undefined && maxArtifactBytes > FLEET_HARD_LIMITS.maxArtifactBytes) {
    issues.push(`${label}.maxArtifactBytes exceeds the hard limit of ${FLEET_HARD_LIMITS.maxArtifactBytes}`);
  }
  if (providerValue === "codex" && maxBudgetUsd !== undefined) {
    issues.push(`${label}.maxBudgetUsd cannot be guaranteed by the current Codex CLI adapter; remove it or use Claude`);
  }
  if (providerValue === "codex" && maxTurns !== undefined) {
    issues.push(`${label}.maxTurns cannot be guaranteed by the current Codex CLI adapter; use timeoutMs or use Claude`);
  }
  if (providerValue === "kimi" && allowProviderAutoPermissions !== true) {
    issues.push(`${label}.allowProviderAutoPermissions must be true for Kimi because its documented non-interactive mode enables automatic permissions`);
  }
  if (providerValue !== "kimi" && allowProviderAutoPermissions === true) {
    issues.push(`${label}.allowProviderAutoPermissions is only valid for Kimi tasks`);
  }
  if (providerValue === "kimi" && maxBudgetUsd !== undefined) {
    issues.push(`${label}.maxBudgetUsd cannot be guaranteed by the current Kimi CLI adapter; remove it or use Claude`);
  }
  if (providerValue === "kimi" && maxTurns !== undefined) {
    issues.push(`${label}.maxTurns cannot be guaranteed by the current Kimi CLI adapter; use timeoutMs or use Claude`);
  }

  if (!id || !objective || (providerValue !== "codex" && providerValue !== "claude" && providerValue !== "kimi") || (modeValue !== "read-only" && modeValue !== "writer")) {
    return undefined;
  }
  return {
    id,
    objective,
    provider: providerValue,
    ...(dependsOn ? { dependsOn } : {}),
    mode: modeValue,
    ...(worktree ? { worktree } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(allowProviderAutoPermissions !== undefined ? { allowProviderAutoPermissions } : {}),
    ...(allowUnenforcedReadOnly !== undefined ? { allowUnenforcedReadOnly } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(maxArtifactBytes !== undefined ? { maxArtifactBytes } : {}),
    ...(artifacts ? { artifacts } : {})
  };
}

function computeGraph(tasks: FleetTaskInput[], maxDepth: number, issues: string[]): {
  order: string[];
  waves: string[][];
  depths: Map<string, number>;
} {
  const ids = new Set(tasks.map((task) => task.id));
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const indegrees = new Map<string, number>();

  for (const task of tasks) {
    const deps = task.dependsOn ?? [];
    dependencies.set(task.id, deps);
    indegrees.set(task.id, deps.length);
    for (const dependency of deps) {
      if (dependency === task.id) issues.push(`task '${task.id}' cannot depend on itself`);
      if (!ids.has(dependency)) issues.push(`task '${task.id}' depends on unknown task '${dependency}'`);
      const next = dependents.get(dependency) ?? [];
      next.push(task.id);
      dependents.set(dependency, next);
    }
  }

  const ready = tasks
    .filter((task) => (indegrees.get(task.id) ?? 0) === 0)
    .map((task) => task.id)
    .sort();
  const order: string[] = [];
  const depths = new Map<string, number>();
  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    order.push(current);
    const deps = dependencies.get(current) ?? [];
    const depth = deps.length === 0 ? 1 : Math.max(...deps.map((id) => depths.get(id) ?? 0)) + 1;
    depths.set(current, depth);
    for (const dependent of (dependents.get(current) ?? []).sort()) {
      const next = (indegrees.get(dependent) ?? 0) - 1;
      indegrees.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== tasks.length && !issues.some((issue) => issue.includes("unknown task"))) {
    const cyclic = tasks.map((task) => task.id).filter((id) => !order.includes(id)).sort();
    issues.push(`task dependency graph contains a cycle involving: ${cyclic.join(", ")}`);
  }
  const actualDepth = Math.max(0, ...depths.values());
  if (actualDepth > maxDepth) issues.push(`task dependency depth ${actualDepth} exceeds root.maxDepth ${maxDepth}`);

  const waves: string[][] = [];
  for (const id of order) {
    const depth = depths.get(id) ?? 1;
    const wave = waves[depth - 1] ?? [];
    wave.push(id);
    waves[depth - 1] = wave;
  }
  return { order, waves, depths };
}

function assignCaptureLimits(
  tasks: FleetTaskInput[],
  rootLimit: number,
  field: "maxOutputBytes" | "maxArtifactBytes",
  defaultPerTask: number,
  issues: string[]
): Map<string, number> {
  const limits = new Map<string, number>();
  const explicit = tasks.reduce((total, task) => total + (task[field] ?? 0), 0);
  if (explicit > rootLimit) {
    issues.push(`sum of task.${field} values (${explicit}) exceeds root.${field} (${rootLimit})`);
  }
  const implicit = tasks.filter((task) => task[field] === undefined);
  const remaining = Math.max(0, rootLimit - explicit);
  const implicitLimit = implicit.length === 0 ? 0 : Math.min(defaultPerTask, Math.floor(remaining / implicit.length));
  if (implicit.length > 0 && implicitLimit < 1024) {
    issues.push(`root.${field} leaves less than 1024 bytes for each task without an explicit limit`);
  }
  for (const task of tasks) limits.set(task.id, task[field] ?? implicitLimit);
  return limits;
}

export function parseFleetPlan(value: unknown): FleetPlan {
  const issues: string[] = [];
  if (!isRecord(value)) throw new FleetValidationError(["plan must be a JSON object"]);
  unknownKeys(value, new Set(["version", "name", "root", "tasks"]), "plan", issues);

  if (value.version !== FLEET_PLAN_VERSION) issues.push(`version must be ${FLEET_PLAN_VERSION}`);
  const name = requiredString(value.name, "name", issues);
  if (name && name.length > 120) issues.push("name must be 120 characters or fewer");

  const rootInput = value.root === undefined ? {} : value.root;
  if (!isRecord(rootInput)) issues.push("root must be an object");
  const rootRecord = isRecord(rootInput) ? rootInput : {};
  unknownKeys(rootRecord, new Set([
    "cwd", "timeoutMs", "maxBudgetUsd", "maxTasks", "maxDepth", "maxConcurrency",
    "maxOutputBytes", "maxArtifactBytes", "failFast", "allowRootWorktreeWrite", "allowNonGitIsolation"
  ]), "root", issues);

  const cwd = optionalString(rootRecord.cwd, "root.cwd", issues) ?? ".";
  const timeoutMs = finitePositiveInteger(rootRecord.timeoutMs, "root.timeoutMs", issues) ?? DEFAULTS.timeoutMs;
  const maxBudgetUsd = finitePositiveNumber(rootRecord.maxBudgetUsd, "root.maxBudgetUsd", issues);
  const maxTasks = finitePositiveInteger(rootRecord.maxTasks, "root.maxTasks", issues) ?? DEFAULTS.maxTasks;
  const maxDepth = finitePositiveInteger(rootRecord.maxDepth, "root.maxDepth", issues) ?? DEFAULTS.maxDepth;
  const maxConcurrency = finitePositiveInteger(rootRecord.maxConcurrency, "root.maxConcurrency", issues) ?? DEFAULTS.maxConcurrency;
  const maxOutputBytes = finitePositiveInteger(rootRecord.maxOutputBytes, "root.maxOutputBytes", issues) ?? DEFAULTS.maxOutputBytes;
  const maxArtifactBytes = finitePositiveInteger(rootRecord.maxArtifactBytes, "root.maxArtifactBytes", issues) ?? DEFAULTS.maxArtifactBytes;
  const failFastValue = rootRecord.failFast ?? true;
  if (typeof failFastValue !== "boolean") issues.push("root.failFast must be a boolean");
  const allowRootWorktreeWriteValue = rootRecord.allowRootWorktreeWrite ?? false;
  if (typeof allowRootWorktreeWriteValue !== "boolean") issues.push("root.allowRootWorktreeWrite must be a boolean");
  const allowNonGitIsolationValue = rootRecord.allowNonGitIsolation ?? false;
  if (typeof allowNonGitIsolationValue !== "boolean") issues.push("root.allowNonGitIsolation must be a boolean");

  if (timeoutMs > FLEET_HARD_LIMITS.timeoutMs) issues.push(`root.timeoutMs exceeds the hard limit of ${FLEET_HARD_LIMITS.timeoutMs}`);
  if (maxTasks > FLEET_HARD_LIMITS.maxTasks) issues.push(`root.maxTasks exceeds the hard limit of ${FLEET_HARD_LIMITS.maxTasks}`);
  if (maxDepth > FLEET_HARD_LIMITS.maxDepth) issues.push(`root.maxDepth exceeds the hard limit of ${FLEET_HARD_LIMITS.maxDepth}`);
  if (maxConcurrency > FLEET_HARD_LIMITS.maxConcurrency) issues.push(`root.maxConcurrency exceeds the hard limit of ${FLEET_HARD_LIMITS.maxConcurrency}`);
  if (maxOutputBytes > FLEET_HARD_LIMITS.maxOutputBytes) issues.push(`root.maxOutputBytes exceeds the hard limit of ${FLEET_HARD_LIMITS.maxOutputBytes}`);
  if (maxArtifactBytes > FLEET_HARD_LIMITS.maxArtifactBytes) issues.push(`root.maxArtifactBytes exceeds the hard limit of ${FLEET_HARD_LIMITS.maxArtifactBytes}`);

  let taskInputs: FleetTaskInput[] = [];
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    issues.push("tasks must be a non-empty array");
  } else {
    taskInputs = value.tasks.map((task, index) => parseTask(task, index, issues)).filter((task): task is FleetTaskInput => task !== undefined);
    if (value.tasks.length > maxTasks) issues.push(`plan has ${value.tasks.length} tasks, exceeding root.maxTasks ${maxTasks}`);
  }

  const seen = new Set<string>();
  for (const task of taskInputs) {
    if (seen.has(task.id)) issues.push(`duplicate task id '${task.id}'`);
    seen.add(task.id);
  }

  const graph = computeGraph(taskInputs, maxDepth, issues);
  const outputLimits = assignCaptureLimits(taskInputs, maxOutputBytes, "maxOutputBytes", DEFAULTS.taskOutputBytes, issues);
  const artifactLimits = assignCaptureLimits(taskInputs, maxArtifactBytes, "maxArtifactBytes", DEFAULTS.taskArtifactBytes, issues);

  if (maxBudgetUsd !== undefined) {
    const missing = taskInputs.filter((task) => task.maxBudgetUsd === undefined).map((task) => task.id);
    if (missing.length > 0) {
      issues.push(`root.maxBudgetUsd requires every task to declare maxBudgetUsd; missing: ${missing.sort().join(", ")}`);
    }
    const sum = taskInputs.reduce((total, task) => total + (task.maxBudgetUsd ?? 0), 0);
    if (sum > maxBudgetUsd + 1e-9) issues.push(`sum of task maxBudgetUsd values (${sum}) exceeds root.maxBudgetUsd (${maxBudgetUsd})`);
  }

  if (issues.length > 0 || !name) throw new FleetValidationError(issues);

  const root: FleetRoot = {
    cwd,
    timeoutMs,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    maxTasks,
    maxDepth,
    maxConcurrency,
    maxOutputBytes,
    maxArtifactBytes,
    failFast: failFastValue as boolean,
    allowRootWorktreeWrite: allowRootWorktreeWriteValue as boolean,
    allowNonGitIsolation: allowNonGitIsolationValue as boolean
  };
  const tasks: FleetTask[] = taskInputs.map((task) => ({
    id: task.id,
    objective: task.objective,
    provider: task.provider,
    dependsOn: [...(task.dependsOn ?? [])].sort(),
    mode: task.mode ?? "read-only",
    ...(task.worktree ? { worktree: task.worktree } : {}),
    ...(task.model ? { model: task.model } : {}),
    timeoutMs: task.timeoutMs ?? DEFAULTS.taskTimeoutMs,
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.maxBudgetUsd !== undefined ? { maxBudgetUsd: task.maxBudgetUsd } : {}),
    ...(task.allowProviderAutoPermissions !== undefined ? { allowProviderAutoPermissions: task.allowProviderAutoPermissions } : {}),
    ...(task.allowUnenforcedReadOnly !== undefined ? { allowUnenforcedReadOnly: task.allowUnenforcedReadOnly } : {}),
    maxOutputBytes: outputLimits.get(task.id) ?? 1024,
    maxArtifactBytes: artifactLimits.get(task.id) ?? 1024,
    artifacts: [...(task.artifacts ?? [])].sort(),
    depth: graph.depths.get(task.id) ?? 1
  }));

  const warnings: string[] = [
    "Review every dry-run plan and worktree boundary before execution. Fleet workers still use each provider's native permission and sandbox policy."
  ];
  if (tasks.some((task) => task.provider === "codex")) {
    warnings.push("Codex tasks are bounded by wall-clock timeout and captured bytes; the current Codex CLI adapter does not expose hard turn or USD caps.");
  }
  if (tasks.some((task) => task.provider === "kimi")) {
    warnings.push("Kimi non-interactive execution uses provider auto-permissions. Each Kimi task must explicitly opt in with allowProviderAutoPermissions: true; turn and USD caps are unavailable.");
  }

  return {
    version: FLEET_PLAN_VERSION,
    name,
    root,
    tasks,
    topologicalOrder: graph.order,
    waves: graph.waves,
    warnings
  };
}

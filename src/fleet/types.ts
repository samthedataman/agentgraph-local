import type { DelegateOptions, DelegateResult } from "../adapters/index.js";

export const FLEET_PLAN_VERSION = 1 as const;

export type FleetProvider = "codex" | "claude" | "kimi";
export type FleetTaskMode = "read-only" | "writer";
export type FleetTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "skipped";

export interface FleetRootInput {
  cwd?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  maxTasks?: number;
  maxDepth?: number;
  maxConcurrency?: number;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  failFast?: boolean;
  allowRootWorktreeWrite?: boolean;
  allowNonGitIsolation?: boolean;
}

export interface FleetTaskInput {
  id: string;
  objective: string;
  provider: FleetProvider;
  dependsOn?: string[];
  mode?: FleetTaskMode;
  worktree?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowProviderAutoPermissions?: boolean;
  allowUnenforcedReadOnly?: boolean;
  maxOutputBytes?: number;
  maxArtifactBytes?: number;
  artifacts?: string[];
}

export interface FleetPlanInput {
  version: typeof FLEET_PLAN_VERSION;
  name: string;
  root?: FleetRootInput;
  tasks: FleetTaskInput[];
}

export interface FleetRoot {
  cwd: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  maxTasks: number;
  maxDepth: number;
  maxConcurrency: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  failFast: boolean;
  allowRootWorktreeWrite: boolean;
  allowNonGitIsolation: boolean;
}

export interface FleetTask {
  id: string;
  objective: string;
  provider: FleetProvider;
  dependsOn: string[];
  mode: FleetTaskMode;
  worktree?: string;
  model?: string;
  timeoutMs: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowProviderAutoPermissions?: boolean;
  allowUnenforcedReadOnly?: boolean;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  artifacts: string[];
  depth: number;
}

export interface FleetPlan {
  version: typeof FLEET_PLAN_VERSION;
  name: string;
  root: FleetRoot;
  tasks: FleetTask[];
  topologicalOrder: string[];
  waves: string[][];
  warnings: string[];
}

export interface ResolvedFleetWorktree {
  cwd: string;
  ownershipKey: string;
}

export interface FleetPreviewTask {
  id: string;
  provider: FleetProvider;
  mode: FleetTaskMode;
  depth: number;
  dependsOn: string[];
  cwd: string;
  ownershipKey?: string;
  timeoutMs: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowProviderAutoPermissions?: boolean;
  allowUnenforcedReadOnly?: boolean;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  isolation: "verified-git-worktree" | "requires-preparation" | "non-git-override" | "root-write-override";
}

export interface FleetPreview {
  schema: "agentgraph.fleet-preview/1";
  version: typeof FLEET_PLAN_VERSION;
  name: string;
  root: FleetRoot;
  waves: string[][];
  tasks: FleetPreviewTask[];
  warnings: string[];
  preparationCommands: string[];
  executionNotes: string[];
}

export interface FleetArtifact {
  path: string;
  sizeBytes: number;
  capturedBytes: number;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
}

export interface FleetTaskResult {
  id: string;
  provider: FleetProvider;
  mode: FleetTaskMode;
  status: Exclude<FleetTaskStatus, "pending" | "running">;
  exitCode?: number;
  sessionId?: string;
  finalResponse: string;
  stderr: string;
  outputTruncated: boolean;
  artifacts: FleetArtifact[];
  error?: string;
  durationMs: number;
}

export interface FleetRunResult {
  schema: "agentgraph.fleet-result/1";
  version: typeof FLEET_PLAN_VERSION;
  name: string;
  status: "succeeded" | "failed" | "cancelled" | "timed-out";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timedOut: number;
    skipped: number;
  };
  tasks: FleetTaskResult[];
  warnings: string[];
}

export interface FleetWriterLease {
  release(): Promise<void>;
}

export interface FleetRuntime {
  delegate(options: DelegateOptions): Promise<DelegateResult>;
  resolveWorktree(task: FleetTask, rootCwd: string): Promise<ResolvedFleetWorktree>;
  acquireWriterLease(worktree: ResolvedFleetWorktree, task: FleetTask): Promise<FleetWriterLease>;
  collectArtifacts(
    worktree: ResolvedFleetWorktree,
    paths: string[],
    maxBytes: number
  ): Promise<FleetArtifact[]>;
  now(): Date;
}

export interface FleetOptions {
  baseCwd?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  runtime?: Partial<FleetRuntime>;
}

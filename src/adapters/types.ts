export type AgentProvider = "codex" | "claude" | "kimi";

export interface DelegateOptions {
  provider: AgentProvider;
  prompt: string;
  cwd: string;
  sessionId?: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxCapturedBytes?: number;
  allowProviderAutoPermissions?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: ManagedAgentEvent) => void | Promise<void>;
}

export interface ManagedAgentEvent {
  provider: AgentProvider;
  type: string;
  timestamp: string;
  data: unknown;
}

export interface DelegateResult {
  provider: AgentProvider;
  sessionId?: string;
  finalResponse: string;
  exitCode: number;
  durationMs: number;
  events: ManagedAgentEvent[];
  stderr: string;
}

export interface ProviderInvocation {
  command: string;
  args: string[];
  stdin?: string;
}

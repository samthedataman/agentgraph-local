export const EVENT_SCHEMA = "local.agent.event/1" as const;

export type Provider = "codex" | "claude" | "custom" | (string & {});
export type EventSource = "wrapper" | "hook" | "stream" | "daemon" | (string & {});

export type ProcessState = "starting" | "live" | "stale" | "exited" | "crashed" | "unknown";
export type AgentActivity =
  | "initializing"
  | "idle"
  | "thinking"
  | "using_tool"
  | "waiting_for_approval"
  | "waiting_for_user"
  | "compacting"
  | "failed"
  | "unknown";
export type PresenceConfidence = "supervised" | "provider_managed" | "hook_seen" | "process_inferred" | "heuristic";
export type ProcessMode = "interactive" | "background" | "attached" | "managed";

export interface TerminalFingerprint {
  tty: string | null;
  termProgram: string | null;
  termSessionId: string | null;
  itermSessionId: string | null;
  tmuxPane: string | null;
  parentPid: number | null;
}

export interface ProcessRegistration {
  runId: string;
  leaseToken: string;
  provider: Provider;
  mode?: ProcessMode;
  pid: number;
  processStartToken: string;
  executable: string;
  argv?: string[];
  cwd: string;
  repositoryRoot?: string | null;
  worktreeRoot?: string | null;
  terminal?: TerminalFingerprint | null;
  metadata?: Record<string, unknown>;
}

export interface ProcessPresence {
  id: string;
  runId: string;
  provider: Provider;
  mode: ProcessMode;
  pid: number;
  processStartToken: string;
  executable: string;
  argv: string[];
  cwd: string;
  repositoryRoot: string | null;
  worktreeRoot: string | null;
  terminalId: string | null;
  terminal: TerminalFingerprint | null;
  providerSessionId: string | null;
  state: ProcessState;
  activity: AgentActivity;
  confidence: PresenceConfidence;
  registeredAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Canonical event representation. Optional properties are deliberately tolerant:
 * wrappers and provider hooks do not all observe the same fields.
 */
export interface AgentEventInput {
  schema?: string;
  event_id?: string;
  occurred_at?: string;
  observed_at?: string;
  provider: Provider;
  source: EventSource;
  host_id?: string | null;
  terminal_id?: string | null;
  process_instance_id?: string | null;
  provider_session_id?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  subagent_id?: string | null;
  sequence?: number | null;
  kind: string;
  payload?: Record<string, unknown>;
  raw_ref?: string | null;
  idempotency_key?: string | null;
  origin_event_id?: string | null;
  hop_count?: number;
  sensitivity?: string;
  projection_version?: number;
  [key: string]: unknown;
}

export interface AgentEvent extends Required<Pick<AgentEventInput,
  "schema" | "event_id" | "occurred_at" | "observed_at" | "provider" | "source" | "kind" | "payload" | "hop_count" | "sensitivity" | "projection_version"
>> {
  host_id: string | null;
  terminal_id: string | null;
  process_instance_id: string | null;
  provider_session_id: string | null;
  turn_id: string | null;
  subagent_id: string | null;
  sequence: number | null;
  raw_ref: string | null;
  idempotency_key: string | null;
  origin_event_id: string | null;
}

export interface DiscoveredProcess {
  pid: number;
  parentPid: number | null;
  provider: Provider;
  command: string;
  cwd: string | null;
  tty: string | null;
  processStartToken: string;
}


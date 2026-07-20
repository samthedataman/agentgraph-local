export type HookProvider = "codex" | "claude";

export interface HookEnvironment {
  AGENTGRAPH_PROCESS_INSTANCE_ID?: string;
  AGENTGRAPH_RUN_ID?: string;
  AGENTGRAPH_TERMINAL_ID?: string;
  AGENTGRAPH_HOME?: string;
  AGENTGRAPH_SPOOL_DIR?: string;
  AGENTGRAPH_HOOK_SPOOL_DIR?: string;
  HOME?: string;
  XDG_DATA_HOME?: string;
  [key: string]: string | undefined;
}

/**
 * The hook protocol deliberately accepts unknown vendor fields. Both Codex and
 * Claude add fields over time, and telemetry must continue to work when they do.
 */
export type VendorHookInput = Record<string, unknown>;

export interface NormalizedHookEvent {
  schema: "local.agent.event/1";
  event_id: string;
  occurred_at: string;
  observed_at: string;
  provider: HookProvider;
  source: "hook";
  process_instance_id: string | null;
  terminal_id: string | null;
  provider_session_id: string | null;
  turn_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  origin_event_id: null;
  hop_count: 0;
  sensitivity: "private";
}

export interface NormalizeHookOptions {
  env?: HookEnvironment;
  now?: Date | string;
  tty?: string | null;
}

export interface HookDeliveryResult {
  delivered: boolean;
  spooled: boolean;
  spoolPath?: string;
  error?: string;
}

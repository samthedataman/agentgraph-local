import { id, sha256, stableJson } from "../util/ids.js";
import { currentTty } from "../daemon/process-inspection.js";
import type {
  HookEnvironment,
  HookProvider,
  NormalizedHookEvent,
  NormalizeHookOptions,
  VendorHookInput
} from "./types.js";

const MAX_STRING_LENGTH = 32_768;
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

const EVENT_KINDS: Record<string, string> = {
  SessionStart: "session.started",
  SessionEnd: "session.detached",
  UserPromptSubmit: "turn.prompted",
  PreToolUse: "tool.started",
  PermissionRequest: "approval.requested",
  PermissionDenied: "approval.resolved",
  PostToolUse: "tool.completed",
  PostToolUseFailure: "tool.failed",
  PostToolBatch: "tool.batch_completed",
  Stop: "turn.completed",
  StopFailure: "turn.failed",
  SubagentStart: "subagent.started",
  SubagentStop: "subagent.completed",
  TeammateIdle: "subagent.idle",
  TaskCreated: "task.created",
  TaskCompleted: "task.completed",
  PreCompact: "session.compacting",
  PostCompact: "session.compacted",
  Notification: "session.notification",
  CwdChanged: "session.cwd_changed",
  FileChanged: "artifact.changed",
  WorktreeCreate: "worktree.created",
  WorktreeRemove: "worktree.removed",
  ConfigChange: "session.config_changed",
  InstructionsLoaded: "session.instructions_loaded",
  Setup: "session.setup"
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isoTime(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function redactString(value: string): string {
  const bounded = value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;
  return bounded.replaceAll(SECRET_VALUE, "[REDACTED]");
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || normalized.includes("privatekey")
    || normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized === "cookie"
    || normalized.endsWith("cookie");
}

/** Redact credential-looking fields while retaining unknown fields for forward compatibility. */
export function sanitizeHookValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (sensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((entry) => sanitizeHookValue(entry, "", depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
      output[childKey] = sanitizeHookValue(childValue, childKey, depth + 1);
    }
    return output;
  }
  return value;
}

function resolveEventName(input: VendorHookInput): string {
  return asString(input.hook_event_name)
    ?? asString(input.event_name)
    ?? asString(input.event)
    ?? "Unknown";
}

function eventKind(eventName: string, input: VendorHookInput): string {
  if (eventName === "SessionStart" && input.source === "resume") return "session.resumed";
  if (eventName === "Notification" && input.notification_type === "idle_prompt") {
    return "session.waiting_for_user";
  }
  return EVENT_KINDS[eventName] ?? "provider.event";
}

function normalizedNow(now: Date | string | undefined): string {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string") {
    const parsed = new Date(now);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function envValue(env: HookEnvironment, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function normalizeHook(
  provider: HookProvider,
  input: VendorHookInput,
  options: NormalizeHookOptions = {}
): NormalizedHookEvent {
  const env = options.env ?? (process.env as HookEnvironment);
  const observedAt = normalizedNow(options.now);
  const eventName = resolveEventName(input);
  const sanitized = sanitizeHookValue(input) as Record<string, unknown>;
  const providerSessionId = asString(input.session_id) ?? null;
  const turnId = asString(input.turn_id) ?? null;
  // This is the store's internal process row id, not the wrapper run id. The
  // latter remains in payload for correlation until a daemon resolves it.
  const processInstanceId = envValue(env, "AGENTGRAPH_PROCESS_INSTANCE_ID");

  const payload: Record<string, unknown> = {
    ...sanitized,
    hook_event_name: eventName,
    agentgraph_run_id: envValue(env, "AGENTGRAPH_RUN_ID"),
    agentgraph_hook_tty: options.tty === undefined ? currentTty() : options.tty
  };
  const eventFingerprint = stableJson({
    provider,
    providerSessionId,
    turnId,
    eventName,
    payload
  });

  return {
    schema: "local.agent.event/1",
    event_id: id("evt"),
    occurred_at: isoTime(input.occurred_at ?? input.timestamp, observedAt),
    observed_at: observedAt,
    provider,
    source: "hook",
    process_instance_id: processInstanceId,
    terminal_id: envValue(env, "AGENTGRAPH_TERMINAL_ID"),
    provider_session_id: providerSessionId,
    turn_id: turnId,
    kind: eventKind(eventName, input),
    payload,
    idempotency_key: `hook:${sha256(eventFingerprint)}`,
    origin_event_id: null,
    hop_count: 0,
    sensitivity: "private"
  };
}

export function normalizeCodexHook(
  input: VendorHookInput,
  options?: NormalizeHookOptions
): NormalizedHookEvent {
  return normalizeHook("codex", input, options);
}

export function normalizeClaudeHook(
  input: VendorHookInput,
  options?: NormalizeHookOptions
): NormalizedHookEvent {
  return normalizeHook("claude", input, options);
}

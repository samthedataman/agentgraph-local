import { commandPath } from "../util/process.js";
import { runInvocation } from "./runner.js";
import type { DelegateOptions, DelegateResult, ProviderInvocation } from "./types.js";

interface ExtractionState {
  sessionId?: string;
  finalResponse: string;
}

export function kimiArgs(options: DelegateOptions): string[] {
  if (options.allowProviderAutoPermissions !== true) {
    throw new Error(
      "Kimi Code --prompt mode uses its auto permission policy; pass --allow-provider-auto only after reviewing the task/worktree boundary"
    );
  }
  if (options.maxTurns !== undefined) {
    throw new Error("Kimi Code does not expose a documented max-turns flag; use a fleet/task timeout instead");
  }
  if (options.maxBudgetUsd !== undefined) {
    throw new Error("Kimi Code does not expose a documented CLI budget flag; enforce the fleet root budget externally");
  }
  const args: string[] = [];
  if (options.sessionId) args.push("--session", options.sessionId);
  if (options.model) args.push("--model", options.model);
  args.push("--prompt", options.prompt, "--output-format", "stream-json");
  return args;
}

function invocation(options: DelegateOptions): ProviderInvocation {
  const command = commandPath("kimi");
  if (!command) throw new Error("Kimi Code CLI was not found in PATH");
  return { command, args: kimiArgs(options) };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return "";
      const record = block as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractKimiEvent(value: unknown, state: ExtractionState): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const event = value as Record<string, unknown>;
  const sessionId = event.session_id ?? event.sessionId;
  if (typeof sessionId === "string" && sessionId) state.sessionId = sessionId;

  const nested = event.message && typeof event.message === "object" && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : null;
  const role = event.role ?? nested?.role;
  if (role === "assistant" || event.type === "assistant") {
    const text = contentText(nested?.content ?? event.content ?? event.text);
    if (text) state.finalResponse = text;
  }
  if (event.type === "result") {
    const result = event.result ?? event.output ?? event.text;
    if (typeof result === "string" && result) state.finalResponse = result;
  }
}

export async function delegateKimi(options: DelegateOptions): Promise<DelegateResult> {
  return runInvocation("kimi", invocation(options), options, extractKimiEvent);
}

import { commandPath } from "../util/process.js";
import { runInvocation } from "./runner.js";
import type { DelegateOptions, DelegateResult, ProviderInvocation } from "./types.js";

function invocation(options: DelegateOptions): ProviderInvocation {
  const command = commandPath("codex");
  if (!command) throw new Error("Codex CLI was not found in PATH");

  const args = options.sessionId
    ? ["exec", "resume", options.sessionId, "--json"]
    : ["exec", "--json"];
  if (options.model) args.push("--model", options.model);
  args.push("-");
  return { command, args, stdin: options.prompt };
}

export async function delegateCodex(options: DelegateOptions): Promise<DelegateResult> {
  return runInvocation("codex", invocation(options), options, (value, state) => {
    if (typeof value !== "object" || value === null) return;
    const event = value as Record<string, unknown>;
    const type = String(event.type ?? "");
    if (type === "thread.started") {
      const threadId = event.thread_id ?? event.threadId;
      if (typeof threadId === "string") state.sessionId = threadId;
    }
    if (type === "item.completed") {
      const item = event.item;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (record.type === "agent_message" && typeof record.text === "string") {
          state.finalResponse = record.text;
        }
      }
    }
    if (type === "turn.completed" && typeof event.final_response === "string") {
      state.finalResponse = event.final_response;
    }
  });
}

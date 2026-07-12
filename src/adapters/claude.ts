import { commandPath } from "../util/process.js";
import { runInvocation } from "./runner.js";
import type { DelegateOptions, DelegateResult, ProviderInvocation } from "./types.js";

function invocation(options: DelegateOptions): ProviderInvocation {
  const command = commandPath("claude");
  if (!command) throw new Error("Claude CLI was not found in PATH");
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (options.sessionId) args.push("--resume", options.sessionId);
  if (options.model) args.push("--model", options.model);
  if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  args.push(options.prompt);
  return { command, args };
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const value = block as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function delegateClaude(options: DelegateOptions): Promise<DelegateResult> {
  return runInvocation("claude", invocation(options), options, (value, state) => {
    if (typeof value !== "object" || value === null) return;
    const event = value as Record<string, unknown>;
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.type === "assistant") {
      const message = event.message;
      if (typeof message === "object" && message !== null) {
        const text = textFromContent((message as Record<string, unknown>).content);
        if (text) state.finalResponse = text;
      }
    }
    if (event.type === "result" && typeof event.result === "string") {
      state.finalResponse = event.result;
    }
  });
}

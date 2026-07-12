import { delegateClaude } from "./claude.js";
import { delegateCodex } from "./codex.js";
import { delegateKimi } from "./kimi.js";
import type { DelegateOptions, DelegateResult } from "./types.js";

export async function delegate(options: DelegateOptions): Promise<DelegateResult> {
  if (options.provider === "codex") return delegateCodex(options);
  if (options.provider === "claude") return delegateClaude(options);
  return delegateKimi(options);
}

export type {
  AgentProvider,
  DelegateOptions,
  DelegateResult,
  ManagedAgentEvent
} from "./types.js";

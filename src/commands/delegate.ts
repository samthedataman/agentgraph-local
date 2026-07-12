import { readFile } from "node:fs/promises";
import { delegate, type AgentProvider, type ManagedAgentEvent } from "../adapters/index.js";
import { takeFlag, takeOption } from "../util/args.js";
import { id, sha256, stableJson } from "../util/ids.js";
import { writeJson, writeLine } from "../util/output.js";
import { nowIso } from "../util/time.js";
import { sanitizeHookValue } from "../hooks/normalize.js";

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function recordEvent(provider: AgentProvider, event: ManagedAgentEvent): Promise<void> {
  try {
    const { rpc } = await import("../ipc/client.js");
    const eventId = id("evt");
    const sanitized = sanitizeHookValue(event.data);
    const payload = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized as Record<string, unknown>
      : { value: sanitized };
    await rpc("event.append", {
      event: {
        schema: "local.agent.event/1",
        event_id: eventId,
        occurred_at: event.timestamp,
        observed_at: nowIso(),
        provider,
        source: "stream",
        kind: `managed.${event.type}`,
        payload,
        idempotency_key: sha256(stableJson([provider, eventId, payload])),
        hop_count: 0,
        sensitivity: "private"
      }
    });
  } catch {
    // Delegation still works when the daemon is unavailable.
  }
}

export async function run(args: string[], json: boolean): Promise<number> {
  const managedDepth = Number(process.env.AGENTGRAPH_MANAGED_DEPTH ?? (process.env.AGENTGRAPH_MANAGED === "1" ? "1" : "0"));
  if (Number.isFinite(managedDepth) && managedDepth > 0) {
    throw new Error("Nested managed delegation is disabled to prevent recursive agent loops");
  }
  const providerOption = takeOption(args, "--provider");
  const positionalProvider = providerOption === undefined && (args[0] === "codex" || args[0] === "claude" || args[0] === "kimi")
    ? args.shift()
    : undefined;
  const provider = (providerOption ?? positionalProvider) as AgentProvider | undefined;
  if (provider !== "codex" && provider !== "claude" && provider !== "kimi") {
    throw new Error("Usage: agentgraph delegate --provider <codex|claude|kimi> --prompt <text>");
  }
  const promptFile = takeOption(args, "--prompt-file");
  const optionPrompt = takeOption(args, "--prompt");
  const cwd = takeOption(args, "--cwd") ?? process.cwd();
  const sessionId = takeOption(args, "--session");
  const model = takeOption(args, "--model");
  const timeout = Number(takeOption(args, "--timeout-ms") ?? 900_000);
  const maxTurnsText = takeOption(args, "--max-turns");
  const maxBudgetText = takeOption(args, "--max-budget-usd");
  const allowProviderAutoPermissions = takeFlag(args, "--allow-provider-auto");
  const prompt = promptFile
    ? await readFile(promptFile, "utf8")
    : optionPrompt ?? args.join(" ") ?? "";
  const resolvedPrompt = prompt.trim() || (process.stdin.isTTY ? "" : (await stdinText()).trim());
  if (!resolvedPrompt) throw new Error("A prompt is required");

  const result = await delegate({
    provider,
    prompt: resolvedPrompt,
    cwd,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    timeoutMs: timeout,
    ...(maxTurnsText ? { maxTurns: Number(maxTurnsText) } : {}),
    ...(maxBudgetText ? { maxBudgetUsd: Number(maxBudgetText) } : {}),
    ...(allowProviderAutoPermissions ? { allowProviderAutoPermissions: true } : {}),
    onEvent: (event) => recordEvent(provider, event)
  });

  if (json) writeJson(result);
  else {
    writeLine(result.finalResponse || "(The agent returned no final text.)");
    if (result.sessionId) writeLine(`\nSession: ${result.sessionId}`);
  }
  return result.exitCode;
}

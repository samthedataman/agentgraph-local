import { ingestHookEvent } from "../hooks/ingest.js";
import { normalizeHook } from "../hooks/normalize.js";
import { neutralHookOutput, readHookInput } from "../hooks/protocol.js";
import type { HookProvider } from "../hooks/types.js";

function providerFrom(value: string | undefined): HookProvider | undefined {
  return value === "codex" || value === "claude" ? value : undefined;
}

export async function run(args: string[], _json: boolean): Promise<number> {
  const provider = providerFrom(args[0]);
  if (!provider) {
    process.stderr.write("Usage: agentgraph hook <codex|claude>\n");
    return 2;
  }

  try {
    const input = await readHookInput();
    const event = normalizeHook(provider, input);
    const result = await ingestHookEvent(event);
    if (!result.delivered && !result.spooled && process.env.AGENTGRAPH_HOOK_DEBUG === "1") {
      process.stderr.write(`AgentGraph hook delivery failed: ${result.error ?? "unknown error"}\n`);
    }
    const output = neutralHookOutput(provider, input.hook_event_name);
    if (output) process.stdout.write(output);
  } catch (error) {
    // Telemetry must be fail-open. Hook parse/delivery failures never stop an
    // agent turn; diagnostics go only to stderr and only when explicitly asked.
    if (process.env.AGENTGRAPH_HOOK_DEBUG === "1") {
      process.stderr.write(
        `AgentGraph hook ignored: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  return 0;
}

import type { HookProvider } from "./types.js";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

export async function readHookInput(
  input: NodeJS.ReadableStream = process.stdin,
  maxBytes = MAX_STDIN_BYTES
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error(`Hook input exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Hook received empty stdin");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Codex Stop accepts the common output schema. Returning a tiny explicit
 * continue decision prevents diagnostics from ever becoming accidental hook
 * output. Other telemetry hooks stay completely silent on stdout.
 */
export function neutralHookOutput(provider: HookProvider, eventName: unknown): string | undefined {
  return provider === "codex" && eventName === "Stop"
    ? `${JSON.stringify({ continue: true })}\n`
    : undefined;
}

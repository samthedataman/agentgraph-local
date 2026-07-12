import { spawn } from "node:child_process";
import { nowIso } from "../util/time.js";
import type {
  AgentProvider,
  DelegateOptions,
  DelegateResult,
  ManagedAgentEvent,
  ProviderInvocation
} from "./types.js";

interface ExtractionState {
  sessionId?: string;
  finalResponse: string;
}

export async function runInvocation(
  provider: AgentProvider,
  invocation: ProviderInvocation,
  options: DelegateOptions,
  extract: (value: unknown, state: ExtractionState) => void
): Promise<DelegateResult> {
  const started = Date.now();
  const events: ManagedAgentEvent[] = [];
  const state: ExtractionState = { finalResponse: "" };
  const maxCapturedBytes = Math.min(Math.max(options.maxCapturedBytes ?? 1024 * 1024, 16 * 1024), 4 * 1024 * 1024);
  let capturedEventBytes = 0;
  let stderr = "";
  let settled = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  const useProcessGroup = process.platform !== "win32";

  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      AGENTGRAPH_MANAGED: "1",
      AGENTGRAPH_MANAGED_DEPTH: String(Number(process.env.AGENTGRAPH_MANAGED_DEPTH ?? "0") + 1)
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: useProcessGroup
  });

  const emit = async (type: string, data: unknown): Promise<void> => {
    const event: ManagedAgentEvent = {
      provider,
      type,
      timestamp: nowIso(),
      data
    };
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (capturedEventBytes + eventBytes <= maxCapturedBytes) {
      events.push(event);
      capturedEventBytes += eventBytes;
    }
    await options.onEvent?.(event);
  };

  const handleStdoutLine = (line: string): void => {
    let value: unknown = line;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      // Some provider errors and compatibility messages are plain text.
    }
    void emit("stream", value);
    extract(value, state);
    state.finalResponse = boundString(state.finalResponse, maxCapturedBytes);
  };

  // readline buffers an entire line before emitting it. Provider streams are
  // normally small JSONL records, but a malformed or hostile child could emit
  // one unbounded line. This parser drops an oversized record while keeping
  // memory bounded and resumes at the next newline.
  const maxLineBytes = maxCapturedBytes;
  let pending = Buffer.alloc(0);
  let droppingOversizedLine = false;
  child.stdout.on("data", (chunk: Buffer | string) => {
    let input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (input.length > 0) {
      const newline = input.indexOf(0x0a);
      if (droppingOversizedLine) {
        if (newline === -1) return;
        droppingOversizedLine = false;
        input = input.subarray(newline + 1);
        continue;
      }
      const piece = newline === -1 ? input : input.subarray(0, newline);
      if (pending.length + piece.length > maxLineBytes) {
        pending = Buffer.alloc(0);
        void emit("stream_truncated", { reason: "provider JSONL record exceeded maxCapturedBytes" });
        if (newline === -1) {
          droppingOversizedLine = true;
          return;
        }
        input = input.subarray(newline + 1);
        continue;
      }
      if (piece.length > 0) pending = Buffer.concat([pending, piece], pending.length + piece.length);
      if (newline === -1) return;
      const line = pending.length > 0 && pending[pending.length - 1] === 0x0d
        ? pending.subarray(0, -1).toString("utf8")
        : pending.toString("utf8");
      pending = Buffer.alloc(0);
      handleStdoutLine(line);
      input = input.subarray(newline + 1);
    }
  });
  child.stdout.on("end", () => {
    if (!droppingOversizedLine && pending.length > 0) handleStdoutLine(pending.toString("utf8"));
    pending = Buffer.alloc(0);
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderr = boundString(`${stderr}${text}`, maxCapturedBytes);
    void emit("stderr", text);
  });

  if (invocation.stdin !== undefined) {
    child.stdin.end(invocation.stdin);
  } else {
    child.stdin.end();
  }

  const signalTree = (signal: NodeJS.Signals): void => {
    if (useProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
        return;
      }
    }
    child.kill(signal);
  };

  const terminate = (): void => {
    if (settled) return;
    signalTree("SIGTERM");
    escalationTimer = setTimeout(() => signalTree("SIGKILL"), 2_000);
    escalationTimer.unref();
  };

  const abortListener = (): void => terminate();
  options.signal?.addEventListener("abort", abortListener, { once: true });
  const timeout = options.timeoutMs
    ? setTimeout(terminate, options.timeoutMs)
    : undefined;
  timeout?.unref();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      resolve(code ?? (signal ? 128 : 1));
    });
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (escalationTimer) clearTimeout(escalationTimer);
    options.signal?.removeEventListener("abort", abortListener);
  });

  await emit("completed", { exitCode });

  return {
    provider,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    finalResponse: state.finalResponse.trim(),
    exitCode,
    durationMs: Date.now() - started,
    events,
    stderr: stderr.trim()
  };
}

function boundString(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

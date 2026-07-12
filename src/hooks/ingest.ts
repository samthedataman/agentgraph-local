import { rpc } from "../ipc/client.js";
import { spoolHookEvent, type SpoolOptions } from "./spool.js";
import type { HookDeliveryResult, NormalizedHookEvent } from "./types.js";

export interface IngestHookOptions extends SpoolOptions {
  timeoutMs?: number;
  socketPath?: string;
  send?: typeof rpc;
}

/** Deliver quickly; a daemon outage must never break or stall the host agent. */
export async function ingestHookEvent(
  event: NormalizedHookEvent,
  options: IngestHookOptions = {}
): Promise<HookDeliveryResult> {
  const send = options.send ?? rpc;
  try {
    await send(
      "event.append",
      { event },
      {
        timeoutMs: options.timeoutMs ?? 250,
        ...(options.socketPath ? { socketPath: options.socketPath } : {})
      }
    );
    return { delivered: true, spooled: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const spoolPath = await spoolHookEvent(event, options);
      return { delivered: false, spooled: true, spoolPath, error: message };
    } catch (spoolError) {
      const spoolMessage = spoolError instanceof Error ? spoolError.message : String(spoolError);
      return {
        delivered: false,
        spooled: false,
        error: `${message}; spool failed: ${spoolMessage}`
      };
    }
  }
}

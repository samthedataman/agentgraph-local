import { mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { rpc } from "../src/ipc/client.js";
import { ingestHookEvent } from "../src/hooks/ingest.js";
import { drainHookSpool } from "../src/hooks/spool.js";
import { normalizeCodexHook } from "../src/hooks/normalize.js";

function event() {
  return normalizeCodexHook(
    { hook_event_name: "Stop", session_id: "thr_1", turn_id: "turn_1" },
    { now: "2026-07-12T12:00:00Z", env: {} }
  );
}

describe("hook delivery", () => {
  it("uses the short RPC path when the daemon is healthy", async () => {
    const calls: unknown[][] = [];
    const send: typeof rpc = async <T>(...args: Parameters<typeof rpc>) => {
      calls.push(args);
      return { inserted: true } as T;
    };
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-hooks-"));
    const result = await ingestHookEvent(event(), { send, directory, timeoutMs: 17 });
    expect(result).toEqual({ delivered: true, spooled: false });
    expect(calls[0]?.[0]).toBe("event.append");
    expect((calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBe(17);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("atomically spools one event when RPC is unavailable", async () => {
    const send: typeof rpc = async () => {
      throw new Error("daemon down");
    };
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-hooks-"));
    const result = await ingestHookEvent(event(), { send, directory });
    expect(result.delivered).toBe(false);
    expect(result.spooled).toBe(true);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.event$/);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    const parsed = JSON.parse(await readFile(join(directory, files[0] as string), "utf8")) as {
      event: { kind: string };
    };
    expect(parsed.event.kind).toBe("turn.completed");
  });

  it("replays and removes durable spool events", async () => {
    const send: typeof rpc = async () => {
      throw new Error("daemon down");
    };
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-hooks-"));
    await ingestHookEvent(event(), { send, directory });
    const delivered: string[] = [];
    const result = await drainHookSpool(directory, (item) => {
      delivered.push(item.event_id);
    });
    expect(result).toMatchObject({ delivered: 1, retried: 0, quarantined: 0 });
    expect(delivered).toHaveLength(1);
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("recovers a processing claim stranded by a daemon crash", async () => {
    const send: typeof rpc = async () => {
      throw new Error("daemon down");
    };
    const directory = await mkdtemp(join(tmpdir(), "agentgraph-hooks-"));
    await ingestHookEvent(event(), { send, directory });
    const [eventName] = await readdir(directory);
    expect(eventName).toMatch(/\.event$/);
    await rename(
      join(directory, eventName as string),
      join(directory, (eventName as string).replace(/\.event$/, ".processing"))
    );

    const delivered: string[] = [];
    const result = await drainHookSpool(directory, (item) => delivered.push(item.event_id));
    expect(result).toMatchObject({ delivered: 1, recovered: 1, retried: 0, quarantined: 0 });
    expect(delivered).toHaveLength(1);
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteSyncClient, makeRemoteIdempotencyKey, validateRemoteUrl } from "../src/remote/client.js";
import { startRemoteHub } from "../src/remote/hub.js";
import { RemoteHubStore } from "../src/remote/store.js";
import { getProcessStartToken } from "../src/daemon/process-inspection.js";
import type { Authenticator, RemoteRecordInput } from "../src/remote/types.js";

const TOKEN = "remote-client-test-token-0123456789abcdef";
const authenticator: Authenticator = {
  authenticate: (token) => token === TOKEN
    ? { tokenId: "client", teamId: "team-a", repositoryIds: ["repo-a"] }
    : null
};

function memory(text: string): RemoteRecordInput {
  const withoutId: Omit<RemoteRecordInput, "idempotencyKey"> = {
    type: "memory",
    subjectId: `subject-${text}`,
    payload: { kind: "fact", text, confidence: 0.9, importance: 0.8, expiresAt: null },
    provenance: {
      source: "test-client",
      sourceRecordId: `local-${text}`,
      occurredAt: "2026-07-12T12:00:00Z",
      originHostId: "host-a"
    },
    sensitivity: "team"
  };
  return { ...withoutId, idempotencyKey: makeRemoteIdempotencyKey(withoutId) };
}

function client(url: string, statePath: string, enabled = true): RemoteSyncClient {
  return new RemoteSyncClient({
    enabled,
    url,
    token: TOKEN,
    teamId: "team-a",
    repositoryId: "repo-a",
    statePath,
    requestTimeoutMs: 2_000
  });
}

describe("remote sync client", () => {
  it("rejects plaintext non-loopback hubs and stays disabled until explicitly enabled", async () => {
    expect(() => validateRemoteUrl("http://example.com:4320")).toThrow(/HTTPS/);
    const statePath = join(mkdtempSync(join(tmpdir(), "agentgraph-remote-disabled-")), "state.json");
    const disabled = client("http://127.0.0.1:4320", statePath, false);
    expect(disabled.status()).toMatchObject({ enabled: false, cursor: 0, pendingCount: 0 });
    await expect(disabled.syncOnce()).rejects.toThrow(/disabled/);
  });

  it("atomically checkpoints pushes and pulls without sharing the daemon database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-client-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator });
    try {
      const sender = client(hub.url, join(directory, "sender.json"));
      const receiver = client(hub.url, join(directory, "receiver.json"));
      const record = memory("shared-decision");
      expect(sender.enqueue([record, record])).toBe(1);
      const sent = await sender.syncOnce();
      expect(sent).toMatchObject({ pushed: 1, pending: 0 });
      expect(await sender.syncOnce([record])).toMatchObject({ pushed: 0, duplicates: 0, pending: 0 });
      const received = await receiver.syncOnce();
      expect(received).toMatchObject({ pulled: 1, inbox: 1 });
      expect(sender.isOwnRecord(sender.readInbox()[0]!)).toBe(true);
      expect(receiver.isOwnRecord(receiver.readInbox()[0]!)).toBe(false);
      expect(receiver.readInbox()[0]?.actorTokenId).toBe("client");
      expect(receiver.readInbox()[0]?.payload).toMatchObject({ text: "shared-decision" });
      expect(receiver.acknowledgeInbox([receiver.readInbox()[0]!.cursor])).toBe(1);
      expect(receiver.status().inboxCount).toBe(0);
      expect(statSync(join(directory, "receiver.json")).mode & 0o777).toBe(0o600);
      expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("splits push batches by serialized bytes below the default hub request limit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-byte-batch-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator, maxRequestBytes: 1_024 });
    const requestSizes: number[] = [];
    const sender = new RemoteSyncClient({
      enabled: true,
      url: hub.url,
      token: TOKEN,
      teamId: "team-a",
      repositoryId: "repo-a",
      statePath: join(directory, "sender.json"),
      maxRequestBytes: 1_024,
      fetchFn: async (input, init) => {
        if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/push")) {
          requestSizes.push(Buffer.byteLength(String(init?.body ?? ""), "utf8"));
        }
        return fetch(input, init);
      }
    });
    try {
      const records = ["a", "b", "c"].map((key) => ({
        ...memory(`batch-${key}`),
        payload: { ...memory(`batch-${key}`).payload, text: key.repeat(300) }
      }));
      expect(await sender.syncOnce(records)).toMatchObject({ pushed: 3, pending: 0 });
      expect(requestSizes.length).toBeGreaterThan(1);
      expect(requestSizes.every((size) => size <= 1_024)).toBe(true);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("stops streaming an oversized response at the hard local byte limit", async () => {
    let cancelled = false;
    const statePath = join(mkdtempSync(join(tmpdir(), "agentgraph-remote-stream-limit-")), "state.json");
    const bounded = new RemoteSyncClient({
      enabled: true,
      url: "http://127.0.0.1:4320",
      token: TOKEN,
      teamId: "team-a",
      repositoryId: "repo-a",
      statePath,
      maxResponseBytes: 64,
      fetchFn: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(40));
          controller.enqueue(new Uint8Array(40));
        },
        cancel() { cancelled = true; }
      }), { status: 200, headers: { "content-type": "application/json" } })
    });
    await expect(bounded.syncOnce()).rejects.toThrow(/response exceeded/);
    expect(cancelled).toBe(true);
  });

  it("locks state across processes and recovers the lock only after PID birth identity is stale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-state-lock-"));
    const statePath = join(directory, "state.json");
    const locked = client("http://127.0.0.1:4320", statePath);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      let processStartToken: string | null = null;
      for (let attempt = 0; attempt < 20 && !processStartToken; attempt += 1) {
        processStartToken = getProcessStartToken(child.pid!);
        if (!processStartToken) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(processStartToken).not.toBeNull();
      writeFileSync(`${statePath}.lock`, JSON.stringify({
        pid: child.pid,
        processStartToken,
        leaseToken: "held-by-child",
        acquiredAt: new Date().toISOString()
      }), { mode: 0o600 });
      expect(() => locked.enqueue([memory("blocked")])).toThrow(/locked by another process/);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(locked.enqueue([memory("recovered")])).toBe(1);
      expect(locked.status().pendingCount).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("atomically stages local mutation cursors and uses actor-safe binding keys", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "agentgraph-remote-stage-")), "state.json");
    const staged = client("http://127.0.0.1:4320", statePath);
    const invalid = { ...memory("invalid"), payload: { kind: "fact", text: "x" } } as RemoteRecordInput;
    expect(() => staged.stageLocalMutations([invalid], 5)).toThrow();
    expect(staged.getLocalMutationCursor()).toBe(0);
    expect(staged.status().pendingCount).toBe(0);
    expect(staged.stageLocalMutations([memory("valid")], 5)).toBe(1);
    expect(staged.getLocalMutationCursor()).toBe(5);
    expect(staged.status().pendingCount).toBe(1);
    expect(staged.stageLocalMutations([], 6)).toBe(0);
    expect(staged.getLocalMutationCursor()).toBe(6);

    staged.setRemoteBinding("actor-a", "__proto__", "local-a");
    expect(staged.getRemoteBinding("actor-a", "__proto__")).toBe("local-a");
    expect(staged.getRemoteBinding("actor-b", "__proto__")).toBeNull();
  });

  it("keeps pending records after a network failure for a later idempotent retry", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "agentgraph-remote-retry-")), "state.json");
    const unavailable = client("http://127.0.0.1:1", statePath);
    await expect(unavailable.syncOnce([memory("retry")])).rejects.toThrow();
    expect(unavailable.status().pendingCount).toBe(1);
  });

  it("watches with bounded long polls and stops cleanly when aborted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-watch-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator, maxLongPollMs: 500 });
    try {
      const watcher = client(hub.url, join(directory, "watcher.json"));
      const sender = client(hub.url, join(directory, "sender.json"));
      const abort = new AbortController();
      let observed = 0;
      const watching = watcher.watch({
        signal: abort.signal,
        waitMs: 500,
        onSync: (result) => {
          observed += result.pulled;
          if (observed > 0) abort.abort();
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await sender.syncOnce([memory("near-real-time")]);
      await watching;
      expect(observed).toBe(1);
      expect(watcher.status().cursor).toBeGreaterThan(0);
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("cancels an in-flight watch request immediately on abort", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-watch-abort-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator, maxLongPollMs: 1_000 });
    try {
      const watcher = client(hub.url, join(directory, "watcher.json"));
      const abort = new AbortController();
      const watching = watcher.watch({ signal: abort.signal, waitMs: 1_000 });
      setTimeout(() => abort.abort(), 25);
      await expect(Promise.race([
        watching.then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 300))
      ])).resolves.toBe("stopped");
    } finally {
      await hub.close();
      store.close();
    }
  });
});

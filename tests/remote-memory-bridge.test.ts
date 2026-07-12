import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MemoryItem, MemoryMutation, MemoryMutationBatch } from "../src/memory/types.js";
import { RemoteSyncClient } from "../src/remote/client.js";
import { startRemoteHub } from "../src/remote/hub.js";
import { RemoteMemoryBridge, type RemoteRpcCall } from "../src/remote/memory-bridge.js";
import { RemoteHubStore } from "../src/remote/store.js";
import type { Authenticator, RemoteRecordInput } from "../src/remote/types.js";

const TOKEN = "remote-bridge-test-token-0123456789abcdef";
const authenticator: Authenticator = {
  authenticate: () => ({ tokenId: "bridge", teamId: "team-a", repositoryIds: ["repo-a"] })
};

function localMemory(id: string, sensitivity: MemoryItem["sensitivity"] = "public", metadata: Record<string, unknown> = {}): MemoryItem {
  return {
    id,
    kind: "decision",
    text: `text ${id}`,
    scope: { kind: "repository", key: "/workspace" },
    sourceSessionId: null,
    sources: [],
    confidence: 0.9,
    importance: 0.8,
    sensitivity,
    status: "current",
    supersededBy: null,
    expiresAt: null,
    metadata,
    createdAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:01.000Z"
  };
}

function inboundMemory(): RemoteRecordInput {
  return {
    idempotencyKey: "bridge-inbound-record-0001",
    type: "memory",
    subjectId: "remote-memory-1",
    payload: {
      kind: "decision",
      text: "remote team decision",
      confidence: 0.9,
      importance: 0.8,
      expiresAt: null
    },
    provenance: {
      source: "agentgraph-local-memory",
      sourceRecordId: "origin-memory-1",
      occurredAt: "2026-07-12T12:00:00.000Z",
      originHostId: "remote-host",
      originAgent: "claude"
    },
    sensitivity: "team"
  };
}

describe("remote local-memory bridge", () => {
  it("exports public memories while always excluding secrets, private-by-default, and remote echoes", async () => {
    const values = [
      localMemory("public"),
      localMemory("private", "private"),
      localMemory("secret", "secret"),
      localMemory("echo", "public", { remoteSync: { cursor: 1 } })
    ];
    const rpcCall: RemoteRpcCall = async <T>(method: string): Promise<T> => {
      expect(method).toBe("memory.search");
      return values as T;
    };
    const bridge = new RemoteMemoryBridge({ originHostId: "local-host", rpcCall });
    const records = await bridge.exportMemories({ scope: { kind: "repository", key: "/workspace" } });
    expect(records.map((item) => item.subjectId)).toEqual(["public"]);
    expect(records[0]?.provenance).toMatchObject({ originHostId: "local-host", sourceRecordId: "public" });

    const privateBridge = new RemoteMemoryBridge({ originHostId: "local-host", rpcCall, sharePrivate: true });
    expect((await privateBridge.exportMemories({ scope: { kind: "repository", key: "/workspace" } }))
      .map((item) => item.subjectId)).toEqual(["public", "private"]);
  });

  it("imports remote memories through daemon RPC, checkpoints each item, and maps later tombstones", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-bridge-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator });
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpcCall: RemoteRpcCall = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "memory.commit") return localMemory("local-imported", "private") as T;
      if (method === "memory.forget") return { forgotten: true } as T;
      throw new Error(`unexpected method ${method}`);
    };
    const client = new RemoteSyncClient({
      enabled: true,
      url: hub.url,
      token: TOKEN,
      teamId: "team-a",
      repositoryId: "repo-a",
      statePath: join(directory, "state.json")
    });
    const bridge = new RemoteMemoryBridge({
      originHostId: "local-host",
      rpcCall,
      localScope: { kind: "repository", key: "/local/workspace" }
    });
    try {
      store.push(client.namespace, [inboundMemory()], "actor-a");
      await client.syncOnce();
      expect(await bridge.applyInbox(client)).toMatchObject({ applied: 1, skipped: 0, failed: [] });
      expect(client.status().inboxCount).toBe(0);
      expect(client.getRemoteBinding("actor-a", "remote-memory-1")).toBe("local-imported");
      expect(calls[0]).toMatchObject({
        method: "memory.commit",
        params: {
          scope: { kind: "repository", key: "/local/workspace" },
          sensitivity: "private",
          sources: [{
            type: "agent",
            id: "remote-token:actor-a"
          }],
          metadata: {
            trust: {
              level: "untrusted-peer",
              authenticatedActorTokenId: "actor-a"
            },
            remoteSync: {
              authenticatedActorTokenId: "actor-a",
              trust: "untrusted-peer"
            }
          }
        }
      });

      store.push(client.namespace, [{
        ...inboundMemory(),
        idempotencyKey: "bridge-tombstone-record-01",
        type: "tombstone",
        subjectId: "remote-memory-1",
        payload: { reason: "removed by team" }
      }], "actor-b");
      await client.syncOnce();
      expect(await bridge.applyInbox(client)).toMatchObject({ applied: 0, skipped: 1, failed: [] });
      expect(calls.some((call) => call.method === "memory.forget")).toBe(false);

      store.push(client.namespace, [{
        ...inboundMemory(),
        idempotencyKey: "bridge-tombstone-record-02",
        type: "tombstone",
        subjectId: "remote-memory-1",
        payload: { reason: "removed by the originating actor" }
      }], "actor-a");
      await client.syncOnce();
      expect(await bridge.applyInbox(client)).toMatchObject({ applied: 1, failed: [] });
      expect(calls.at(-1)).toEqual({ method: "memory.forget", params: { memoryId: "local-imported" } });
    } finally {
      await hub.close();
      store.close();
    }
  });

  it("pages the durable mutation outbox beyond 100 and atomically stages only shareable local records", async () => {
    const mutations: MemoryMutation[] = Array.from({ length: 205 }, (_, index) => {
      const memory = localMemory(`memory-${index}`);
      return {
        cursor: index + 1,
        mutationId: `mutation-${index}`,
        operation: "commit",
        memoryId: memory.id,
        supersedesMemoryId: null,
        memory,
        supersedes: null,
        createdAt: memory.updatedAt
      };
    });
    mutations.push({
      cursor: 206,
      mutationId: "mutation-secret",
      operation: "commit",
      memoryId: "secret",
      supersedesMemoryId: null,
      memory: localMemory("secret", "secret"),
      supersedes: null,
      createdAt: "2026-07-12T12:00:02.000Z"
    });
    mutations.push({
      cursor: 207,
      mutationId: "mutation-echo",
      operation: "commit",
      memoryId: "echo",
      supersedesMemoryId: null,
      memory: localMemory("echo", "public", { remoteSync: { cursor: 1 } }),
      supersedes: null,
      createdAt: "2026-07-12T12:00:03.000Z"
    });
    const rpcCall: RemoteRpcCall = async <T>(method: string, params?: unknown): Promise<T> => {
      expect(method).toBe("memory.mutations");
      const input = params as { afterCursor: number; limit: number };
      const page = mutations.filter((item) => item.cursor > input.afterCursor).slice(0, input.limit);
      const nextCursor = page.at(-1)?.cursor ?? input.afterCursor;
      return ({
        mutations: page,
        nextCursor,
        latestCursor: mutations.length,
        hasMore: nextCursor < mutations.length
      } satisfies MemoryMutationBatch) as T;
    };
    let cursor = 0;
    const staged: RemoteRecordInput[] = [];
    const client = {
      getLocalMutationCursor: () => cursor,
      stageLocalMutations: (records: RemoteRecordInput[], throughCursor: number) => {
        staged.push(...records);
        cursor = throughCursor;
        return records.length;
      }
    } as unknown as RemoteSyncClient;
    const bridge = new RemoteMemoryBridge({ originHostId: "local-host", rpcCall });

    expect(await bridge.stageMemoryMutations(client, {
      scope: { kind: "repository", key: "/workspace" },
      pageSize: 100
    })).toEqual({ scanned: 207, staged: 205, cursor: 207, hasMore: false });
    expect(staged).toHaveLength(205);
    expect(staged.map((record) => record.subjectId)).toContain("memory-204");
    expect(staged.some((record) => record.subjectId === "secret" || record.subjectId === "echo")).toBe(false);
  });

  it("maps durable delete and supersede mutations without leaking a secret replacement", () => {
    const bridge = new RemoteMemoryBridge({ originHostId: "local-host" });
    const original = localMemory("original");
    const replacement = localMemory("replacement");
    const supersede: MemoryMutation = {
      cursor: 2,
      mutationId: "mutation-supersede",
      operation: "supersede",
      memoryId: replacement.id,
      supersedesMemoryId: original.id,
      memory: replacement,
      supersedes: { ...original, status: "superseded", supersededBy: replacement.id },
      createdAt: replacement.updatedAt
    };
    expect(bridge.mutationToRecords(supersede)[0]).toMatchObject({
      type: "supersession",
      subjectId: "replacement",
      payload: { supersedesId: "original", replacement: { text: "text replacement" } }
    });

    const deleted = { ...replacement, status: "deleted" as const };
    expect(bridge.mutationToRecords({
      cursor: 3,
      mutationId: "mutation-delete",
      operation: "delete",
      memoryId: deleted.id,
      supersedesMemoryId: null,
      memory: deleted,
      supersedes: null,
      createdAt: deleted.updatedAt
    })[0]).toMatchObject({ type: "tombstone", subjectId: "replacement" });

    const privateDeleted = { ...deleted, id: "private-deleted", sensitivity: "private" as const };
    expect(bridge.mutationToRecords({
      cursor: 4,
      mutationId: "mutation-private-delete",
      operation: "delete",
      memoryId: privateDeleted.id,
      supersedesMemoryId: null,
      memory: privateDeleted,
      supersedes: null,
      createdAt: privateDeleted.updatedAt
    })[0]).toMatchObject({ type: "tombstone", subjectId: "private-deleted" });

    const secret = localMemory("secret-replacement", "secret");
    expect(bridge.mutationToRecords({ ...supersede, memory: secret, memoryId: secret.id })[0]).toMatchObject({
      type: "tombstone",
      subjectId: "original"
    });
  });

  it("acknowledges unsupported remote record types instead of wedging the inbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentgraph-remote-unsupported-"));
    const store = new RemoteHubStore(":memory:");
    const hub = await startRemoteHub({ enabled: true, port: 0, store, authenticator });
    const client = new RemoteSyncClient({
      enabled: true,
      url: hub.url,
      token: TOKEN,
      teamId: "team-a",
      repositoryId: "repo-a",
      statePath: join(directory, "state.json")
    });
    const bridge = new RemoteMemoryBridge({
      originHostId: "local-host",
      rpcCall: async () => { throw new Error("unsupported records must not call local memory RPC"); }
    });
    try {
      store.push(client.namespace, [{
        ...inboundMemory(),
        idempotencyKey: "bridge-artifact-record-001",
        type: "artifact",
        subjectId: "artifact-1",
        payload: { name: "report.txt" }
      }]);
      await client.syncOnce();
      expect(await bridge.applyInbox(client)).toEqual({ applied: 0, skipped: 1, failed: [] });
      expect(client.status().inboxCount).toBe(0);
    } finally {
      await hub.close();
      store.close();
    }
  });
});

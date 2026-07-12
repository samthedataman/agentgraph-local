import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDomainHandlers } from "../src/daemon/domain-handlers.js";
import type { SqliteDatabase } from "../src/memory/database.js";
import { MemoryStore } from "../src/memory/store.js";

const open: Database.Database[] = [];

function database(): SqliteDatabase {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  open.push(db);
  return db as unknown as SqliteDatabase;
}

afterEach(() => {
  while (open.length) open.pop()?.close();
});

describe("durable memory mutation outbox", () => {
  it("appends commit, supersede, and delete snapshots behind a monotonic cursor", () => {
    let tick = 0;
    const store = new MemoryStore(database(), () => `2026-07-12T12:00:0${tick++}.000Z`);
    const first = store.commit({
      kind: "decision",
      text: "Use port 3000",
      scope: { kind: "repository", key: "/repo" },
      sensitivity: "private",
      sources: [{ type: "event", id: "evt_1" }]
    });
    const replacement = store.supersede(first.id, {
      kind: "decision",
      text: "Use a Unix socket",
      scope: { kind: "repository", key: "/repo" },
      sensitivity: "public"
    });
    expect(store.forget(replacement.id)).toBe(true);

    const batch = store.mutationsAfter({ afterCursor: 0, limit: 20 });
    expect(batch).toMatchObject({ nextCursor: 3, latestCursor: 3, hasMore: false });
    expect(batch.mutations.map((mutation) => mutation.cursor)).toEqual([1, 2, 3]);
    expect(batch.mutations.map((mutation) => mutation.operation)).toEqual(["commit", "supersede", "delete"]);
    expect(batch.mutations[0]).toMatchObject({
      memoryId: first.id,
      memory: { id: first.id, status: "current", sensitivity: "private" }
    });
    expect(batch.mutations[1]).toMatchObject({
      memoryId: replacement.id,
      supersedesMemoryId: first.id,
      memory: { id: replacement.id, status: "current" },
      supersedes: { id: first.id, status: "superseded", supersededBy: replacement.id }
    });
    expect(batch.mutations[2]).toMatchObject({
      memoryId: replacement.id,
      memory: { id: replacement.id, status: "deleted" }
    });
  });

  it("preserves sensitivity and remote-import metadata for fail-closed bridge filtering", () => {
    const store = new MemoryStore(database());
    store.commit({
      kind: "fact",
      text: "never synchronize this",
      scope: { kind: "repository", key: "/repo" },
      sensitivity: "secret",
      metadata: { remoteSync: { cursor: 42, sourceRecordId: "peer-memory" } }
    });

    expect(store.mutationsAfter({ afterCursor: 0 }).mutations[0]?.memory).toMatchObject({
      sensitivity: "secret",
      metadata: { remoteSync: { cursor: 42, sourceRecordId: "peer-memory" } }
    });
  });

  it("backfills pre-outbox memories once without losing status or filtering metadata", () => {
    const db = database();
    const beforeUpgrade = new MemoryStore(db);
    const current = beforeUpgrade.commit({
      kind: "fact",
      text: "imported secret",
      scope: { kind: "repository", key: "/repo" },
      sensitivity: "secret",
      metadata: { remoteSync: { sourceRecordId: "remote-1" } }
    });
    const deleted = beforeUpgrade.commit({
      kind: "warning",
      text: "obsolete warning",
      scope: { kind: "repository", key: "/repo" }
    });
    beforeUpgrade.forget(deleted.id);
    db.exec("DROP TABLE ag_memory_mutations");

    const afterUpgrade = new MemoryStore(db);
    const mutations = afterUpgrade.mutationsAfter({ afterCursor: 0 }).mutations;
    expect(mutations).toHaveLength(2);
    expect(mutations.every((mutation) => mutation.operation === "commit")).toBe(true);
    expect(mutations.find((mutation) => mutation.memoryId === current.id)?.memory).toMatchObject({
      sensitivity: "secret",
      metadata: { remoteSync: { sourceRecordId: "remote-1" } }
    });
    expect(mutations.find((mutation) => mutation.memoryId === deleted.id)?.memory.status).toBe("deleted");

    // Reopening the schema does not duplicate the migration snapshots.
    new MemoryStore(db);
    expect(afterUpgrade.mutationsAfter({ afterCursor: 0 }).mutations).toHaveLength(2);
  });

  it("paginates without skipping records and rejects unbounded reads", () => {
    const store = new MemoryStore(database());
    for (let index = 0; index < 3; index += 1) {
      store.commit({
        kind: "fact",
        text: `memory ${index}`,
        scope: { kind: "repository", key: "/repo" }
      });
    }
    const first = store.mutationsAfter({ afterCursor: 0, limit: 2 });
    expect(first).toMatchObject({ nextCursor: 2, latestCursor: 3, hasMore: true });
    expect(store.mutationsAfter({ afterCursor: first.nextCursor, limit: 2 })).toMatchObject({
      nextCursor: 3,
      latestCursor: 3,
      hasMore: false
    });
    expect(() => store.mutationsAfter({ afterCursor: -1 })).toThrow(/afterCursor/);
    expect(() => store.mutationsAfter({ afterCursor: 0, limit: 501 })).toThrow(/limit/);
  });

  it("filters mutation cursors by scope so a sync client cannot skip another scope", () => {
    const store = new MemoryStore(database());
    store.commit({
      kind: "fact",
      text: "repo-a",
      scope: { kind: "repository", key: "/repo-a" },
      sensitivity: "public"
    });
    store.commit({
      kind: "fact",
      text: "repo-b",
      scope: { kind: "repository", key: "/repo-b" },
      sensitivity: "public"
    });
    const batch = store.mutationsAfter({
      afterCursor: 0,
      scope: { kind: "repository", key: "/repo-b" }
    });
    expect(batch.mutations.map((mutation) => mutation.memory.text)).toEqual(["repo-b"]);
    expect(batch.nextCursor).toBe(batch.mutations[0]?.cursor);
    expect(batch.hasMore).toBe(false);
  });

  it("rolls back every memory operation if its outbox append fails", () => {
    const db = database();
    const store = new MemoryStore(db);
    const original = store.commit({
      kind: "fact",
      text: "original",
      scope: { kind: "repository", key: "/repo" }
    });
    db.exec(`
      CREATE TRIGGER reject_memory_mutations
      BEFORE INSERT ON ag_memory_mutations
      BEGIN
        SELECT RAISE(ABORT, 'outbox append failed');
      END;
    `);

    expect(() => store.commit({
      kind: "fact",
      text: "must roll back",
      scope: { kind: "repository", key: "/repo" }
    })).toThrow(/outbox append failed/);
    expect(() => store.supersede(original.id, {
      kind: "fact",
      text: "replacement must roll back",
      scope: { kind: "repository", key: "/repo" }
    })).toThrow(/outbox append failed/);
    expect(() => store.forget(original.id)).toThrow(/outbox append failed/);

    expect(store.get(original.id)).toMatchObject({ status: "current", supersededBy: null });
    expect(store.search({ query: "original", scope: { kind: "repository", key: "/repo" } })).toHaveLength(1);
    expect(store.search({ query: "roll back", scope: { kind: "repository", key: "/repo" } })).toEqual([]);
    expect(store.mutationsAfter({ afterCursor: 0 }).mutations).toHaveLength(1);
  });

  it("exposes bounded cursor reads through the daemon domain RPC", () => {
    const db = database();
    const owner = { database: db };
    const handlers = createDomainHandlers(owner);
    handlers["memory.commit"]?.({
      kind: "fact",
      text: "RPC mutation",
      scope: { kind: "repository", key: "/repo" }
    });

    expect(handlers["memory.mutations"]?.({ afterCursor: 0, limit: 10 })).toMatchObject({
      nextCursor: 1,
      latestCursor: 1,
      hasMore: false,
      mutations: [expect.objectContaining({ operation: "commit" })]
    });
    expect(() => handlers["memory.mutations"]?.({ afterCursor: -1 })).toThrow(/afterCursor/);
    expect(() => handlers["memory.mutations"]?.({ afterCursor: 0, limit: 501 })).toThrow(/limit/);
  });
});

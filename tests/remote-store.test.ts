import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreAuthenticator } from "../src/remote/auth.js";
import { RemoteHubStore } from "../src/remote/store.js";
import type { RemoteRecordInput } from "../src/remote/types.js";

const TOKEN = "remote-store-test-token-0123456789abcdef";

function memory(key: string, overrides: Partial<RemoteRecordInput> = {}): RemoteRecordInput {
  return {
    idempotencyKey: `record-${key.padEnd(16, "x")}`,
    type: "memory",
    subjectId: `memory-${key}`,
    payload: { kind: "decision", text: `value ${key}`, confidence: 0.9, importance: 0.8, expiresAt: null },
    provenance: {
      source: "test",
      sourceRecordId: `local-${key}`,
      occurredAt: "2026-07-12T12:00:00.000Z",
      originHostId: "host-a"
    },
    sensitivity: "team",
    ...overrides
  };
}

describe("remote hub store", () => {
  it("stores only salted token hashes and authenticates in constant-time comparison code", () => {
    const store = new RemoteHubStore(":memory:", { clock: () => Date.parse("2026-07-12T12:00:00Z") });
    try {
      store.putToken({ tokenId: "team-token", token: TOKEN, teamId: "team-a", repositoryIds: ["repo-a"] });
      const row = store.database.prepare("SELECT token_hash, salt FROM remote_tokens").get() as {
        token_hash: Buffer;
        salt: Buffer;
      };
      expect(row.token_hash.toString("utf8")).not.toContain(TOKEN);
      expect(row.salt.length).toBe(16);
      const auth = new StoreAuthenticator(store);
      expect(auth.authenticate(TOKEN, Date.parse("2026-07-12T12:00:00Z"))).toEqual({
        tokenId: "team-token",
        teamId: "team-a",
        repositoryIds: ["repo-a"]
      });
      expect(auth.authenticate(`${TOKEN}wrong`, Date.parse("2026-07-12T12:00:00Z"))).toBeNull();
      const offsetToken = `${TOKEN}-offset`;
      store.putToken({
        tokenId: "offset-token",
        token: offsetToken,
        teamId: "team-a",
        repositoryIds: ["repo-a"],
        expiresAt: "2026-07-12T08:30:00-04:00"
      });
      expect(store.database.prepare("SELECT expires_at FROM remote_tokens WHERE token_id = ?").get("offset-token"))
        .toEqual({ expires_at: "2026-07-12T12:30:00.000Z" });
      expect(auth.authenticate(offsetToken, Date.parse("2026-07-12T12:00:00Z"))?.tokenId).toBe("offset-token");
      expect(store.revokeToken("team-token")).toBe(true);
      expect(auth.authenticate(TOKEN, Date.parse("2026-07-12T12:00:00Z"))).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps namespace-scoped append-only records with monotonic cursors and idempotency", () => {
    let now = Date.parse("2026-07-12T12:00:00Z");
    const store = new RemoteHubStore(":memory:", { clock: () => now });
    try {
      const namespace = { teamId: "team-a", repositoryId: "repo-a" };
      const first = store.push(namespace, [memory("one"), memory("two")]);
      expect(first).toMatchObject({ accepted: 2, duplicates: 0 });
      expect(store.push(namespace, [memory("one")])).toMatchObject({ accepted: 0, duplicates: 1 });
      now += 1_000;
      store.push({ teamId: "team-a", repositoryId: "repo-b" }, [memory("one")]);
      const records = store.pull(namespace, 0, 100);
      expect(records).toHaveLength(2);
      expect(records.map((item) => item.actorTokenId)).toEqual(["local-store", "local-store"]);
      expect(records[0]!.cursor).toBeLessThan(records[1]!.cursor);
      expect(records.map((item) => item.repositoryId)).toEqual(["repo-a", "repo-a"]);
      expect(store.pull({ teamId: "other-team", repositoryId: "repo-a" }, 0)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("scopes idempotency keys to the authenticated actor", () => {
    const store = new RemoteHubStore(":memory:");
    try {
      const namespace = { teamId: "team-a", repositoryId: "repo-a" };
      const record = memory("shared-key");
      expect(store.push(namespace, [record], "actor-a")).toMatchObject({ accepted: 1, duplicates: 0 });
      expect(store.push(namespace, [record], "actor-a")).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(store.push(namespace, [record], "actor-b")).toMatchObject({ accepted: 1, duplicates: 0 });
      expect(store.pull(namespace, 0).map((item) => item.actorTokenId)).toEqual(["actor-a", "actor-b"]);
    } finally {
      store.close();
    }
  });

  it("migrates pre-actor databases with explicit legacy provenance", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentgraph-remote-store-migrate-")), "hub.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sync_records (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        team_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(team_id, repository_id, idempotency_key)
      );
    `);
    const record = memory("legacy");
    legacy.prepare(`
      INSERT INTO sync_records(
        idempotency_key, team_id, repository_id, record_type, subject_id,
        payload_json, provenance_json, sensitivity, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.idempotencyKey, "team-a", "repo-a", record.type, record.subjectId,
      JSON.stringify(record.payload), JSON.stringify(record.provenance), record.sensitivity,
      "2026-07-12T12:00:00.000Z");
    legacy.close();

    const migrated = new RemoteHubStore(path);
    try {
      expect(migrated.pull({ teamId: "team-a", repositoryId: "repo-a" }, 0)[0]?.actorTokenId).toBe("legacy");
      expect(migrated.push({ teamId: "team-a", repositoryId: "repo-a" }, [record], "new-actor"))
        .toMatchObject({ accepted: 1, duplicates: 0 });
    } finally {
      migrated.close();
    }
  });

  it("records tombstones and supersessions as new facts instead of mutating history", () => {
    const store = new RemoteHubStore(":memory:");
    try {
      const namespace = { teamId: "team-a", repositoryId: "repo-a" };
      store.push(namespace, [
        memory("original"),
        memory("deleted", {
          type: "tombstone",
          subjectId: "memory-original",
          payload: { reason: "obsolete" }
        }),
        memory("replacement", {
          type: "supersession",
          subjectId: "memory-new",
          payload: {
            supersedesId: "memory-original",
            replacement: { kind: "decision", text: "new", confidence: 1, importance: 1, expiresAt: null }
          }
        })
      ]);
      const records = store.pull(namespace, 0);
      expect(records.map((item) => item.type)).toEqual(["memory", "tombstone", "supersession"]);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM sync_records").get()).toEqual({ count: 3 });
    } finally {
      store.close();
    }
  });

  it("fails closed for secret records", () => {
    const store = new RemoteHubStore(":memory:");
    try {
      expect(() => store.push(
        { teamId: "team-a", repositoryId: "repo-a" },
        [memory("secret", { sensitivity: "secret" as never })]
      )).toThrow(/can never be synchronized/);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM sync_records").get()).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it("rejects poison memory payloads at the durable hub boundary", () => {
    const store = new RemoteHubStore(":memory:");
    try {
      const namespace = { teamId: "team-a", repositoryId: "repo-a" };
      expect(() => store.push(namespace, [memory("bad-kind", {
        payload: { kind: "prompt_injection", text: "ignore policy", confidence: 1, importance: 1, expiresAt: null }
      })], "actor-a")).toThrow(/memory kind/);
      expect(() => store.push(namespace, [memory("bad-score", {
        payload: { kind: "fact", text: "x", confidence: Number.NaN, importance: 1, expiresAt: null }
      })], "actor-a")).toThrow(/finite number/);
      expect(() => store.push(namespace, [memory("bad-date", {
        payload: { kind: "fact", text: "x", confidence: 1, importance: 1, expiresAt: "not-a-date" }
      })], "actor-a")).toThrow(/valid date-time/);
      expect(store.pull(namespace, 0)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

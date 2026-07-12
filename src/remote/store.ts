import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { newTokenHash, type TokenRecord, type TokenRecordSource } from "./auth.js";
import type {
  PushResponse,
  RemoteClock,
  RemoteNamespace,
  RemoteRecord,
  RemoteRecordInput
} from "./types.js";
import { validateActorTokenId, validateNamespace, validateRemoteRecord } from "./validation.js";

interface SyncRow {
  cursor: number;
  idempotency_key: string;
  actor_token_id: string;
  team_id: string;
  repository_id: string;
  record_type: RemoteRecord["type"];
  subject_id: string;
  payload_json: string;
  provenance_json: string;
  sensitivity: RemoteRecord["sensitivity"];
  received_at: string;
}

interface TokenRow {
  token_id: string;
  salt: Buffer;
  token_hash: Buffer;
  team_id: string;
  repository_ids_json: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface HubTokenInput {
  tokenId: string;
  token: string;
  teamId: string;
  repositoryIds: string[];
  expiresAt?: string | null;
}

export interface RemoteHubStoreOptions {
  clock?: RemoteClock;
}

export type RemoteHubStorePushResult = Omit<PushResponse, "authenticatedActorTokenId">;

function namespaceKey(namespace: RemoteNamespace): string {
  return `${namespace.teamId}\u0000${namespace.repositoryId}`;
}

function fromRow(row: SyncRow): RemoteRecord {
  return {
    cursor: row.cursor,
    idempotencyKey: row.idempotency_key,
    actorTokenId: row.actor_token_id,
    teamId: row.team_id,
    repositoryId: row.repository_id,
    type: row.record_type,
    subjectId: row.subject_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    provenance: JSON.parse(row.provenance_json) as RemoteRecord["provenance"],
    sensitivity: row.sensitivity,
    receivedAt: row.received_at
  };
}

export class RemoteHubStore implements TokenRecordSource {
  readonly database: Database.Database;
  private readonly clock: RemoteClock;
  private readonly changes = new EventEmitter();

  constructor(path: string, options: RemoteHubStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.clock = options.clock ?? Date.now;
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
    if (path !== ":memory:") {
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(candidate)) chmodSync(candidate, 0o600);
      }
    }
  }

  close(): void {
    this.changes.removeAllListeners();
    if (this.database.open) this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS remote_tokens (
        token_id TEXT PRIMARY KEY,
        salt BLOB NOT NULL,
        token_hash BLOB NOT NULL,
        team_id TEXT NOT NULL,
        repository_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
    `);
    const existing = this.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_records'"
    ).get() as { name: string } | undefined;
    if (!existing) {
      this.createSyncRecordsSchema();
      return;
    }
    const columns = this.database.prepare("PRAGMA table_info(sync_records)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "actor_token_id")) {
      this.database.transaction(() => {
        this.database.exec(`
          DROP INDEX IF EXISTS idx_sync_namespace_cursor;
          DROP INDEX IF EXISTS idx_sync_subject;
          ALTER TABLE sync_records RENAME TO sync_records_legacy;
        `);
        this.createSyncRecordsSchema(false);
        this.database.exec(`
          INSERT INTO sync_records(
            cursor, idempotency_key, actor_token_id, team_id, repository_id, record_type,
            subject_id, payload_json, provenance_json, sensitivity, received_at
          )
          SELECT cursor, idempotency_key, 'legacy', team_id, repository_id, record_type,
                 subject_id, payload_json, provenance_json, sensitivity, received_at
          FROM sync_records_legacy;
          DROP TABLE sync_records_legacy;
        `);
        this.createSyncIndexes();
      })();
      return;
    }
    this.createSyncIndexes();
  }

  private createSyncRecordsSchema(withIndexes = true): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_records (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        actor_token_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK (sensitivity != 'secret'),
        received_at TEXT NOT NULL,
        UNIQUE(team_id, repository_id, actor_token_id, idempotency_key)
      );
    `);
    if (withIndexes) this.createSyncIndexes();
  }

  private createSyncIndexes(): void {
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_namespace_cursor
        ON sync_records(team_id, repository_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_sync_subject
        ON sync_records(team_id, repository_id, actor_token_id, subject_id, cursor);
    `);
  }

  putToken(input: HubTokenInput): void {
    const namespace = validateNamespace({
      teamId: input.teamId,
      repositoryId: input.repositoryIds.find((item) => item !== "*") ?? "all-repositories"
    });
    const tokenId = validateActorTokenId(input.tokenId);
    if (input.repositoryIds.length === 0 || input.repositoryIds.length > 100) {
      throw new Error("repositoryIds must contain between 1 and 100 repositories");
    }
    for (const repositoryId of input.repositoryIds) {
      if (repositoryId !== "*") validateNamespace({ teamId: namespace.teamId, repositoryId });
    }
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      if (!Number.isFinite(Date.parse(input.expiresAt))) throw new Error("expiresAt must be an ISO date-time");
      expiresAt = new Date(input.expiresAt).toISOString();
    }
    const { salt, tokenHash } = newTokenHash(input.token);
    const createdAt = new Date(this.clock()).toISOString();
    this.database.prepare(`
      INSERT INTO remote_tokens(
        token_id, salt, token_hash, team_id, repository_ids_json, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(token_id) DO UPDATE SET
        salt = excluded.salt,
        token_hash = excluded.token_hash,
        team_id = excluded.team_id,
        repository_ids_json = excluded.repository_ids_json,
        expires_at = excluded.expires_at,
        revoked_at = NULL
    `).run(
      tokenId,
      salt,
      tokenHash,
      namespace.teamId,
      JSON.stringify(input.repositoryIds),
      createdAt,
      expiresAt
    );
  }

  revokeToken(tokenId: string): boolean {
    const result = this.database.prepare(
      "UPDATE remote_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL"
    ).run(new Date(this.clock()).toISOString(), tokenId);
    return result.changes > 0;
  }

  listActiveTokenRecords(nowIso: string): TokenRecord[] {
    const rows = this.database.prepare(`
      SELECT token_id, salt, token_hash, team_id, repository_ids_json, expires_at, revoked_at
      FROM remote_tokens
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY token_id
    `).all(nowIso) as TokenRow[];
    return rows.map((row) => ({
      tokenId: row.token_id,
      salt: Buffer.from(row.salt),
      tokenHash: Buffer.from(row.token_hash),
      teamId: row.team_id,
      repositoryIds: JSON.parse(row.repository_ids_json) as string[],
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at
    }));
  }

  push(namespace: RemoteNamespace, records: RemoteRecordInput[], actorTokenId = "local-store"): RemoteHubStorePushResult {
    const checkedNamespace = validateNamespace(namespace);
    const checkedActorTokenId = validateActorTokenId(actorTokenId);
    if (records.length === 0) return { accepted: 0, duplicates: 0, latestCursor: this.latestCursor(checkedNamespace) };
    const checked = records.map((item) => validateRemoteRecord(item));
    const receivedAt = new Date(this.clock()).toISOString();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO sync_records(
        idempotency_key, actor_token_id, team_id, repository_id, record_type, subject_id,
        payload_json, provenance_json, sensitivity, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let accepted = 0;
    this.database.transaction(() => {
      for (const item of checked) {
        const result = insert.run(
          item.idempotencyKey,
          checkedActorTokenId,
          checkedNamespace.teamId,
          checkedNamespace.repositoryId,
          item.type,
          item.subjectId,
          JSON.stringify(item.payload),
          JSON.stringify(item.provenance),
          item.sensitivity,
          receivedAt
        );
        accepted += result.changes;
      }
    })();
    const latestCursor = this.latestCursor(checkedNamespace);
    if (accepted > 0) this.changes.emit(namespaceKey(checkedNamespace), latestCursor);
    return { accepted, duplicates: checked.length - accepted, latestCursor };
  }

  pull(namespace: RemoteNamespace, afterCursor: number, limit = 100): RemoteRecord[] {
    const checked = validateNamespace(namespace);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error("afterCursor must be non-negative");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
    const rows = this.database.prepare(`
      SELECT cursor, idempotency_key, team_id, repository_id, record_type, subject_id,
             actor_token_id, payload_json, provenance_json, sensitivity, received_at
      FROM sync_records
      WHERE team_id = ? AND repository_id = ? AND cursor > ?
      ORDER BY cursor ASC
      LIMIT ?
    `).all(checked.teamId, checked.repositoryId, afterCursor, limit) as SyncRow[];
    return rows.map(fromRow);
  }

  latestCursor(namespace: RemoteNamespace): number {
    const checked = validateNamespace(namespace);
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(cursor), 0) AS cursor
      FROM sync_records WHERE team_id = ? AND repository_id = ?
    `).get(checked.teamId, checked.repositoryId) as { cursor: number };
    return row.cursor;
  }

  async waitForChange(namespace: RemoteNamespace, afterCursor: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0 || this.latestCursor(namespace) > afterCursor) return;
    const key = namespaceKey(namespace);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.changes.off(key, onChange);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const onChange = (cursor: number): void => {
        if (cursor > afterCursor) finish();
      };
      const timer = setTimeout(finish, waitMs);
      timer.unref?.();
      this.changes.on(key, onChange);
      signal?.addEventListener("abort", finish, { once: true });
      // Close the check/subscribe race.
      if (this.latestCursor(namespace) > afterCursor) finish();
    });
  }
}

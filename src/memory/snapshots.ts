import { nowIso } from "../util/time.js";
import type { SqliteDatabase } from "./database.js";
import { ensureDomainSchema } from "./schema.js";
import type { MemoryScope, SessionSnapshot, SessionSnapshotInput } from "./types.js";
import { parseJsonObject } from "./validation.js";

interface SnapshotRow {
  session_id: string;
  scope_kind: MemoryScope["kind"];
  scope_key: string;
  activity: string | null;
  objective: string | null;
  summary: string | null;
  source_event_id: string | null;
  metadata_json: string;
  updated_at: string;
}

export class SessionSnapshotStore {
  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: () => string = nowIso
  ) {
    ensureDomainSchema(database);
  }

  upsert(input: SessionSnapshotInput): SessionSnapshot {
    if (!input.sessionId.trim()) throw new Error("sessionId is required");
    this.database
      .prepare(
        `INSERT INTO ag_session_snapshots(
          session_id, scope_kind, scope_key, activity, objective, summary,
          source_event_id, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          scope_kind = excluded.scope_kind,
          scope_key = excluded.scope_key,
          activity = excluded.activity,
          objective = excluded.objective,
          summary = excluded.summary,
          source_event_id = excluded.source_event_id,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`
      )
      .run(
        input.sessionId,
        input.scope.kind,
        input.scope.key,
        input.activity ?? null,
        input.objective ?? null,
        input.summary ?? null,
        input.sourceEventId ?? null,
        JSON.stringify(input.metadata ?? {}),
        this.clock()
      );
    const snapshot = this.get(input.sessionId);
    if (!snapshot) throw new Error("Failed to read session snapshot after upsert");
    return snapshot;
  }

  get(sessionId: string): SessionSnapshot | null {
    const row = this.database.prepare("SELECT * FROM ag_session_snapshots WHERE session_id = ?").get(sessionId) as
      | SnapshotRow
      | undefined;
    return row ? mapSnapshot(row) : null;
  }

  list(scope: MemoryScope, limit = 20): SessionSnapshot[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM ag_session_snapshots WHERE scope_kind = ? AND scope_key = ?
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(scope.kind, scope.key, Math.min(Math.max(limit, 1), 100)) as SnapshotRow[];
    return rows.map(mapSnapshot);
  }
}

function mapSnapshot(row: SnapshotRow): SessionSnapshot {
  return {
    sessionId: row.session_id,
    scope: { kind: row.scope_kind, key: row.scope_key },
    activity: row.activity,
    objective: row.objective,
    summary: row.summary,
    sourceEventId: row.source_event_id,
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at
  };
}


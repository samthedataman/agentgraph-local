import { id } from "../util/ids.js";
import type { SqliteDatabase } from "./database.js";
import type { MemoryItem, MemoryKind, MemoryScope, MemorySource, Sensitivity } from "./types.js";

export interface DomainSchemaCapabilities {
  fts5: boolean;
}

interface BackfillMemoryRow {
  memory_id: string;
  kind: MemoryKind;
  text: string;
  scope_kind: MemoryScope["kind"];
  scope_key: string;
  source_session_id: string | null;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  status: MemoryItem["status"];
  superseded_by: string | null;
  expires_at: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface BackfillSourceRow {
  memory_id: string;
  source_type: MemorySource["type"];
  source_id: string;
  excerpt: string | null;
}

export function ensureDomainSchema(database: SqliteDatabase): DomainSchemaCapabilities {
  const mutationTableExisted = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ag_memory_mutations'")
      .get()
  );
  database.transaction(() => {
    database.exec(`
    CREATE TABLE IF NOT EXISTS ag_memory_items (
      memory_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      source_session_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.8 CHECK(confidence >= 0 AND confidence <= 1),
      importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1),
      sensitivity TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'current',
      superseded_by TEXT REFERENCES ag_memory_items(memory_id),
      expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ag_memory_scope_idx
      ON ag_memory_items(scope_kind, scope_key, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS ag_memory_session_idx
      ON ag_memory_items(source_session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ag_memory_sources (
      memory_id TEXT NOT NULL REFERENCES ag_memory_items(memory_id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      excerpt TEXT,
      PRIMARY KEY(memory_id, source_type, source_id)
    );

    -- Durable local outbox. Each row is appended in the same SQLite
    -- transaction as the memory mutation it describes, so a synchronizer can
    -- resume from a monotonic cursor without rescanning mutable memory state.
    CREATE TABLE IF NOT EXISTS ag_memory_mutations (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      mutation_id TEXT NOT NULL UNIQUE,
      operation TEXT NOT NULL CHECK(operation IN ('commit', 'delete', 'supersede')),
      memory_id TEXT NOT NULL,
      supersedes_memory_id TEXT,
      memory_json TEXT NOT NULL,
      supersedes_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ag_memory_mutation_memory_idx
      ON ag_memory_mutations(memory_id, cursor);

    CREATE TABLE IF NOT EXISTS ag_graph_nodes (
      node_id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      canonical_key TEXT NOT NULL,
      label TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_kind, scope_key, node_type, canonical_key)
    );
    CREATE INDEX IF NOT EXISTS ag_graph_node_scope_idx
      ON ag_graph_nodes(scope_kind, scope_key, node_type);

    CREATE TABLE IF NOT EXISTS ag_graph_edges (
      edge_id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL REFERENCES ag_graph_nodes(node_id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES ag_graph_nodes(node_id) ON DELETE CASCADE,
      edge_type TEXT NOT NULL,
      evidence_event_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(from_node_id, to_node_id, edge_type, evidence_event_id)
    );
    CREATE INDEX IF NOT EXISTS ag_graph_edge_from_idx ON ag_graph_edges(from_node_id, edge_type);
    CREATE INDEX IF NOT EXISTS ag_graph_edge_to_idx ON ag_graph_edges(to_node_id, edge_type);

    CREATE TABLE IF NOT EXISTS ag_artifacts (
      artifact_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      content_ref TEXT NOT NULL,
      inline_content TEXT,
      source_session_id TEXT,
      source_event_id TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'private',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ag_artifact_scope_idx
      ON ag_artifacts(scope_kind, scope_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS ag_artifact_hash_idx ON ag_artifacts(sha256);

    CREATE TABLE IF NOT EXISTS ag_session_snapshots (
      session_id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      activity TEXT,
      objective TEXT,
      summary TEXT,
      source_event_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ag_snapshot_scope_idx
      ON ag_session_snapshots(scope_kind, scope_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ag_handoffs (
      handoff_id TEXT PRIMARY KEY,
      from_session TEXT NOT NULL,
      target_session TEXT,
      target_provider TEXT,
      target_repository TEXT,
      target_capability TEXT,
      objective TEXT NOT NULL,
      state TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      requires_ack INTEGER NOT NULL DEFAULT 1,
      context_refs_json TEXT NOT NULL DEFAULT '[]',
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      causal_chain_json TEXT NOT NULL DEFAULT '[]',
      hop_count INTEGER NOT NULL DEFAULT 0,
      max_hops INTEGER NOT NULL DEFAULT 2,
      claimed_by_session TEXT,
      result_summary TEXT,
      error TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      claimed_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ag_handoff_inbox_idx
      ON ag_handoffs(target_session, target_provider, target_repository, state, created_at);
    CREATE INDEX IF NOT EXISTS ag_handoff_sender_idx
      ON ag_handoffs(from_session, created_at DESC);

    CREATE TABLE IF NOT EXISTS ag_handoff_deliveries (
      delivery_id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL REFERENCES ag_handoffs(handoff_id) ON DELETE CASCADE,
      recipient_session TEXT,
      state TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ag_delivery_handoff_idx
      ON ag_handoff_deliveries(handoff_id, created_at);
    `);
    if (!mutationTableExisted) backfillMemoryMutations(database);
  })();

  let fts5 = true;
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ag_memory_fts USING fts5(
        memory_id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
    `);
  } catch {
    fts5 = false;
  }
  return { fts5 };
}

/**
 * A pre-outbox database may already contain memories. Seed one immutable
 * snapshot for each of them when the outbox table is first introduced. The
 * original status, sensitivity, and metadata are retained so downstream
 * synchronization can still fail closed for secrets/imported echoes and map
 * deleted or superseded state correctly.
 */
function backfillMemoryMutations(database: SqliteDatabase): void {
  const memories = database
    .prepare("SELECT * FROM ag_memory_items ORDER BY created_at ASC, memory_id ASC")
    .all() as BackfillMemoryRow[];
  if (memories.length === 0) return;
  const sourceStatement = database.prepare(
    "SELECT * FROM ag_memory_sources WHERE memory_id = ? ORDER BY source_type, source_id"
  );
  const insert = database.prepare(
    `INSERT INTO ag_memory_mutations (
      mutation_id, operation, memory_id, supersedes_memory_id,
      memory_json, supersedes_json, created_at
    ) VALUES (?, 'commit', ?, NULL, ?, NULL, ?)`
  );
  for (const row of memories) {
    const sources = (sourceStatement.all(row.memory_id) as BackfillSourceRow[]).map((source) => ({
      memoryId: source.memory_id,
      type: source.source_type,
      id: source.source_id,
      ...(source.excerpt === null ? {} : { excerpt: source.excerpt })
    }));
    const memory: MemoryItem = {
      id: row.memory_id,
      kind: row.kind,
      text: row.text,
      scope: { kind: row.scope_kind, key: row.scope_key },
      sourceSessionId: row.source_session_id,
      sources,
      confidence: row.confidence,
      importance: row.importance,
      sensitivity: row.sensitivity,
      status: row.status,
      supersededBy: row.superseded_by,
      expiresAt: row.expires_at,
      metadata: parseMetadata(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    insert.run(id("mut"), row.memory_id, JSON.stringify(memory), row.updated_at);
  }
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

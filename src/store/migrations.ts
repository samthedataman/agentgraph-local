import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core presence and event log",
    sql: `
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS terminals (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(id),
        tty TEXT,
        term_program TEXT,
        term_session_id TEXT,
        iterm_session_id TEXT,
        tmux_pane TEXT,
        parent_pid INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        fingerprint_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS process_instances (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL REFERENCES hosts(id),
        terminal_id TEXT REFERENCES terminals(id),
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_start_token TEXT NOT NULL,
        executable TEXT NOT NULL,
        argv_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT NOT NULL,
        repository_root TEXT,
        worktree_root TEXT,
        lease_token_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        activity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        exit_signal TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(host_id, pid, process_start_token)
      );

      CREATE INDEX IF NOT EXISTS process_instances_state_lease_idx
        ON process_instances(state, lease_expires_at);
      CREATE INDEX IF NOT EXISTS process_instances_repo_idx
        ON process_instances(repository_root, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS provider_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'resumable',
        label TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(provider, native_session_id)
      );

      CREATE TABLE IF NOT EXISTS session_attachments (
        id TEXT PRIMARY KEY,
        process_instance_id TEXT NOT NULL REFERENCES process_instances(id),
        provider_session_id TEXT NOT NULL REFERENCES provider_sessions(id),
        attached_at TEXT NOT NULL,
        detached_at TEXT,
        detach_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS session_attachments_one_active_process_idx
        ON session_attachments(process_instance_id) WHERE detached_at IS NULL;
      CREATE INDEX IF NOT EXISTS session_attachments_session_idx
        ON session_attachments(provider_session_id, attached_at DESC);

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        provider_session_id TEXT REFERENCES provider_sessions(id),
        native_turn_id TEXT,
        state TEXT NOT NULL,
        prompted_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        parent_provider_session_id TEXT REFERENCES provider_sessions(id),
        native_agent_id TEXT,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        source TEXT NOT NULL,
        host_id TEXT,
        terminal_id TEXT,
        process_instance_id TEXT,
        provider_session_id TEXT,
        turn_id TEXT,
        subagent_id TEXT,
        sequence INTEGER,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_ref TEXT,
        idempotency_key TEXT,
        origin_event_id TEXT,
        hop_count INTEGER NOT NULL DEFAULT 0,
        sensitivity TEXT NOT NULL DEFAULT 'private',
        projection_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency_idx
        ON events(source, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS events_session_time_idx
        ON events(provider_session_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS events_process_time_idx
        ON events(process_instance_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS events_kind_time_idx
        ON events(kind, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS projector_checkpoints (
        projector TEXT PRIMARY KEY,
        event_id TEXT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spool_receipts (
        idempotency_key TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `
  }
] as const;

export function migrate(database: Database.Database, migrations: readonly Migration[] = CORE_MIGRATIONS): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: number }).version)
  );
  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (!applied.has(migration.version)) apply(migration);
  }
}


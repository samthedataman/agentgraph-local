import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { EVENT_SCHEMA, type AgentActivity, type AgentEvent, type AgentEventInput, type ProcessPresence, type ProcessRegistration, type ProcessState, type TerminalFingerprint } from "../protocol/index.js";
import { id, sha256, stableJson } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { migrate } from "./migrations.js";

export interface StoreOptions {
  hostId?: string;
  leaseDurationMs?: number;
}

export interface ListProcessesOptions {
  includeExited?: boolean;
  recentSeconds?: number;
  repositoryRoot?: string;
  provider?: string;
}

export interface ListEventsOptions {
  processInstanceId?: string;
  providerSessionId?: string;
  kind?: string;
  limit?: number;
}

export interface SessionLookupOptions {
  provider?: string;
  repositoryRoot?: string;
  worktreeRoot?: string;
}

export interface SearchSessionsOptions extends SessionLookupOptions {
  query: string;
  excludeSessionId?: string;
  limit?: number;
}

export interface SessionRecord {
  sessionId: string;
  provider: string;
  state: string;
  label: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  cwd: string | null;
  repositoryRoot: string | null;
  worktreeRoot: string | null;
  transcriptPath: string | null;
  latestPrompt: string | null;
  latestAssistantMessage: string | null;
  title: string;
  matchSnippets: string[];
  score?: number;
}

interface ProcessRow {
  id: string;
  run_id: string;
  provider: string;
  mode: ProcessPresence["mode"];
  pid: number;
  process_start_token: string;
  executable: string;
  argv_json: string;
  cwd: string;
  repository_root: string | null;
  worktree_root: string | null;
  terminal_id: string | null;
  provider_session_native_id: string | null;
  state: ProcessState;
  activity: AgentActivity;
  confidence: ProcessPresence["confidence"];
  registered_at: string;
  last_seen_at: string;
  lease_expires_at: string;
  exited_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  metadata_json: string;
  tty: string | null;
  term_program: string | null;
  term_session_id: string | null;
  iterm_session_id: string | null;
  tmux_pane: string | null;
  parent_pid: number | null;
}

interface EventRow {
  event_id: string;
  schema: string;
  occurred_at: string;
  observed_at: string;
  provider: string;
  source: string;
  host_id: string | null;
  terminal_id: string | null;
  process_instance_id: string | null;
  provider_session_id: string | null;
  turn_id: string | null;
  subagent_id: string | null;
  sequence: number | null;
  kind: string;
  payload_json: string;
  raw_ref: string | null;
  idempotency_key: string | null;
  origin_event_id: string | null;
  hop_count: number;
  sensitivity: string;
  projection_version: number;
}

interface SessionEventRow extends EventRow {
  session_state: string;
  session_label: string | null;
  session_first_seen_at: string;
  session_last_seen_at: string;
  process_cwd: string | null;
  process_repository_root: string | null;
  process_worktree_root: string | null;
}

const PROCESS_SELECT = `
  SELECT p.*,
    ps.native_session_id AS provider_session_native_id,
    t.tty, t.term_program, t.term_session_id, t.iterm_session_id, t.tmux_pane, t.parent_pid
  FROM process_instances p
  LEFT JOIN terminals t ON t.id = p.terminal_id
  LEFT JOIN session_attachments sa ON sa.process_instance_id = p.id AND sa.detached_at IS NULL
  LEFT JOIN provider_sessions ps ON ps.id = sa.provider_session_id
`;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function processFromRow(row: ProcessRow): ProcessPresence {
  const terminal: TerminalFingerprint | null = row.terminal_id === null ? null : {
    tty: row.tty,
    termProgram: row.term_program,
    termSessionId: row.term_session_id,
    itermSessionId: row.iterm_session_id,
    tmuxPane: row.tmux_pane,
    parentPid: row.parent_pid
  };
  return {
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    mode: row.mode,
    pid: row.pid,
    processStartToken: row.process_start_token,
    executable: row.executable,
    argv: parseJson<string[]>(row.argv_json, []),
    cwd: row.cwd,
    repositoryRoot: row.repository_root,
    worktreeRoot: row.worktree_root,
    terminalId: row.terminal_id,
    terminal,
    providerSessionId: row.provider_session_native_id,
    state: row.state,
    activity: row.activity,
    confidence: row.confidence,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    leaseExpiresAt: row.lease_expires_at,
    exitedAt: row.exited_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {})
  };
}

function eventFromRow(row: EventRow): AgentEvent {
  return {
    schema: row.schema,
    event_id: row.event_id,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    provider: row.provider,
    source: row.source,
    host_id: row.host_id,
    terminal_id: row.terminal_id,
    process_instance_id: row.process_instance_id,
    provider_session_id: row.provider_session_id,
    turn_id: row.turn_id,
    subagent_id: row.subagent_id,
    sequence: row.sequence,
    kind: row.kind,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    raw_ref: row.raw_ref,
    idempotency_key: row.idempotency_key,
    origin_event_id: row.origin_event_id,
    hop_count: row.hop_count,
    sensitivity: row.sensitivity,
    projection_version: row.projection_version
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactSnippet(value: string, maximum = 500): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function sessionFromRows(rows: SessionEventRow[], repositoryFallback?: string): SessionRecord | null {
  const first = rows[0];
  if (!first?.provider_session_id) return null;
  let cwd: string | null = null;
  let repositoryRoot: string | null = null;
  let worktreeRoot: string | null = null;
  let transcriptPath: string | null = null;
  let latestPrompt: string | null = null;
  let latestAssistantMessage: string | null = null;
  const snippets: string[] = [];

  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
    cwd ??= nonEmptyString(payload.cwd) ?? nonEmptyString(payload.working_directory) ?? row.process_cwd;
    repositoryRoot ??= row.process_repository_root ?? repositoryFallback ?? null;
    worktreeRoot ??= row.process_worktree_root ?? repositoryFallback ?? null;
    transcriptPath ??= nonEmptyString(payload.transcript_path);
    const prompt = nonEmptyString(payload.prompt);
    const assistant = nonEmptyString(payload.last_assistant_message);
    latestPrompt ??= prompt;
    latestAssistantMessage ??= assistant;
    const snippet = prompt ?? assistant;
    if (snippet && snippets.length < 3) {
      const compact = compactSnippet(snippet);
      if (!snippets.includes(compact)) snippets.push(compact);
    }
  }

  const titleSource = first.session_label ?? latestPrompt ?? latestAssistantMessage ?? first.provider_session_id;
  return {
    sessionId: first.provider_session_id,
    provider: first.provider,
    state: first.session_state,
    label: first.session_label,
    firstSeenAt: first.session_first_seen_at,
    lastSeenAt: first.session_last_seen_at,
    cwd,
    repositoryRoot,
    worktreeRoot,
    transcriptPath,
    latestPrompt,
    latestAssistantMessage,
    title: compactSnippet(titleSource, 200),
    matchSnippets: snippets
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function searchTerms(query: string): string[] {
  const ignored = new Set(["component", "session", "section", "working", "work", "please", "find", "recent", "latest"]);
  const terms = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((term) => !ignored.has(term))
  );
  if (terms.has("chat")) {
    terms.add("intake");
    terms.add("widget");
  }
  if (terms.has("web")) terms.add("website");
  return [...terms].slice(0, 20);
}

function searchConcept(term: string): string {
  if (term === "chat" || term === "intake" || term === "widget") return "web-chat";
  if (term === "web" || term === "website") return "web";
  return term;
}

function asIso(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Store {
  readonly database: Database.Database;
  readonly hostId: string;
  readonly leaseDurationMs: number;

  constructor(path: string, options: StoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.hostId = options.hostId ?? "host_local";
    this.leaseDurationMs = options.leaseDurationMs ?? 15_000;
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    migrate(this.database);
    this.touchHost();
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  migrate(): void {
    migrate(this.database);
  }

  private touchHost(at = nowIso()): void {
    this.database.prepare(`
      INSERT INTO hosts(id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(this.hostId, at, at);
  }

  private upsertTerminal(terminal: TerminalFingerprint | null | undefined, at: string): string | null {
    if (!terminal) return null;
    const terminalId = `term_${sha256(stableJson({ hostId: this.hostId, ...terminal })).slice(0, 32)}`;
    this.database.prepare(`
      INSERT INTO terminals(
        id, host_id, tty, term_program, term_session_id, iterm_session_id, tmux_pane,
        parent_pid, first_seen_at, last_seen_at, fingerprint_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(
      terminalId, this.hostId, terminal.tty, terminal.termProgram, terminal.termSessionId,
      terminal.itermSessionId, terminal.tmuxPane, terminal.parentPid, at, at, JSON.stringify(terminal)
    );
    return terminalId;
  }

  registerProcess(
    registration: ProcessRegistration,
    overrides: Partial<Pick<ProcessPresence, "confidence" | "state" | "activity">> = {}
  ): ProcessPresence {
    if (!registration.runId || !registration.leaseToken || !registration.processStartToken) {
      throw new Error("runId, leaseToken, and processStartToken are required");
    }
    if (!Number.isInteger(registration.pid) || registration.pid <= 0) throw new Error("pid must be a positive integer");
    const at = nowIso();
    const leaseExpiresAt = new Date(Date.now() + this.leaseDurationMs).toISOString();
    const terminalId = this.upsertTerminal(registration.terminal, at);
    this.touchHost(at);

    const existing = this.database.prepare(
      "SELECT id, run_id FROM process_instances WHERE run_id = ? OR (host_id = ? AND pid = ? AND process_start_token = ?) LIMIT 1"
    ).get(registration.runId, this.hostId, registration.pid, registration.processStartToken) as { id: string; run_id: string } | undefined;
    const processId = existing?.id ?? id("proc");
    const runId = existing?.run_id ?? registration.runId;
    const state = overrides.state ?? "live";
    const activity = overrides.activity ?? "initializing";
    const confidence = overrides.confidence ?? "supervised";

    this.database.prepare(`
      INSERT INTO process_instances(
        id, run_id, host_id, terminal_id, provider, mode, pid, process_start_token,
        executable, argv_json, cwd, repository_root, worktree_root, lease_token_hash,
        state, activity, confidence, registered_at, last_seen_at, lease_expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        terminal_id = excluded.terminal_id,
        provider = excluded.provider,
        mode = excluded.mode,
        executable = excluded.executable,
        argv_json = excluded.argv_json,
        cwd = excluded.cwd,
        repository_root = excluded.repository_root,
        worktree_root = excluded.worktree_root,
        lease_token_hash = excluded.lease_token_hash,
        state = excluded.state,
        activity = excluded.activity,
        confidence = excluded.confidence,
        last_seen_at = excluded.last_seen_at,
        lease_expires_at = excluded.lease_expires_at,
        exited_at = NULL,
        exit_code = NULL,
        exit_signal = NULL,
        metadata_json = excluded.metadata_json
    `).run(
      processId, runId, this.hostId, terminalId, registration.provider,
      registration.mode ?? "interactive", registration.pid, registration.processStartToken,
      registration.executable, JSON.stringify(registration.argv ?? []), registration.cwd,
      registration.repositoryRoot ?? null, registration.worktreeRoot ?? null,
      sha256(registration.leaseToken), state, activity, confidence, at, at, leaseExpiresAt,
      JSON.stringify(registration.metadata ?? {})
    );
    this.correlateOrphanEvents(runId, processId, terminalId);
    return this.getProcessById(processId)!;
  }

  /**
   * SessionStart can beat process.register by a few milliseconds. Hooks carry
   * the wrapper run id, so attach those already-durable events once the PID is
   * registered and replay only the core projection.
   */
  private correlateOrphanEvents(runId: string, processId: string, terminalId: string | null): void {
    const rows = this.database.prepare(`
      UPDATE events
      SET process_instance_id = ?, terminal_id = COALESCE(terminal_id, ?), host_id = COALESCE(host_id, ?)
      WHERE process_instance_id IS NULL
        AND (
          json_extract(payload_json, '$.agentgraph_run_id') = ?
          OR json_extract(payload_json, '$.run_id') = ?
        )
      RETURNING *
    `).all(processId, terminalId, this.hostId, runId, runId) as EventRow[];
    for (const row of rows) this.projectCoreEvent(eventFromRow(row));
  }

  heartbeat(runId: string, leaseToken: string, activity?: AgentActivity, cwd?: string): ProcessPresence {
    const auth = this.database.prepare("SELECT id, lease_token_hash FROM process_instances WHERE run_id = ?")
      .get(runId) as { id: string; lease_token_hash: string } | undefined;
    if (!auth || !secureEqual(auth.lease_token_hash, sha256(leaseToken))) throw new Error("Invalid process lease");
    const at = nowIso();
    const expires = new Date(Date.now() + this.leaseDurationMs).toISOString();
    const assignments = ["last_seen_at = ?", "lease_expires_at = ?", "state = 'live'"];
    const values: unknown[] = [at, expires];
    if (activity) {
      assignments.push("activity = ?");
      values.push(activity);
    }
    if (cwd) {
      assignments.push("cwd = ?");
      values.push(cwd);
    }
    values.push(runId);
    this.database.prepare(`UPDATE process_instances SET ${assignments.join(", ")} WHERE run_id = ?`).run(...values);
    return this.getProcessById(auth.id)!;
  }

  markExited(runId: string, leaseToken: string, exitCode: number | null, exitSignal: string | null): ProcessPresence {
    const auth = this.database.prepare("SELECT id, lease_token_hash FROM process_instances WHERE run_id = ?")
      .get(runId) as { id: string; lease_token_hash: string } | undefined;
    if (!auth || !secureEqual(auth.lease_token_hash, sha256(leaseToken))) throw new Error("Invalid process lease");
    const at = nowIso();
    const state: ProcessState = exitCode === 0 || exitCode === null && exitSignal === null ? "exited" : "crashed";
    this.database.prepare(`
      UPDATE process_instances SET state = ?, activity = 'idle', last_seen_at = ?,
        lease_expires_at = ?, exited_at = ?, exit_code = ?, exit_signal = ?
      WHERE run_id = ?
    `).run(state, at, at, at, exitCode, exitSignal, runId);
    this.detachProcessSessions(auth.id, "process_exit", at);
    return this.getProcessById(auth.id)!;
  }

  markProcessState(processId: string, state: ProcessState, at = nowIso()): ProcessPresence | null {
    const exited = state === "exited" || state === "crashed";
    this.database.prepare(`
      UPDATE process_instances SET state = ?, last_seen_at = ?,
        exited_at = CASE WHEN ? THEN COALESCE(exited_at, ?) ELSE exited_at END
      WHERE id = ?
    `).run(state, at, exited ? 1 : 0, at, processId);
    if (exited) this.detachProcessSessions(processId, "reconciled_exit", at);
    return this.getProcessById(processId);
  }

  touchAttachedProcess(processId: string, at = nowIso()): void {
    const expires = new Date(Date.parse(at) + this.leaseDurationMs).toISOString();
    this.database.prepare(`
      UPDATE process_instances SET state = 'live', last_seen_at = ?, lease_expires_at = ?
      WHERE id = ? AND mode = 'attached'
    `).run(at, expires, processId);
  }

  expiredProcesses(at = nowIso()): ProcessPresence[] {
    return (this.database.prepare(`${PROCESS_SELECT}
      WHERE p.state IN ('starting', 'live', 'stale') AND p.lease_expires_at < ?
      ORDER BY p.lease_expires_at
    `).all(at) as ProcessRow[]).map(processFromRow);
  }

  getProcessById(processId: string): ProcessPresence | null {
    const row = this.database.prepare(`${PROCESS_SELECT} WHERE p.id = ?`).get(processId) as ProcessRow | undefined;
    return row ? processFromRow(row) : null;
  }

  getProcessByRunId(runId: string): ProcessPresence | null {
    const row = this.database.prepare(`${PROCESS_SELECT} WHERE p.run_id = ?`).get(runId) as ProcessRow | undefined;
    return row ? processFromRow(row) : null;
  }

  getProcessByPid(pid: number, processStartToken?: string): ProcessPresence | null {
    const suffix = processStartToken ? " AND p.process_start_token = ?" : "";
    const values: unknown[] = processStartToken ? [this.hostId, pid, processStartToken] : [this.hostId, pid];
    const row = this.database.prepare(`${PROCESS_SELECT} WHERE p.host_id = ? AND p.pid = ?${suffix}
      ORDER BY p.registered_at DESC LIMIT 1`).get(...values) as ProcessRow | undefined;
    return row ? processFromRow(row) : null;
  }

  listProcesses(options: ListProcessesOptions = {}): ProcessPresence[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.includeExited) {
      const threshold = new Date(Date.now() - (options.recentSeconds ?? 3_600) * 1000).toISOString();
      clauses.push("(p.state IN ('starting', 'live', 'stale') OR p.exited_at >= ?)");
      values.push(threshold);
    } else {
      clauses.push("p.state IN ('starting', 'live', 'stale')");
    }
    if (options.repositoryRoot) {
      clauses.push("p.repository_root = ?");
      values.push(options.repositoryRoot);
    }
    if (options.provider) {
      clauses.push("p.provider = ?");
      values.push(options.provider);
    }
    const rows = this.database.prepare(`${PROCESS_SELECT}
      WHERE ${clauses.join(" AND ")}
      ORDER BY CASE p.state WHEN 'live' THEN 0 WHEN 'starting' THEN 1 WHEN 'stale' THEN 2 ELSE 3 END,
        p.last_seen_at DESC
    `).all(...values) as ProcessRow[];
    return rows.map(processFromRow);
  }

  normalizeEvent(input: AgentEventInput): AgentEvent {
    if (input === null || typeof input !== "object") throw new Error("event must be an object");
    if (typeof input.provider !== "string" || input.provider.length === 0) throw new Error("event.provider is required");
    if (typeof input.source !== "string" || input.source.length === 0) throw new Error("event.source is required");
    if (typeof input.kind !== "string" || input.kind.length === 0) throw new Error("event.kind is required");
    const observed = nowIso();
    const payload = input.payload !== null && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload
      : {};
    const sequence = typeof input.sequence === "number" && Number.isInteger(input.sequence) ? input.sequence : null;
    const sessionId = nullableString(input.provider_session_id) ?? nullableString(input.session_id);
    return {
      schema: typeof input.schema === "string" ? input.schema : EVENT_SCHEMA,
      event_id: typeof input.event_id === "string" && input.event_id.length > 0 ? input.event_id : id("evt"),
      occurred_at: asIso(input.occurred_at, observed),
      observed_at: asIso(input.observed_at, observed),
      provider: input.provider,
      source: input.source,
      host_id: nullableString(input.host_id) ?? this.hostId,
      terminal_id: nullableString(input.terminal_id),
      process_instance_id: nullableString(input.process_instance_id),
      provider_session_id: sessionId,
      turn_id: nullableString(input.turn_id),
      subagent_id: nullableString(input.subagent_id),
      sequence,
      kind: input.kind,
      payload,
      raw_ref: nullableString(input.raw_ref),
      idempotency_key: nullableString(input.idempotency_key),
      origin_event_id: nullableString(input.origin_event_id),
      hop_count: typeof input.hop_count === "number" && Number.isInteger(input.hop_count) && input.hop_count >= 0 ? input.hop_count : 0,
      sensitivity: typeof input.sensitivity === "string" ? input.sensitivity : "private",
      projection_version: typeof input.projection_version === "number" && Number.isInteger(input.projection_version) ? input.projection_version : 1
    };
  }

  appendEvent(input: AgentEventInput): { event: AgentEvent; inserted: boolean } {
    const event = this.normalizeEvent(input);
    const append = this.database.transaction((): { event: AgentEvent; inserted: boolean } => {
      if (event.idempotency_key) {
        const duplicate = this.database.prepare("SELECT * FROM events WHERE source = ? AND idempotency_key = ?")
          .get(event.source, event.idempotency_key) as EventRow | undefined;
        if (duplicate) return { event: eventFromRow(duplicate), inserted: false };
      }
      const byId = this.database.prepare("SELECT * FROM events WHERE event_id = ?").get(event.event_id) as EventRow | undefined;
      if (byId) return { event: eventFromRow(byId), inserted: false };
      this.database.prepare(`
        INSERT INTO events(
          event_id, schema, occurred_at, observed_at, provider, source, host_id, terminal_id,
          process_instance_id, provider_session_id, turn_id, subagent_id, sequence, kind,
          payload_json, raw_ref, idempotency_key, origin_event_id, hop_count, sensitivity,
          projection_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.event_id, event.schema, event.occurred_at, event.observed_at, event.provider,
        event.source, event.host_id, event.terminal_id, event.process_instance_id,
        event.provider_session_id, event.turn_id, event.subagent_id, event.sequence, event.kind,
        JSON.stringify(event.payload), event.raw_ref, event.idempotency_key, event.origin_event_id,
        event.hop_count, event.sensitivity, event.projection_version
      );
      this.projectCoreEvent(event);
      return { event, inserted: true };
    });
    return append();
  }

  listEvents(options: ListEventsOptions = {}): AgentEvent[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (options.processInstanceId) {
      clauses.push("process_instance_id = ?");
      values.push(options.processInstanceId);
    }
    if (options.providerSessionId) {
      clauses.push("provider_session_id = ?");
      values.push(options.providerSessionId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      values.push(options.kind);
    }
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
    values.push(limit);
    const sql = `SELECT * FROM events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY occurred_at DESC, observed_at DESC LIMIT ?`;
    return (this.database.prepare(sql).all(...values) as EventRow[]).map(eventFromRow);
  }

  getSession(sessionId: string, options: SessionLookupOptions = {}): SessionRecord | null {
    const clauses = ["e.provider_session_id = ?"];
    const values: unknown[] = [sessionId];
    this.addSessionScope(clauses, values, options);
    const rows = this.database.prepare(`${SESSION_EVENT_SELECT}
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.occurred_at DESC, e.observed_at DESC
      LIMIT 500
    `).all(...values) as SessionEventRow[];
    return sessionFromRows(rows, options.repositoryRoot ?? options.worktreeRoot);
  }

  searchSessions(options: SearchSessionsOptions): SessionRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const terms = searchTerms(options.query);
    const clauses = ["e.provider_session_id IS NOT NULL", `e.kind IN ('turn.prompted', 'turn.completed', 'session.started', 'session.resumed')`];
    const values: unknown[] = [];
    this.addSessionScope(clauses, values, options);
    if (options.excludeSessionId) {
      clauses.push("e.provider_session_id != ?");
      values.push(options.excludeSessionId);
    }
    if (terms.length) {
      clauses.push(`(${terms.map(() => "lower(e.payload_json) LIKE ? ESCAPE '\\'").join(" OR ")})`);
      values.push(...terms.map((term) => `%${escapeLike(term)}%`));
    }
    const rowLimit = Math.min(Math.max(limit * 200, 1_000), 10_000);
    values.push(rowLimit);
    const rows = this.database.prepare(`${SESSION_EVENT_SELECT}
      WHERE ${clauses.join(" AND ")}
      ORDER BY e.occurred_at DESC, e.observed_at DESC
      LIMIT ?
    `).all(...values) as SessionEventRow[];

    const grouped = new Map<string, SessionEventRow[]>();
    for (const row of rows) {
      if (!row.provider_session_id) continue;
      const key = `${row.provider}\u0000${row.provider_session_id}`;
      const existing = grouped.get(key) ?? [];
      existing.push(row);
      grouped.set(key, existing);
    }
    const phrase = options.query.trim().toLowerCase();
    const sessions: SessionRecord[] = [];
    for (const sessionRows of grouped.values()) {
      const session = sessionFromRows(sessionRows, options.repositoryRoot ?? options.worktreeRoot);
      if (!session) continue;
      const covered = new Set<string>();
      let bestEventScore = 0;
      let exactPhrase = false;
      for (const row of sessionRows) {
        const payload = row.payload_json.toLowerCase();
        const weight = row.kind === "turn.prompted" ? 4 : row.kind === "turn.completed" ? 2 : 1;
        const eventConcepts = new Set<string>();
        for (const term of terms) {
          if (payload.includes(term)) {
            const concept = searchConcept(term);
            covered.add(concept);
            eventConcepts.add(concept);
          }
        }
        const eventScore = eventConcepts.size * weight;
        if (phrase && payload.includes(phrase)) exactPhrase = true;
        bestEventScore = Math.max(bestEventScore, eventScore);
      }
      const score = bestEventScore + covered.size * 5 + (exactPhrase ? 12 : 0);
      sessions.push({ ...session, score });
    }
    return sessions
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, limit);
  }

  private addSessionScope(clauses: string[], values: unknown[], options: SessionLookupOptions): void {
    if (options.provider) {
      clauses.push("e.provider = ?");
      values.push(options.provider);
    }
    const root = options.worktreeRoot ?? options.repositoryRoot;
    if (!root) return;
    const prefix = `${escapeLike(root.replace(/\/$/, ""))}/%`;
    const column = options.worktreeRoot ? "p.worktree_root" : "p.repository_root";
    clauses.push(`(
      ${column} = ?
      OR json_extract(e.payload_json, '$.cwd') = ?
      OR json_extract(e.payload_json, '$.working_directory') = ?
      OR json_extract(e.payload_json, '$.cwd') LIKE ? ESCAPE '\\'
      OR json_extract(e.payload_json, '$.working_directory') LIKE ? ESCAPE '\\'
    )`);
    values.push(root, root, root, prefix, prefix);
  }

  private projectCoreEvent(event: AgentEvent): void {
    let sessionRowId: string | null = null;
    if (event.provider_session_id) {
      const at = event.observed_at;
      const existing = this.database.prepare("SELECT id FROM provider_sessions WHERE provider = ? AND native_session_id = ?")
        .get(event.provider, event.provider_session_id) as { id: string } | undefined;
      sessionRowId = existing?.id ?? id("session");
      this.database.prepare(`
        INSERT INTO provider_sessions(id, provider, native_session_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, native_session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).run(sessionRowId, event.provider, event.provider_session_id, at, at);
      const current = this.database.prepare("SELECT id FROM provider_sessions WHERE provider = ? AND native_session_id = ?")
        .get(event.provider, event.provider_session_id) as { id: string };
      sessionRowId = current.id;
    }

    const processExists = event.process_instance_id
      ? this.database.prepare("SELECT 1 FROM process_instances WHERE id = ?").get(event.process_instance_id) !== undefined
      : false;
    if (event.process_instance_id && sessionRowId && processExists) {
      const active = this.database.prepare(`
        SELECT id, provider_session_id FROM session_attachments
        WHERE process_instance_id = ? AND detached_at IS NULL
      `).get(event.process_instance_id) as { id: string; provider_session_id: string } | undefined;
      if (active?.provider_session_id !== sessionRowId) {
        if (active) {
          this.database.prepare("UPDATE session_attachments SET detached_at = ?, detach_reason = 'session_switch' WHERE id = ?")
            .run(event.observed_at, active.id);
        }
        this.database.prepare(`
          INSERT INTO session_attachments(id, process_instance_id, provider_session_id, attached_at)
          VALUES (?, ?, ?, ?)
        `).run(id("attach"), event.process_instance_id, sessionRowId, event.observed_at);
      }
    }

    const activity = activityForEvent(event.kind);
    if (event.process_instance_id && activity && processExists) {
      this.database.prepare("UPDATE process_instances SET activity = ?, last_seen_at = ? WHERE id = ?")
        .run(activity, event.observed_at, event.process_instance_id);
    }
    if (event.process_instance_id && processExists && (event.kind === "session.ended" || event.kind === "session.detached")) {
      this.detachProcessSessions(event.process_instance_id, event.kind, event.observed_at);
    }
  }

  private detachProcessSessions(processId: string, reason: string, at: string): void {
    this.database.prepare(`
      UPDATE session_attachments SET detached_at = ?, detach_reason = ?
      WHERE process_instance_id = ? AND detached_at IS NULL
    `).run(at, reason, processId);
  }
}

const SESSION_EVENT_SELECT = `
  SELECT e.*,
    ps.state AS session_state,
    ps.label AS session_label,
    ps.first_seen_at AS session_first_seen_at,
    ps.last_seen_at AS session_last_seen_at,
    p.cwd AS process_cwd,
    p.repository_root AS process_repository_root,
    p.worktree_root AS process_worktree_root
  FROM events e
  JOIN provider_sessions ps
    ON ps.provider = e.provider AND ps.native_session_id = e.provider_session_id
  LEFT JOIN process_instances p ON p.id = e.process_instance_id
`;

function activityForEvent(kind: string): AgentActivity | null {
  if (["turn.started", "turn.prompted", "user.prompt", "prompt.submitted"].includes(kind)) return "thinking";
  if (["tool.started", "tool.pre", "tool.use.started"].includes(kind)) return "using_tool";
  if (["approval.requested", "permission.requested"].includes(kind)) return "waiting_for_approval";
  if (["session.compacting", "compact.started"].includes(kind)) return "compacting";
  if (["turn.failed", "tool.failed", "stop.failed"].includes(kind)) return "failed";
  if (["turn.completed", "session.idle", "stop", "session.started", "session.resumed"].includes(kind)) return "idle";
  return null;
}

import { id } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import type { SqliteDatabase } from "./database.js";
import { ensureDomainSchema } from "./schema.js";
import type {
  CommitMemoryInput,
  MemoryItem,
  MemoryKind,
  MemoryMutation,
  MemoryMutationBatch,
  MemoryMutationOperation,
  MemoryScope,
  MemorySource,
  ReadMemoryMutationsInput,
  SearchMemoryInput,
  Sensitivity
} from "./types.js";
import { boundedNumber, parseJsonObject } from "./validation.js";

interface MemoryRow {
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
  lexical_score?: number;
}

interface SourceRow {
  memory_id: string;
  source_type: MemorySource["type"];
  source_id: string;
  excerpt: string | null;
}

interface MutationRow {
  cursor: number;
  mutation_id: string;
  operation: MemoryMutationOperation;
  memory_id: string;
  supersedes_memory_id: string | null;
  memory_json: string;
  supersedes_json: string | null;
  created_at: string;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "fact",
  "decision",
  "constraint",
  "preference",
  "procedure",
  "open_question",
  "warning",
  "session_summary",
  "handoff_summary"
]);

export class MemoryStore {
  readonly fts5: boolean;

  constructor(
    readonly database: SqliteDatabase,
    private readonly clock: () => string = nowIso
  ) {
    this.fts5 = ensureDomainSchema(database).fts5;
  }

  commit(input: CommitMemoryInput): MemoryItem {
    return this.database.transaction(() => {
      const memory = this.insert(input);
      this.appendMutation("commit", memory, null);
      return memory;
    })();
  }

  supersede(memoryId: string, replacement: CommitMemoryInput): MemoryItem {
    return this.database.transaction(() => {
      const current = this.get(memoryId);
      if (!current) throw new Error(`Memory not found: ${memoryId}`);
      if (current.status !== "current") throw new Error(`Memory is already ${current.status}: ${memoryId}`);
      if (current.scope.kind !== replacement.scope.kind || current.scope.key !== replacement.scope.key) {
        throw new Error("A replacement memory must stay in the same scope");
      }
      const next = this.insert(replacement);
      const timestamp = this.clock();
      this.database
        .prepare(
          "UPDATE ag_memory_items SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE memory_id = ?"
        )
        .run(next.id, timestamp, memoryId);
      this.removeFts(memoryId);
      const supersedes = this.get(memoryId);
      if (!supersedes) throw new Error(`Failed to read superseded memory: ${memoryId}`);
      this.appendMutation("supersede", next, supersedes);
      return next;
    })();
  }

  forget(memoryId: string): boolean {
    return this.database.transaction(() => {
      const result = this.database
        .prepare("UPDATE ag_memory_items SET status = 'deleted', updated_at = ? WHERE memory_id = ? AND status != 'deleted'")
        .run(this.clock(), memoryId);
      if (result.changes === 0) return false;
      this.removeFts(memoryId);
      const memory = this.get(memoryId);
      if (!memory) throw new Error(`Failed to read deleted memory: ${memoryId}`);
      this.appendMutation("delete", memory, null);
      return true;
    })();
  }

  mutationsAfter(input: ReadMemoryMutationsInput): MemoryMutationBatch {
    const afterCursor = requireCursor(input.afterCursor);
    const limit = requireMutationLimit(input.limit);
    const scopeClause = input.scope
      ? " AND memory_id IN (SELECT memory_id FROM ag_memory_items WHERE scope_kind = ? AND scope_key = ?)"
      : "";
    const scopeParams = input.scope ? [input.scope.kind, input.scope.key] : [];
    const rows = this.database
      .prepare(`SELECT * FROM ag_memory_mutations WHERE cursor > ?${scopeClause} ORDER BY cursor ASC LIMIT ?`)
      .all(afterCursor, ...scopeParams, limit) as MutationRow[];
    const latestRow = this.database
      .prepare(`SELECT COALESCE(MAX(cursor), 0) AS latest_cursor FROM ag_memory_mutations WHERE 1 = 1${scopeClause}`)
      .get(...scopeParams) as { latest_cursor: number };
    const mutations = rows.map((row) => this.mapMutationRow(row));
    const nextCursor = mutations.at(-1)?.cursor ?? afterCursor;
    const latestCursor = latestRow.latest_cursor;
    return {
      mutations,
      nextCursor,
      latestCursor,
      hasMore: nextCursor < latestCursor
    };
  }

  get(memoryId: string): MemoryItem | null {
    const row = this.database.prepare("SELECT * FROM ag_memory_items WHERE memory_id = ?").get(memoryId) as
      | MemoryRow
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  search(input: SearchMemoryInput): MemoryItem[] {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const now = input.now ?? this.clock();
    const scopeSql = input.includeGlobal
      ? "((m.scope_kind = ? AND m.scope_key = ?) OR m.scope_kind = 'global')"
      : "(m.scope_kind = ? AND m.scope_key = ?)";
    const kindSql = input.kinds?.length
      ? ` AND m.kind IN (${input.kinds.map(() => "?").join(",")})`
      : "";
    const sensitivitySql = input.includeSecret ? "" : " AND m.sensitivity != 'secret'";
    const baseParams: unknown[] = [input.scope.kind, input.scope.key, ...(input.kinds ?? []), now];
    const query = input.query.trim();
    let rows: MemoryRow[];

    if (this.fts5 && query) {
      const match = ftsExpression(query);
      if (match) {
        try {
          rows = this.database
            .prepare(
              `SELECT m.*, bm25(ag_memory_fts) AS lexical_score
               FROM ag_memory_fts
               JOIN ag_memory_items m ON m.memory_id = ag_memory_fts.memory_id
               WHERE ag_memory_fts MATCH ? AND ${scopeSql}${kindSql}${sensitivitySql}
                 AND m.status = 'current' AND (m.expires_at IS NULL OR m.expires_at > ?)
               ORDER BY lexical_score ASC, m.importance DESC, m.updated_at DESC
               LIMIT ?`
            )
            .all(match, ...baseParams, limit) as MemoryRow[];
        } catch {
          rows = this.likeSearch(query, scopeSql, `${kindSql}${sensitivitySql}`, baseParams, limit);
        }
      } else {
        rows = this.likeSearch(query, scopeSql, `${kindSql}${sensitivitySql}`, baseParams, limit);
      }
    } else if (query) {
      rows = this.likeSearch(query, scopeSql, `${kindSql}${sensitivitySql}`, baseParams, limit);
    } else {
      rows = this.database
        .prepare(
          `SELECT m.* FROM ag_memory_items m
           WHERE ${scopeSql}${kindSql}${sensitivitySql}
             AND m.status = 'current' AND (m.expires_at IS NULL OR m.expires_at > ?)
           ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`
        )
        .all(...baseParams, limit) as MemoryRow[];
    }

    return rows.map((row) => {
      const item = this.mapRow(row);
      const lexical = row.lexical_score === undefined ? lexicalSimilarity(query, item.text) : 1 / (1 + Math.abs(row.lexical_score));
      const score = clamp(lexical * 0.55 + item.importance * 0.2 + item.confidence * 0.15 + recency(item.updatedAt, now) * 0.1);
      return { ...item, score };
    });
  }

  private likeSearch(
    query: string,
    scopeSql: string,
    kindSql: string,
    baseParams: unknown[],
    limit: number
  ): MemoryRow[] {
    return this.database
      .prepare(
        `SELECT m.* FROM ag_memory_items m
         WHERE lower(m.text) LIKE lower(?) ESCAPE '\\' AND ${scopeSql}${kindSql}
           AND m.status = 'current' AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?`
      )
      .all(`%${escapeLike(query)}%`, ...baseParams, limit) as MemoryRow[];
  }

  private insert(input: CommitMemoryInput): MemoryItem {
    validateMemory(input);
    const memoryId = id("mem");
    const timestamp = this.clock();
    const confidence = boundedNumber(input.confidence, "confidence", 0.8);
    const importance = boundedNumber(input.importance, "importance", 0.5);
    const sensitivity = input.sensitivity ?? "private";
    this.database
      .prepare(
        `INSERT INTO ag_memory_items (
          memory_id, kind, text, scope_kind, scope_key, source_session_id,
          confidence, importance, sensitivity, status, expires_at, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?)`
      )
      .run(
        memoryId,
        input.kind,
        input.text.trim(),
        input.scope.kind,
        input.scope.key,
        input.sourceSessionId ?? null,
        confidence,
        importance,
        sensitivity,
        input.expiresAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp
      );

    const sourceStatement = this.database.prepare(
      "INSERT OR IGNORE INTO ag_memory_sources(memory_id, source_type, source_id, excerpt) VALUES (?, ?, ?, ?)"
    );
    for (const source of input.sources ?? []) {
      sourceStatement.run(memoryId, source.type, source.id, source.excerpt ?? null);
    }
    if (input.sourceSessionId) {
      sourceStatement.run(memoryId, "session", input.sourceSessionId, null);
    }
    if (this.fts5) {
      this.database.prepare("INSERT INTO ag_memory_fts(memory_id, text) VALUES (?, ?)").run(memoryId, input.text.trim());
    }
    const item = this.get(memoryId);
    if (!item) throw new Error("Failed to read newly committed memory");
    return item;
  }

  private removeFts(memoryId: string): void {
    if (!this.fts5) return;
    this.database.prepare("DELETE FROM ag_memory_fts WHERE memory_id = ?").run(memoryId);
  }

  private appendMutation(
    operation: MemoryMutationOperation,
    memory: MemoryItem,
    supersedes: MemoryItem | null
  ): void {
    const timestamp = this.clock();
    this.database
      .prepare(
        `INSERT INTO ag_memory_mutations (
          mutation_id, operation, memory_id, supersedes_memory_id,
          memory_json, supersedes_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id("mut"),
        operation,
        memory.id,
        supersedes?.id ?? null,
        JSON.stringify(memory),
        supersedes ? JSON.stringify(supersedes) : null,
        timestamp
      );
  }

  private mapMutationRow(row: MutationRow): MemoryMutation {
    return {
      cursor: row.cursor,
      mutationId: row.mutation_id,
      operation: row.operation,
      memoryId: row.memory_id,
      supersedesMemoryId: row.supersedes_memory_id,
      memory: parseMemorySnapshot(row.memory_json),
      supersedes: row.supersedes_json === null ? null : parseMemorySnapshot(row.supersedes_json),
      createdAt: row.created_at
    };
  }

  private mapRow(row: MemoryRow): MemoryItem {
    const sourceRows = this.database
      .prepare("SELECT * FROM ag_memory_sources WHERE memory_id = ? ORDER BY source_type, source_id")
      .all(row.memory_id) as SourceRow[];
    const sources: MemorySource[] = sourceRows.map((source) => {
      const base: MemorySource = {
        memoryId: source.memory_id,
        type: source.source_type,
        id: source.source_id
      };
      return source.excerpt === null ? base : { ...base, excerpt: source.excerpt };
    });
    return {
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
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

function validateMemory(input: CommitMemoryInput): void {
  if (!MEMORY_KINDS.has(input.kind)) throw new Error(`Unsupported memory kind: ${input.kind}`);
  if (!input.text?.trim()) throw new Error("Memory text cannot be empty");
  if (Buffer.byteLength(input.text, "utf8") > 64 * 1024) throw new Error("Memory text exceeds 64 KiB");
  if (!input.scope?.kind || !input.scope.key?.trim()) throw new Error("Memory scope is required");
  if (input.sensitivity && !new Set(["public", "private", "secret"]).has(input.sensitivity)) {
    throw new Error(`Unsupported sensitivity: ${input.sensitivity}`);
  }
}

function ftsExpression(query: string): string {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.slice(0, 20).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function lexicalSimilarity(query: string, text: string): number {
  if (!query) return 0.5;
  const terms = new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean));
  if (!terms.size) return 0;
  const haystack = text.toLocaleLowerCase();
  let matched = 0;
  for (const term of terms) if (haystack.includes(term)) matched += 1;
  return matched / terms.size;
}

function recency(updatedAt: string, now: string): number {
  const ageDays = Math.max(0, Date.parse(now) - Date.parse(updatedAt)) / 86_400_000;
  return Number.isFinite(ageDays) ? 1 / (1 + ageDays / 14) : 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function requireCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("afterCursor must be a non-negative safe integer");
  }
  return value;
}

function requireMutationLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return limit;
}

function parseMemorySnapshot(value: string): MemoryItem {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored memory mutation snapshot is invalid");
  }
  return parsed as MemoryItem;
}

/**
 * The memory domain deliberately depends on the tiny subset of better-sqlite3
 * that it uses.  The daemon's Store exposes its `database` property and is the
 * only writer in production; tests can provide an in-memory compatible handle.
 */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: any[]): SqliteRunResult;
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
}

export function asDatabase(value: unknown): SqliteDatabase {
  if (!value || typeof value !== "object") {
    throw new Error("AgentGraph domain handlers require Store.database");
  }
  const candidate = value as Partial<SqliteDatabase>;
  if (
    typeof candidate.exec !== "function" ||
    typeof candidate.prepare !== "function" ||
    typeof candidate.transaction !== "function"
  ) {
    throw new Error("Store.database is not a compatible SQLite handle");
  }
  return candidate as SqliteDatabase;
}


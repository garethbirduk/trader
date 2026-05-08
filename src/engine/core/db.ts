/**
 * Thin DB adapter interface. The engine talks SQL through this; concrete
 * implementations wrap better-sqlite3 (Node) or sql.js / wa-sqlite (browser).
 *
 * Parameter style: named bindings via objects (e.g. `@id` in SQL,
 * `{ id: 42 }` at the call site). Avoids positional-arg ordering bugs and
 * is supported by both target backends.
 */

export type DBParams = Record<string, DBValue>;
export type DBValue = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface PreparedStatement<R = unknown> {
  run(params?: DBParams): RunResult;
  get(params?: DBParams): R | undefined;
  all(params?: DBParams): R[];
}

export interface DB {
  /** Execute one or more statements separated by `;`. No params, no results. */
  exec(sql: string): void;

  /** Prepare a parameterised statement for repeated use. */
  prepare<R = unknown>(sql: string): PreparedStatement<R>;

  /**
   * Run `fn` inside a transaction. Returns whatever `fn` returns. Rolls back
   * if `fn` throws.
   */
  transaction<T>(fn: () => T): T;

  close(): void;
}

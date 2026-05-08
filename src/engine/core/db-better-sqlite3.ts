import Database from "better-sqlite3";
import type { DB, DBParams, PreparedStatement, RunResult } from "./db.js";

export interface BetterSqlite3Options {
  /** File path, or `:memory:` for an in-process ephemeral DB. */
  filename: string;
  readonly?: boolean;
}

/**
 * Adapter wrapping the synchronous, native better-sqlite3 driver.
 * Used by the headless engine in Node. The browser path will use a
 * separate adapter over wa-sqlite / sql.js but expose the same `DB`.
 */
export function openBetterSqlite3DB(opts: BetterSqlite3Options): DB {
  const native = new Database(opts.filename, { readonly: opts.readonly ?? false });
  native.pragma("journal_mode = WAL");
  native.pragma("foreign_keys = ON");

  return {
    exec(sql: string): void {
      native.exec(sql);
    },

    prepare<R = unknown>(sql: string): PreparedStatement<R> {
      const stmt = native.prepare(sql);
      return {
        run(params?: DBParams): RunResult {
          const r = params === undefined ? stmt.run() : stmt.run(params);
          return {
            changes: r.changes,
            lastInsertRowid:
              typeof r.lastInsertRowid === "bigint"
                ? Number(r.lastInsertRowid)
                : r.lastInsertRowid,
          };
        },
        get(params?: DBParams): R | undefined {
          return (params === undefined ? stmt.get() : stmt.get(params)) as
            | R
            | undefined;
        },
        all(params?: DBParams): R[] {
          return (params === undefined ? stmt.all() : stmt.all(params)) as R[];
        },
      };
    },

    transaction<T>(fn: () => T): T {
      const wrapped = native.transaction(fn);
      return wrapped();
    },

    close(): void {
      native.close();
    },
  };
}

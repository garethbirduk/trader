/**
 * Adapter wrapping sql.js — SQLite compiled to WebAssembly. Used by
 * the in-browser live mode. Same `DB` contract as the better-sqlite3
 * adapter, so the engine code on top is driver-agnostic.
 *
 * Differences from the better-sqlite3 adapter that live in this file:
 *   • Initialization is async (loads the WASM blob). The factory
 *     therefore returns a Promise<DB>; everything after init is sync.
 *   • Transactions are wrapped manually as BEGIN / COMMIT / ROLLBACK
 *     (sql.js has no transaction helper).
 *   • `lastInsertRowid` is fetched via `last_insert_rowid()` after
 *     each INSERT (sql.js doesn't expose it on the run result).
 *   • Engine SQL uses `@name` named parameters. sql.js wants the
 *     prefix in the JS keys, so we re-key params from `{ foo: 1 }` to
 *     `{ "@foo": 1 }` before binding.
 *   • Prepared statements are cached per SQL string and freed in
 *     `close()`. sql.js statements hold native memory until freed.
 */

import type {
  DB,
  DBParams,
  DBValue,
  PreparedStatement,
  RunResult,
} from "./db.js";

// We import the type from @types/sql.js but defer the runtime import
// to the factory so this module can be type-checked in environments
// where sql.js isn't installed (e.g. the engine's Node typecheck).
import type {
  Database as SqlJsDatabase,
  SqlJsStatic,
  Statement as SqlJsStatement,
  BindParams,
  SqlValue,
} from "sql.js";

export interface SqlJsOptions {
  /**
   * Optional initial DB bytes (e.g. a previous `db.export()` reloaded
   * from IndexedDB). When omitted, opens an empty in-memory database.
   */
  readonly initialData?: Uint8Array;
  /**
   * Pre-loaded sql.js module. If supplied, the factory uses it directly
   * and skips dynamic import + WASM load — useful when the host already
   * controls how the WASM file is fetched (e.g. via Vite's `?url`).
   */
  readonly sqlJs?: SqlJsStatic;
  /**
   * Override how sql.js locates its WASM file. Forwarded to
   * `initSqlJs({ locateFile })`. Ignored when `sqlJs` is supplied.
   */
  readonly locateFile?: (file: string) => string;
}

export async function openSqlJsDB(opts: SqlJsOptions = {}): Promise<DB> {
  const SQL = opts.sqlJs ?? (await loadSqlJs(opts.locateFile));
  const native: SqlJsDatabase = opts.initialData
    ? new SQL.Database(opts.initialData)
    : new SQL.Database();
  native.run("PRAGMA foreign_keys = ON");

  return makeAdapter(native);
}

async function loadSqlJs(
  locateFile?: (file: string) => string,
): Promise<SqlJsStatic> {
  const initSqlJs = (await import("sql.js")).default;
  return initSqlJs(locateFile ? { locateFile } : undefined);
}

function makeAdapter(native: SqlJsDatabase): DB {
  // Cache prepared statements per SQL string so we don't leak native
  // memory: each `db.prepare()` call returns a wrapper around the
  // same underlying Statement.
  const prepared = new Map<string, SqlJsStatement>();

  // Nesting depth for `transaction()`. The outermost call uses BEGIN /
  // COMMIT / ROLLBACK; inner calls use SAVEPOINT / RELEASE / ROLLBACK
  // TO — same behaviour as better-sqlite3's `.transaction()`. Engine
  // code routinely nests (e.g. settleDeal opens a transaction and
  // internally calls transferStockUnits which also opens one) and
  // relied on this without realising.
  let txDepth = 0;

  function getOrPrepare(sql: string): SqlJsStatement {
    let stmt = prepared.get(sql);
    if (stmt === undefined) {
      stmt = native.prepare(sql);
      prepared.set(sql, stmt);
    }
    return stmt;
  }

  function bind(stmt: SqlJsStatement, params: DBParams | undefined): void {
    stmt.reset();
    if (params === undefined) return;
    stmt.bind(toSqlJsParams(params));
  }

  return {
    exec(sql: string): void {
      // sql.js returns an array of result sets but `exec` semantics
      // discard them by contract.
      native.exec(sql);
    },

    prepare<R = unknown>(sql: string): PreparedStatement<R> {
      // We don't pre-prepare here — defer until first use so callers
      // can prepare statements that are only conditionally executed.
      return {
        run(params?: DBParams): RunResult {
          const stmt = getOrPrepare(sql);
          bind(stmt, params);
          stmt.step();
          stmt.reset();
          return {
            changes: native.getRowsModified(),
            lastInsertRowid: lastInsertRowid(native),
          };
        },
        get(params?: DBParams): R | undefined {
          const stmt = getOrPrepare(sql);
          bind(stmt, params);
          if (!stmt.step()) {
            stmt.reset();
            return undefined;
          }
          const row = stmt.getAsObject();
          stmt.reset();
          return row as unknown as R;
        },
        all(params?: DBParams): R[] {
          const stmt = getOrPrepare(sql);
          bind(stmt, params);
          const rows: R[] = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject() as unknown as R);
          }
          stmt.reset();
          return rows;
        },
      };
    },

    transaction<T>(fn: () => T): T {
      if (txDepth === 0) {
        native.run("BEGIN");
        txDepth = 1;
        try {
          const result = fn();
          native.run("COMMIT");
          return result;
        } catch (err) {
          // Roll back the whole stack — SAVEPOINT-level rollbacks
          // inside fn would have already unwound by the time we get
          // here if the inner caller handled them. Anything still
          // wrapped is now discarded.
          native.run("ROLLBACK");
          throw err;
        } finally {
          txDepth = 0;
        }
      }
      const sp = `trader_sp_${txDepth}`;
      native.run(`SAVEPOINT ${sp}`);
      txDepth += 1;
      try {
        const result = fn();
        native.run(`RELEASE ${sp}`);
        return result;
      } catch (err) {
        native.run(`ROLLBACK TO ${sp}`);
        native.run(`RELEASE ${sp}`);
        throw err;
      } finally {
        txDepth -= 1;
      }
    },

    close(): void {
      for (const stmt of prepared.values()) stmt.free();
      prepared.clear();
      native.close();
    },
  };
}

function lastInsertRowid(native: SqlJsDatabase): number {
  const rows = native.exec("SELECT last_insert_rowid() AS id");
  if (rows.length === 0 || rows[0]!.values.length === 0) return 0;
  const v = rows[0]!.values[0]![0];
  return typeof v === "number" ? v : Number(v);
}

/**
 * Engine SQL uses `@name` named parameters and engine call sites pass
 * params without the prefix (e.g. `{ name: 1 }`). sql.js wants the
 * prefix included in the JS keys. We also coerce a few JS types that
 * SQLite accepts but sql.js doesn't bind directly: bigint → number,
 * boolean → 0/1.
 */
function toSqlJsParams(params: DBParams): BindParams {
  const out: Record<string, SqlValue> = {};
  for (const [key, val] of Object.entries(params)) {
    out[`@${key}`] = coerce(val);
  }
  return out as BindParams;
}

function coerce(v: DBValue): SqlValue {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  return v;
}

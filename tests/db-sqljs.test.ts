import { describe, it, expect, afterEach } from "vitest";
import { openSqlJsDB } from "../src/engine/core/db-sqljs.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { setupWorld } from "../src/engine/setup.js";
import type { DB } from "../src/engine/core/db.js";

describe("sql.js DB adapter", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("opens an in-memory DB, applies migrations, and round-trips a row", async () => {
    db = await openSqlJsDB();
    applyMigrations(db, ALL_MIGRATIONS);

    db.prepare("INSERT INTO smoke_kv (key, value) VALUES (@key, @value)").run({
      key: "hello",
      value: "world",
    });

    const row = db
      .prepare<{ key: string; value: string }>(
        "SELECT key, value FROM smoke_kv WHERE key = @key",
      )
      .get({ key: "hello" });

    expect(row).toEqual({ key: "hello", value: "world" });
  });

  it("records applied migrations in schema_version", async () => {
    db = await openSqlJsDB();
    applyMigrations(db, ALL_MIGRATIONS);

    const versions = db
      .prepare<{ version: number; name: string }>(
        "SELECT version, name FROM schema_version ORDER BY version ASC",
      )
      .all();

    expect(versions.length).toBe(ALL_MIGRATIONS.length);
    expect(versions[0]).toEqual({ version: 1, name: "smoke" });
  });

  it("rolls back a failing transaction", async () => {
    db = await openSqlJsDB();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    db.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 1 });

    expect(() =>
      db!.transaction(() => {
        db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 2 });
        throw new Error("rollback please");
      }),
    ).toThrow(/rollback please/);

    const rows = db
      .prepare<{ v: number }>("SELECT v FROM t ORDER BY v ASC")
      .all();
    expect(rows.map((r) => r.v)).toEqual([1]);
  });

  it("nested transactions use SAVEPOINTs (no 'transaction within a transaction' error)", async () => {
    // Regression: settleDeal wraps in db.transaction() and internally
    // calls transferStockUnits / claimFromPool / adjustTrust which also
    // wrap. Before this fix, the sql.js adapter issued raw BEGIN and
    // SQLite threw "cannot start a transaction within a transaction"
    // — the error then leaked out as a defaulted deal's reason in
    // live mode.
    db = await openSqlJsDB();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    db.transaction(() => {
      db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 1 });
      db!.transaction(() => {
        db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 2 });
      });
      db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 3 });
    });
    const rows = db
      .prepare<{ v: number }>("SELECT v FROM t ORDER BY v ASC")
      .all();
    expect(rows.map((r) => r.v)).toEqual([1, 2, 3]);
  });

  it("inner transaction rollback doesn't break outer commit", async () => {
    db = await openSqlJsDB();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    db.transaction(() => {
      db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 1 });
      try {
        db!.transaction(() => {
          db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 99 });
          throw new Error("nope");
        });
      } catch {
        // swallow — outer transaction continues
      }
      db!.prepare("INSERT INTO t (v) VALUES (@v)").run({ v: 2 });
    });
    const rows = db
      .prepare<{ v: number }>("SELECT v FROM t ORDER BY v ASC")
      .all();
    expect(rows.map((r) => r.v)).toEqual([1, 2]);
  });

  it("returns lastInsertRowid for inserts", async () => {
    db = await openSqlJsDB();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const r1 = db
      .prepare("INSERT INTO t (v) VALUES (@v)")
      .run({ v: "a" });
    const r2 = db
      .prepare("INSERT INTO t (v) VALUES (@v)")
      .run({ v: "b" });
    expect(r1.lastInsertRowid).toBe(1);
    expect(r2.lastInsertRowid).toBe(2);
    expect(r1.changes).toBe(1);
  });

  it("can boot the full engine against sql.js (setupWorld + a few ticks)", async () => {
    db = await openSqlJsDB();
    const { world } = setupWorld(db, { seed: "sqljs-smoke", runLengthDays: 2 });

    // Drive a couple of days. We're not asserting specific events —
    // just that the engine runs to completion against sql.js without
    // any DB-driver mismatch.
    world.runToCompletion();
    expect(world.isFinished()).toBe(true);
  }, 30_000);

  it("a full multi-day run produces no transaction-driver errors", async () => {
    // Settlements call into transferStockUnits / claimFromPool /
    // trust-reactions which all wrap themselves in db.transaction.
    // The 2-day smoke isn't long enough to exercise that nesting —
    // here we run long enough to hit it and assert no deal defaulted
    // with a driver-internal reason.
    db = await openSqlJsDB();
    const { world } = setupWorld(db, { seed: "sqljs-tx", runLengthDays: 7 });
    const driverErrors: string[] = [];
    world.events.subscribe((e) => {
      if (e.type === "deal.defaulted" && /transaction/i.test(e.reason)) {
        driverErrors.push(e.reason);
      }
    });
    world.runToCompletion();
    expect(driverErrors).toEqual([]);
  }, 60_000);
});

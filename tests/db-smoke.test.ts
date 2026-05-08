import { describe, it, expect, afterEach } from "vitest";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import type { DB } from "../src/engine/core/db.js";

describe("M0 smoke: DB adapter + migrations", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("opens an in-memory DB, applies migrations, and round-trips a row", () => {
    db = openBetterSqlite3DB({ filename: ":memory:" });
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

  it("records applied migrations in schema_version", () => {
    db = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db, ALL_MIGRATIONS);

    const versions = db
      .prepare<{ version: number; name: string }>(
        "SELECT version, name FROM schema_version ORDER BY version ASC",
      )
      .all();

    expect(versions.length).toBe(ALL_MIGRATIONS.length);
    expect(versions[0]).toEqual({ version: 1, name: "smoke" });
    // Versions are sequential from 1.
    versions.forEach((v, i) => {
      expect(v.version).toBe(i + 1);
    });
  });

  it("is idempotent — re-running migrations is a no-op", () => {
    db = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db, ALL_MIGRATIONS);
    const countAfterFirst = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version")
      .get()?.n;
    applyMigrations(db, ALL_MIGRATIONS);
    const countAfterSecond = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM schema_version")
      .get()?.n;

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(countAfterFirst).toBe(ALL_MIGRATIONS.length);
  });

  it("rolls back a failing migration", () => {
    db = openBetterSqlite3DB({ filename: ":memory:" });
    expect(() =>
      applyMigrations(db!, [
        {
          version: 1,
          name: "fails-after-create",
          up(d) {
            d.exec("CREATE TABLE will_be_rolled_back (id INTEGER);");
            throw new Error("boom");
          },
        },
      ]),
    ).toThrow(/boom/);

    const tbl = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='will_be_rolled_back'",
      )
      .get();
    expect(tbl).toBeUndefined();
  });
});

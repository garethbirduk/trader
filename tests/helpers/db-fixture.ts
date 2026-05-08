import { openBetterSqlite3DB } from "../../src/engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../../src/engine/core/migrations/index.js";
import type { DB } from "../../src/engine/core/db.js";

/**
 * Open a fresh in-memory DB with all engine migrations applied. Tests use
 * this to get a clean slate without sharing state.
 */
export function freshDB(): DB {
  const db = openBetterSqlite3DB({ filename: ":memory:" });
  applyMigrations(db, ALL_MIGRATIONS);
  return db;
}

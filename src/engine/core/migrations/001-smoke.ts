import type { Migration } from "../migrations.js";

/**
 * Placeholder schema for M0. A trivial key/value table proves the DB adapter
 * and migration runner work end-to-end. Real engine tables (items, actors,
 * stock_lots, deals, leads, world_pools, ...) arrive in subsequent milestones.
 */
export const m001Smoke: Migration = {
  version: 1,
  name: "smoke",
  up(db) {
    db.exec(`
      CREATE TABLE smoke_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
};

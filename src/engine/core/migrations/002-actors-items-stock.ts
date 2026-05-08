import type { Migration } from "../migrations.js";

/**
 * Schema for the M2 surface: item kinds (the abstract catalogue), actors
 * (anyone who can own stock or hold cash), and stock_lots (concrete batches
 * of items in someone's possession). Stock lots are immutable in their
 * acquired_* fields once created — splits and transfers create new rows.
 *
 * Currency is in whole pounds (INTEGER). The genre's mental model is "20
 * quid", not "£20.50"; if we ever need fractional pricing, a follow-up
 * migration multiplies through.
 */
export const m002ActorsItemsStock: Migration = {
  version: 2,
  name: "actors-items-stock",
  up(db) {
    db.exec(`
      CREATE TABLE item_kinds (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT    NOT NULL UNIQUE,
        display_name TEXT    NOT NULL,
        category     TEXT    NOT NULL,
        base_value   INTEGER NOT NULL CHECK (base_value > 0)
      );

      CREATE TABLE actors (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT    NOT NULL UNIQUE,
        display_name TEXT    NOT NULL,
        cash         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE stock_lots (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_actor_id      INTEGER NOT NULL REFERENCES actors(id),
        item_kind_id        INTEGER NOT NULL REFERENCES item_kinds(id),
        quality_tier        TEXT    NOT NULL
                            CHECK (quality_tier IN ('mint','good','fair','shoddy','broken')),
        quantity            INTEGER NOT NULL CHECK (quantity > 0),
        acquired_unit_price INTEGER NOT NULL CHECK (acquired_unit_price >= 0),
        acquired_day        INTEGER NOT NULL CHECK (acquired_day >= 1)
      );

      CREATE INDEX idx_stock_lots_owner ON stock_lots(owner_actor_id);
      CREATE INDEX idx_stock_lots_kind  ON stock_lots(item_kind_id);
    `);
  },
};

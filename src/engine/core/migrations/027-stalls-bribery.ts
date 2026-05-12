import type { Migration } from "../migrations.js";

/**
 * Market trading mode (legit/adhoc) + Slater's bribability.
 *
 * Two intertwined design lanes land together (todolist #3 + #4):
 *
 *   #3 Legit vs adhoc market trading. Sellers now register a stall
 *      mode each day. Legit = pay a £20 fee, no risk. Adhoc = free,
 *      but Slater patrols. New `market_stalls` row per (seller, day)
 *      tracks the mode, the fee paid, when (if ever) Slater turned
 *      up, and how the situation resolved.
 *
 *   #4 Slater is bent. Actors gain a `bribable` flag. The wider
 *      plod (default 0) plays it straight; Slater specifically (1)
 *      accepts bribes that clear his threshold. Bribery itself is
 *      handled by a primitive (see bribe.ts) — the schema change
 *      here is the per-actor flag.
 */
export const m027StallsBribery: Migration = {
  version: 27,
  name: "stalls-bribery",
  up(db) {
    db.exec(`
      ALTER TABLE actors ADD COLUMN bribable INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE market_stalls (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_actor_id INTEGER NOT NULL REFERENCES actors(id),
        location_id     INTEGER NOT NULL REFERENCES locations(id),
        day             INTEGER NOT NULL CHECK (day >= 1),
        mode            TEXT    NOT NULL
                          CHECK (mode IN ('legit','adhoc','cleared','bribed','busted')),
        fee_paid        INTEGER NOT NULL DEFAULT 0,
        patrol_arrived_hour INTEGER,
        resolved_hour       INTEGER,
        fine_paid           INTEGER NOT NULL DEFAULT 0,
        bribe_paid          INTEGER NOT NULL DEFAULT 0,
        units_lost          INTEGER NOT NULL DEFAULT 0,
        UNIQUE (seller_actor_id, location_id, day)
      );
      CREATE INDEX idx_market_stalls_day ON market_stalls(day);
      CREATE INDEX idx_market_stalls_seller ON market_stalls(seller_actor_id);
    `);
  },
};

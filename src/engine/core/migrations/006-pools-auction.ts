import type { Migration } from "../migrations.js";

/**
 * World pools — the upstream supply layer. A pool represents N units
 * available from some source within a window. Reachability is per actor;
 * NPCs and the player race to claim before the pool's expiry, at which
 * point unsold stock dumps to the auction house (the engine's clearing
 * sink).
 *
 * Auction lots are the downstream side: anything that didn't clear
 * privately in a pool gets listed here. v1 lists lots but doesn't yet
 * have NPC bidders — M9 brings the auction to life.
 */
export const m006PoolsAuction: Migration = {
  version: 6,
  name: "pools-auction",
  up(db) {
    db.exec(`
      CREATE TABLE world_pools (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        item_kind_id        INTEGER NOT NULL REFERENCES item_kinds(id),
        quality_tier        TEXT    NOT NULL
                              CHECK (quality_tier IN ('mint','good','fair','shoddy','broken')),
        quantity_remaining  INTEGER NOT NULL CHECK (quantity_remaining >= 0),
        created_day         INTEGER NOT NULL CHECK (created_day >= 1),
        expiry_day          INTEGER NOT NULL CHECK (expiry_day >= created_day),
        opening_unit_price  INTEGER NOT NULL CHECK (opening_unit_price >= 0),
        closing_unit_price  INTEGER NOT NULL CHECK (closing_unit_price >= 0),
        dump_destination    TEXT    NOT NULL
                              CHECK (dump_destination IN ('auction','market','write_off')),
        flushed_day         INTEGER
      );
      CREATE INDEX idx_pools_kind   ON world_pools(item_kind_id);
      CREATE INDEX idx_pools_expiry ON world_pools(expiry_day);

      CREATE TABLE pool_reachability (
        pool_id  INTEGER NOT NULL REFERENCES world_pools(id),
        actor_id INTEGER NOT NULL REFERENCES actors(id),
        PRIMARY KEY (pool_id, actor_id)
      );

      CREATE TABLE auction_lots (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        source_pool_id      INTEGER REFERENCES world_pools(id),
        item_kind_id        INTEGER NOT NULL REFERENCES item_kinds(id),
        quality_tier        TEXT    NOT NULL
                              CHECK (quality_tier IN ('mint','good','fair','shoddy','broken')),
        quantity            INTEGER NOT NULL CHECK (quantity > 0),
        floor_unit_price    INTEGER NOT NULL CHECK (floor_unit_price >= 0),
        listed_day          INTEGER NOT NULL CHECK (listed_day >= 1),
        cleared_day         INTEGER,
        cleared_unit_price  INTEGER,
        cleared_to_actor_id INTEGER REFERENCES actors(id)
      );
      CREATE INDEX idx_auction_lots_listed ON auction_lots(listed_day);
    `);
  },
};

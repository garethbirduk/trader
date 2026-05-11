import type { Migration } from "../migrations.js";

/**
 * Stage 6 — named external producers and consumers.
 *
 * Off-map supply gets a face: *Trader Bob has 200 fair Nikes at £7/u*.
 * The schema additions:
 *
 *  • `actors.is_virtual` (boolean, default 0) — virtual actors don't
 *    tick, don't have a routine, don't pubdeal in person. They own
 *    pools and are named by gossip; they exist as a record only.
 *  • `world_pools.owner_actor_id` (nullable FK) — the virtual actor
 *    behind this pool. Null = ambient pool (no named producer).
 *  • `world_pools.provenance` (nullable TEXT) — a one-line story
 *    attached to the pool: "estate clearance in Bromley", "fell off
 *    a lorry on the A2". Carries through to the viewer so the
 *    narrative is visible.
 *
 * No separate broker table — broker access lives on
 * `pool_reachability`, which is already the per-pool access gate. A
 * virtual producer's "brokers" are simply the local actor ids the
 * spawner places into pool_reachability when it attributes a pool
 * to that producer.
 */
export const m020VirtualActors: Migration = {
  version: 20,
  name: "virtual-actors",
  up(db) {
    db.exec(`
      ALTER TABLE actors
        ADD COLUMN is_virtual INTEGER NOT NULL DEFAULT 0
          CHECK (is_virtual IN (0, 1));
      ALTER TABLE world_pools
        ADD COLUMN owner_actor_id INTEGER REFERENCES actors(id);
      ALTER TABLE world_pools
        ADD COLUMN provenance TEXT;

      CREATE INDEX idx_pools_owner ON world_pools(owner_actor_id);
      CREATE INDEX idx_actors_virtual ON actors(is_virtual);
    `);
  },
};

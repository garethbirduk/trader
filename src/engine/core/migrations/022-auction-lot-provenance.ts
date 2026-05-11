import type { Migration } from "../migrations.js";

/**
 * Stage 7 — provenance on auction lots.
 *
 * Regional clearance lots (Stage 7) need a narrative tag so the
 * viewer can distinguish "this came from Trader Bob's pool that
 * flushed" from "this is the morning's regional clearance from
 * Bexleyheath." The pool-spawned lots inherit their provenance
 * implicitly via `source_pool_id`; the new lots have
 * `source_pool_id IS NULL` and supply their own string here.
 */
export const m022AuctionLotProvenance: Migration = {
  version: 22,
  name: "auction-lot-provenance",
  up(db) {
    db.exec(`
      ALTER TABLE auction_lots
        ADD COLUMN provenance TEXT;
    `);
  },
};

import type { Migration } from "../migrations.js";

/**
 * Auction docket + knowledge gating.
 *
 * - `scheduled_hour` on auction_lots: when a lot is picked for today's
 *   running docket (max 6/day at 11:00–16:00), the daily-auction handler
 *   stamps the hour the lot will be auctioned. Lots that were never
 *   picked have it NULL; cleared/written-off lots keep their last value.
 * - `actor_known_lots`: an actor knows about a lot once they've seen the
 *   listing. Learned via Sid's Café (newspaper at 06:00+), Sotheby's
 *   gallery (08:00+), gossip exchange, or auction attendance.
 * - `actor_inspected_lots`: an actor has spent one hour at Sotheby's
 *   reviewing a specific lot, revealing its quality tier. Required for
 *   bidders who want a quality-aware ceiling — uninspected bidders bid
 *   against the listed-only signal (item kind, quantity, floor) and
 *   guess at quality.
 */
export const m018AuctionDocket: Migration = {
  version: 18,
  name: "auction-docket",
  up(db) {
    db.exec(`
      ALTER TABLE auction_lots ADD COLUMN scheduled_hour INTEGER;

      CREATE TABLE actor_known_lots (
        actor_id      INTEGER NOT NULL REFERENCES actors(id),
        lot_id        INTEGER NOT NULL REFERENCES auction_lots(id),
        learned_day   INTEGER NOT NULL CHECK (learned_day >= 1),
        learned_hour  INTEGER NOT NULL CHECK (learned_hour BETWEEN 0 AND 23),
        learned_via   TEXT    NOT NULL
                       CHECK (learned_via IN ('paper','gallery','gossip','attended')),
        learned_from_actor_id INTEGER REFERENCES actors(id),
        PRIMARY KEY (actor_id, lot_id)
      );
      CREATE INDEX idx_known_lots_actor ON actor_known_lots(actor_id);
      CREATE INDEX idx_known_lots_lot   ON actor_known_lots(lot_id);

      CREATE TABLE actor_inspected_lots (
        actor_id        INTEGER NOT NULL REFERENCES actors(id),
        lot_id          INTEGER NOT NULL REFERENCES auction_lots(id),
        inspected_day   INTEGER NOT NULL CHECK (inspected_day >= 1),
        inspected_hour  INTEGER NOT NULL CHECK (inspected_hour BETWEEN 0 AND 23),
        PRIMARY KEY (actor_id, lot_id)
      );
      CREATE INDEX idx_inspected_lots_actor ON actor_inspected_lots(actor_id);
      CREATE INDEX idx_inspected_lots_lot   ON actor_inspected_lots(lot_id);
    `);
  },
};

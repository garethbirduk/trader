import type { Migration } from "../migrations.js";

/**
 * Newspaper-knowledge gating for clearance listings — mirrors the
 * `actor_known_lots` table used by the auction docket (migration 018).
 * A listing exists in the world from the morning drop, but an actor
 * only KNOWS about it if they were at a newspaper venue during paper
 * hours, picked it up via gossip, or attended a clearance-mention
 * scene. Without knowledge, an NPC won't book it and a player viewer
 * won't render it.
 */
export const m026ClearanceKnowledge: Migration = {
  version: 26,
  name: "clearance-knowledge",
  up(db) {
    db.exec(`
      CREATE TABLE actor_known_clearance_listings (
        actor_id      INTEGER NOT NULL REFERENCES actors(id),
        listing_id    INTEGER NOT NULL REFERENCES clearance_listings(id),
        learned_day   INTEGER NOT NULL CHECK (learned_day >= 1),
        learned_hour  INTEGER NOT NULL CHECK (learned_hour BETWEEN 0 AND 23),
        learned_via   TEXT    NOT NULL
                       CHECK (learned_via IN ('paper','gossip','overheard')),
        learned_from_actor_id INTEGER REFERENCES actors(id),
        PRIMARY KEY (actor_id, listing_id)
      );
      CREATE INDEX idx_known_clearances_actor
        ON actor_known_clearance_listings(actor_id);
      CREATE INDEX idx_known_clearances_listing
        ON actor_known_clearance_listings(listing_id);
    `);
  },
};

import type { Migration } from "../migrations.js";

/**
 * actor_known_flaws records what an actor has *learned* about an item
 * kind's hidden flaw — usually by paying an expert to inspect it
 * ("take the engines to Boycie"), but also by being burned previously
 * or by hearing it on the network.
 *
 * Granularity is per (actor, item_kind, flaw_type) — once you know
 * that vacuums of THIS kind are FAULTY, you'll spot the flaw on every
 * future batch. Per-lot granularity is overkill for v1 and could be a
 * later schema split if we ever need it.
 *
 * The bidder-profile pipeline reads this when valuing an auction lot:
 * an actor with the relevant known flaw is treated as if their
 * `flawTypeDetection` is 1.0 for that flaw — they always apply the
 * discount.
 */
export const m009KnownFlaws: Migration = {
  version: 9,
  name: "known-flaws",
  up(db) {
    db.exec(`
      CREATE TABLE actor_known_flaws (
        holder_actor_id       INTEGER NOT NULL REFERENCES actors(id),
        item_kind_id          INTEGER NOT NULL REFERENCES item_kinds(id),
        flaw_type             TEXT    NOT NULL
                                CHECK (flaw_type IN
                                  ('faulty','stolen','scam_bait','fake',
                                   'wrong_season','wrong_market','dangerous')),
        learned_day           INTEGER NOT NULL,
        learned_from_actor_id INTEGER REFERENCES actors(id),
        PRIMARY KEY (holder_actor_id, item_kind_id, flaw_type)
      );
      CREATE INDEX idx_known_flaws_holder ON actor_known_flaws(holder_actor_id);
    `);
  },
};

import type { Migration } from "../migrations.js";

/**
 * Each actor has a transport tier — pocket / boot / van / truck / none —
 * that caps how much they can physically deliver per deal. A pocket-tier
 * actor can move a fistful of jewellery; a truck-tier actor can shift a
 * job lot of white goods; a no-tier actor (a publican behind a bar)
 * can't move anything at all.
 *
 * v1 only enforces this at settlement (and pre-emptively in the pub-deal
 * autonomy when sizing forward sales). Future phases add physical stock
 * locations and movement-takes-time semantics.
 */
export const m011Transport: Migration = {
  version: 11,
  name: "actor-transport-capacity",
  up(db) {
    db.exec(`
      ALTER TABLE actors
        ADD COLUMN transport_capacity TEXT NOT NULL DEFAULT 'pocket'
        CHECK (transport_capacity IN ('none','pocket','boot','van','truck'));
    `);
  },
};

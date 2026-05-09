import type { Migration } from "../migrations.js";

/**
 * Add a lockup_location_id to actors — where they keep their stock.
 * Distinct from `home_location_id` (where they sleep) and from the
 * routine's `default_location` (where they hang out by day).
 *
 * Some characters have all three at one place (Mike: Nag's Head is
 * home, lockup, and default). Others split: Boycie sleeps at home but
 * stock lives at Boyce Autos. A third group rents containers at the
 * shared "The Lock-up" (Trigger, Paddy, Monkey Harris, etc.).
 *
 * Nullable for legacy rows; the placeholder skin sets it on seed.
 */
export const m017ActorLockup: Migration = {
  version: 17,
  name: "actor-lockup",
  up(db) {
    db.exec(`
      ALTER TABLE actors ADD COLUMN lockup_location_id INTEGER
        REFERENCES locations(id) ON DELETE SET NULL;
    `);
  },
};

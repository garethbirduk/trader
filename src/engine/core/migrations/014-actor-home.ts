import type { Migration } from "../migrations.js";

/**
 * Actors gain a `home_location_id` — where they live / sleep. Distinct
 * from `current_location_id` (where they happen to be right now) and from
 * the workplace they go to during work hours. Surfaced in the webapp's
 * actor profile + diary.
 */
export const m014ActorHome: Migration = {
  version: 14,
  name: "actor-home",
  up(db) {
    db.exec(`
      ALTER TABLE actors ADD COLUMN home_location_id INTEGER REFERENCES locations(id);
    `);
  },
};

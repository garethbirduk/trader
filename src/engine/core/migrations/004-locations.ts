import type { Migration } from "../migrations.js";

/**
 * Locations are nodes the world is partitioned into — actors are at one
 * location at a time and conversations / mechanics happen between actors
 * at the same place. Pure skin data: each skin seeds its own social
 * venues, lock-ups, dealer houses, auction halls, and any workplaces
 * its characters spend their days at.
 */
export const m004Locations: Migration = {
  version: 4,
  name: "locations",
  up(db) {
    db.exec(`
      CREATE TABLE locations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL
      );

      ALTER TABLE actors
        ADD COLUMN current_location_id INTEGER REFERENCES locations(id);
    `);
  },
};

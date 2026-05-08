import type { Migration } from "../migrations.js";

/**
 * Locations gain a `type` (home / business / pub / auction / civic /
 * street / abstract) and an optional opening-hours window. The type
 * drives how the webapp renders the location's diary; the hours feed
 * "who's here" and "is this place open" displays.
 *
 * Engine-agnostic: skins choose appropriate types; nothing in the
 * engine's mechanics keys off type yet.
 */
export const m015LocationType: Migration = {
  version: 15,
  name: "location-type",
  up(db) {
    db.exec(`
      ALTER TABLE locations ADD COLUMN type TEXT NOT NULL DEFAULT 'business';
      ALTER TABLE locations ADD COLUMN open_hour_start INTEGER;
      ALTER TABLE locations ADD COLUMN open_hour_end   INTEGER;
    `);
  },
};

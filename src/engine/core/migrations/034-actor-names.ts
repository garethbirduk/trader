import type { Migration } from "../migrations.js";

/**
 * Structured actor names — replace the single `display_name` column
 * with three explicit fields that the UI's chip levels consume:
 *
 *   • first_name — given name (required).
 *   • last_name  — family name (nullable: institutions like Sotheby's
 *     and one-name characters have none).
 *   • short_name — chip-friendly nickname or short label (required;
 *     defaults to first_name when the skin doesn't supply one).
 *
 * `display_name` is kept and continues to be written by the seed
 * (composed as `first_name + " " + last_name`) so legacy readers
 * (snapshot, profile views, anything that didn't migrate yet) keep
 * working. Future consumers should prefer the three structured fields
 * and use `fullName(...)` / `chipName(...)` from the placeholder
 * skin's helpers to compose what they need.
 *
 * SQLite's ALTER TABLE ADD COLUMN with NOT NULL requires a default,
 * hence the empty-string defaults; the seed overwrites them.
 */
export const m034ActorNames: Migration = {
  version: 34,
  name: "actor-names",
  up(db) {
    db.exec(`
      ALTER TABLE actors ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE actors ADD COLUMN last_name  TEXT;
      ALTER TABLE actors ADD COLUMN short_name TEXT NOT NULL DEFAULT '';
    `);
  },
};

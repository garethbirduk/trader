import type { Migration } from "../migrations.js";

/**
 * Knowledge axes v2 — the four-skill price-axis model (todolist:67-78).
 *
 * Drops the brand-and-pair v1 framing. Identification stops being
 * "tell A from B" and becomes "where on this category's price axis
 * does the lot sit, given my mental partition of the axis?" The
 * actor's perception is stored directly as a per-(actor, category)
 * list of price bands; their condition-impact knowledge is stored
 * directly as per-tier multiplier beliefs.
 *
 * Three schema changes:
 *
 *   1. `actor_category_bands` — each row is one band in the actor's
 *      mental partition of a category's price range. Bands need not
 *      cover the whole range — an idiot with one band (£2000, £10000)
 *      only perceives that chunk and has no model for cheaper or
 *      pricier items.
 *
 *   2. `actor_tier_beliefs` — the actor's mental multiplier for each
 *      tier per category. Truth lives in EconomicsConfig; the actor's
 *      stored belief may differ. An electrician might think a broken
 *      Bosch dishwasher is ×0.7 (still salvageable) when the truth is
 *      ×0.25 — a category-specific knowledge gap.
 *
 *   3. Rebuild `actor_skills` and `actor_skill_defaults` with a
 *      permissive axis constraint so v2 axes
 *      (band_placement, band_tightness, condition_detection) live
 *      alongside the v1 names. Axis validation moves into the app
 *      layer (knowledge/types.ts) — the DB-level CHECK was a v1
 *      shortcut.
 */
export const m024KnowledgeAxesV2: Migration = {
  version: 24,
  name: "knowledge-axes-v2",
  up(db) {
    db.exec(`
      CREATE TABLE actor_category_bands (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id  INTEGER NOT NULL REFERENCES actors(id),
        category  TEXT    NOT NULL,
        low       INTEGER NOT NULL CHECK (low >= 0),
        high      INTEGER NOT NULL CHECK (high > low),
        band_idx  INTEGER NOT NULL CHECK (band_idx >= 0),
        UNIQUE (actor_id, category, band_idx)
      );
      CREATE INDEX idx_acb_actor_cat ON actor_category_bands(actor_id, category);

      CREATE TABLE actor_tier_beliefs (
        actor_id    INTEGER NOT NULL REFERENCES actors(id),
        category    TEXT    NOT NULL,
        tier        TEXT    NOT NULL
                    CHECK (tier IN ('mint','good','fair','shoddy','broken')),
        multiplier  REAL    NOT NULL CHECK (multiplier >= 0),
        PRIMARY KEY (actor_id, category, tier)
      );
      CREATE INDEX idx_atb_actor ON actor_tier_beliefs(actor_id);

      -- Rebuild actor_skills with a permissive axis constraint. The
      -- SQLite recipe: create new, copy data, drop old, rename.
      -- Indexes on the dropped table go with it; we recreate.
      CREATE TABLE actor_skills_new (
        actor_id   INTEGER NOT NULL REFERENCES actors(id),
        axis       TEXT    NOT NULL,
        key        TEXT    NOT NULL,
        accuracy   REAL    NOT NULL CHECK (accuracy BETWEEN 0 AND 1),
        PRIMARY KEY (actor_id, axis, key)
      );
      INSERT INTO actor_skills_new (actor_id, axis, key, accuracy)
        SELECT actor_id, axis, key, accuracy FROM actor_skills;
      DROP TABLE actor_skills;
      ALTER TABLE actor_skills_new RENAME TO actor_skills;
      CREATE INDEX idx_actor_skills_actor ON actor_skills(actor_id);

      CREATE TABLE actor_skill_defaults_new (
        actor_id   INTEGER NOT NULL REFERENCES actors(id),
        axis       TEXT    NOT NULL,
        accuracy   REAL    NOT NULL CHECK (accuracy BETWEEN 0 AND 1),
        PRIMARY KEY (actor_id, axis)
      );
      INSERT INTO actor_skill_defaults_new (actor_id, axis, accuracy)
        SELECT actor_id, axis, accuracy FROM actor_skill_defaults;
      DROP TABLE actor_skill_defaults;
      ALTER TABLE actor_skill_defaults_new RENAME TO actor_skill_defaults;
    `);
  },
};

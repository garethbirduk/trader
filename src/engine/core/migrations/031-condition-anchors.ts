import type { Migration } from "../migrations.js";

/**
 * Per-category condition anchor table — the v2 condition arm's "what
 * does a clueless actor think condition looks like in this category?"
 * prior. Parallel to `category_anchors` (the price prior) but stores
 * a quality scalar in [0, 1] rather than a £ value.
 *
 *   anchor = 0.0 → broken-end prior ("most of this category is junk")
 *   anchor = 0.5 → "fair" prior (the v1 global default)
 *   anchor = 1.0 → mint-end prior ("most of this category is near-new")
 *
 * Lets skin authors give tools a beaten-up prior (~0.3) and electronics
 * a near-new prior (~0.6) without a separate column on the existing
 * anchors table. Missing rows fall back to 0.5 in the repo layer.
 *
 * Lookup-only; one row per category; seeded by the skin.
 */
export const m031ConditionAnchors: Migration = {
  version: 31,
  name: "condition-anchors",
  up(db) {
    db.exec(`
      CREATE TABLE category_condition_anchors (
        category      TEXT NOT NULL PRIMARY KEY,
        anchor_value  REAL NOT NULL CHECK (anchor_value BETWEEN 0 AND 1)
      );
    `);
  },
};

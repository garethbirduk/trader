import type { Migration } from "../migrations.js";

/**
 * Extend item_kinds with the dodginess + spawn metadata that the catalogue
 * system needs:
 *
 *   • flaw_type        — what's wrong with it (FAULTY/STOLEN/SCAM_BAIT/...).
 *                        NULL for clean stock.
 *   • risk             — heat scalar 0..5. Used by the future Authority system.
 *   • target_customers — comma-separated customer types this item appeals to
 *                        (e.g. "yuppies,businesses"). Empty string for none.
 *   • is_easter_egg    — flagged show-specific items, surfaced with extra
 *                        flavour in the event stream.
 *   • flavour_text     — the joke / one-liner. Shown on spawn for easter eggs.
 *   • spawn_weight     — relative pool-spawn frequency. Higher = more common.
 *                        Set to 0 to disable spawning for an item.
 *
 * v1 only USES is_easter_egg, flavour_text, and spawn_weight at the
 * mechanic layer. flaw_type / risk / target_customers ship as data so
 * later milestones (heat, customer-type matching, inspection-aware
 * appraisal) can drop in without further schema changes.
 */
export const m008ItemKindExtras: Migration = {
  version: 8,
  name: "item-kind-extras",
  up(db) {
    db.exec(`
      ALTER TABLE item_kinds ADD COLUMN flaw_type TEXT
        CHECK (flaw_type IS NULL OR flaw_type IN
          ('faulty','stolen','scam_bait','fake','wrong_season','wrong_market','dangerous'));
      ALTER TABLE item_kinds ADD COLUMN risk INTEGER NOT NULL DEFAULT 0
        CHECK (risk >= 0 AND risk <= 5);
      ALTER TABLE item_kinds ADD COLUMN target_customers TEXT NOT NULL DEFAULT '';
      ALTER TABLE item_kinds ADD COLUMN is_easter_egg INTEGER NOT NULL DEFAULT 0
        CHECK (is_easter_egg IN (0,1));
      ALTER TABLE item_kinds ADD COLUMN flavour_text TEXT;
      ALTER TABLE item_kinds ADD COLUMN spawn_weight INTEGER NOT NULL DEFAULT 10
        CHECK (spawn_weight >= 0);
    `);
  },
};

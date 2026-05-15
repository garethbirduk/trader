import type { Migration } from "../migrations.js";

/**
 * Two-tier gossip — Model B (lock-state per lead).
 *
 * Every lead carries a `detail_unlocked` flag. When the flag is 0 the
 * holder sees only the headline (subject + side + holder). When 1, the
 * holder sees the full row.
 *
 * First-hand creation paths (seed-from-stock, seed-from-wishlist,
 * witness, clearance observation, lot inspection) leave detail_unlocked
 * at the default 1 — you know what you've directly observed.
 *
 * Gossip transfer paths (`shareLead`, `clarifyLead`) explicitly write
 * detail_unlocked = 0 and NULL the detail fields on the receiver's row.
 *
 * Existing rows in an in-flight DB backfill to 1 (everything previously
 * created is fully known — no surprise headlines for an in-flight run).
 */
export const m028LeadDetailUnlocked: Migration = {
  version: 28,
  name: "lead-detail-unlocked",
  up(db) {
    db.exec(`
      ALTER TABLE leads
        ADD COLUMN detail_unlocked INTEGER NOT NULL DEFAULT 1
          CHECK (detail_unlocked IN (0, 1));

      CREATE INDEX idx_leads_detail_unlocked ON leads(detail_unlocked);
    `);
  },
};

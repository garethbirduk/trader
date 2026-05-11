import type { Migration } from "../migrations.js";

/**
 * Reputation leads — Stage 5 of the information layer.
 *
 * A "rep lead" is a warning (or vouch) about a *person*, propagated
 * through the same gossip channels that carry commodity leads. The
 * fictional shape is "Boyce stitched Trigger" — a holder, a subject
 * (Boyce), and the actor on the receiving end of the stitch-up
 * (Trigger, stored in the existing `counterparty_actor_id` column).
 *
 * We layer this onto the existing `leads` table with two new columns:
 *
 *  • `kind`                     — 'commodity' (the legacy meaning, the
 *                                  default) or 'rep'.
 *  • `subject_target_actor_id`  — for rep leads, the actor the lead is
 *                                  about; NULL for commodity leads.
 *
 * For rep leads `subject_item_kind_id` becomes NULL (the lead isn't
 * about an item), so we rebuild the table to relax the NOT NULL.
 * `estimated_qty` and `estimated_unit_price` are repurposed: qty = how
 * many recorded offences this report aggregates (almost always 1 in v1);
 * price = total monetary damage in pence. Both stay non-null.
 *
 * Row-level CHECK constraints enforce the discriminator:
 *
 *  commodity:  item kind set, target NULL
 *  rep:        item kind NULL, target set
 *
 * The migration preserves every existing row with kind='commodity'.
 */
export const m019RepLeads: Migration = {
  version: 19,
  name: "rep-leads",
  up(db) {
    db.exec(`
      -- Rebuild leads to relax subject_item_kind_id NOT NULL and add
      -- the rep-lead columns + discriminator check. Existing rows are
      -- copied verbatim with kind='commodity'.

      CREATE TABLE leads_new (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        holder_actor_id          INTEGER NOT NULL REFERENCES actors(id),
        kind                     TEXT    NOT NULL DEFAULT 'commodity'
                                   CHECK (kind IN ('commodity','rep')),
        side                     TEXT    NOT NULL CHECK (side IN ('supply','demand')),
        subject_item_kind_id     INTEGER REFERENCES item_kinds(id),
        subject_quality_tier     TEXT
                                   CHECK (subject_quality_tier IS NULL OR
                                          subject_quality_tier IN ('mint','good','fair','shoddy','broken')),
        subject_target_actor_id  INTEGER REFERENCES actors(id),
        counterparty_actor_id    INTEGER REFERENCES actors(id),
        estimated_qty            INTEGER NOT NULL CHECK (estimated_qty > 0),
        estimated_unit_price     INTEGER NOT NULL CHECK (estimated_unit_price >= 0),
        confidence               TEXT    NOT NULL CHECK (confidence IN ('warm','cold')),
        source_actor_id          INTEGER REFERENCES actors(id),
        acquired_day             INTEGER NOT NULL CHECK (acquired_day >= 1),
        hop_count                INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
        derived_from_lead_id     INTEGER REFERENCES leads_new(id),
        subject_pool_id          INTEGER REFERENCES world_pools(id),
        CHECK (
          (kind = 'commodity' AND subject_item_kind_id IS NOT NULL
            AND subject_target_actor_id IS NULL)
          OR
          (kind = 'rep' AND subject_item_kind_id IS NULL
            AND subject_target_actor_id IS NOT NULL)
        )
      );

      INSERT INTO leads_new (
        id, holder_actor_id, kind, side,
        subject_item_kind_id, subject_quality_tier,
        subject_target_actor_id, counterparty_actor_id,
        estimated_qty, estimated_unit_price,
        confidence, source_actor_id, acquired_day, hop_count,
        derived_from_lead_id, subject_pool_id
      )
      SELECT
        id, holder_actor_id, 'commodity', side,
        subject_item_kind_id, subject_quality_tier,
        NULL, counterparty_actor_id,
        estimated_qty, estimated_unit_price,
        confidence, source_actor_id, acquired_day, hop_count,
        derived_from_lead_id, subject_pool_id
      FROM leads;

      DROP TABLE leads;
      ALTER TABLE leads_new RENAME TO leads;

      CREATE INDEX idx_leads_holder           ON leads(holder_actor_id);
      CREATE INDEX idx_leads_subject_item     ON leads(subject_item_kind_id);
      CREATE INDEX idx_leads_subject_target   ON leads(subject_target_actor_id);
      CREATE INDEX idx_leads_kind             ON leads(kind);
    `);
  },
};

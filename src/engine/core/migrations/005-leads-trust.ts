import type { Migration } from "../migrations.js";

/**
 * Leads are the information ledger — what an actor has heard about who
 * has or wants what. Trust is per-pair: holder actor's belief in target
 * actor's reliability. Both feed the eventual rumour-chain mechanic and
 * the gating of how much NPCs share with the player.
 *
 * Schema includes hooks for future chained leads (`hop_count`,
 * `derived_from_lead_id`) and "a guy" pools (counterparty_actor_id is
 * nullable). v1 uses none of those — they're inert columns until the
 * relevant systems land.
 */
export const m005LeadsTrust: Migration = {
  version: 5,
  name: "leads-trust",
  up(db) {
    db.exec(`
      CREATE TABLE leads (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        holder_actor_id        INTEGER NOT NULL REFERENCES actors(id),
        side                   TEXT    NOT NULL CHECK (side IN ('supply','demand')),
        subject_item_kind_id   INTEGER NOT NULL REFERENCES item_kinds(id),
        subject_quality_tier   TEXT
                                CHECK (subject_quality_tier IS NULL OR
                                       subject_quality_tier IN ('mint','good','fair','shoddy','broken')),
        counterparty_actor_id  INTEGER REFERENCES actors(id),
        estimated_qty          INTEGER NOT NULL CHECK (estimated_qty > 0),
        estimated_unit_price   INTEGER NOT NULL CHECK (estimated_unit_price >= 0),
        confidence             TEXT    NOT NULL CHECK (confidence IN ('warm','cold')),
        source_actor_id        INTEGER REFERENCES actors(id),
        acquired_day           INTEGER NOT NULL CHECK (acquired_day >= 1),
        hop_count              INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
        derived_from_lead_id   INTEGER REFERENCES leads(id)
      );
      CREATE INDEX idx_leads_holder ON leads(holder_actor_id);
      CREATE INDEX idx_leads_kind   ON leads(subject_item_kind_id);

      CREATE TABLE actor_trust (
        holder_actor_id INTEGER NOT NULL REFERENCES actors(id),
        target_actor_id INTEGER NOT NULL REFERENCES actors(id),
        score           INTEGER NOT NULL DEFAULT 0,
        last_event_day  INTEGER,
        PRIMARY KEY (holder_actor_id, target_actor_id),
        CHECK (holder_actor_id != target_actor_id)
      );
    `);
  },
};

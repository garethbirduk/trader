import type { Migration } from "../migrations.js";

/**
 * Multiple independent knowledge axes per actor — todolist:57.
 *
 * Replaces the runtime-only two-axis BidderProfile (appraisalAccuracy +
 * flawTypeDetection) with a five-axis persisted skill grid plus a
 * per-(actor, lot) belief log. Adds confusable item-kind pairs so the
 * id-axis has something concrete to roll against (Rolex vs Rulex, real
 * Persian vs printed carpet).
 *
 * The five axes:
 *   id           — "what is this?" (per pair of confusable kinds)
 *   condition    — "what tier?" (per category)
 *   flaw         — "is anything wrong?" (per flaw type — keeps the
 *                  existing flawTypeDetection semantics)
 *   price        — "what's the going rate?" (per category)
 *   customer_fit — "who would buy this?" (per category)
 *
 * Beliefs are written by the consultation action: actor A pays expert B
 * £3 + 1h to consult on a specific (lot, axis); B's per-axis skill rolls
 * against the lot's truth and a possibly-wrong answer is recorded in
 * actor_beliefs. The belief-band aggregator integrates rows for a given
 * (actor, lot) into a £ extraction band that anchors the haggle.
 */
export const m023KnowledgeAxes: Migration = {
  version: 23,
  name: "knowledge-axes",
  up(db) {
    db.exec(`
      -- Pairs of item kinds that are easy to confuse with each other.
      -- Canonical ordering kind_a_id < kind_b_id so each pair has one row.
      -- difficulty ∈ [0,1]: 0 = trivially distinguishable on sight,
      -- 1 = so similar even an expert struggles. The id-skill roll is
      -- effectively skill × (1 - difficulty), so high-difficulty pairs
      -- cap the maximum reliable ID anyone can have.
      CREATE TABLE confusable_item_pairs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind_a_id   INTEGER NOT NULL REFERENCES item_kinds(id),
        kind_b_id   INTEGER NOT NULL REFERENCES item_kinds(id),
        difficulty  REAL    NOT NULL CHECK (difficulty BETWEEN 0 AND 1),
        CHECK (kind_a_id < kind_b_id),
        UNIQUE (kind_a_id, kind_b_id)
      );
      CREATE INDEX idx_confusable_pairs_a ON confusable_item_pairs(kind_a_id);
      CREATE INDEX idx_confusable_pairs_b ON confusable_item_pairs(kind_b_id);

      -- Per-actor per-axis skill scores. Replaces (and persists) the
      -- in-memory BidderProfile. The 'key' column scopes the skill:
      --   id           → pair code "kind_a_code|kind_b_code"
      --   condition    → category
      --   flaw         → flaw_type
      --   price        → category
      --   customer_fit → category
      -- Missing rows fall back to the per-(actor, axis) default in
      -- actor_skill_defaults; missing defaults fall back to engine
      -- defaults (FALLBACK_BIDDER_PROFILE).
      CREATE TABLE actor_skills (
        actor_id   INTEGER NOT NULL REFERENCES actors(id),
        axis       TEXT    NOT NULL
                    CHECK (axis IN ('id','condition','flaw','price','customer_fit')),
        key        TEXT    NOT NULL,
        accuracy   REAL    NOT NULL CHECK (accuracy BETWEEN 0 AND 1),
        PRIMARY KEY (actor_id, axis, key)
      );
      CREATE INDEX idx_actor_skills_actor ON actor_skills(actor_id);

      CREATE TABLE actor_skill_defaults (
        actor_id   INTEGER NOT NULL REFERENCES actors(id),
        axis       TEXT    NOT NULL
                    CHECK (axis IN ('id','condition','flaw','price','customer_fit')),
        accuracy   REAL    NOT NULL CHECK (accuracy BETWEEN 0 AND 1),
        PRIMARY KEY (actor_id, axis)
      );

      -- Per-actor per-stock-lot persistent beliefs. One row per
      -- consultation, so two conflicting reads on the same axis coexist
      -- (Rodney says mint, Boyce says scratched — both rows; viewer
      -- shows the conflict; aggregator integrates over the mixture).
      --
      -- value_json holds the axis-specific payload:
      --   id           → { "kindId": 42 }
      --   condition    → { "tier": "mint" }
      --   flaw         → { "flawType": "fake" } or { "flawType": null }
      --                  (the latter = "expert says it looks clean")
      --   price        → { "low": 100, "high": 110 }
      --   customer_fit → { "types": ["yuppies","businesses"] }
      --
      -- sourced_from_actor_id is the expert consulted (NULL when the
      -- holder formed the belief themselves — e.g. acquired the lot
      -- with full knowledge).
      CREATE TABLE actor_beliefs (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id              INTEGER NOT NULL REFERENCES actors(id),
        lot_id                INTEGER NOT NULL REFERENCES stock_lots(id),
        axis                  TEXT    NOT NULL
                              CHECK (axis IN ('id','condition','flaw','price','customer_fit')),
        value_json            TEXT    NOT NULL,
        confidence            REAL    NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        sourced_from_actor_id INTEGER REFERENCES actors(id),
        acquired_day          INTEGER NOT NULL CHECK (acquired_day >= 1)
      );
      CREATE INDEX idx_beliefs_actor_lot ON actor_beliefs(actor_id, lot_id);
      CREATE INDEX idx_beliefs_axis      ON actor_beliefs(actor_id, lot_id, axis);
    `);
  },
};

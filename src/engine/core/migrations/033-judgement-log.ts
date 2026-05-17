import type { Migration } from "../migrations.js";

/**
 * Judgement audit trail (docs/judgement.md — "Judgement audit trail
 * + hover-over math in the UI"). Every judgement-engine call that
 * drives a player-visible action leaves a row here so the UI can
 * surface the math retrospectively without re-deriving it.
 *
 * Schema:
 *   • day/hour — when the judgement was made.
 *   • actor_id — whose judgement it is (the perceiver / decider).
 *   • arm — 'price' for `estimate`/`estimatePriceBand`; 'condition'
 *     for `estimateCondition`; 'composite' for `estimateLotValue`
 *     (the Condition ∘ Price chain plus flaw + customer-fit + the
 *     character-arm bonus). The same actor can have many rows in
 *     the same hour — one per decision they made.
 *   • context_kind — what decision this judgement informed.
 *     'auction-bid', 'pubdeal-appraisal', 'market-seller-belief',
 *     'shop-seller-belief', 'lead-seed'. Indexed for "show me all
 *     pubdeal appraisals from D5" queries.
 *   • context_ref_id — nullable FK into the related row (auction
 *     bid id, pub-deal id, market-stall id, lead id). Lets the UI
 *     join from an event back to its judgement.
 *   • payload — JSON blob with the kind-specific math fields. Price-
 *     arm: itemKindId, category, truthTier (nullable), truthUnit,
 *     anchor, expertise, j, centre, low, high, sample (nullable when
 *     the call was RNG-free), tierMultiplier. Composite: above plus
 *     perceivedTier, conditionOverridden, condition arm dials,
 *     flawDetected, flawMultiplier, flawDetectionBonus,
 *     knownFlawType, customerFitMultiplier, quantity,
 *     perceivedLotValue. Stored as JSON to keep variants legible
 *     without per-variant columns; queryable via SQLite JSON1 if a
 *     future filter needs it.
 *
 * No FK to actors(id) — keeps the audit row valid after an actor
 * gets pruned by a future cleanup. The audit is a record of what
 * happened, not a live relation.
 *
 * No retention enforcement here — a future migration or a
 * registry-level housekeeper can truncate by day. v1 keeps every
 * row; volume estimate is ~400 rows/day for a 20-actor world,
 * mostly auction bids.
 */
export const m033JudgementLog: Migration = {
  version: 33,
  name: "judgement-log",
  up(db) {
    db.exec(`
      CREATE TABLE judgement_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        day             INTEGER NOT NULL,
        hour            INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
        actor_id        INTEGER NOT NULL,
        arm             TEXT    NOT NULL
                        CHECK (arm IN ('price','condition','composite')),
        context_kind    TEXT    NOT NULL,
        context_ref_id  INTEGER,
        payload         TEXT    NOT NULL
      );
      CREATE INDEX idx_judgement_log_day_hour
        ON judgement_log(day, hour);
      CREATE INDEX idx_judgement_log_actor_day
        ON judgement_log(actor_id, day);
      CREATE INDEX idx_judgement_log_context
        ON judgement_log(context_kind, context_ref_id);
    `);
  },
};

import type { Migration } from "../migrations.js";

/**
 * Stage 7 — pending payouts.
 *
 * Stage 6 made the off-map dealers' resale revenue return to them
 * immediately at end-of-day. That made whales effectively bottomless:
 * any cash they paid for an auction lot came back as cash within a few
 * hours of resale, with only the resellMargin shaving lost.
 *
 * Stage 7 lags those payouts. Off-map resale credits a deferred entry
 * in this table with `available_day = today + payoutLagDays`. A
 * pending-payouts handler drains the table each morning, crediting any
 * row whose day has come. Whales who spent their cash bidding now have
 * to wait for the lag to elapse before they can spend again — which
 * means they can be outbid, sit out a day, or genuinely run short.
 *
 * The table is general-purpose: any deferred cash flow can use it.
 * `source` is a freeform label for tracing.
 */
export const m021PendingPayouts: Migration = {
  version: 21,
  name: "pending-payouts",
  up(db) {
    db.exec(`
      CREATE TABLE pending_payouts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id        INTEGER NOT NULL REFERENCES actors(id),
        amount          INTEGER NOT NULL CHECK (amount > 0),
        available_day   INTEGER NOT NULL CHECK (available_day >= 1),
        source          TEXT    NOT NULL,
        created_day     INTEGER NOT NULL CHECK (created_day >= 1)
      );
      CREATE INDEX idx_pending_payouts_due
        ON pending_payouts(available_day);
      CREATE INDEX idx_pending_payouts_actor
        ON pending_payouts(actor_id);
    `);
  },
};

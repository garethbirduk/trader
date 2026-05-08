import type { Migration } from "../migrations.js";

/**
 * Deals are the central obligation ledger. A deal is a promise — stock and
 * cash actually move at settlement, not at agreement. Forward selling falls
 * out of this naturally: a seller can agree to deliver goods they don't
 * yet hold, and the engine only checks reality at the deadline.
 *
 * State machine: proposed → agreed → settled | defaulted | cancelled.
 * `proposed` is reserved for future negotiation flows where a buyer floats
 * an offer that the seller hasn't yet accepted; M3 jumps straight to
 * `agreed` via createAgreedDeal.
 */
export const m003Deals: Migration = {
  version: 3,
  name: "deals",
  up(db) {
    db.exec(`
      CREATE TABLE deals (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        buyer_actor_id       INTEGER NOT NULL REFERENCES actors(id),
        seller_actor_id      INTEGER NOT NULL REFERENCES actors(id),
        state                TEXT    NOT NULL
                              CHECK (state IN ('proposed','agreed','settled','defaulted','cancelled')),
        agreed_day           INTEGER NOT NULL CHECK (agreed_day >= 1),
        deadline_day         INTEGER NOT NULL CHECK (deadline_day >= agreed_day),
        delivery_location_id INTEGER,
        settled_day          INTEGER,
        defaulted_day        INTEGER,
        default_reason       TEXT,
        notes                TEXT,
        CHECK (buyer_actor_id != seller_actor_id)
      );

      CREATE TABLE deal_lines (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id       INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        item_kind_id  INTEGER NOT NULL REFERENCES item_kinds(id),
        quality_tier  TEXT    NOT NULL
                       CHECK (quality_tier IN ('mint','good','fair','shoddy','broken')),
        quantity      INTEGER NOT NULL CHECK (quantity > 0),
        unit_price    INTEGER NOT NULL CHECK (unit_price >= 0)
      );

      CREATE INDEX idx_deals_buyer    ON deals(buyer_actor_id);
      CREATE INDEX idx_deals_seller   ON deals(seller_actor_id);
      CREATE INDEX idx_deals_state    ON deals(state);
      CREATE INDEX idx_deals_deadline ON deals(deadline_day);
      CREATE INDEX idx_deal_lines_deal ON deal_lines(deal_id);
    `);
  },
};

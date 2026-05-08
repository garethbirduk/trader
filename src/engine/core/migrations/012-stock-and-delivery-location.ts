import type { Migration } from "../migrations.js";

/**
 * Phase 2 of physical delivery:
 *
 * 1. `stock_lot.location_id` — every batch of stock now sits somewhere
 *    physical, separate from its owner's body. A seller can be at the
 *    pub while their inventory remains in the lock-up.
 *
 * 2. `deal.delivery_location_id` — every deal records *where* the
 *    buyer expects the goods to arrive (typically the location they
 *    were both at when the deal was struck).
 *
 * 3. `deal.delivery_dispatched_day` — set when the seller has
 *    physically moved the stock to the delivery location. Reserved for
 *    future time-aware delivery; the v1 settlement walk handles
 *    dispatching atomically (charging a per-trip fee based on transport
 *    tier).
 *
 * Both new FK columns are nullable so legacy rows (and tests that
 * predate Phase 2) work without retrofit.
 */
export const m012StockAndDeliveryLocation: Migration = {
  version: 12,
  name: "stock-and-delivery-location",
  up(db) {
    db.exec(`
      ALTER TABLE stock_lots
        ADD COLUMN location_id INTEGER REFERENCES locations(id);
      ALTER TABLE deals
        ADD COLUMN delivery_dispatched_day INTEGER;
    `);
    // Note: deals.delivery_location_id already exists from migration
    // 003 — Phase 2 just starts populating it from the agreement
    // location and reading it during settlement.
  },
};

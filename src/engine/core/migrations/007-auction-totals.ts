import type { Migration } from "../migrations.js";

/**
 * Auction prices are totals for the whole lot, not per-unit. A bidder
 * either takes the entire lot or not — they don't bid £/unit. Rename the
 * relevant columns and convert any in-flight values from per-unit to
 * total by multiplying through the lot quantity.
 */
export const m007AuctionTotals: Migration = {
  version: 7,
  name: "auction-totals",
  up(db) {
    db.exec(`
      ALTER TABLE auction_lots RENAME COLUMN floor_unit_price   TO floor_price;
      ALTER TABLE auction_lots RENAME COLUMN cleared_unit_price TO cleared_price;
      UPDATE auction_lots SET floor_price   = floor_price   * quantity;
      UPDATE auction_lots SET cleared_price = cleared_price * quantity
        WHERE cleared_price IS NOT NULL;
    `);
  },
};

import type { Migration } from "../migrations.js";

/**
 * Add a physical-size category to item_kinds. Three buckets:
 *
 *   • small  — pocket-sized; can be exchanged person-to-person without
 *              transport. Cigarettes, ties, watches.
 *   • mid    — needs a car boot to move. Hi-fis, microwaves, table lamps.
 *   • large  — needs a van or truck. Wardrobes, sofas, ladders.
 *
 * Defaults to 'mid' so existing rows are valid; the placeholder skin
 * sets per-item sizes when seeding.
 */
export const m016ItemSize: Migration = {
  version: 16,
  name: "item-size",
  up(db) {
    db.exec(`
      ALTER TABLE item_kinds ADD COLUMN size TEXT NOT NULL DEFAULT 'mid'
        CHECK (size IN ('small', 'mid', 'large'));
    `);
  },
};

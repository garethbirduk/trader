import type { Migration } from "../migrations.js";

/**
 * Two extensions in one round:
 *
 * 1. `leads.subject_pool_id` — supply leads can now point at the actual
 *    upstream `world_pool` row they describe. When two leads from
 *    different counterparties reference the same pool, the world is
 *    revealing that there really is only one batch of stock — and the
 *    cascade comedy follows naturally.
 *
 * 2. `locations.proprietor_actor_id` — a location can have a fixed
 *    "owner" NPC (a pub landlord, a cafe proprietor, etc.). Proprietors
 *    are information sinks: every visitor exchanges one piece of
 *    knowledge with them on arrival, so they accumulate over time.
 */
export const m010LeadsAndLocations: Migration = {
  version: 10,
  name: "leads-pool-and-location-proprietor",
  up(db) {
    db.exec(`
      ALTER TABLE leads
        ADD COLUMN subject_pool_id INTEGER REFERENCES world_pools(id);
      ALTER TABLE locations
        ADD COLUMN proprietor_actor_id INTEGER REFERENCES actors(id);
    `);
  },
};

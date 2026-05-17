import type { Migration } from "../migrations.js";

/**
 * Remove the identity-arm scaffolding.
 *
 * The "Is this a Rolex or a Rulex?" identity arm doesn't match this
 * game — goods are watches, chandeliers, silver cutlery; the category
 * is given and what varies is condition and value. Identity stops
 * being a perception axis; the v2 band-placement skill stays (now
 * properly named in the TypeScript layer).
 *
 *   1. Drop the `confusable_item_pairs` table from m023.
 *   2. Delete leftover axis='id' rows from actor_skills,
 *      actor_skill_defaults, and actor_beliefs. The DB tables were
 *      already permissive on axis from m024; this is data cleanup,
 *      not schema cleanup.
 *
 * `actor_arm_j.arm` and `actor_perception_anchors.arm` still have
 * 'identity' in their CHECK constraints from m029; that's harmless
 * (no code writes 'identity' anymore) and a future migration can
 * rebuild those tables to scrub the constraint if it ever bites.
 */
export const m032RemoveIdentityArm: Migration = {
  version: 32,
  name: "remove-identity-arm",
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS confusable_item_pairs;
      DELETE FROM actor_skills WHERE axis = 'id';
      DELETE FROM actor_skill_defaults WHERE axis = 'id';
      DELETE FROM actor_beliefs WHERE axis = 'id';
    `);
  },
};

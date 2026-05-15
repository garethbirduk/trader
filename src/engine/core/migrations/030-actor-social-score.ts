import type { Migration } from "../migrations.js";

/**
 * Character arm (docs/judgement.md) — per-actor social score.
 *
 * The fourth perception arm reads another actor's character. v1 lands
 * the read as a public scalar attribute (`social_score`) on each
 * actor. At pub-deal entry, the (buyer_social − seller_social) delta
 * modifies the buyer's effective flaw-detection: a high-social buyer
 * spots tells a low-social seller can't conceal, and vice versa. The
 * `characterArmAlpha` knob in economics config controls how much
 * weight the delta carries.
 *
 * v1 simplification: social_score is a deterministic, public attribute
 * — everyone sees the same number. A future iteration could layer the
 * judgement engine's expertise + j machinery over the read, so e.g.
 * Trigger (low character-expertise) mis-reads who's actually shifty.
 *
 * Default 0.5 (neutral) — actors not seeded by the skin sit at the
 * midpoint and contribute zero delta in either direction.
 */
export const m030ActorSocialScore: Migration = {
  version: 30,
  name: "actor-social-score",
  up(db) {
    db.exec(`
      ALTER TABLE actors
        ADD COLUMN social_score REAL NOT NULL DEFAULT 0.5
          CHECK (social_score BETWEEN 0 AND 1);
    `);
  },
};

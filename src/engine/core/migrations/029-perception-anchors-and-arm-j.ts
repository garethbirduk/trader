import type { Migration } from "../migrations.js";

/**
 * Judgement engine v1 — persistence shape (docs/judgement.md).
 *
 * Two tables, both lookup-only:
 *
 *   1. `category_anchors` — per-category "uninformed prior". The
 *      `lerp(genericAnchor, truth, expertise)` floor used by every
 *      numeric `estimate()` call. A zero-expertise actor's belief
 *      centres on this number, not on the truth; that's what
 *      "confidently wrong" looks like in the four-case model. One
 *      row per item category; seeded by the skin.
 *
 *   2. `actor_arm_j` — per-actor per-arm j scalar (decisiveness /
 *      band-narrowness). Distinct from the existing per-axis
 *      expertise scores in `actor_skills` — `j` controls the
 *      *spread* and *sampling shape*, the expertise controls the
 *      *centre*. Missing rows fall back to the actor's expertise
 *      for that arm (see perception/expertise.ts), preserving the
 *      doc's "skin defaults set them equal per category for most
 *      actors" behaviour.
 *
 * Both tables are nullable / sparse — call sites tolerate the
 * fallback, so partial seeding during migration is safe.
 */
export const m029PerceptionAnchorsAndArmJ: Migration = {
  version: 29,
  name: "perception-anchors-and-arm-j",
  up(db) {
    db.exec(`
      CREATE TABLE category_anchors (
        category      TEXT    NOT NULL PRIMARY KEY,
        anchor_value  INTEGER NOT NULL CHECK (anchor_value >= 0)
      );

      -- v1 arms: identity, condition, price, character. The DB-level
      -- CHECK pins the spelling for the migrations that exist today;
      -- if a future skin adds a new arm we'll widen the constraint
      -- via a rebuild migration in the same shape as 024.
      CREATE TABLE actor_arm_j (
        actor_id  INTEGER NOT NULL REFERENCES actors(id),
        arm       TEXT    NOT NULL
                  CHECK (arm IN ('identity','condition','price','character')),
        j         REAL    NOT NULL CHECK (j BETWEEN 0 AND 1),
        PRIMARY KEY (actor_id, arm)
      );
      CREATE INDEX idx_actor_arm_j_actor ON actor_arm_j(actor_id);
    `);
  },
};

import type { DB } from "../core/db.js";
import { PERCEPTION_ARMS, type Arm, isPerceptionArm } from "./types.js";

/**
 * Per-actor per-arm `j` scalar — the "decisiveness" knob (band
 * narrowness + sampling kernel sharpness). Distinct from the
 * existing per-axis expertise scores in `actor_skills`; expertise
 * drives the *centre*, j drives the *spread*.
 *
 * Missing rows are explicitly tolerated: callers (see
 * `perception/expertise.ts`) fall back to the actor's expertise for
 * that arm. The doc's default — "skin defaults set them equal per
 * category for most actors" — is realised by NOT writing a row
 * unless the author wants j to diverge from expertise.
 */

interface ArmJRow {
  actor_id: number;
  arm: string;
  j: number;
}

export function setActorArmJ(
  db: DB,
  args: { actorId: number; arm: Arm; j: number },
): void {
  if (args.j < 0 || args.j > 1 || !Number.isFinite(args.j)) {
    throw new Error(
      `j must be a finite scalar in [0, 1]; got ${args.j} for ` +
        `actor=${args.actorId} arm=${args.arm}`,
    );
  }
  db.prepare(
    `INSERT INTO actor_arm_j (actor_id, arm, j)
     VALUES (@actor, @arm, @j)
     ON CONFLICT (actor_id, arm) DO UPDATE SET j = excluded.j`,
  ).run({ actor: args.actorId, arm: args.arm, j: args.j });
}

/** Returns the stored j for this (actor, arm), or null if absent. */
export function getActorArmJ(
  db: DB,
  actorId: number,
  arm: Arm,
): number | null {
  const row = db
    .prepare<ArmJRow>(
      `SELECT * FROM actor_arm_j WHERE actor_id = @actor AND arm = @arm`,
    )
    .get({ actor: actorId, arm });
  return row?.j ?? null;
}

/** Returns the full per-arm j map for one actor. Missing arms absent. */
export function getActorAllArmJ(db: DB, actorId: number): ReadonlyMap<Arm, number> {
  const out = new Map<Arm, number>();
  for (const row of db
    .prepare<ArmJRow>(`SELECT * FROM actor_arm_j WHERE actor_id = @actor`)
    .all({ actor: actorId })) {
    if (isPerceptionArm(row.arm)) out.set(row.arm, row.j);
  }
  return out;
}

/**
 * Seed per-arm j values for a set of actors. Idempotent — re-running
 * with the same map overwrites the same rows. Skipping an arm leaves
 * the existing row in place (or absent — the j-resolution layer falls
 * back to expertise).
 */
export function seedActorArmJ(
  db: DB,
  actorJByArm: ReadonlyMap<number, ReadonlyMap<Arm, number>>,
): void {
  db.transaction(() => {
    for (const [actorId, perArm] of actorJByArm) {
      for (const [arm, j] of perArm) {
        setActorArmJ(db, { actorId, arm, j });
      }
    }
  });
}

// Re-export for callers that want the canonical arm list.
export { PERCEPTION_ARMS };

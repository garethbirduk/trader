import type { DB } from "../core/db.js";

/**
 * Per-pair trust score. Defaults to 0 (neutral) when no row exists. Scores
 * are integers; the engine doesn't fix bounds, but skins typically clamp
 * to e.g. [-100, 100].
 *
 * Trust changes are driven by event reactions, not by direct policy
 * decisions: see src/engine/world/trust-reactions.ts for the wiring.
 */
export interface TrustPair {
  readonly holderActorId: number;
  readonly targetActorId: number;
  readonly score: number;
  readonly lastEventDay: number | null;
}

interface TrustRow {
  holder_actor_id: number;
  target_actor_id: number;
  score: number;
  last_event_day: number | null;
}

function rowToPair(r: TrustRow): TrustPair {
  return {
    holderActorId: r.holder_actor_id,
    targetActorId: r.target_actor_id,
    score: r.score,
    lastEventDay: r.last_event_day,
  };
}

export function getTrust(
  db: DB,
  holderActorId: number,
  targetActorId: number,
): TrustPair {
  if (holderActorId === targetActorId) {
    throw new Error("trust is between distinct actors");
  }
  const row = db
    .prepare<TrustRow>(
      `SELECT * FROM actor_trust
       WHERE holder_actor_id = @holder AND target_actor_id = @target`,
    )
    .get({ holder: holderActorId, target: targetActorId });
  if (row) return rowToPair(row);
  return {
    holderActorId,
    targetActorId,
    score: 0,
    lastEventDay: null,
  };
}

export function adjustTrust(
  db: DB,
  holderActorId: number,
  targetActorId: number,
  delta: number,
  onDay: number,
): TrustPair {
  if (holderActorId === targetActorId) {
    throw new Error("trust is between distinct actors");
  }
  return db.transaction((): TrustPair => {
    db.prepare(
      `INSERT INTO actor_trust (holder_actor_id, target_actor_id, score, last_event_day)
       VALUES (@holder, @target, @delta, @day)
       ON CONFLICT (holder_actor_id, target_actor_id)
       DO UPDATE SET
         score = score + @delta,
         last_event_day = @day`,
    ).run({
      holder: holderActorId,
      target: targetActorId,
      delta,
      day: onDay,
    });
    return getTrust(db, holderActorId, targetActorId);
  });
}

export function listTrustHeldBy(db: DB, holderActorId: number): TrustPair[] {
  return db
    .prepare<TrustRow>(
      `SELECT * FROM actor_trust
       WHERE holder_actor_id = @holder
       ORDER BY target_actor_id ASC`,
    )
    .all({ holder: holderActorId })
    .map(rowToPair);
}

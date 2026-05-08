import type { DB } from "../core/db.js";

export interface HeatRecord {
  readonly actorId: number;
  readonly score: number;
  readonly lastEventDay: number | null;
}

interface HeatRow {
  actor_id: number;
  score: number;
  last_event_day: number | null;
}

function rowToHeat(r: HeatRow): HeatRecord {
  return {
    actorId: r.actor_id,
    score: r.score,
    lastEventDay: r.last_event_day,
  };
}

/** Returns 0-heat record for actors who've never registered any. */
export function getHeat(db: DB, actorId: number): HeatRecord {
  const row = db
    .prepare<HeatRow>(`SELECT * FROM actor_heat WHERE actor_id = @id`)
    .get({ id: actorId });
  if (row) return rowToHeat(row);
  return { actorId, score: 0, lastEventDay: null };
}

/**
 * Raise an actor's heat by `delta`. Negative deltas reduce heat (used
 * by raids and decay). Heat is clamped to >= 0 — no negative scores.
 */
export function raiseHeat(
  db: DB,
  actorId: number,
  delta: number,
  onDay: number,
): HeatRecord {
  return db.transaction((): HeatRecord => {
    db.prepare(
      `INSERT INTO actor_heat (actor_id, score, last_event_day)
       VALUES (@id, MAX(0, @delta), @day)
       ON CONFLICT (actor_id)
       DO UPDATE SET
         score = MAX(0, score + @delta),
         last_event_day = @day`,
    ).run({ id: actorId, delta, day: onDay });
    return getHeat(db, actorId);
  });
}

/** Mass-decay: subtract `perDay` from every actor's score (clamped at 0). */
export function decayAllHeat(db: DB, perDay: number): number {
  if (perDay <= 0) return 0;
  return db
    .prepare(
      `UPDATE actor_heat SET score = MAX(0, score - @per) WHERE score > 0`,
    )
    .run({ per: perDay }).changes;
}

export function listActorsAboveHeat(
  db: DB,
  minScore: number,
): HeatRecord[] {
  return db
    .prepare<HeatRow>(
      `SELECT * FROM actor_heat
       WHERE score >= @min
       ORDER BY score DESC, actor_id ASC`,
    )
    .all({ min: minScore })
    .map(rowToHeat);
}

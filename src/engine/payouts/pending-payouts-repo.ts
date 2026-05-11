import type { DB } from "../core/db.js";

export interface PendingPayout {
  readonly id: number;
  readonly actorId: number;
  readonly amount: number;
  readonly availableDay: number;
  readonly source: string;
  readonly createdDay: number;
}

interface PendingPayoutRow {
  id: number;
  actor_id: number;
  amount: number;
  available_day: number;
  source: string;
  created_day: number;
}

function rowToPayout(r: PendingPayoutRow): PendingPayout {
  return {
    id: r.id,
    actorId: r.actor_id,
    amount: r.amount,
    availableDay: r.available_day,
    source: r.source,
    createdDay: r.created_day,
  };
}

export interface InsertPendingPayoutInput {
  readonly actorId: number;
  readonly amount: number;
  readonly availableDay: number;
  readonly source: string;
  readonly createdDay: number;
}

export function insertPendingPayout(
  db: DB,
  input: InsertPendingPayoutInput,
): PendingPayout {
  const result = db
    .prepare(
      `INSERT INTO pending_payouts
        (actor_id, amount, available_day, source, created_day)
       VALUES
        (@actor, @amount, @available, @source, @created)`,
    )
    .run({
      actor: input.actorId,
      amount: input.amount,
      available: input.availableDay,
      source: input.source,
      created: input.createdDay,
    });
  return {
    id: result.lastInsertRowid,
    actorId: input.actorId,
    amount: input.amount,
    availableDay: input.availableDay,
    source: input.source,
    createdDay: input.createdDay,
  };
}

/** Payouts whose available_day has arrived but which haven't been
 *  paid out yet. Drained by the day-start handler. */
export function listDuePayouts(db: DB, today: number): PendingPayout[] {
  return db
    .prepare<PendingPayoutRow>(
      `SELECT * FROM pending_payouts
       WHERE available_day <= @today
       ORDER BY id ASC`,
    )
    .all({ today })
    .map(rowToPayout);
}

/** All unpaid pending payouts for an actor. Used by the viewer to show
 *  "cash in transit" totals on whale profiles. */
export function listPendingPayoutsForActor(
  db: DB,
  actorId: number,
): PendingPayout[] {
  return db
    .prepare<PendingPayoutRow>(
      `SELECT * FROM pending_payouts
       WHERE actor_id = @actor
       ORDER BY available_day ASC`,
    )
    .all({ actor: actorId })
    .map(rowToPayout);
}

export function deletePendingPayout(db: DB, id: number): void {
  db.prepare(`DELETE FROM pending_payouts WHERE id = @id`).run({ id });
}

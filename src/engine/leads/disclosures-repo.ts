import type { DB } from "../core/db.js";

/**
 * Unlock audit log for two-tier gossip (Model B).
 *
 * Visibility itself lives on `leads.detail_unlocked` — a per-lead lock
 * flag flipped 0→1 when the holder pays to unlock. This table records
 * the *history* of those unlocks: who paid, when, at which partner's
 * table, and how much it cost. The detail is shown via the lead's
 * flag; this table answers the diary-side question "how did I come to
 * know this?".
 *
 * Holders see their own first-hand leads at detail tier from creation
 * (no row here). Gossip-received leads start locked (detail_unlocked=0
 * on the lead) and a successful unlock writes a row here + flips the
 * flag.
 */

export interface LeadDisclosure {
  readonly leadId: number;
  readonly actorId: number;
  readonly revealedAtDay: number;
  readonly revealedByActorId: number | null;
  readonly costPaid: number;
}

interface DisclosureRow {
  lead_id: number;
  actor_id: number;
  revealed_at_day: number;
  revealed_by_actor_id: number | null;
  cost_paid: number;
}

function rowToDisclosure(r: DisclosureRow): LeadDisclosure {
  return {
    leadId: r.lead_id,
    actorId: r.actor_id,
    revealedAtDay: r.revealed_at_day,
    revealedByActorId: r.revealed_by_actor_id,
    costPaid: r.cost_paid,
  };
}

/**
 * Record an unlock event. Idempotent on (leadId, actorId) — re-paying
 * to unlock the same lead is a no-op.
 */
export function recordLeadDisclosure(
  db: DB,
  args: {
    leadId: number;
    actorId: number;
    revealedAtDay: number;
    revealedByActorId?: number | null;
    costPaid?: number;
  },
): LeadDisclosure {
  db.prepare(
    `INSERT INTO lead_disclosures
       (lead_id, actor_id, revealed_at_day, revealed_by_actor_id, cost_paid)
     VALUES (@lead, @actor, @day, @by, @cost)
     ON CONFLICT (lead_id, actor_id) DO NOTHING`,
  ).run({
    lead: args.leadId,
    actor: args.actorId,
    day: args.revealedAtDay,
    by: args.revealedByActorId ?? null,
    cost: args.costPaid ?? 0,
  });
  const row = db
    .prepare<DisclosureRow>(
      `SELECT * FROM lead_disclosures
         WHERE lead_id = @lead AND actor_id = @actor`,
    )
    .get({ lead: args.leadId, actor: args.actorId });
  if (!row) throw new Error("failed to fetch lead_disclosure");
  return rowToDisclosure(row);
}

/** All unlock events for an actor, oldest first. */
export function getDisclosuresForActor(
  db: DB,
  actorId: number,
): LeadDisclosure[] {
  return db
    .prepare<DisclosureRow>(
      `SELECT * FROM lead_disclosures WHERE actor_id = @actor
         ORDER BY revealed_at_day ASC, lead_id ASC`,
    )
    .all({ actor: actorId })
    .map(rowToDisclosure);
}

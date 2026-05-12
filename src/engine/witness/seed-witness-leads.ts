import type { DB } from "../core/db.js";
import { getActorsAtLocation } from "../locations/locations.js";
import { getLeadById } from "../leads/leads-repo.js";
import type { Lead } from "../leads/types.js";

/**
 * #6 — Witnessed events become gossip-able leads.
 *
 * When a notable event fires at a venue, every present non-principal
 * gets a fresh rep-kind lead recording what they saw. Witnesses are
 * derived from `getActorsAtLocation(venue)` minus the principals.
 *
 * The lead piggybacks on the existing `rep` schema with the
 * subject_event_type / subject_context_json columns added in
 * migration 025 carrying the narrative payload:
 *
 *   subject_target_actor_id  → the active principal (the doer)
 *   counterparty_actor_id    → the passive principal (the recipient,
 *                              if any — e.g. Slater on a bribe)
 *   subject_event_type       → e.g. "bribe", "phone-call", "raid"
 *   subject_context_json     → free-form JSON for the specifics
 *   estimated_unit_price     → repurposed as £ damage / amount where
 *                              meaningful (bribe amount, etc.)
 *
 * Caller is responsible for deciding *which* events are notable. This
 * primitive just plants the leads.
 */

export interface WitnessEventArgs {
  /** The venue where the event happened. */
  readonly locationId: number;
  /** The actor primarily responsible for the act (Del in a Del→Slater bribe). */
  readonly principalActorId: number;
  /** The passive principal, if any (Slater on a bribe). Excluded from
   *  the witness set alongside the principal. */
  readonly counterpartyActorId?: number | null;
  /** Stable tag for what just happened — "bribe", "phone-call", etc. */
  readonly eventType: string;
  /** Free-form payload — narrative specifics (amount, item kind,
   *  scheduled time on a clearance call, ...). Stored as JSON. */
  readonly context?: Record<string, unknown>;
  /** Monetary amount tied to the event, used to scale the lead's
   *  `estimated_unit_price` (which doubles as "severity" on rep
   *  leads). 0 when there's no money in play. */
  readonly amount?: number;
  /** Today. The lead's acquired_day. */
  readonly atDay: number;
  /** Cap on the number of witness leads spawned. Default 32 (an
   *  entire pub catching the same event would noise-up gossip). */
  readonly maxWitnesses?: number;
}

export interface SeedWitnessLeadsResult {
  readonly witnessActorIds: readonly number[];
  readonly leadIds: readonly number[];
}

export function seedWitnessLeads(
  db: DB,
  args: WitnessEventArgs,
): SeedWitnessLeadsResult {
  const presentIds = getActorsAtLocation(db, args.locationId);
  const principals = new Set<number>([args.principalActorId]);
  if (args.counterpartyActorId != null) {
    principals.add(args.counterpartyActorId);
  }
  const witnesses = presentIds.filter((id) => !principals.has(id));
  const cap = args.maxWitnesses ?? 32;
  const trimmed = witnesses.slice(0, cap);

  const contextJson =
    args.context !== undefined ? JSON.stringify(args.context) : null;

  const leadIds: number[] = [];
  for (const witnessId of trimmed) {
    const lead = insertWitnessLeadRow(db, {
      holderActorId: witnessId,
      principalActorId: args.principalActorId,
      counterpartyActorId: args.counterpartyActorId ?? null,
      eventType: args.eventType,
      contextJson,
      amount: args.amount ?? 0,
      atDay: args.atDay,
    });
    leadIds.push(lead.id);
  }

  return { witnessActorIds: trimmed, leadIds };
}

/**
 * Direct insert helper that bypasses `insertLead`'s shape constraints
 * (which don't currently take the new event-context columns). The
 * lead is `kind='rep'`, side='supply' (rep leads use supply
 * conventionally), with the event payload columns set.
 */
function insertWitnessLeadRow(
  db: DB,
  args: {
    holderActorId: number;
    principalActorId: number;
    counterpartyActorId: number | null;
    eventType: string;
    contextJson: string | null;
    amount: number;
    atDay: number;
  },
): Lead {
  const result = db
    .prepare(
      `INSERT INTO leads
         (holder_actor_id, kind, side,
          subject_item_kind_id, subject_quality_tier,
          subject_target_actor_id, counterparty_actor_id,
          estimated_qty, estimated_unit_price, confidence,
          source_actor_id, acquired_day, hop_count, derived_from_lead_id,
          subject_pool_id, subject_event_type, subject_context_json)
       VALUES
         (@holder, 'rep', 'supply',
          NULL, NULL,
          @principal, @counterparty,
          1, @amount, 'warm',
          NULL, @day, 0, NULL,
          NULL, @event, @ctx)`,
    )
    .run({
      holder: args.holderActorId,
      principal: args.principalActorId,
      counterparty: args.counterpartyActorId,
      amount: args.amount,
      day: args.atDay,
      event: args.eventType,
      ctx: args.contextJson,
    });
  const fetched = getLeadById(db, result.lastInsertRowid);
  if (!fetched) throw new Error("failed to fetch newly inserted witness lead");
  return fetched;
}

import type { DB } from "../core/db.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import { getLeadById } from "./leads-repo.js";
import type { Lead } from "./types.js";

/**
 * #7 — Two-tier gossip: headlines vs details.
 *
 * Every lead has an implicit two-tier shape:
 *   • Headline — the lead's subject only (actor + item-kind, or
 *     actor + event-type). Free to share through gossip; what the
 *     world's chatter exposes.
 *   • Detail   — qty, price, source chain, hop count, confidence,
 *     witnessed-event payload. Costs the asker £fee + an hour with
 *     the holder to unlock.
 *
 * The holder always sees their own leads in full; the disclosure
 * table records which OTHER actors have been let in on the detail
 * tier. Default state for everyone-not-on-the-list is "headline
 * only" — the redaction happens at read-time via
 * `redactLeadForViewer`.
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
 * Record that `actorId` has had the detail tier of `leadId`
 * disclosed to them. Idempotent on the (leadId, actorId) pair.
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

export function isLeadDisclosedTo(
  db: DB,
  leadId: number,
  actorId: number,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM lead_disclosures
         WHERE lead_id = @lead AND actor_id = @actor`,
    )
    .get({ lead: leadId, actor: actorId });
  return (row?.n ?? 0) > 0;
}

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

/**
 * Headline-only view of a lead — strips everything actionable down
 * to "what kind of thing is this?" The viewer sees who/what but
 * doesn't see the numerics, source chain, hop count, confidence,
 * or witnessed-event context payload.
 *
 * Convention: headline keeps subject identity and the lead's
 * `kind` flag so the UI can render "Boyce has radios" or
 * "Del did something at the market" without leaking actionable
 * detail.
 */
export interface LeadHeadline {
  readonly leadId: number;
  readonly holderActorId: number;
  readonly kind: "commodity" | "rep";
  readonly side: "supply" | "demand";
  readonly subjectItemKindId: number | null;
  readonly subjectTargetActorId: number | null;
  readonly subjectEventType: string | null;
}

function leadToHeadline(lead: Lead): LeadHeadline {
  return {
    leadId: lead.id,
    holderActorId: lead.holderActorId,
    kind: lead.kind,
    side: lead.side,
    subjectItemKindId: lead.subjectItemKindId,
    subjectTargetActorId: lead.subjectTargetActorId,
    subjectEventType: lead.subjectEventType,
  };
}

/**
 * The view-time redaction function. Returns either the full `Lead`
 * (when the viewer is the holder or has been disclosed to) or a
 * stripped `LeadHeadline`.
 *
 * Pass `viewerId === lead.holderActorId` to always get the full lead
 * — holders always see their own.
 */
export function redactLeadForViewer(
  db: DB,
  lead: Lead,
  viewerId: number,
):
  | { tier: "detail"; lead: Lead }
  | { tier: "headline"; headline: LeadHeadline } {
  if (viewerId === lead.holderActorId) {
    return { tier: "detail", lead };
  }
  if (isLeadDisclosedTo(db, lead.id, viewerId)) {
    return { tier: "detail", lead };
  }
  return { tier: "headline", headline: leadToHeadline(lead) };
}

/**
 * Paid clarification primitive. The asker pays the holder a fee
 * (typically £3) and an hour of in-world time (caller is responsible
 * for advancing the clock / scheduling the actors as appropriate).
 * On success, a disclosure row is recorded and the cash transfers.
 *
 * Pre-conditions enforced:
 *   • asker has enough cash for the fee;
 *   • asker and holder are different actors;
 *   • the lead exists.
 *
 * If the disclosure already exists (asker paid before), the call is
 * a no-op success — no second fee charged.
 */
export interface PayForLeadDetailsArgs {
  readonly askerActorId: number;
  readonly holderActorId: number;
  readonly leadId: number;
  readonly fee: number;
  readonly atDay: number;
}

export type PayForLeadDetailsResult =
  | {
      readonly type: "disclosed";
      readonly disclosure: LeadDisclosure;
      readonly alreadyKnew: boolean;
    }
  | { readonly type: "blocked"; readonly reason: string };

export function payForLeadDetails(
  db: DB,
  args: PayForLeadDetailsArgs,
): PayForLeadDetailsResult {
  if (args.askerActorId === args.holderActorId) {
    return { type: "blocked", reason: "asker and holder are the same actor" };
  }
  if (args.fee < 0) {
    return { type: "blocked", reason: `fee must be >= 0; got ${args.fee}` };
  }
  return db.transaction((): PayForLeadDetailsResult => {
    const lead = getLeadById(db, args.leadId);
    if (!lead) return { type: "blocked", reason: `lead ${args.leadId} not found` };
    if (lead.holderActorId !== args.holderActorId) {
      return {
        type: "blocked",
        reason: `lead ${args.leadId} not held by actor ${args.holderActorId}`,
      };
    }
    if (isLeadDisclosedTo(db, args.leadId, args.askerActorId)) {
      // Already disclosed — fee waived. Return the existing row.
      const existing = db
        .prepare<DisclosureRow>(
          `SELECT * FROM lead_disclosures
             WHERE lead_id = @lead AND actor_id = @actor`,
        )
        .get({ lead: args.leadId, actor: args.askerActorId });
      if (!existing) {
        throw new Error("disclosure should exist but didn't");
      }
      return {
        type: "disclosed",
        disclosure: rowToDisclosure(existing),
        alreadyKnew: true,
      };
    }
    const asker = getActorById(db, args.askerActorId);
    if (!asker) return { type: "blocked", reason: "asker not found" };
    if (asker.cash < args.fee) {
      return {
        type: "blocked",
        reason: `asker cash £${asker.cash} < fee £${args.fee}`,
      };
    }
    if (args.fee > 0) {
      adjustActorCash(db, args.askerActorId, -args.fee);
      adjustActorCash(db, args.holderActorId, args.fee);
    }
    const disclosure = recordLeadDisclosure(db, {
      leadId: args.leadId,
      actorId: args.askerActorId,
      revealedAtDay: args.atDay,
      revealedByActorId: args.holderActorId,
      costPaid: args.fee,
    });
    return { type: "disclosed", disclosure, alreadyKnew: false };
  });
}

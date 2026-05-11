import type { World, Unsubscribe } from "../core/world.js";
import { getDealById, getDealLinesByDealId } from "../deals/deals-repo.js";
import { insertLead, getRepLeadAbout } from "../leads/leads-repo.js";

/**
 * Reputation reactions — Stage 5.
 *
 * When a deal defaults, the burned party walks away with a fresh rep
 * lead about the defaulter. That lead carries:
 *
 *   • `subjectTargetActorId` = the actor who defaulted (the seller, in
 *     practice — they failed to deliver).
 *   • `counterpartyActorId`  = the actor who got burned (the buyer).
 *   • `estimatedQuantity`    = severity: 1 if this is the buyer's
 *     first registered grievance about this seller, else += 1 onto
 *     the existing lead's severity (we update in place).
 *   • `estimatedUnitPrice`   = total £ damage from this default.
 *
 * Side is fixed at 'supply' — this is a "negative rep" warning. The
 * design notes a future positive-rep ("vouch") channel that could use
 * 'demand', but Stage 5 only models warnings.
 *
 * Once spawned, the rep lead enters the same gossip channels as
 * commodity leads: it propagates, mutates, decays. The cascade comedy
 * — "I heard Trigger burned Boyce" two hops down from "Boyce burned
 * Trigger" — is the role-reversal mutation kicking in.
 */
export function registerReputationReactions(world: World): Unsubscribe {
  return world.events.subscribe((e) => {
    if (e.type !== "deal.defaulted") return;

    const burned = e.buyerActorId; // they paid (or expected delivery) and got nothing
    const defaulter = e.sellerActorId;

    // Damage figure — sum of every line's qty × unitPrice on the deal.
    // We pull it via the deal repo rather than via the event because the
    // event doesn't embed the totals.
    const deal = getDealById(world.db, e.dealId);
    if (!deal) return;
    const lines = getDealLinesByDealId(world.db, e.dealId);
    const damage = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    const damageOnLead = Math.max(1, damage);

    // De-duplicate: if the burned party already holds a rep lead about
    // this defaulter (first-hand or via gossip), we don't spawn a parallel
    // one. The trust system tracks the per-pair score numerically already
    // — rep leads are the gossipable counterpart, and one is enough.
    const existing = getRepLeadAbout(world.db, burned, defaulter);
    if (existing !== null) return;

    const lead = insertLead(world.db, {
      holderActorId: burned,
      kind: "rep",
      side: "supply",
      subjectItemKindId: null,
      subjectTargetActorId: defaulter,
      counterpartyActorId: burned,
      estimatedQuantity: 1,
      estimatedUnitPrice: damageOnLead,
      acquiredDay: e.at.day,
      confidence: "warm",
      sourceActorId: null, // first-hand grievance, not heard from anyone
    });

    world.events.emit({
      type: "rep.spawned",
      at: e.at,
      leadId: lead.id,
      holderActorId: burned,
      subjectTargetActorId: defaulter,
      counterpartyActorId: burned,
      dealId: e.dealId,
      damage: damageOnLead,
    });
  });
}

import type { World, Unsubscribe } from "../core/world.js";
import type { EconomicsConfig } from "../economics/config.js";
import { getDealById, getDealLinesByDealId } from "../deals/deals-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { insertLead, getRepLeadAbout } from "../leads/leads-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";

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
 *   • `estimatedUnitPrice`   = perceived £ damage from this default —
 *     the burned actor's belief about the value of what they were
 *     owed, sampled per-line through the judgement engine's price band
 *     (docs/judgement.md). Replaces the prior ledger-truth formula
 *     (deal line `qty × unitPrice`). A clueless buyer who overpaid
 *     reports a smaller surprise gap; a sharp buyer who negotiated a
 *     steal reports a larger one. Gossip onward carries the burned
 *     party's perception, not the objective loss.
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
export function registerReputationReactions(
  world: World,
  opts: { readonly economics: EconomicsConfig },
): Unsubscribe {
  return world.events.subscribe((e) => {
    if (e.type !== "deal.defaulted") return;

    const burned = e.buyerActorId; // they paid (or expected delivery) and got nothing
    const defaulter = e.sellerActorId;

    const deal = getDealById(world.db, e.dealId);
    if (!deal) return;
    const lines = getDealLinesByDealId(world.db, e.dealId);

    // Perceived damage — sum the burned actor's price-band centre for
    // each line's (category, tier-adjusted truth). If the item kind
    // can't be resolved (skin oddity), fall back to the line's deal
    // price for that line so we never silently zero out the severity.
    let perceived = 0;
    for (const line of lines) {
      const item = getItemKindById(world.db, line.itemKindId);
      if (item === null) {
        perceived += line.quantity * line.unitPrice;
        continue;
      }
      const truth = item.baseValue * opts.economics.tierMultipliers[line.qualityTier];
      const band = estimatePriceBand({
        db: world.db,
        actorId: burned,
        category: item.category,
        truth,
      });
      perceived += line.quantity * Math.max(0, band.centre);
    }
    const damageOnLead = Math.max(1, Math.round(perceived));

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

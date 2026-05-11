import type { World, Unsubscribe } from "../core/world.js";
import type { GossipExchange } from "../core/events.js";
import type { Lead } from "../leads/types.js";
import { getLocationProprietor } from "../locations/locations.js";
import { getLeadsByHolder, shareLead } from "../leads/leads-repo.js";

function toExchange(lead: Lead, fromActorId: number, toActorId: number): GossipExchange {
  return {
    fromActorId,
    toActorId,
    lead: {
      side: lead.side,
      subjectItemKindId: lead.subjectItemKindId,
      subjectQualityTier: lead.subjectQualityTier,
      counterpartyActorId: lead.counterpartyActorId,
      estimatedQuantity: lead.estimatedQuantity,
      estimatedUnitPrice: lead.estimatedUnitPrice,
      confidence: lead.confidence,
      hopCount: lead.hopCount,
      sourceActorId: lead.sourceActorId,
    },
  };
}

/**
 * True if `listener` already holds a lead identical to `speaker` on every
 * value-bearing field (subject + qty + price). Different values count as
 * a *refinement* — a £7 correction to a previously-known £8 fact is news
 * and should still be transmitted, surfacing as a conflict in the
 * receiver's bag. Confidence/hopCount/source aren't compared because the
 * same fact retold always cools to cold with a higher hop, but that's
 * not a change in the underlying claim.
 */
function isLeadKnownTo(speaker: Lead, listenerLeads: readonly Lead[]): boolean {
  for (const l of listenerLeads) {
    if (
      l.side === speaker.side &&
      l.subjectItemKindId === speaker.subjectItemKindId &&
      l.subjectQualityTier === speaker.subjectQualityTier &&
      l.counterpartyActorId === speaker.counterpartyActorId &&
      l.estimatedQuantity === speaker.estimatedQuantity &&
      l.estimatedUnitPrice === speaker.estimatedUnitPrice
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Listens for `actor.travelled` events. Whenever an actor arrives at a
 * location with a `proprietor_actor_id`, the engine fires off a
 * one-each-way lead exchange:
 *
 *   • the visitor passes one of their leads to the proprietor (gossip up)
 *   • the proprietor passes one of theirs back (gossip down)
 *
 * Each leg only transmits a lead the *receiver doesn't already know* —
 * identical retransmission of a fact the recipient already holds is
 * silent (people don't repeat themselves). If there's no novel material
 * either way, no event fires. A lead with the same subject but different
 * numeric values still goes through, because it's a correction.
 *
 * The proprietor sees every visitor and contributes one piece per visit;
 * the visitor sees the proprietor only when they themselves stop in. So
 * over time the proprietor accumulates the local information graph,
 * positioning them as the obvious future "pay for premium intel" NPC.
 *
 * Crucially, leads carry their `subject_pool_id` through every gossip
 * hop. Multiple visitors describing what looks like distinct supply may
 * unknowingly all be repeating the same upstream pool — and once any of
 * them tries to forward-sell on the aggregate, the cascade fires.
 */
export function registerLocationGossip(world: World): Unsubscribe {
  return world.events.subscribe((e) => {
    if (e.type !== "actor.travelled") return;
    const proprietorId = getLocationProprietor(world.db, e.toLocationId);
    if (proprietorId === null) return;
    if (proprietorId === e.actorId) return;

    const exchanges: GossipExchange[] = [];

    const visitorLeads = getLeadsByHolder(world.db, e.actorId);
    const proprietorLeads = getLeadsByHolder(world.db, proprietorId);

    // Visitor → proprietor: only share something the proprietor doesn't
    // already hold verbatim.
    const novelToProprietor = visitorLeads.filter(
      (l) => !isLeadKnownTo(l, proprietorLeads),
    );
    if (novelToProprietor.length > 0) {
      const lead = world.rng.pick(novelToProprietor);
      try {
        shareLead(world.db, e.actorId, proprietorId, lead.id, e.at.day);
        exchanges.push(toExchange(lead, e.actorId, proprietorId));
      } catch {
        // Self-share or holder mismatch — skip silently.
      }
    }

    // Proprietor → visitor — same novelty filter in reverse.
    const novelToVisitor = proprietorLeads.filter(
      (l) => !isLeadKnownTo(l, visitorLeads),
    );
    if (novelToVisitor.length > 0) {
      const lead = world.rng.pick(novelToVisitor);
      try {
        shareLead(world.db, proprietorId, e.actorId, lead.id, e.at.day);
        exchanges.push(toExchange(lead, proprietorId, e.actorId));
      } catch {
        // Skip silently.
      }
    }

    if (exchanges.length > 0) {
      world.events.emit({
        type: "gossip.exchanged",
        at: e.at,
        atLocationId: e.toLocationId,
        visitorActorId: e.actorId,
        proprietorActorId: proprietorId,
        exchanges,
      });
    }
  });
}

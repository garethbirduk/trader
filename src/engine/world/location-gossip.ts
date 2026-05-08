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
 * Listens for `actor.travelled` events. Whenever an actor arrives at a
 * location with a `proprietor_actor_id`, the engine fires off a one-each-way
 * lead exchange:
 *
 *   • the visitor passes one of their leads to the proprietor (gossip up)
 *   • the proprietor passes one of theirs back (gossip down)
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
    if (visitorLeads.length > 0) {
      const lead = world.rng.pick(visitorLeads);
      try {
        shareLead(world.db, e.actorId, proprietorId, lead.id, e.at.day);
        exchanges.push(toExchange(lead, e.actorId, proprietorId));
      } catch {
        // Self-share or holder mismatch — skip silently.
      }
    }

    const proprietorLeads = getLeadsByHolder(world.db, proprietorId);
    if (proprietorLeads.length > 0) {
      const lead = world.rng.pick(proprietorLeads);
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

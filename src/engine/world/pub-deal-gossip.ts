import type { World, Unsubscribe } from "../core/world.js";
import type { GossipExchange } from "../core/events.js";
import { getLeadsByHolder, shareLead } from "../leads/leads-repo.js";
import { selectNovelLeads, toExchange } from "../leads/gossip-utils.js";

export interface PubDealGossipOptions {
  /** Leads exchanged each direction per agreed/walked pub-deal. Default 1
   *  — one rumour per round of negotiation, regardless of outcome. */
  readonly leadsPerSide?: number;
}

/**
 * Deal-adjacent gossip. Negotiating with someone — whether you close or
 * walk — surfaces information about what they're sitting on, what they
 * just paid, what they're scouting for. The two parties exchange a
 * piece of news each way at the end of every pubdeal lifecycle event,
 * tagged as `kind: "deal"` on the gossip stream so the diary can
 * distinguish "we passed words at the bar" from "we tried to deal."
 *
 * Fires for both `pubdeal.agreed` and `pubdeal.walked`. The novelty
 * filter is the same shared `selectNovelLeads` used elsewhere — a fact
 * the listener already holds verbatim is silent, but a different
 * quantity or price still goes through as a correction.
 */
export function registerPubDealGossip(
  world: World,
  opts: PubDealGossipOptions = {},
): Unsubscribe {
  const leadsPerSide = opts.leadsPerSide ?? 1;

  return world.events.subscribe((e) => {
    if (e.type !== "pubdeal.agreed" && e.type !== "pubdeal.walked") return;

    const seller = e.sellerActorId;
    const buyer = e.buyerActorId;
    const locId = e.locationId;

    const sellerLeads = getLeadsByHolder(world.db, seller);
    const buyerLeads = getLeadsByHolder(world.db, buyer);

    const exchanges: GossipExchange[] = [];
    pour(world, seller, buyer, sellerLeads, buyerLeads, leadsPerSide, e.at.day, exchanges);
    pour(world, buyer, seller, buyerLeads, sellerLeads, leadsPerSide, e.at.day, exchanges);

    if (exchanges.length === 0) return;
    world.events.emit({
      type: "gossip.exchanged",
      at: e.at,
      atLocationId: locId,
      kind: "deal",
      participantActorIds: [seller, buyer],
      exchanges,
    });
  });
}

function pour(
  world: World,
  fromActorId: number,
  toActorId: number,
  fromLeads: readonly import("../leads/types.js").Lead[],
  toLeadsSnapshot: readonly import("../leads/types.js").Lead[],
  cap: number,
  onDay: number,
  out: GossipExchange[],
): void {
  if (cap <= 0) return;
  const novel = selectNovelLeads(fromLeads, toLeadsSnapshot);
  if (novel.length === 0) return;

  const pool = [...novel];
  let drawn = 0;
  while (drawn < cap && pool.length > 0) {
    const idx = Math.floor(world.rng.next() * pool.length);
    const lead = pool[idx]!;
    pool.splice(idx, 1);
    drawn += 1;
    try {
      shareLead(world.db, fromActorId, toActorId, lead.id, onDay);
      out.push(toExchange(lead, fromActorId, toActorId));
    } catch {
      // Holder mismatch or self-share — skip silently.
    }
  }
}

import type { Clock } from "./clock.js";
import { formatClock } from "./clock.js";

/** Value-shape of a single bidder who turned up for an auction lot.
 *  `ceiling` is the maximum total they were prepared to pay; the resolver
 *  walks the bid ladder to determine the actual hammer price. Embedding
 *  the ceilings on the event lets consumers replay the bidding visually. */
export interface AuctionBidderSnapshot {
  readonly actorId: number;
  readonly ceiling: number;
}

/** Value-shape of a single lead transferred during a gossip exchange.
 *  Embedded in `gossip.exchanged` so consumers (UI, dump) can reconstruct
 *  what was actually said without joining back to the leads table. */
export interface GossipExchange {
  readonly fromActorId: number;
  readonly toActorId: number;
  readonly lead: {
    readonly side: "supply" | "demand";
    readonly subjectItemKindId: number;
    readonly subjectQualityTier: string | null;
    readonly counterpartyActorId: number | null;
    readonly estimatedQuantity: number;
    readonly estimatedUnitPrice: number;
    readonly confidence: "warm" | "cold";
    readonly hopCount: number;
    readonly sourceActorId: number | null;
  };
}

/**
 * Read-only narration of what the engine has done. Events are emitted by
 * the World and its mechanics; consumers (loggers, UI, tests) subscribe to
 * the stream. Events never carry references to mutable internal state —
 * everything in an event payload is value-shaped and safe to retain.
 */
export type WorldEvent =
  | { readonly type: "world.started"; readonly at: Clock; readonly seed: string; readonly maxDays: number }
  | { readonly type: "world.ended"; readonly at: Clock }
  | { readonly type: "day.started"; readonly at: Clock; readonly day: number }
  | { readonly type: "day.ended"; readonly at: Clock; readonly day: number }
  | { readonly type: "actor.departed"; readonly at: Clock; readonly actorId: number; readonly fromLocationId: number | null; readonly toLocationId: number }
  | { readonly type: "actor.travelled"; readonly at: Clock; readonly actorId: number; readonly toLocationId: number }
  | { readonly type: "deal.settled"; readonly at: Clock; readonly dealId: number; readonly buyerActorId: number; readonly sellerActorId: number; readonly totalPrice: number }
  | { readonly type: "deal.defaulted"; readonly at: Clock; readonly dealId: number; readonly buyerActorId: number; readonly sellerActorId: number; readonly reason: string }
  | { readonly type: "action.failed"; readonly at: Clock; readonly actorId: number; readonly actionType: string; readonly reason: string }
  | { readonly type: "policy.errored"; readonly at: Clock; readonly actorId: number; readonly policyId: string; readonly reason: string }
  | { readonly type: "pool.flushed"; readonly at: Clock; readonly poolId: number; readonly quantity: number; readonly destination: "auction" | "market" | "write_off"; readonly auctionLotId: number | null }
  | { readonly type: "pubdeal.attempted"; readonly at: Clock; readonly locationId: number; readonly sellerActorId: number; readonly buyerActorId: number; readonly itemKindId: number; readonly qualityTier: string; readonly quantity: number }
  | { readonly type: "pubdeal.agreed"; readonly at: Clock; readonly dealId: number; readonly sellerActorId: number; readonly buyerActorId: number; readonly unitPrice: number; readonly quantity: number }
  | { readonly type: "pubdeal.walked"; readonly at: Clock; readonly sellerActorId: number; readonly buyerActorId: number; readonly reason: string }
  | { readonly type: "pubdeal.skipped-low-trust"; readonly at: Clock; readonly sellerActorId: number; readonly buyerActorId: number; readonly trustScore: number }
  | { readonly type: "gossip.exchanged"; readonly at: Clock; readonly atLocationId: number; readonly visitorActorId: number; readonly proprietorActorId: number; readonly exchanges: readonly GossipExchange[] }
  | { readonly type: "settlement.lead-claim"; readonly at: Clock; readonly dealId: number; readonly sellerActorId: number; readonly poolId: number; readonly quantity: number; readonly unitPrice: number; readonly throughLeadId: number }
  | { readonly type: "delivery.fee"; readonly at: Clock; readonly dealId: number; readonly sellerActorId: number; readonly fee: number }
  | { readonly type: "heat.raised"; readonly at: Clock; readonly actorId: number; readonly delta: number; readonly score: number; readonly reason: string }
  | { readonly type: "authority.raid"; readonly at: Clock; readonly actorId: number; readonly unitsSeized: number; readonly seizedItemCodes: readonly string[]; readonly fine: number; readonly heatBefore: number }
  | { readonly type: "auction.cleared"; readonly at: Clock; readonly auctionLotId: number; readonly winnerActorId: number; readonly unitPrice: number; readonly totalPrice: number; readonly floorPrice: number; readonly effectiveFloor: number; readonly openingAsk: number; readonly attendees: readonly number[]; readonly bidders: readonly AuctionBidderSnapshot[] }
  | { readonly type: "auction.unsold"; readonly at: Clock; readonly auctionLotId: number; readonly reason: string; readonly floorPrice: number; readonly effectiveFloor: number; readonly openingAsk: number; readonly attendees: readonly number[]; readonly bidders: readonly AuctionBidderSnapshot[] }
  | { readonly type: "auction.written_off"; readonly at: Clock; readonly auctionLotId: number; readonly daysOpen: number }
  | { readonly type: "pool.claimed"; readonly at: Clock; readonly poolId: number; readonly actorId: number; readonly quantity: number; readonly unitPrice: number }
  | { readonly type: "pool.spawned"; readonly at: Clock; readonly poolId: number; readonly itemKindId: number; readonly itemCode: string; readonly qualityTier: string; readonly quantity: number; readonly openingUnitPrice: number; readonly closingUnitPrice: number; readonly expiryDay: number; readonly isEasterEgg: boolean; readonly flavourText: string | null };

export type EventHandler = (event: WorldEvent) => void;

export interface EventLog {
  emit(event: WorldEvent): void;
  subscribe(handler: EventHandler): () => void;
}

export function createEventLog(): EventLog {
  const handlers = new Set<EventHandler>();
  return {
    emit(event) {
      for (const h of handlers) h(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

/** Pretty-print events to stdout. */
export function consoleHandler(): EventHandler {
  return (e) => {
    const stamp = formatClock(e.at);
    switch (e.type) {
      case "world.started":
        console.log(`[${stamp}] world.started seed=${e.seed} maxDays=${e.maxDays}`);
        break;
      case "world.ended":
        console.log(`[${stamp}] world.ended`);
        break;
      case "day.started":
        console.log(`[${stamp}] day.started day=${e.day}`);
        break;
      case "day.ended":
        console.log(`[${stamp}] day.ended day=${e.day}`);
        break;
      case "actor.departed":
        console.log(`[${stamp}] actor.departed actor=${e.actorId} from=${e.fromLocationId ?? "—"} to=${e.toLocationId}`);
        break;
      case "actor.travelled":
        console.log(`[${stamp}] actor.travelled actor=${e.actorId} to=${e.toLocationId}`);
        break;
      case "deal.settled":
        console.log(`[${stamp}] deal.settled deal=${e.dealId} total=£${e.totalPrice}`);
        break;
      case "deal.defaulted":
        console.log(`[${stamp}] deal.defaulted deal=${e.dealId} reason="${e.reason}"`);
        break;
      case "action.failed":
        console.log(`[${stamp}] action.failed actor=${e.actorId} action=${e.actionType} reason="${e.reason}"`);
        break;
      case "policy.errored":
        console.log(`[${stamp}] policy.errored actor=${e.actorId} policy=${e.policyId} reason="${e.reason}"`);
        break;
      case "pool.flushed":
        console.log(`[${stamp}] pool.flushed pool=${e.poolId} qty=${e.quantity} dest=${e.destination}${e.auctionLotId !== null ? ` lot=${e.auctionLotId}` : ""}`);
        break;
      case "pubdeal.attempted":
        console.log(`[${stamp}] pubdeal.attempted seller=${e.sellerActorId} buyer=${e.buyerActorId} kind=${e.itemKindId}/${e.qualityTier} qty=${e.quantity}`);
        break;
      case "pubdeal.agreed":
        console.log(`[${stamp}] pubdeal.agreed deal=${e.dealId} seller=${e.sellerActorId} buyer=${e.buyerActorId} ${e.quantity}@£${e.unitPrice}`);
        break;
      case "pubdeal.walked":
        console.log(`[${stamp}] pubdeal.walked seller=${e.sellerActorId} buyer=${e.buyerActorId} reason="${e.reason}"`);
        break;
      case "pubdeal.skipped-low-trust":
        console.log(`[${stamp}] pubdeal.skipped-low-trust seller=${e.sellerActorId} buyer=${e.buyerActorId} (trust=${e.trustScore})`);
        break;
      case "gossip.exchanged": {
        const summaries = e.exchanges
          .map((x) => {
            const l = x.lead;
            const tier = l.subjectQualityTier ?? "?";
            return `${x.fromActorId}→${x.toActorId} [${l.side} kind=${l.subjectItemKindId}/${tier} qty=${l.estimatedQuantity}@£${l.estimatedUnitPrice} ${l.confidence} hop=${l.hopCount}]`;
          })
          .join(" ");
        console.log(`[${stamp}] gossip.exchanged loc=${e.atLocationId} ${summaries}`);
        break;
      }
      case "settlement.lead-claim":
        console.log(`[${stamp}] settlement.lead-claim deal=${e.dealId} seller=${e.sellerActorId} pool=${e.poolId} ${e.quantity}@£${e.unitPrice} (lead=${e.throughLeadId})`);
        break;
      case "delivery.fee":
        console.log(`[${stamp}] delivery.fee deal=${e.dealId} seller=${e.sellerActorId} £${e.fee}`);
        break;
      case "heat.raised":
        console.log(`[${stamp}] heat.raised actor=${e.actorId} +${e.delta} → ${e.score} (${e.reason})`);
        break;
      case "authority.raid":
        console.log(`[${stamp}] 🚨 authority.raid actor=${e.actorId} seized=${e.unitsSeized} units fine=£${e.fine} heat-was=${e.heatBefore}`);
        break;
      case "auction.cleared":
        console.log(`[${stamp}] auction.cleared lot=${e.auctionLotId} winner=${e.winnerActorId} @£${e.unitPrice} total=£${e.totalPrice} floor=£${e.effectiveFloor} bidders=${e.bidders.length}`);
        break;
      case "auction.unsold":
        console.log(`[${stamp}] auction.unsold lot=${e.auctionLotId} reason=${e.reason} floor=£${e.effectiveFloor} bidders=${e.bidders.length}`);
        break;
      case "auction.written_off":
        console.log(`[${stamp}] auction.written_off lot=${e.auctionLotId} after ${e.daysOpen} days unsold`);
        break;
      case "pool.claimed":
        console.log(`[${stamp}] pool.claimed pool=${e.poolId} actor=${e.actorId} ${e.quantity}@£${e.unitPrice}`);
        break;
      case "pool.spawned": {
        const tag = e.isEasterEgg ? " ✨" : "";
        const flavour = e.flavourText ? ` "${e.flavourText}"` : "";
        console.log(
          `[${stamp}] pool.spawned${tag} pool=${e.poolId} item=${e.itemCode} tier=${e.qualityTier} qty=${e.quantity} window=£${e.openingUnitPrice}→£${e.closingUnitPrice} expires=D${String(e.expiryDay).padStart(2, "0")}${flavour}`,
        );
        break;
      }
    }
  };
}

/** Capture every event into an array. Useful in tests. */
export function bufferHandler(): { handler: EventHandler; events: WorldEvent[] } {
  const events: WorldEvent[] = [];
  return {
    handler: (e) => {
      events.push(e);
    },
    events,
  };
}

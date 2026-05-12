import type { Clock } from "./clock.js";
import { formatClock } from "./clock.js";

/** Value-shape of one turn in a pub-deal negotiation. The full sequence
 *  is embedded on `pubdeal.agreed` / `pubdeal.walked` so the UI can play
 *  the haggle out step-by-step. */
export interface NegotiationTurnSnapshot {
  readonly by: "seller" | "buyer";
  readonly action: "open" | "counter" | "accept" | "walk";
  readonly unitPrice: number | null;
}

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
    /** `commodity` is the legacy meaning (who has/wants stock). `rep`
     *  is a warning/vouch about a person. Same channel, same machinery,
     *  different content. */
    readonly kind: "commodity" | "rep";
    readonly side: "supply" | "demand";
    /** Commodity-only — null on rep leads. */
    readonly subjectItemKindId: number | null;
    readonly subjectQualityTier: string | null;
    /** Rep-only — the actor the lead is about. Null on commodity leads. */
    readonly subjectTargetActorId: number | null;
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
  | {
      readonly type: "pubdeal.agreed";
      readonly at: Clock;
      readonly locationId: number;
      readonly dealId: number;
      readonly sellerActorId: number;
      readonly buyerActorId: number;
      readonly unitPrice: number;
      readonly quantity: number;
      readonly turns: readonly NegotiationTurnSnapshot[];
      /** Seller's per-unit belief band at the moment of agreement —
       *  what they thought a unit was worth as they shook hands.
       *  Snapshot of `estimateUnitRetail` against the seller's
       *  bidder profile. Optional for back-compat with older dumps. */
      readonly sellerBelief?: { readonly low: number; readonly high: number };
      /** Buyer's per-unit belief band at the moment of agreement.
       *  The two-band diff is the asymmetric-knowledge surface area. */
      readonly buyerBelief?: { readonly low: number; readonly high: number };
      /** Engine truth: the lot's per-unit RRP at the agreed tier.
       *  Surfaced for the UI's "what they thought vs the truth" diff. */
      readonly truePricePerUnit?: number;
    }
  | { readonly type: "pubdeal.walked"; readonly at: Clock; readonly locationId: number; readonly sellerActorId: number; readonly buyerActorId: number; readonly reason: string; readonly turns: readonly NegotiationTurnSnapshot[] }
  | { readonly type: "pubdeal.skipped-low-trust"; readonly at: Clock; readonly sellerActorId: number; readonly buyerActorId: number; readonly trustScore: number }
  | { readonly type: "pubdeal.skipped-rep"; readonly at: Clock; readonly locationId: number; readonly sellerActorId: number; readonly buyerActorId: number; readonly repLeadId: number; readonly damageOnLead: number; readonly hopCount: number }
  | {
      readonly type: "pubdeal.skipped-too-small";
      readonly at: Clock;
      readonly locationId: number;
      readonly sellerActorId: number;
      readonly buyerActorId: number;
      readonly itemKindId: number;
      readonly qualityTier: string;
      /** Seller's RRP estimate over their on-hand bag. */
      readonly sellerRrp: number;
      /** Buyer's appraised RRP of the seller's max-committable bag. */
      readonly buyerRrp: number;
      readonly floor: number;
    }
  | {
      readonly type: "gossip.exchanged";
      readonly at: Clock;
      readonly atLocationId: number;
      /**
       * `proprietor`    — the existing drive-by exchange between a visitor
       *   and the location's proprietor on arrival (passive, no hour cost).
       * `chat`          — a visitor↔visitor conversation at a social venue.
       * `deal`          — gossip that fires alongside a pub-deal attempt
       *   (agreed or walked) between the two would-be counterparties.
       * `clarification` — a targeted "what do *you* know about X?" lookup
       *   inside a conversation. The asker brings a subject; the target
       *   surfaces their matching lead. Distinguishes "stuff came up" from
       *   "I asked specifically."
       */
      readonly kind: "proprietor" | "chat" | "deal" | "clarification";
      /** The two actors involved. For proprietor exchanges, index 0 is
       *  the visitor and index 1 is the proprietor (legacy ordering).
       *  For chat/deal exchanges the order is not meaningful. */
      readonly participantActorIds: readonly number[];
      readonly exchanges: readonly GossipExchange[];
    }
  | { readonly type: "settlement.lead-claim"; readonly at: Clock; readonly dealId: number; readonly sellerActorId: number; readonly poolId: number; readonly quantity: number; readonly unitPrice: number; readonly throughLeadId: number }
  | { readonly type: "delivery.fee"; readonly at: Clock; readonly dealId: number; readonly sellerActorId: number; readonly fee: number }
  | { readonly type: "heat.raised"; readonly at: Clock; readonly actorId: number; readonly delta: number; readonly score: number; readonly reason: string }
  | { readonly type: "rep.spawned"; readonly at: Clock; readonly leadId: number; readonly holderActorId: number; readonly subjectTargetActorId: number; readonly counterpartyActorId: number; readonly dealId: number; readonly damage: number }
  | {
      readonly type: "broker.materialised";
      readonly at: Clock;
      readonly brokerActorId: number;
      readonly producerActorId: number;
      readonly locationId: number;
      readonly untilHour: number;
      readonly fee: number;
      /** Actors present at the venue when the producer arrives. The
       *  scene deck uses this to render the room. */
      readonly attendees: readonly number[];
    }
  | {
      readonly type: "broker.materialisation-aborted";
      readonly at: Clock;
      readonly brokerActorId: number;
      readonly producerActorId: number;
      readonly locationId: number;
      /** The actor whose rep ledger blocked the encounter — either the
       *  producer holds rep about them, or they hold rep about the
       *  producer. Surfaces in the diary/scene. */
      readonly blockerActorId: number;
      readonly repLeadId: number;
      readonly direction: "producer-knows-blocker" | "blocker-knows-producer";
    }
  | { readonly type: "authority.raid"; readonly at: Clock; readonly actorId: number; readonly unitsSeized: number; readonly seizedItemCodes: readonly string[]; readonly fine: number; readonly heatBefore: number }
  | { readonly type: "auction.cleared"; readonly at: Clock; readonly auctionLotId: number; readonly winnerActorId: number; readonly unitPrice: number; readonly totalPrice: number; readonly floorPrice: number; readonly effectiveFloor: number; readonly openingAsk: number; readonly attendees: readonly number[]; readonly bidders: readonly AuctionBidderSnapshot[] }
  | { readonly type: "auction.unsold"; readonly at: Clock; readonly auctionLotId: number; readonly reason: string; readonly floorPrice: number; readonly effectiveFloor: number; readonly openingAsk: number; readonly attendees: readonly number[]; readonly bidders: readonly AuctionBidderSnapshot[] }
  | { readonly type: "auction.written_off"; readonly at: Clock; readonly auctionLotId: number; readonly daysOpen: number; readonly reason?: string }
  | { readonly type: "auction.docket-published"; readonly at: Clock; readonly lots: readonly { readonly lotId: number; readonly scheduledHour: number }[] }
  | { readonly type: "auction.knowledge-acquired"; readonly at: Clock; readonly actorId: number; readonly auctionLotId: number; readonly via: "paper" | "gallery" | "gossip" | "attended"; readonly fromActorId: number | null }
  | { readonly type: "auction.lot-inspected"; readonly at: Clock; readonly actorId: number; readonly auctionLotId: number }
  | {
      readonly type: "actor.planned";
      readonly at: Clock;
      readonly actorId: number;
      /** The day the planned destination applies to. Almost always
       *  `at.day`, except at the day rollover (planned at 23:00 → next day 00:00). */
      readonly targetDay: number;
      /** The hour the planned destination applies to. */
      readonly targetHour: number;
      readonly locationId: number;
      readonly kind: "auction" | "market" | "pub" | "shop" | "newspaper" | "home";
      /** Argmax score (rounded to 2dp) — useful for explaining ties in the trace. */
      readonly score: number;
    }
  | {
      readonly type: "market.hour-summary";
      readonly at: Clock;
      readonly sellerActorId: number;
      readonly atLocationId: number;
      readonly stockLotId: number;
      readonly itemKindId: number;
      readonly qualityTier: string;
      /** Average realised price per unit (revenue / unitsSold). */
      readonly pricePerUnit: number;
      /** Per-unit price range across the hour. With the customer-
       *  drives-price model, individual customers pay different
       *  prices in [0.9, 1.1] × RRP; this surfaces the spread. */
      readonly priceRange?: { readonly low: number; readonly high: number };
      /** What the seller thought a unit was worth — their own
       *  belief band before any customers walked in. The UI can
       *  contrast this with the realised range to show "the seller
       *  thought X; they actually got Y." */
      readonly sellerBelief?: { readonly low: number; readonly high: number };
      /** Engine truth: the lot's per-unit RRP (item baseValue ×
       *  tier multiplier). Unknown to the seller; surfaced in the
       *  event for retrospective analysis / UI display. */
      readonly truePricePerUnit?: number;
      readonly unitsOffered: number;
      readonly unitsSold: number;
      readonly revenue: number;
      readonly footfall: number;
      readonly customerMix: Readonly<Record<string, number>>;
      readonly soldByPersona: Readonly<Record<string, number>>;
    }
  | { readonly type: "pool.claimed"; readonly at: Clock; readonly poolId: number; readonly actorId: number; readonly quantity: number; readonly unitPrice: number }
  | { readonly type: "pool.spawned"; readonly at: Clock; readonly poolId: number; readonly itemKindId: number; readonly itemCode: string; readonly qualityTier: string; readonly quantity: number; readonly openingUnitPrice: number; readonly closingUnitPrice: number; readonly expiryDay: number; readonly isEasterEgg: boolean; readonly flavourText: string | null }
  | {
      readonly type: "off-map.resold";
      readonly at: Clock;
      readonly dealerActorId: number;
      readonly marketActorId: number;
      readonly lotsSold: number;
      readonly unitsSold: number;
      readonly totalValue: number;
    }
  | {
      readonly type: "payout.released";
      readonly at: Clock;
      readonly actorId: number;
      readonly amount: number;
      readonly source: string;
      readonly originatedDay: number;
    }
  | {
      readonly type: "regional-clearance.listed";
      readonly at: Clock;
      readonly auctionLotId: number;
      readonly itemKindId: number;
      readonly qualityTier: string;
      readonly quantity: number;
      readonly floorPrice: number;
      readonly provenance: string | null;
    }
  | {
      readonly type: "stock.written-off";
      readonly at: Clock;
      readonly ownerActorId: number;
      readonly stockLotId: number;
      readonly itemKindId: number;
      readonly qualityTier: string;
      readonly quantity: number;
      readonly feePaid: number;
      readonly reason: string;
    }
  | {
      readonly type: "trust.adjusted";
      readonly at: Clock;
      readonly holderActorId: number;
      readonly targetActorId: number;
      readonly delta: number;
      readonly newScore: number;
      /** What event triggered the change. 'settled' = a clean deal,
       *  'defaulted' = the wronged buyer side. */
      readonly reason: "settled" | "defaulted";
      readonly dealId: number;
    }
  | {
      readonly type: "clearance.listed";
      readonly at: Clock;
      readonly listingId: number;
      readonly scheduledDay: number;
      readonly fee: number;
      readonly flavour: string | null;
      readonly lots: readonly {
        readonly itemKindId: number;
        readonly qualityTier: string;
        readonly quantity: number;
      }[];
    }
  | {
      readonly type: "clearance.resolved";
      readonly at: Clock;
      readonly listingId: number;
      readonly winnerActorId: number | null;
      readonly winningBookingId: number | null;
      readonly feeCharged: number;
      readonly loserActorIds: readonly number[];
      readonly lotsDelivered: readonly {
        readonly stockLotId: number;
        readonly itemKindId: number;
        readonly quantity: number;
      }[];
    }
  | {
      readonly type: "clearance.expired";
      readonly at: Clock;
      readonly listingId: number;
      readonly flavour: string | null;
    }
  | {
      readonly type: "clearance.booked";
      readonly at: Clock;
      readonly listingId: number;
      readonly bookingId: number;
      readonly bookerActorId: number;
      readonly scheduledHour: number;
      readonly atLocationId: number | null;
    }
  | {
      readonly type: "market.stall-rented";
      readonly at: Clock;
      readonly stallId: number;
      readonly sellerActorId: number;
      readonly locationId: number;
      readonly mode: "legit" | "adhoc";
      readonly feePaid: number;
    }
  | {
      readonly type: "market.patrol-arrived";
      readonly at: Clock;
      readonly locationId: number;
      readonly officerActorId: number;
      readonly stallIds: readonly number[];
    }
  | {
      readonly type: "market.stall-busted";
      readonly at: Clock;
      readonly stallId: number;
      readonly sellerActorId: number;
      readonly locationId: number;
      readonly officerActorId: number;
      readonly finePaid: number;
      readonly unitsLost: number;
    }
  | {
      readonly type: "market.stall-cleared";
      readonly at: Clock;
      readonly stallId: number;
      readonly sellerActorId: number;
      readonly locationId: number;
    }
  | {
      readonly type: "market.stall-bribed";
      readonly at: Clock;
      readonly stallId: number;
      readonly sellerActorId: number;
      readonly locationId: number;
      readonly officerActorId: number;
      readonly bribeAmount: number;
    }
  | {
      readonly type: "bribe.offered";
      readonly at: Clock;
      readonly offererActorId: number;
      readonly officerActorId: number;
      readonly amount: number;
      readonly thresholdAtTime: number;
      readonly locationId: number;
    }
  | {
      readonly type: "bribe.accepted";
      readonly at: Clock;
      readonly offererActorId: number;
      readonly officerActorId: number;
      readonly amount: number;
      readonly thresholdAtTime: number;
      readonly locationId: number;
    }
  | {
      readonly type: "bribe.refused";
      readonly at: Clock;
      readonly offererActorId: number;
      readonly officerActorId: number;
      readonly amount: number;
      readonly reason: "not-bribable" | "below-threshold";
      readonly locationId: number;
    }
  | {
      readonly type: "slater.alert";
      readonly at: Clock;
      readonly slaterActorId: number;
      readonly destinationLocationId: number;
      readonly fromDay: number;
      readonly fromHour: number;
      readonly toDay: number;
      readonly toHour: number;
      readonly reason: string;
      /** Optional — the deal id that triggered the alert (when the
       *  trigger was a pubdeal of stolen goods). */
      readonly sourceDealId?: number;
    };

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
      case "pubdeal.skipped-rep":
        console.log(`[${stamp}] pubdeal.skipped-rep seller=${e.sellerActorId} buyer=${e.buyerActorId} (rep-lead=${e.repLeadId} hop=${e.hopCount} damage=£${e.damageOnLead})`);
        break;
      case "pubdeal.skipped-too-small":
        console.log(`[${stamp}] pubdeal.skipped-too-small seller=${e.sellerActorId} buyer=${e.buyerActorId} kind=${e.itemKindId}/${e.qualityTier} sellerRrp=£${e.sellerRrp} buyerRrp=£${e.buyerRrp} floor=£${e.floor}`);
        break;
      case "gossip.exchanged": {
        const summaries = e.exchanges
          .map((x) => {
            const l = x.lead;
            const tier = l.subjectQualityTier ?? "?";
            return `${x.fromActorId}→${x.toActorId} [${l.side} kind=${l.subjectItemKindId}/${tier} qty=${l.estimatedQuantity}@£${l.estimatedUnitPrice} ${l.confidence} hop=${l.hopCount}]`;
          })
          .join(" ");
        console.log(`[${stamp}] gossip.exchanged (${e.kind}) loc=${e.atLocationId} ${summaries}`);
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
      case "rep.spawned":
        console.log(`[${stamp}] rep.spawned holder=${e.holderActorId} target=${e.subjectTargetActorId} damage=£${e.damage} (deal=${e.dealId})`);
        break;
      case "broker.materialised":
        console.log(`[${stamp}] broker.materialised broker=${e.brokerActorId} producer=${e.producerActorId} loc=${e.locationId} until=${String(e.untilHour).padStart(2,"0")}:00 fee=£${e.fee} (${e.attendees.length} present)`);
        break;
      case "broker.materialisation-aborted":
        console.log(`[${stamp}] broker.materialisation-aborted broker=${e.brokerActorId} producer=${e.producerActorId} blocked-by=${e.blockerActorId} (${e.direction})`);
        break;
      case "payout.released":
        console.log(`[${stamp}] payout.released actor=${e.actorId} +£${e.amount} from ${e.source} (D${e.originatedDay})`);
        break;
      case "regional-clearance.listed":
        console.log(`[${stamp}] regional-clearance.listed lot=${e.auctionLotId} ${e.quantity}×${e.qualityTier} floor=£${e.floorPrice}${e.provenance ? ` "${e.provenance}"` : ""}`);
        break;
      case "stock.written-off":
        console.log(`[${stamp}] stock.written-off owner=${e.ownerActorId} lot=${e.stockLotId} ${e.quantity}×${e.qualityTier} fee=£${e.feePaid} (${e.reason})`);
        break;
      case "trust.adjusted":
        console.log(`[${stamp}] trust.adjusted holder=${e.holderActorId} target=${e.targetActorId} ${e.delta >= 0 ? "+" : ""}${e.delta} → ${e.newScore} (${e.reason} deal=${e.dealId})`);
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
        console.log(`[${stamp}] auction.written_off lot=${e.auctionLotId} after ${e.daysOpen} days${e.reason ? ` (${e.reason})` : ""}`);
        break;
      case "auction.docket-published":
        console.log(`[${stamp}] auction.docket-published lots=${e.lots.length}${e.lots.length > 0 ? ` (${e.lots.map((l) => `lot=${l.lotId}@${String(l.scheduledHour).padStart(2, "0")}:00`).join(", ")})` : ""}`);
        break;
      case "auction.knowledge-acquired":
        console.log(`[${stamp}] auction.knowledge-acquired actor=${e.actorId} lot=${e.auctionLotId} via=${e.via}${e.fromActorId !== null ? ` from=${e.fromActorId}` : ""}`);
        break;
      case "auction.lot-inspected":
        console.log(`[${stamp}] auction.lot-inspected actor=${e.actorId} lot=${e.auctionLotId}`);
        break;
      case "market.hour-summary":
        console.log(`[${stamp}] market.hour-summary seller=${e.sellerActorId} sold=${e.unitsSold}/${e.unitsOffered} @£${e.pricePerUnit}/u rev=£${e.revenue} footfall=${e.footfall}`);
        break;
      case "actor.planned":
        console.log(`[${stamp}] actor.planned actor=${e.actorId} → D${String(e.targetDay).padStart(2,"0")} ${String(e.targetHour).padStart(2,"0")}:00 ${e.kind} loc=${e.locationId} (score=${e.score})`);
        break;
      case "off-map.resold":
        console.log(`[${stamp}] off-map.resold dealer=${e.dealerActorId} ${e.lotsSold} lot${e.lotsSold===1?"":"s"} (${e.unitsSold} units) → £${e.totalValue}`);
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

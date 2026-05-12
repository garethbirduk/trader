import type { DB } from "../../core/db.js";
import type { Clock } from "../../core/clock.js";
import type { EventLog } from "../../core/events.js";
import type { SeededRNG } from "../../core/rng.js";
import { getActorCurrentLocationId } from "../../locations/locations.js";
import { runRuleBasedNegotiation } from "../../negotiation/rule-based.js";
import type {
  BuyerParty,
  NegotiationContext,
  NegotiationResult,
  SellerParty,
} from "../../negotiation/types.js";
import { createAgreedDeal } from "../../deals/deals-repo.js";
import { settleDeal } from "../../deals/settlement.js";
import { totalQuantityForOwnerKindAndTier } from "../../stock/lots-repo.js";
import { getActorById } from "../../actors/actors-repo.js";
import { TRANSPORT_LIMITS } from "../../actors/types.js";
import type { QualityTier } from "../../stock/types.js";

export interface PubDealAttemptArgs {
  readonly db: DB;
  readonly events: EventLog;
  readonly rng: SeededRNG;
  readonly clock: Clock;

  readonly locationId: number;
  readonly seller: SellerParty;
  readonly buyer: BuyerParty;

  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;

  readonly initiator: "seller" | "buyer";
  readonly maxRounds?: number;

  /** Delivery deadline for the resulting deal, if agreement is reached. */
  readonly deadlineDay: number;
}

export type PubDealResult =
  | {
      readonly type: "agreed";
      readonly dealId: number;
      readonly unitPrice: number;
      readonly negotiation: NegotiationResult;
    }
  | {
      readonly type: "walked";
      readonly reason: string;
      readonly negotiation: NegotiationResult;
    }
  | { readonly type: "blocked"; readonly reason: string };

/**
 * The pub-deal mechanic: two actors meet at the same location, run a
 * negotiation, and if they agree, a deal is created in 'agreed' state.
 * No stock or cash moves at this point — settlement happens later via the
 * daily-settlement loop, which may succeed or default depending on the
 * seller's ability to source the goods by `deadlineDay`.
 *
 * This is the lingua franca mechanic — the same surface used by every
 * skin's social-trading venue, just reskinned. Specialised mechanics
 * (auction house, market stall, dealer house) build on the same
 * primitives but expose different UX shapes.
 */
export function attemptPubDeal(args: PubDealAttemptArgs): PubDealResult {
  // Both parties must be at the named location.
  const sellerLoc = getActorCurrentLocationId(args.db, args.seller.actorId);
  if (sellerLoc !== args.locationId) {
    return {
      type: "blocked",
      reason: `seller actor ${args.seller.actorId} is not at location ${args.locationId}`,
    };
  }
  const buyerLoc = getActorCurrentLocationId(args.db, args.buyer.actorId);
  if (buyerLoc !== args.locationId) {
    return {
      type: "blocked",
      reason: `buyer actor ${args.buyer.actorId} is not at location ${args.locationId}`,
    };
  }
  if (args.deadlineDay < args.clock.day) {
    return {
      type: "blocked",
      reason: `deadlineDay ${args.deadlineDay} is in the past (today=${args.clock.day})`,
    };
  }

  const ctx: NegotiationContext = {
    itemKindId: args.itemKindId,
    qualityTier: args.qualityTier,
    quantity: args.quantity,
    seller: args.seller,
    buyer: args.buyer,
    initiator: args.initiator,
    maxRounds: args.maxRounds ?? 12,
  };

  const negotiation = runRuleBasedNegotiation(ctx, args.rng);

  args.events.emit({
    type: "pubdeal.attempted",
    at: args.clock,
    locationId: args.locationId,
    sellerActorId: args.seller.actorId,
    buyerActorId: args.buyer.actorId,
    itemKindId: args.itemKindId,
    qualityTier: args.qualityTier,
    quantity: args.quantity,
  });

  if (negotiation.type === "walked") {
    args.events.emit({
      type: "pubdeal.walked",
      at: args.clock,
      locationId: args.locationId,
      sellerActorId: args.seller.actorId,
      buyerActorId: args.buyer.actorId,
      reason: negotiation.reason,
      turns: negotiation.turns,
    });
    return { type: "walked", reason: negotiation.reason, negotiation };
  }

  // The deal's delivery location is where the negotiation happened —
  // both parties were physically there and the buyer expects the goods
  // to materialise there by the deadline.
  const deal = createAgreedDeal(args.db, {
    buyerActorId: args.buyer.actorId,
    sellerActorId: args.seller.actorId,
    agreedDay: args.clock.day,
    deadlineDay: args.deadlineDay,
    deliveryLocationId: args.locationId,
    lines: [
      {
        itemKindId: args.itemKindId,
        qualityTier: args.qualityTier,
        quantity: args.quantity,
        unitPrice: negotiation.unitPrice,
      },
    ],
  });

  args.events.emit({
    type: "pubdeal.agreed",
    at: args.clock,
    locationId: args.locationId,
    dealId: deal.id,
    sellerActorId: args.seller.actorId,
    buyerActorId: args.buyer.actorId,
    unitPrice: negotiation.unitPrice,
    quantity: args.quantity,
    turns: negotiation.turns,
  });

  // Hand-off in the room — when the seller owns enough of the agreed
  // item-tier (at any of their locations) and their transport tier
  // can carry the lot, settle on the spot. Both parties are co-located
  // by construction; the seller brought what they brought. The pre-fix
  // behaviour deferred everything to the next-day delivery scheduler,
  // which let the seller's stock drain into a parallel deal between
  // agreement and settlement and produced spurious defaults. Forward-
  // sale cases (where the seller's commitment exceeds their on-hand
  // stock) still fall through to the deadline path.
  if (canHandOffNow(args)) {
    try {
      settleDeal(args.db, deal.id, args.clock.day, {
        events: args.events,
        atClock: args.clock,
        sellerSelfDelivers: true,
        skipTransitGate: true,
      });
    } catch {
      // Settlement raced or otherwise failed — leave the deal in
      // 'agreed' state and let the daily scheduler retry tomorrow.
    }
  }

  return { type: "agreed", dealId: deal.id, unitPrice: negotiation.unitPrice, negotiation };
}

/**
 * Can this deal settle right now, in the room, without scheduling a
 * separate delivery trip? Two conditions:
 *
 *   1. The seller owns at least the agreed quantity of the item-tier
 *      across all their locations. Settlement will draw from local
 *      lots first (Phase 1a) then from remote lots (Phase 1b) at no
 *      delivery fee, since the seller is self-delivering and the
 *      transit-time gate is bypassed for the in-the-room case.
 *   2. The seller's transport tier could physically carry the lot.
 *      A van's worth of fridges still needs a van even when the
 *      buyer is standing next to it.
 */
function canHandOffNow(args: PubDealAttemptArgs): boolean {
  const onHand = totalQuantityForOwnerKindAndTier(
    args.db,
    args.seller.actorId,
    args.itemKindId,
    args.qualityTier,
  );
  if (onHand < args.quantity) return false;
  const seller = getActorById(args.db, args.seller.actorId);
  if (!seller) return false;
  const limit = TRANSPORT_LIMITS[seller.transportCapacity];
  return limit >= args.quantity;
}

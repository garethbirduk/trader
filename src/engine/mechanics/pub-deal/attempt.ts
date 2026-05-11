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

  return { type: "agreed", dealId: deal.id, unitPrice: negotiation.unitPrice, negotiation };
}

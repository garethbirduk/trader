import type { World, Unsubscribe } from "../core/world.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import {
  FALLBACK_BIDDER_PROFILE,
  appraiseLot,
} from "../auction/bidder-profile.js";
import { actorKnowsFlaw } from "../inspection/inspection-repo.js";
import { getActorById } from "../actors/actors-repo.js";
import { TRANSIT_DAYS_BY_TIER, TRANSPORT_LIMITS } from "../actors/types.js";
import { getActorsAtLocation } from "../locations/locations.js";
import { getItemKindById } from "../stock/items-repo.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import { getTrust } from "../trust/trust-repo.js";
import { getSupplyLeadsForItem } from "../leads/leads-repo.js";
import { getPoolById } from "../pools/pools-repo.js";
import { attemptPubDeal } from "../mechanics/pub-deal/attempt.js";
import type { AuctionLot } from "../auction/types.js";
import type { FlawType, QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface PubDealAutonomyOptions {
  /** Locations where pub-deal attempts can happen (a skin's social venues). */
  readonly pubLocationIds: readonly number[];
  /** Actors eligible to participate as either buyer or seller. */
  readonly npcActorIds: readonly number[];
  /** Per-actor bidder profiles. Buyers value lots through these. */
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
  /** Hour window in which attempts can fire. Inclusive on both ends. */
  readonly startHour?: number;
  readonly endHour?: number;
  /** How many pairing trials each pub-location runs per hour. */
  readonly attemptsPerHour?: number;
  /** Probability each trial actually attempts (otherwise just chatter). */
  readonly pairChance?: number;
  /** Days from today until the deal's delivery deadline (normal sales). */
  readonly deadlineDaysOut?: number;
  /** Seller's mark-up over their acquisition cost as their opening ask. */
  readonly sellerTargetMarkup?: number;
  /**
   * Buyer's opening offer as a fraction of their per-unit ceiling.
   * Lower = bigger anchoring move = more counter-offer rounds before
   * meeting in the middle. Default 0.2.
   */
  readonly buyerTargetFraction?: number;
  /**
   * Probability (0..1) that an attempt becomes a forward-sale — the seller
   * commits to a quantity larger than they currently hold of that lot,
   * with a deadline several days out, betting they'll source more in time.
   * Defaults arise naturally when the bet doesn't pay off. v1 default: 0.25.
   */
  readonly forwardSellChance?: number;
  /**
   * For forward-sales, multiply the available lot quantity by a uniform
   * factor in [min, max] to get the committed quantity. Default [1.5, 3].
   */
  readonly forwardSellQtyMultiplierRange?: readonly [number, number];
  /** Deadline span for forward-sales: today + uniform[min, max] days. */
  readonly forwardSellDeadlineRange?: readonly [number, number];
  /**
   * If the buyer's trust in the seller is at or below this score, skip
   * the attempt entirely — the buyer won't deal with someone who's
   * defaulted on them too often. Default -25 (≈ 2-3 unrecovered defaults
   * given M6's -10/default and +2/clean-settle calibration).
   */
  readonly trustGatingThreshold?: number;
  /**
   * Economic tuning bundle. Tier multipliers, the buyer-ceiling
   * fraction (default 0.5 = aim for 50% of retail value), and the
   * tier-blind mode (whether the buyer values the lot at its actual
   * tier or assumes the listing's `pubAssumedTier`) all read from here.
   */
  readonly economics?: EconomicsConfig;
  /**
   * If set, the seller side must come from this set of actor ids.
   * Used by the shop-deal wiring to force dealer-sells-to-shopkeeper
   * direction (seller = dealer). When unset, any present actor in
   * `npcActorIds` may be the seller (the original pub behaviour).
   */
  readonly requireSellerFrom?: ReadonlySet<number>;
  /**
   * If set, the buyer side must come from this set of actor ids.
   * Used by the shop-deal wiring (buyer = shopkeeper).
   */
  readonly requireBuyerFrom?: ReadonlySet<number>;
}


/**
 * Evening pub-deal autonomy. During the configured hour window (default
 * 18–22) at each named pub location, pairs of NPCs are drawn and one
 * proposes selling a slice of their stock to the other. Pricing is built
 * from:
 *
 *   • Seller floor  = their per-unit acquisition cost (won't sell at a
 *     loss).
 *   • Seller target = floor × markup (default 1.5).
 *   • Buyer ceiling = min(per-unit valuation from their bidder profile,
 *                          per-unit cash budget).
 *   • Buyer target  = max(sellerFloor, ceiling × 0.6).
 *
 * If ranges overlap, the engine's rule-based negotiator runs and on
 * agreement creates a deal with `deadlineDay = today + deadlineDaysOut`
 * (default 1). Settlement happens through the existing daily-settlement
 * loop the next morning — short-stock cases default, propagating trust
 * hits and producing the cascading-failure beats the design was built for.
 *
 * v1 only sells stock the seller actually holds. Forward-sales (selling
 * stock you don't yet have) is a follow-up extension that loosens the
 * floor and accepts deeper deadlines.
 */
export function registerPubDealAutonomy(
  world: World,
  opts: PubDealAutonomyOptions,
): Unsubscribe {
  const startHour = opts.startHour ?? 18;
  const endHour = opts.endHour ?? 22;
  const attemptsPerHour = opts.attemptsPerHour ?? 3;
  const pairChance = opts.pairChance ?? 0.5;
  const deadlineDaysOut = opts.deadlineDaysOut ?? 1;
  const sellerTargetMarkup = opts.sellerTargetMarkup ?? 2.5;
  const buyerTargetFraction = opts.buyerTargetFraction ?? 0.2;
  const forwardSellChance = opts.forwardSellChance ?? 0.25;
  const forwardSellQtyRange =
    opts.forwardSellQtyMultiplierRange ?? ([1.5, 3] as const);
  const forwardSellDeadlineRange =
    opts.forwardSellDeadlineRange ?? ([2, 5] as const);
  const trustGatingThreshold = opts.trustGatingThreshold ?? -25;
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const npcSet = new Set(opts.npcActorIds);

  return world.onHour((clock) => {
    if (clock.hour < startHour || clock.hour > endHour) return;

    for (const locId of opts.pubLocationIds) {
      const presentAll = getActorsAtLocation(world.db, locId);
      const present = presentAll.filter((id) => npcSet.has(id));
      if (present.length < 2) continue;

      for (let trial = 0; trial < attemptsPerHour; trial += 1) {
        if (!world.rng.chance(pairChance)) continue;
        runOneAttempt({
          world,
          clock,
          locId,
          present,
          profiles: opts.bidderProfiles,
          normalDeadlineDay: clock.day + deadlineDaysOut,
          sellerTargetMarkup,
          buyerTargetFraction,
          forwardSellChance,
          forwardSellQtyRange,
          forwardSellDeadlineRange,
          trustGatingThreshold,
          economics,
          requireSellerFrom: opts.requireSellerFrom ?? null,
          requireBuyerFrom: opts.requireBuyerFrom ?? null,
        });
      }
    }
  });
}

function runOneAttempt(args: {
  world: World;
  clock: import("../core/clock.js").Clock;
  locId: number;
  present: readonly number[];
  profiles: ReadonlyMap<number, BidderProfile>;
  normalDeadlineDay: number;
  sellerTargetMarkup: number;
  buyerTargetFraction: number;
  forwardSellChance: number;
  forwardSellQtyRange: readonly [number, number];
  forwardSellDeadlineRange: readonly [number, number];
  trustGatingThreshold: number;
  economics: EconomicsConfig;
  requireSellerFrom: ReadonlySet<number> | null;
  requireBuyerFrom: ReadonlySet<number> | null;
}): void {
  const { world, clock, locId, present, profiles, economics } = args;

  if (present.length < 2) return;
  const sellerCandidates = args.requireSellerFrom
    ? present.filter((id) => args.requireSellerFrom!.has(id))
    : present;
  if (sellerCandidates.length === 0) return;
  const sellerId = world.rng.pick(sellerCandidates);
  const buyerCandidates = (args.requireBuyerFrom
    ? present.filter((id) => args.requireBuyerFrom!.has(id))
    : present
  ).filter((id) => id !== sellerId);
  if (buyerCandidates.length === 0) return;
  const buyerId = world.rng.pick(buyerCandidates);

  // Trust gate — buyer won't even sit down with a chronic defaulter.
  const trust = getTrust(world.db, buyerId, sellerId);
  if (trust.score <= args.trustGatingThreshold) {
    world.events.emit({
      type: "pubdeal.skipped-low-trust",
      at: clock,
      sellerActorId: sellerId,
      buyerActorId: buyerId,
      trustScore: trust.score,
    });
    return;
  }

  const lots = getStockLotsByOwner(world.db, sellerId);
  if (lots.length === 0) return;
  const lot = world.rng.pick(lots);

  // Roll for forward-sale: commit to MORE than the lot currently holds,
  // with a longer deadline. This is what makes the cascade comedy bite —
  // the seller takes on a delivery promise hoping to source more before
  // the deadline.
  const isForwardSale = world.rng.chance(args.forwardSellChance);
  let proposalQty: number;
  let deadlineDay: number;
  if (isForwardSale) {
    // Lead-driven sizing: the seller's confidence comes from the supply
    // leads they hold. If their notebook lists 200 units across two
    // contacts, they happily commit close to that. Two sellers whose
    // leads both reference the same pool will *both* forward-sell the
    // full quantity — and one of them eats the cascade when settlement
    // drains the shared pool first.
    const supplyLeads = getSupplyLeadsForItem(world.db, sellerId, lot.itemKindId)
      .filter((l) => l.subjectPoolId !== null);
    let leadAvailableQty = 0;
    for (const l of supplyLeads) {
      // Trust the lead's *current* understanding of pool availability if
      // we can read the pool; otherwise fall back to the lead's recorded
      // quantity.
      if (l.subjectPoolId === null) continue;
      const pool = getPoolById(world.db, l.subjectPoolId);
      if (pool && pool.flushedDay === null) {
        leadAvailableQty += pool.quantityRemaining;
      } else {
        leadAvailableQty += l.estimatedQuantity;
      }
    }
    if (leadAvailableQty > 0) {
      // Optimistic: commit own stock + 70% of perceived lead supply.
      proposalQty = Math.max(2, lot.quantity + Math.floor(leadAvailableQty * 0.7));
    } else {
      // Pure speculation: random over-commitment.
      const [lo, hi] = args.forwardSellQtyRange;
      const mult = lo + world.rng.next() * (hi - lo);
      proposalQty = Math.max(2, Math.round(lot.quantity * mult));
    }
    const [dlo, dhi] = args.forwardSellDeadlineRange;
    deadlineDay = clock.day + world.rng.int(dlo, dhi + 1);
  } else {
    proposalQty = Math.max(1, Math.min(lot.quantity, world.rng.int(1, 11)));
    deadlineDay = args.normalDeadlineDay;
  }

  // Cap proposal by what the seller can physically transport. A small-
  // tier seller would never agree to deliver hundreds of units via a
  // coat pocket — so the autonomy doesn't propose it either. Also
  // bump the deadline to give the seller's transport tier enough time
  // to physically make the trip — committing a lorry-load for delivery
  // tomorrow is a guaranteed default.
  const sellerActor = getActorById(world.db, sellerId);
  if (sellerActor) {
    const limit = TRANSPORT_LIMITS[sellerActor.transportCapacity];
    if (limit <= 0) return; // can't move anything; abandon attempt
    proposalQty = Math.max(1, Math.min(proposalQty, limit));

    const transit = TRANSIT_DAYS_BY_TIER[sellerActor.transportCapacity];
    const minDeadline = clock.day + transit;
    if (deadlineDay < minDeadline) deadlineDay = minDeadline;
  }

  const item = getItemKindById(world.db, lot.itemKindId);
  if (!item) return;

  // Buyer's perceived tier — either the lot's actual tier (full info)
  // or an assumed tier (tier-blind: buyer hasn't inspected the seller's
  // stock). The lot's `qualityTier` is what the seller knows; the
  // buyer's mental model uses `perceivedTier`.
  const perceivedTier: QualityTier =
    economics.pubBuyerTierMode === "assumed"
      ? economics.pubAssumedTier
      : lot.qualityTier;
  const tierMult = economics.tierMultipliers[perceivedTier];
  const trueLotValue = Math.max(1, Math.round(item.baseValue * tierMult * proposalQty));

  // Build the buyer's profile, forcing flaw detection if they already know
  // about this item kind's flaw.
  const baseProfile = profiles.get(buyerId) ?? FALLBACK_BIDDER_PROFILE;
  const buyerProfile =
    item.flawType !== null &&
    actorKnowsFlaw(world.db, buyerId, item.id, item.flawType)
      ? withForcedFlawDetection(baseProfile, item.flawType)
      : baseProfile;

  // Synthetic AuctionLot for appraisal — the only field anyone reads is
  // `inspectionAdjustment(lot)` and v1 profiles don't set that callback,
  // so the synthetic shape is harmless. The appraised tier matches the
  // buyer's perceived tier so flaw/customer-fit math stays consistent.
  const fakeLot: AuctionLot = {
    id: -1,
    sourcePoolId: null,
    itemKindId: item.id,
    qualityTier: perceivedTier,
    quantity: proposalQty,
    floorPrice: 0,
    listedDay: clock.day,
    scheduledHour: null,
    clearedDay: null,
    clearedPrice: null,
    clearedToActorId: null,
  };

  const appraisal = appraiseLot({
    profile: buyerProfile,
    lot: fakeLot,
    category: item.category,
    flawType: item.flawType,
    itemTargetCustomers: item.targetCustomers,
    trueLotValue,
    rng: world.rng,
    economics,
  });

  const buyer = getActorById(world.db, buyerId);
  if (!buyer) return;

  // The appraisal is the buyer's noisy estimate of *retail* value (what
  // they think they can resell the lot for). At the pub the buyer is
  // sourcing for onward sale, so they aim to pay only a fraction of
  // that — leaving margin for transport, risk, and profit. The fraction
  // is configurable via economics.pubBuyerCeilingFraction (default 0.5).
  // Cash still caps it.
  const buyerTotalCeiling = Math.min(
    Math.round(appraisal.valuation * economics.pubBuyerCeilingFraction),
    buyer.cash,
  );
  if (buyerTotalCeiling < proposalQty) return; // can't even bid £1/unit

  const buyerCeilingPerUnit = Math.floor(buyerTotalCeiling / proposalQty);
  const sellerFloorPerUnit = Math.max(1, lot.acquiredUnitPrice);
  if (sellerFloorPerUnit > buyerCeilingPerUnit) return; // no overlap

  // Seller opens high, buyer opens low — wide opening anchors create
  // room for visible back-and-forth instead of insta-accepting an
  // already-reasonable opener.
  const sellerTargetPerUnit = Math.max(
    sellerFloorPerUnit,
    Math.round(lot.acquiredUnitPrice * args.sellerTargetMarkup),
  );
  // Buyer opens at a small fraction of their ceiling — deliberately
  // *not* clamped up to the seller's floor, so the buyer can anchor
  // below cost and force the seller to climb down through real rounds.
  // Floor of £1/unit just to keep arithmetic well-defined.
  const buyerTargetPerUnit = Math.min(
    buyerCeilingPerUnit,
    Math.max(1, Math.round(buyerCeilingPerUnit * args.buyerTargetFraction)),
  );

  const initiator: "seller" | "buyer" = world.rng.next() < 0.5 ? "seller" : "buyer";

  // Concession rates per attempt: smaller mean (~0.15) gives more
  // visible back-and-forth than the old flat 0.3, and per-attempt RNG
  // jitter stops every haggle reading like the same arithmetic sequence.
  // Range ~0.08–0.22 — enough to occasionally produce a hard bargainer
  // (low rate, slow concession) opposite a soft one (high rate, quick fold).
  const sellerConcedeRate = 0.08 + world.rng.next() * 0.14;
  const buyerConcedeRate = 0.08 + world.rng.next() * 0.14;

  attemptPubDeal({
    db: world.db,
    events: world.events,
    rng: world.rng,
    clock,
    locationId: locId,
    seller: {
      actorId: sellerId,
      floor: sellerFloorPerUnit,
      target: sellerTargetPerUnit,
      concedeRate: sellerConcedeRate,
    },
    buyer: {
      actorId: buyerId,
      ceiling: buyerCeilingPerUnit,
      target: buyerTargetPerUnit,
      concedeRate: buyerConcedeRate,
    },
    itemKindId: item.id,
    qualityTier: lot.qualityTier,
    quantity: proposalQty,
    initiator,
    deadlineDay,
  });
  // The forward-sale fact isn't carried into the deal record (deals are
  // promises regardless), but the trace can be reconstructed from
  // proposalQty vs the seller's lot quantity at the time of agreement.
}

function withForcedFlawDetection(
  profile: BidderProfile,
  flawType: FlawType,
): BidderProfile {
  const merged = new Map(profile.flawTypeDetection);
  merged.set(flawType, 1);
  return { ...profile, flawTypeDetection: merged };
}

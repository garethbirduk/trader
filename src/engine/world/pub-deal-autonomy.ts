import type { World, Unsubscribe } from "../core/world.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import {
  FALLBACK_BIDDER_PROFILE,
  appraiseLot,
} from "../auction/bidder-profile.js";
import { estimateUnitRetail } from "../auction/estimate.js";
import { actorKnowsFlaw } from "../inspection/inspection-repo.js";
import { getActorById } from "../actors/actors-repo.js";
import { TRANSIT_DAYS_BY_TIER, TRANSPORT_LIMITS } from "../actors/types.js";
import { getActorsAtLocation } from "../locations/locations.js";
import { getItemKindById } from "../stock/items-repo.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import { getTrust } from "../trust/trust-repo.js";
import { getRepLeadAbout, getSupplyLeadsForItem } from "../leads/leads-repo.js";
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
   * Rep-based abort. If the buyer holds a warm rep lead about the seller
   * with damage at or above `repAbortDamageThreshold` and hop count at
   * or below `repAbortMaxHops`, the attempt is skipped. Hop ceiling
   * prevents a wildly mutated 6th-hand rumour from gating real trade;
   * warm-only means the warning has to still feel current. Set
   * `repAbortDamageThreshold` to `Infinity` to disable.
   */
  readonly repAbortDamageThreshold?: number;
  readonly repAbortMaxHops?: number;
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
  const repAbortDamageThreshold = opts.repAbortDamageThreshold ?? 100;
  const repAbortMaxHops = opts.repAbortMaxHops ?? 2;
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
          repAbortDamageThreshold,
          repAbortMaxHops,
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
  repAbortDamageThreshold: number;
  repAbortMaxHops: number;
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

  // Trust gate — buyer won't even sit down with a chronic defaulter
  // they've been burned by themselves.
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

  // Rep gate — even without a first-hand trust dent, a warning passed
  // through the rumour mill might be enough to walk away. We honour
  // warm rep leads within a hop ceiling (deep-hops are too mangled to
  // trust), with damage at or above the configured threshold.
  const rep = getRepLeadAbout(world.db, buyerId, sellerId);
  if (
    rep !== null &&
    rep.confidence === "warm" &&
    rep.hopCount <= args.repAbortMaxHops &&
    rep.estimatedUnitPrice >= args.repAbortDamageThreshold
  ) {
    world.events.emit({
      type: "pubdeal.skipped-rep",
      at: clock,
      locationId: locId,
      sellerActorId: sellerId,
      buyerActorId: buyerId,
      repLeadId: rep.id,
      damageOnLead: rep.estimatedUnitPrice,
      hopCount: rep.hopCount,
    });
    return;
  }

  const allLots = getStockLotsByOwner(world.db, sellerId);
  if (allLots.length === 0) return;
  // Pick a kind+tier the seller wants to push, then aggregate their
  // whole bag of that kind+tier — sellers offer all (or most) of what
  // they have, not a random slice of one stock_lot row.
  const seedLot = world.rng.pick(allLots);
  const sameTierLots = allLots.filter(
    (l) =>
      l.itemKindId === seedLot.itemKindId &&
      l.qualityTier === seedLot.qualityTier,
  );
  const onHand = sameTierLots.reduce((sum, l) => sum + l.quantity, 0);

  // Transport constraints up front.
  const sellerActor = getActorById(world.db, sellerId);
  if (!sellerActor) return;
  const transit = TRANSIT_DAYS_BY_TIER[sellerActor.transportCapacity];
  const transportLimit = TRANSPORT_LIMITS[sellerActor.transportCapacity];
  if (transportLimit <= 0) return;

  // Forward-sell evaluation — only on warm, low-hop, pool-grounded supply
  // leads that match the kind (and tier if specified). A thin cold rumour
  // isn't justification for committing stock you don't have.
  const supplyLeads = getSupplyLeadsForItem(world.db, sellerId, seedLot.itemKindId)
    .filter(
      (l) =>
        l.subjectPoolId !== null &&
        l.confidence === "warm" &&
        l.hopCount <= economics.forwardSellMaxHopCount &&
        (l.subjectQualityTier === null ||
          l.subjectQualityTier === seedLot.qualityTier),
    );
  let sourceable = 0;
  for (const l of supplyLeads) {
    if (l.subjectPoolId === null) continue;
    const pool = getPoolById(world.db, l.subjectPoolId);
    if (pool && pool.flushedDay === null) {
      sourceable += pool.quantityRemaining;
    } else {
      sourceable += l.estimatedQuantity;
    }
  }
  // 70% confidence haircut — the seller's optimism is real but not blind.
  sourceable = Math.floor(sourceable * 0.7);

  // Decide whether to engage the forward-sale path. Requires both:
  // gossip backing (sourceable > 0) AND the coin-flip. Deadline must
  // allow at least 2× transit (one source trip + one delivery trip);
  // if the rolled deadline is too short we bump it up so the commitment
  // is physically achievable.
  const wantsForward = sourceable > 0 && world.rng.chance(args.forwardSellChance);
  let deadlineDay = args.normalDeadlineDay;
  if (wantsForward) {
    const [dlo, dhi] = args.forwardSellDeadlineRange;
    deadlineDay = clock.day + world.rng.int(dlo, dhi + 1);
    const minForwardDeadline = clock.day + 2 * transit;
    if (deadlineDay < minForwardDeadline) deadlineDay = minForwardDeadline;
  }
  // Normal-path deadline also respects single-trip transit.
  const minNormalDeadline = clock.day + transit;
  if (deadlineDay < minNormalDeadline) deadlineDay = minNormalDeadline;

  // Seller's ideal commit = whole bag (+ forward-sourceable), capped
  // by what they can carry. This is the size proposal headed into the
  // haggle; buyer affordability scales it down below.
  let sellerIdealQty = wantsForward ? onHand + sourceable : onHand;
  sellerIdealQty = Math.min(sellerIdealQty, transportLimit);
  if (sellerIdealQty < 1) return;

  const item = getItemKindById(world.db, seedLot.itemKindId);
  if (!item) return;

  // Buyer's perceived tier — either the lot's actual tier (full info)
  // or an assumed tier (tier-blind: buyer hasn't inspected the seller's
  // stock). The lot's `qualityTier` is what the seller knows; the
  // buyer's mental model uses `perceivedTier`.
  const perceivedTier: QualityTier =
    economics.pubBuyerTierMode === "assumed"
      ? economics.pubAssumedTier
      : seedLot.qualityTier;
  const tierMult = economics.tierMultipliers[perceivedTier];

  // Build the buyer's profile, forcing flaw detection if they already know
  // about this item kind's flaw.
  const baseProfile = profiles.get(buyerId) ?? FALLBACK_BIDDER_PROFILE;
  const buyerProfile =
    item.flawType !== null &&
    actorKnowsFlaw(world.db, buyerId, item.id, item.flawType)
      ? withForcedFlawDetection(baseProfile, item.flawType)
      : baseProfile;

  // Synthetic AuctionLot for appraisal at the seller's ideal qty — we
  // need the buyer's RRP estimate at full proposed size for the £100
  // gate.
  const trueLotValueAtIdeal = Math.max(
    1,
    Math.round(item.baseValue * tierMult * sellerIdealQty),
  );
  const fakeLot: AuctionLot = {
    id: -1,
    sourcePoolId: null,
    itemKindId: item.id,
    qualityTier: perceivedTier,
    quantity: sellerIdealQty,
    floorPrice: 0,
    listedDay: clock.day,
    scheduledHour: null,
    provenance: null,
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
    trueLotValue: trueLotValueAtIdeal,
    rng: world.rng,
    economics,
  });

  // Seller's own retail estimate — deterministic tier-anchored mid over
  // the bag they actually hold (excludes forward-sourceable; you don't
  // value rumour stock as if you've already got it).
  const sellerRrp = Math.round(
    item.baseValue *
      economics.tierMultipliers[seedLot.qualityTier] *
      onHand,
  );

  // Rule 7 — symmetric £100 RRP floor. Either side's number below the
  // threshold and neither bothers haggling. Buyer's number is the noisy
  // appraisal at the full proposed bag; seller's is their deterministic
  // mid over their actual on-hand stock.
  if (
    appraisal.valuation < economics.pubDealRrpFloor ||
    sellerRrp < economics.pubDealRrpFloor
  ) {
    world.events.emit({
      type: "pubdeal.skipped-too-small",
      at: clock,
      locationId: locId,
      sellerActorId: sellerId,
      buyerActorId: buyerId,
      itemKindId: item.id,
      qualityTier: seedLot.qualityTier,
      sellerRrp,
      buyerRrp: appraisal.valuation,
      floor: economics.pubDealRrpFloor,
    });
    return;
  }

  const buyer = getActorById(world.db, buyerId);
  if (!buyer) return;

  // Buyer's total ceiling = appraised retail × fraction, capped by cash.
  const buyerTotalCeiling = Math.min(
    Math.round(appraisal.valuation * economics.pubBuyerCeilingFraction),
    buyer.cash,
  );
  if (buyerTotalCeiling < 1) return;

  // Resize qty to what the buyer can actually afford. We use a rough
  // mid price between the seller's floor and the buyer's would-be
  // ceiling at sellerIdealQty as a planning estimate — the haggle will
  // tighten this up later. The resulting `proposalQty` is what we lock
  // in; the converged unit price comes from the haggle.
  const sellerFloorPerUnit = Math.max(1, seedLot.acquiredUnitPrice);
  const ceilingAtIdeal = Math.max(
    1,
    Math.floor(buyerTotalCeiling / sellerIdealQty),
  );
  const roughMidPrice = Math.max(
    sellerFloorPerUnit,
    Math.round((sellerFloorPerUnit + ceilingAtIdeal) / 2),
  );
  const buyerAffordableQty = Math.max(
    1,
    Math.floor(buyer.cash / roughMidPrice),
  );
  const proposalQty = Math.min(sellerIdealQty, buyerAffordableQty);

  // Rule 3 — 25% slice floor. If the converged qty would break the
  // seller's bag into a slice smaller than `pubDealMinSlicePct` of
  // what they were willing to push, neither side bothers. The "bag"
  // here is the seller's on-hand stock; forward-sourceable counts
  // for what they could promise but not for what counts as the bag
  // being broken up.
  const sliceFloor = Math.ceil(onHand * economics.pubDealMinSlicePct);
  if (proposalQty < Math.max(1, sliceFloor)) return;

  // Final per-unit ceiling at the (potentially scaled-down) proposalQty.
  const buyerCeilingPerUnit = Math.max(
    1,
    Math.floor(buyerTotalCeiling / proposalQty),
  );
  if (sellerFloorPerUnit > buyerCeilingPerUnit) return; // no overlap

  // Seller opens high, buyer opens low — wide opening anchors create
  // room for visible back-and-forth instead of insta-accepting an
  // already-reasonable opener.
  const sellerTargetPerUnit = Math.max(
    sellerFloorPerUnit,
    Math.round(seedLot.acquiredUnitPrice * args.sellerTargetMarkup),
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

  // Belief snapshots — what each side thinks a unit is worth right
  // now, surfaced into the pubdeal.agreed event so the UI can show
  // the two bands side-by-side. The seller's belief uses the lot's
  // actual tier (they know what they're holding); the buyer's belief
  // uses the perceived tier (they only see what the seller's chosen
  // to display).
  const sellerProfile = profiles.get(sellerId) ?? FALLBACK_BIDDER_PROFILE;
  const sellerBeliefEstimate = estimateUnitRetail(
    sellerProfile,
    item,
    seedLot.qualityTier,
    economics,
  );
  const buyerBeliefEstimate = estimateUnitRetail(
    buyerProfile,
    item,
    perceivedTier,
    economics,
  );
  const trueRrpPerUnit =
    item.baseValue * economics.tierMultipliers[seedLot.qualityTier];

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
    qualityTier: seedLot.qualityTier,
    quantity: proposalQty,
    initiator,
    deadlineDay,
    sellerBelief: {
      low: sellerBeliefEstimate.low,
      high: sellerBeliefEstimate.high,
    },
    buyerBelief: {
      low: buyerBeliefEstimate.low,
      high: buyerBeliefEstimate.high,
    },
    truePricePerUnit: Math.round(trueRrpPerUnit),
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

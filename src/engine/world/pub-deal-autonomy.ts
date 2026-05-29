import type { World, Unsubscribe } from "../core/world.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import { FALLBACK_KNOWLEDGE_PROFILE } from "../knowledge/types.js";
import { estimateLotValue } from "../perception/lot-value.js";
import { estimatePriceBand } from "../perception/estimate.js";
import {
  buildCompositePayloadFromLotValuation,
  insertJudgement,
} from "../perception/judgement-log-repo.js";
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
import type { QualityTier } from "../stock/types.js";
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
  readonly knowledgeProfiles: ReadonlyMap<number, KnowledgeProfile>;
  /** Hour window in which attempts can fire. Inclusive on both ends. */
  readonly startHour?: number;
  readonly endHour?: number;
  /** How many pairing trials each pub-location runs per hour. */
  readonly attemptsPerHour?: number;
  /** Probability each trial actually attempts (otherwise just chatter). */
  readonly pairChance?: number;
  /** Days from today until the deal's delivery deadline (normal sales). */
  readonly deadlineDaysOut?: number;
  /**
   * @deprecated Cost-anchored markup is gone. The seller's target is
   * now derived from their belief band via `sellerAnchorAggression`.
   * Kept on the type for back-compat; ignored at runtime.
   */
  readonly sellerTargetMarkup?: number;
  /**
   * Multiplier on the seller's per-unit belief HIGH to set their
   * opening target. 1.0 = anchor at honest top-of-belief; 1.5 = hedge
   * high; 0.8 = aim for a quick sale below honest top. Replaces the
   * cost-anchored model so a lucky-buy seller doesn't leave belief
   * surplus on the table and a bad-buy seller can actually clear
   * stock below cost. Default 1.0.
   */
  readonly sellerAnchorAggression?: number;
  /**
   * Multiplier on the seller's per-unit belief LOW to set their
   * walk-away floor. 1.0 = won't go below honest low; 0.5 = willing
   * to halve the bottom of their belief for a real offer; 0.0 =
   * pure price-taker. Default 0.5 — captures the typical pubdeal
   * dynamic where a trader actively looking to clear stock will
   * concede well below their honest low. Premium-stall sellers
   * (Boyce-types) might use 0.85 or higher.
   *
   * **Cost basis is no longer the floor.** A seller who paid £200
   * for stock they now believe is worth £30 will clear at ~£15 and
   * eat the loss — that's the price of a bad buy. The "below cost"
   * fact surfaces on the deal record (acquired_unit_price vs
   * agreed unit_price), not in the negotiation logic.
   */
  readonly sellerFloorMultiplier?: number;
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
  // sellerTargetMarkup is deprecated and ignored; the seller now
  // anchors on their belief band rather than their cost basis.
  void opts.sellerTargetMarkup;
  const sellerAnchorAggression = opts.sellerAnchorAggression ?? 1.0;
  const sellerFloorMultiplier = opts.sellerFloorMultiplier ?? 0.5;
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
          profiles: opts.knowledgeProfiles,
          normalDeadlineDay: clock.day + deadlineDaysOut,
          sellerAnchorAggression,
          sellerFloorMultiplier,
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
  profiles: ReadonlyMap<number, KnowledgeProfile>;
  normalDeadlineDay: number;
  sellerAnchorAggression: number;
  sellerFloorMultiplier: number;
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

  // Buyer's profile — the judgement engine handles "previously
  // burned by this flaw" via the knownFlawType arg below; no need
  // to pre-mutate the profile.
  const buyerProfile = profiles.get(buyerId) ?? FALLBACK_KNOWLEDGE_PROFILE;

  // Seller's profile + per-unit belief band. The belief drives the
  // haggle floor and target — cost basis is sunk and no longer
  // anchors the negotiation (todolist:104-107).
  const sellerProfile = profiles.get(sellerId) ?? FALLBACK_KNOWLEDGE_PROFILE;
  const sellerBeliefEstimate = estimatePriceBand({
    db: world.db,
    actorId: sellerId,
    category: item.category,
    truth: item.baseValue * economics.tierMultipliers[seedLot.qualityTier],
    tierMultiplier: economics.tierMultipliers[seedLot.qualityTier],
    profileOverride: sellerProfile,
  });
  // Buyer's per-unit belief band, used for the event snapshot only.
  // The buyer's actual ceiling routes through `estimateLotValue`
  // below, which is the engine's authoritative valuation.
  const buyerBeliefEstimate = estimatePriceBand({
    db: world.db,
    actorId: buyerId,
    category: item.category,
    truth: item.baseValue * economics.tierMultipliers[perceivedTier],
    tierMultiplier: economics.tierMultipliers[perceivedTier],
    profileOverride: buyerProfile,
  });
  const trueRrpPerUnit =
    item.baseValue * economics.tierMultipliers[seedLot.qualityTier];

  // Synthetic AuctionLot for appraisal at the seller's ideal qty — we
  // need the buyer's RRP estimate at full proposed size for the £100
  // gate.
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
  // Buyer's RRP estimate at the proposed bag size. Same compositional
  // path as the auction call site, with pubdeal-specific overrides:
  //   • condition is overridden to `perceivedTier` — the existing
  //     pubBuyerTierMode logic decides whether the buyer accepts the
  //     seller's tier claim or substitutes a pessimistic assumed tier
  //   • knownFlawType short-circuits the detection roll when the
  //     buyer has previously been burned by this item kind's flaw
  //   • flawDetectionBonus carries the character-arm delta: the
  //     buyer reads tells better when their social exceeds seller's
  const knownBuyerFlaw =
    item.flawType !== null &&
    actorKnowsFlaw(world.db, buyerId, item.id, item.flawType);

  // Character arm (docs/judgement.md). Mike (0.85) reading Boyce
  // (0.7) gets +0.075 detection; Boyce pitching to Trigger (0.2)
  // gives Trigger −0.25. Same-score pairings cancel out.
  const buyerActor = getActorById(world.db, buyerId);
  const sellerActorForRead = getActorById(world.db, sellerId);
  const socialDelta =
    (buyerActor?.socialScore ?? 0.5) -
    (sellerActorForRead?.socialScore ?? 0.5);
  const flawDetectionBonus = economics.characterArmAlpha * socialDelta;

  const knowledgeProfile = buyerProfile;
  const valuationResult = estimateLotValue({
    db: world.db,
    actorId: buyerId,
    lot: fakeLot,
    rng: world.rng,
    economics,
    profileOverride: knowledgeProfile,
    perceivedTierOverride: perceivedTier,
    flawDetectionBonus,
    ...(knownBuyerFlaw && item.flawType !== null
      ? { knownFlawType: item.flawType }
      : {}),
  });
  const appraisedValuation = valuationResult.perceivedLotValue;

  // Audit trail (docs/judgement.md). Persist the buyer's appraisal —
  // the most decision-driving judgement in the flow (gates the £100
  // floor, sets the ceiling, carries the character-arm social-delta
  // contribution). Context ref is the seller's stock lot id; the
  // UI joins (buyer_actor_id, day, hour, seedLot.id) → judgement.
  const buyerJudgementPayload = buildCompositePayloadFromLotValuation({
    db: world.db,
    lot: fakeLot,
    item,
    economics,
    valuation: valuationResult,
    flawDetectionBonus,
    buyerSocial: buyerActor?.socialScore ?? 0.5,
    sellerSocial: sellerActorForRead?.socialScore ?? 0.5,
    characterArmAlpha: economics.characterArmAlpha,
    ...(knownBuyerFlaw && item.flawType !== null
      ? { knownFlawType: item.flawType }
      : {}),
  });
  const buyerJudgementId = insertJudgement(world.db, {
    day: clock.day,
    hour: clock.hour,
    actorId: buyerId,
    arm: "composite",
    contextKind: "pubdeal-appraisal",
    contextRefId: seedLot.id,
    payload: buyerJudgementPayload,
  });
  void buyerJudgementId;

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
    appraisedValuation < economics.pubDealRrpFloor ||
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
      buyerRrp: appraisedValuation,
      floor: economics.pubDealRrpFloor,
    });
    return;
  }

  const buyer = getActorById(world.db, buyerId);
  if (!buyer) return;

  // Buyer's total ceiling = appraised retail × fraction, capped by cash.
  const buyerTotalCeiling = Math.min(
    Math.round(appraisedValuation * economics.pubBuyerCeilingFraction),
    buyer.cash,
  );
  if (buyerTotalCeiling < 1) return;

  // Seller's belief-anchored floor & target. Floor sits below honest
  // belief.low by `sellerFloorMultiplier` (default 0.9 — willing to
  // concede a little). Target sits at belief.high × aggression
  // (default 1.0 — anchor at honest top). Cost basis is *not* in this
  // calculation; a bad-buy seller can clear stock below cost, and a
  // lucky-buy seller doesn't leave belief surplus on the table.
  const sellerFloorPerUnit = Math.max(
    1,
    Math.round(sellerBeliefEstimate.low * args.sellerFloorMultiplier),
  );

  // Resize qty to what the buyer can actually afford. Rough mid price
  // for the planning estimate uses the seller's floor and the buyer's
  // ceiling at the unproposed qty — the haggle tightens this up later.
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
  // already-reasonable opener. Seller target anchors on belief.high.
  const sellerTargetPerUnit = Math.max(
    sellerFloorPerUnit,
    Math.round(sellerBeliefEstimate.high * args.sellerAnchorAggression),
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
    // Belief-anchored openers create wider initial gaps than the old
    // cost-anchored model (seller opens at belief.high, often well
    // above the buyer's resell-margin ceiling). Bump maxRounds so
    // the haggle has time to converge — 30 turns lets a 0.1
    // concession rate close a 30× gap before timing out.
    maxRounds: 30,
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


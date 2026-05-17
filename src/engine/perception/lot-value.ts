import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import type { AuctionLot } from "../auction/types.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { FlawType, ItemKind, QualityTier } from "../stock/types.js";
import { loadKnowledgeProfile } from "../knowledge/skills-repo.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import {
  estimateCondition,
  type ConditionArmResult,
} from "./arms.js";
import { estimate } from "./estimate.js";
import type { EstimateResult } from "./types.js";

/**
 * Compositional auction-lot valuation — Condition ∘ Price.
 *
 * Authoritative buyer-valuation pipeline — an actor's ceiling for a
 * given lot, including flaw + customer-fit discounts. Routes the
 * two perception axes through the judgement engine
 * (docs/judgement.md §"Composition"):
 *
 *   1. Condition arm → which tier?
 *   2. Price arm     → £/unit for the perceived tier
 *
 * Compound uncertainty: a novice on watches gets tier wrong (broken
 * not mint), and price lerp'd toward the anchor — ending well below
 * true value on a £1000 lot.
 *
 * Override exists for the auction's "uninspected bidder" case:
 *   • `perceivedTierOverride` — listing hides the tier; the actor
 *     substitutes a pessimistic-realist guess (typically
 *     `economics.pubAssumedTier`).
 *
 * Flaw detection is composed with the character arm via the
 * `flawDetectionBonus` arg — see `pub-deal-autonomy.ts` for the
 * social-delta wiring. Customer-fit multiplier is applied to the
 * final perceivedLotValue.
 */

export interface LotValuation {
  readonly perceivedTier: QualityTier;
  /** Per-unit perceived £, before flaw / customer-fit multipliers. */
  readonly perceivedUnitValue: number;
  /** Final per-lot £ valuation (unit × quantity × multipliers). */
  readonly perceivedLotValue: number;
  readonly flawDetected: boolean;
  readonly flawMultiplier: number;
  readonly customerFitMultiplier: number;
  /** Diagnostics — populated when the condition arm actually ran
   *  (null when the override path skipped it). */
  readonly condition: ConditionArmResult | null;
  readonly price: EstimateResult;
}

export interface EstimateLotValueArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly lot: AuctionLot;
  readonly rng: SeededRNG;
  readonly economics?: EconomicsConfig;
  /** Cached profile — saves a DB roundtrip in hot loops. */
  readonly profileOverride?: KnowledgeProfile;
  /** Skip condition arm; substitute this tier as perceived. */
  readonly perceivedTierOverride?: QualityTier;
  /**
   * When set, the lot is known to carry this flaw type AND the actor
   * already knows about it (e.g. via inspection or by being burned).
   * The flaw-detection coin toss is short-circuited to "always spots
   * it." Mirrors the `withForcedFlawDetection` behaviour in the
   * legacy bidder pipeline.
   */
  readonly knownFlawType?: FlawType | null;
  /**
   * Additive modifier to the flaw-detection score before the coin
   * toss — the character-arm hook (docs/judgement.md). Positive
   * values let a high-social buyer spot tells a low-social seller
   * can't conceal; negative values let a smooth-talking high-social
   * seller suppress the buyer's tell-reading. The pub-deal wiring
   * computes this as `economics.characterArmAlpha × (buyer_social −
   * seller_social)`. The result is clamp01'd before the roll, so
   * arbitrarily large bonuses still saturate at certain detection.
   */
  readonly flawDetectionBonus?: number;
}

export function estimateLotValue(args: EstimateLotValueArgs): LotValuation {
  const economics = args.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const profile =
    args.profileOverride ?? loadKnowledgeProfile(args.db, args.actorId);

  const item = requireItemKind(args.db, args.lot.itemKindId);

  // ── 1. Condition arm ──────────────────────────────────────────
  let condition: ConditionArmResult | null = null;
  let perceivedTier: QualityTier;
  if (args.perceivedTierOverride !== undefined) {
    perceivedTier = args.perceivedTierOverride;
  } else {
    condition = estimateCondition({
      db: args.db,
      actorId: args.actorId,
      truthTier: args.lot.qualityTier,
      category: item.category,
      rng: args.rng,
      profileOverride: profile,
    });
    perceivedTier = condition.perceivedTier;
  }

  // ── 2. Price arm ──────────────────────────────────────────────
  const tierMult =
    economics.tierMultipliers[perceivedTier] ??
    economics.tierMultipliers.fair;
  const perceivedTruthUnit = item.baseValue * tierMult;
  const price = estimate({
    db: args.db,
    actorId: args.actorId,
    arm: "price",
    key: item.category,
    truth: perceivedTruthUnit,
    tierMultiplier: tierMult,
    rng: args.rng,
    profileOverride: profile,
  });
  const perceivedUnitValue = Math.max(0, price.sample);

  // ── 3. Flaw detection (legacy mechanic, preserved) ────────────
  // The character-arm hook adds a (possibly negative) bonus on top
  // of the base detection score. Already-known flaws stay forced
  // 100% — once you've been burned you always spot it, regardless
  // of who's pitching.
  let flawDetected = false;
  let flawMultiplier = 1;
  if (item.flawType !== null) {
    if (args.knownFlawType === item.flawType) {
      flawDetected = true;
      flawMultiplier = economics.flawDiscount[item.flawType];
      // Still advance the RNG so seed-stability between knownFlaw
      // and unknown-flaw branches stays predictable.
      args.rng.next();
    } else {
      const base =
        profile.flawDetection.get(item.flawType) ??
        profile.defaultFlawDetection;
      const bonus = args.flawDetectionBonus ?? 0;
      const effective = clamp01(base + bonus);
      flawDetected = args.rng.next() < effective;
      if (flawDetected) {
        flawMultiplier = economics.flawDiscount[item.flawType];
      }
    }
  }

  // ── 4. Customer-fit (legacy mechanic, preserved) ──────────────
  const customerFitMultiplier = computeCustomerFit(
    item.targetCustomers ?? [],
    profile.customerTypes ?? [],
    economics.customerMismatchMultiplier,
  );

  const perceivedLotValue = Math.max(
    0,
    Math.round(
      perceivedUnitValue *
        args.lot.quantity *
        flawMultiplier *
        customerFitMultiplier,
    ),
  );

  return {
    perceivedTier,
    perceivedUnitValue,
    perceivedLotValue,
    flawDetected,
    flawMultiplier,
    customerFitMultiplier,
    condition,
    price,
  };
}

function requireItemKind(db: DB, kindId: number): ItemKind {
  const it = getItemKindById(db, kindId);
  if (!it) throw new Error(`estimateLotValue: item_kind ${kindId} not found`);
  return it;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeCustomerFit(
  itemTargets: readonly string[],
  buyerTypes: readonly string[],
  mismatchMultiplier: number,
): number {
  if (itemTargets.length === 0) return 1;
  if (buyerTypes.length === 0) return 1;
  for (const t of itemTargets) {
    if (buyerTypes.includes(t)) return 1;
  }
  return mismatchMultiplier;
}

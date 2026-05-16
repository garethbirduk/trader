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
  estimateIdentity,
  type ConditionArmResult,
  type IdentityArmResult,
} from "./arms.js";
import { estimate } from "./estimate.js";
import type { EstimateResult } from "./types.js";

/**
 * Compositional auction-lot valuation — Identity ∘ Condition ∘ Price.
 *
 * Authoritative buyer-valuation pipeline — an actor's ceiling for a
 * given lot, including flaw + customer-fit discounts. Routes the
 * three perception axes through the judgement engine
 * (docs/judgement.md §"Composition"):
 *
 *   1. Identity arm  → which kind does the actor think this is?
 *   2. Condition arm → which tier?
 *   3. Price arm     → £/unit for the perceived (kind, tier)
 *
 * Compound uncertainty is the whole point: a novice on watches gets
 * id wrong (£50 Rulex), tier wrong (broken not mint), and price
 * lerp'd toward the anchor — ending at e.g. £30 on a £1000 lot.
 *
 * Overrides exist for the auction's "uninspected bidder" case:
 *   • `perceivedKindIdOverride` — listing names the kind; identity
 *     arm doesn't apply when the actor hasn't actually examined
 *     the goods. Pass `lot.itemKindId` here for uninspected.
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
  readonly perceivedKindId: number;
  readonly perceivedTier: QualityTier;
  /** Per-unit perceived £, before flaw / customer-fit multipliers. */
  readonly perceivedUnitValue: number;
  /** Final per-lot £ valuation (unit × quantity × multipliers). */
  readonly perceivedLotValue: number;
  readonly flawDetected: boolean;
  readonly flawMultiplier: number;
  readonly customerFitMultiplier: number;
  /** Diagnostics — populated when the corresponding arm actually ran
   *  (null when the override path skipped it). */
  readonly identity: IdentityArmResult | null;
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
  /** Skip identity arm; substitute this kindId as perceived. */
  readonly perceivedKindIdOverride?: number;
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

  // ── 1. Identity arm ───────────────────────────────────────────
  let identity: IdentityArmResult | null = null;
  let perceivedKindId: number;
  if (args.perceivedKindIdOverride !== undefined) {
    perceivedKindId = args.perceivedKindIdOverride;
  } else {
    identity = estimateIdentity({
      db: args.db,
      actorId: args.actorId,
      truthItemKindId: args.lot.itemKindId,
      rng: args.rng,
      profileOverride: profile,
    });
    perceivedKindId = identity.perceivedKindId;
  }
  const perceivedItem = requireItemKind(args.db, perceivedKindId);
  // The *actual* item still drives flaw + customer-fit, which depend
  // on the goods physically in the lot, not what the actor thinks
  // they are. Identity confusion shows up as the actor PRICING the
  // wrong item, not as failing to notice the actual item's flaw.
  // (The flaw-detection roll is a separate axis the actor rolls
  // against the real flaw — they might spot a faulty Rulex even if
  // they thought it was a Rolex.)
  const actualItem = requireItemKind(args.db, args.lot.itemKindId);

  // ── 2. Condition arm ──────────────────────────────────────────
  let condition: ConditionArmResult | null = null;
  let perceivedTier: QualityTier;
  if (args.perceivedTierOverride !== undefined) {
    perceivedTier = args.perceivedTierOverride;
  } else {
    condition = estimateCondition({
      db: args.db,
      actorId: args.actorId,
      truthTier: args.lot.qualityTier,
      category: perceivedItem.category,
      rng: args.rng,
      profileOverride: profile,
    });
    perceivedTier = condition.perceivedTier;
  }

  // ── 3. Price arm ──────────────────────────────────────────────
  const tierMult =
    economics.tierMultipliers[perceivedTier] ??
    economics.tierMultipliers.fair;
  const perceivedTruthUnit = perceivedItem.baseValue * tierMult;
  const price = estimate({
    db: args.db,
    actorId: args.actorId,
    arm: "price",
    key: perceivedItem.category,
    truth: perceivedTruthUnit,
    tierMultiplier: tierMult,
    rng: args.rng,
    profileOverride: profile,
  });
  const perceivedUnitValue = Math.max(0, price.sample);

  // ── 4. Flaw detection (legacy mechanic, preserved) ────────────
  // The character-arm hook adds a (possibly negative) bonus on top
  // of the base detection score. Already-known flaws stay forced
  // 100% — once you've been burned you always spot it, regardless
  // of who's pitching.
  let flawDetected = false;
  let flawMultiplier = 1;
  if (actualItem.flawType !== null) {
    if (args.knownFlawType === actualItem.flawType) {
      flawDetected = true;
      flawMultiplier = economics.flawDiscount[actualItem.flawType];
      // Still advance the RNG so seed-stability between knownFlaw
      // and unknown-flaw branches stays predictable.
      args.rng.next();
    } else {
      const base =
        profile.flawDetection.get(actualItem.flawType) ??
        profile.defaultFlawDetection;
      const bonus = args.flawDetectionBonus ?? 0;
      const effective = clamp01(base + bonus);
      flawDetected = args.rng.next() < effective;
      if (flawDetected) {
        flawMultiplier = economics.flawDiscount[actualItem.flawType];
      }
    }
  }

  // ── 5. Customer-fit (legacy mechanic, preserved) ──────────────
  const customerFitMultiplier = computeCustomerFit(
    actualItem.targetCustomers ?? [],
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
    perceivedKindId,
    perceivedTier,
    perceivedUnitValue,
    perceivedLotValue,
    flawDetected,
    flawMultiplier,
    customerFitMultiplier,
    identity,
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

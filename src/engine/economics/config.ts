import type { FlawType, QualityTier } from "../stock/types.js";

/**
 * Single source of truth for economic tuning knobs across the engine.
 *
 * Every "magic number" that controls margins, spreads, multipliers, or
 * pricing-chain ratios lives here. Subsystems (pool spawner, pub-deal
 * autonomy, bidder appraisal, retail estimate) take an `EconomicsConfig`
 * via their options and read the relevant fields. All fields have
 * defaults that match the engine's prior hardcoded behaviour, so the
 * refactor is observably a no-op until a skin overrides them.
 *
 * Tuning the world is a config edit, not a code edit.
 */
export interface EconomicsConfig {
  /**
   * Per-quality-tier price multiplier. Applied to `item.baseValue` to
   * derive the tier's mid-retail unit price. Ratios across tiers
   * encode how much condition matters in this world's market.
   */
  readonly tierMultipliers: Readonly<Record<QualityTier, number>>;

  // ── Pool spawning ─────────────────────────────────────────────────
  /**
   * Multiplier on the tier-adjusted retail base when a pool is created.
   * Lower values = cheaper wholesale = more downstream margin. The
   * historical hardcoded behaviour was effectively 1.0 (pool prices ~85%
   * of retail mid after jitter) — set lower to give the trade chain
   * room to mark up.
   */
  readonly poolOpeningFraction: number;
  /**
   * Multiplicative jitter on pool opening price. Final opening price is
   * `tier * baseValue * poolOpeningFraction * (1 - jitter .. 1 + jitter)`.
   * Default 0.25 (±25%).
   */
  readonly poolOpeningJitter: number;
  /**
   * Pool closing price as a fraction of opening price. Models stale-stock
   * fire-sale pressure. Default 0.4.
   */
  readonly poolClosingFraction: number;

  // ── Starter stock ─────────────────────────────────────────────────
  /**
   * Acquisition price for day-1 starter stock, expressed as a fraction
   * of `item.baseValue`. Rolled uniformly in [min, max]. Lower values
   * mean dealers wake up with cheap inventory they can mark up.
   */
  readonly starterStockAcquisitionFractionMin: number;
  readonly starterStockAcquisitionFractionMax: number;

  // ── Pub-deal haggling ─────────────────────────────────────────────
  /**
   * The buyer's per-unit ceiling at a pub deal, as a fraction of their
   * appraised retail value. 0.5 means "I'll pay up to half of what I
   * think it's worth on the market" — leaving margin for risk and
   * onward sale. Lower = stingier buyers (more walks); higher = looser.
   */
  readonly pubBuyerCeilingFraction: number;
  /**
   * What tier does the pub buyer assume the lot is, when valuing it?
   * 'real' uses the lot's actual qualityTier (full-information world);
   * 'assumed' uses `pubAssumedTier` regardless of reality (tier-blind
   * world — buyers can't tell condition without inspection, which they
   * can't currently do at the pub). Defaults to 'real' for parity with
   * the legacy behaviour.
   */
  readonly pubBuyerTierMode: "real" | "assumed";
  /** The tier the buyer mentally substitutes when `pubBuyerTierMode` is
   *  'assumed'. Default 'fair' — the pessimistic-realist guess. */
  readonly pubAssumedTier: QualityTier;

  // ── Retail-estimate band ──────────────────────────────────────────
  /**
   * Band-width of the retail estimate (low/high around mid), as a
   * fraction of mid. Linearly interpolated by category accuracy:
   * accuracy 0 → spreadAtZeroAccuracy; accuracy 1 → spreadAtFullAccuracy.
   * Defaults give ±50% (clueless) to ±5% (expert).
   */
  readonly estimateSpreadAtZeroAccuracy: number;
  readonly estimateSpreadAtFullAccuracy: number;

  // ── Bidder behaviour ──────────────────────────────────────────────
  /**
   * Multiplier applied to a bidder's valuation when the item's target
   * customer types don't overlap with the bidder's. Models "I have no
   * onward market for this." Default 0.4.
   */
  readonly customerMismatchMultiplier: number;
  /**
   * Per-flaw discount applied to a bidder's valuation when they spot
   * the flaw on a lot. 0 = won't pay anything (e.g. scam bait); 1 = no
   * discount. Skin can override per flaw type.
   */
  readonly flawDiscount: Readonly<Record<FlawType, number>>;
}

const DEFAULT_TIER_MULT: Record<QualityTier, number> = {
  mint: 1.5,
  good: 1.1,
  fair: 0.8,
  shoddy: 0.5,
  broken: 0.25,
};

const DEFAULT_FLAW_DISCOUNT: Record<FlawType, number> = {
  faulty: 0.3,
  fake: 0.2,
  stolen: 0.7,
  wrong_market: 0.4,
  wrong_season: 0.5,
  dangerous: 0.1,
  scam_bait: 0.0,
};

/**
 * Defaults match the engine's previous hardcoded values exactly. Skins
 * override individual fields via `resolveEconomicsConfig`.
 */
export const DEFAULT_ECONOMICS_CONFIG: EconomicsConfig = {
  tierMultipliers: DEFAULT_TIER_MULT,
  // Legacy pool prices ran at ~85% of tier-retail after jitter. The
  // historical formula was `baseValue * tierMult * (0.75..1.25)` — i.e.
  // openingFraction = 1.0, jitter = 0.25.
  poolOpeningFraction: 1.0,
  poolOpeningJitter: 0.25,
  poolClosingFraction: 0.4,
  // Starter stock used `0.4 + rng() * 0.4` of baseValue.
  starterStockAcquisitionFractionMin: 0.4,
  starterStockAcquisitionFractionMax: 0.8,
  // Pub deals — recently introduced; 0.5 is the user-stated target.
  pubBuyerCeilingFraction: 0.5,
  // Default keeps current behaviour (tests rely on this).
  pubBuyerTierMode: "real",
  pubAssumedTier: "fair",
  // Estimate spread bounds match the existing constants.
  estimateSpreadAtZeroAccuracy: 0.5,
  estimateSpreadAtFullAccuracy: 0.05,
  customerMismatchMultiplier: 0.4,
  flawDiscount: DEFAULT_FLAW_DISCOUNT,
};

/**
 * Merge a partial override over the defaults. Use this when a skin or
 * test wants to tweak a few knobs without restating the whole bundle.
 */
export function resolveEconomicsConfig(
  partial?: Partial<EconomicsConfig>,
): EconomicsConfig {
  if (partial === undefined) return DEFAULT_ECONOMICS_CONFIG;
  return {
    ...DEFAULT_ECONOMICS_CONFIG,
    ...partial,
    // Nested records need their own merge so callers can override one
    // tier without losing the others.
    tierMultipliers: {
      ...DEFAULT_ECONOMICS_CONFIG.tierMultipliers,
      ...(partial.tierMultipliers ?? {}),
    },
    flawDiscount: {
      ...DEFAULT_ECONOMICS_CONFIG.flawDiscount,
      ...(partial.flawDiscount ?? {}),
    },
  };
}

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

  /**
   * Market-stall sale config. The mechanic: at the market location,
   * during open hours, dealer-roled actors with stock display one lot
   * each. A stylised customer histogram (volume + persona mix) rolls
   * each hour; each customer rolls interest in the item's category and
   * willingness-to-pay vs the seller's price. Sales resolve hour by
   * hour and an aggregated summary event fires per (seller, hour).
   */
  readonly marketSale: MarketSaleConfig;

  /**
   * Daily mode picker for "flexible" dealers — actors who don't have
   * a fixed venue (Boycie, Denzil, Monkey, Mickey, Jevon, Rodney,
   * Paddy, the Player). Each morning they roll a mode (auction /
   * market / pub / home) which overrides their hourly schedule for
   * that day. Auction weight is reactive: it bumps when today's
   * docket has items in the actor's category-skill set.
   */
  readonly dealerDayMode: DealerDayModeConfig;
}

export type DealerDayModeKey = "auction" | "market" | "pub" | "home";

export interface DealerDayModeConfig {
  /** Base weight per mode before reactive adjustment. Relative;
   *  normalised at draw time. */
  readonly baseWeights: Readonly<Record<DealerDayModeKey, number>>;
  /** Added to the 'auction' weight when today's docket has at least
   *  one lot in a category the actor's profile rates >= interestThreshold. */
  readonly auctionInterestBoost: number;
  /** Category-accuracy threshold above which the actor counts a docket
   *  category as "interesting". Default 0.6. */
  readonly interestThreshold: number;
  /**
   * Hour-of-day → location-code map per mode. The day-mode handler
   * applies these as overrides to the actor's regular schedule for
   * the day. Hours not in the map fall through to the actor's normal
   * schedule (or the delivery override, which still wins). Skin
   * resolves the codes against its location table.
   */
  readonly modeSchedules: Readonly<Record<
    DealerDayModeKey,
    Readonly<Record<number, string>>
  >>;
}

export interface MarketSaleConfig {
  /**
   * NPC pricing strategy: per-unit price = trader's deterministic
   * retail-mid × this fraction. 1.0 = sells at retail mid (the
   * default heuristic); lower = aggressive discount; higher = chancing
   * the upside. Phase 2 will switch to a player-set price range.
   */
  readonly pricePerUnitFraction: number;
  /**
   * Personas browsing the market each hour. Keys are arbitrary
   * customer-type ids (e.g. 'old-dears', 'students'). Skins extend
   * by adding new entries; engine code reads the map iteratively so
   * additions don't require code changes.
   */
  readonly customerTypes: Readonly<Record<string, MarketCustomerType>>;
  /**
   * Total customers passing through per market hour. Hours not listed
   * have zero footfall (market closed). Skin can override per hour.
   * Histogram volume is jittered ±25% per draw for texture.
   */
  readonly hourlyFootfall: Readonly<Record<number, number>>;
}

export interface MarketCustomerType {
  /** Per-item-category interest weight (probability multiplier on
   *  whether this persona engages with an item of that category).
   *  Categories not listed fall back to `defaultCategoryInterest`. */
  readonly categoryInterest: Readonly<Record<string, number>>;
  readonly defaultCategoryInterest: number;
  /** Multiplier on the item's true retail mid that this persona
   *  considers reasonable. 1.0 = pays retail; <1 = bargain hunter;
   *  >1 = generous. Each customer rolls a willingness in
   *  [mid * (1 - jitter), mid * (1 + jitter)]. */
  readonly willingnessToPayMid: number;
  readonly willingnessToPayJitter: number;
  /** 0..1. At 0 the persona pays whatever the seller asks (gullible);
   *  at 1 they always check against their willingness ceiling. Skin
   *  models the easily-fooled-old-dear vs. wise-old-tradesman axis. */
  readonly savviness: number;
  /** Population weight in the histogram mix. Higher = more common
   *  per market hour. Relative; the histogram normalises to footfall. */
  readonly populationWeight: number;
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

const DEFAULT_MARKET_CUSTOMER_TYPES: Record<string, MarketCustomerType> = {
  "old-dears": {
    categoryInterest: { decor: 1.5, novelty: 1.5, food: 1.0, clothing: 0.6 },
    defaultCategoryInterest: 0.3,
    willingnessToPayMid: 0.9,
    willingnessToPayJitter: 0.3,
    savviness: 0.2,
    populationWeight: 1.0,
  },
  "students": {
    categoryInterest: { electrical: 1.0, clothing: 1.0, novelty: 0.8, food: 0.8 },
    defaultCategoryInterest: 0.5,
    willingnessToPayMid: 0.5,
    willingnessToPayJitter: 0.2,
    savviness: 0.5,
    populationWeight: 0.6,
  },
  "mums": {
    categoryInterest: { clothing: 1.5, decor: 1.0, food: 1.2, toys: 1.4 },
    defaultCategoryInterest: 0.7,
    willingnessToPayMid: 0.8,
    willingnessToPayJitter: 0.2,
    savviness: 0.7,
    populationWeight: 1.2,
  },
  "dads": {
    categoryInterest: { tools: 1.5, electrical: 1.4, vehicles: 1.0, clothing: 0.6 },
    defaultCategoryInterest: 0.4,
    willingnessToPayMid: 1.0,
    willingnessToPayJitter: 0.3,
    savviness: 0.6,
    populationWeight: 0.8,
  },
};

/** Default footfall curve at Peckham Market — quiet morning, lunchtime
 *  peak, tail off in the afternoon. Hours not listed = market closed. */
const DEFAULT_MARKET_HOURLY_FOOTFALL: Record<number, number> = {
  9: 5,
  10: 12,
  11: 18,
  12: 25,
  13: 22,
  14: 8,
};

/** Default mode schedules: keys are hours of day, values are location
 *  codes (resolved by the skin to ids). Modes leave non-listed hours
 *  alone — actors fall back to their base schedule outside these. */
const DEFAULT_MODE_SCHEDULES: Record<
  "auction" | "market" | "pub" | "home",
  Record<number, string>
> = {
  // Auction-day: paper run + the auction window.
  auction: {
    6: "sids-cafe",
    11: "auction-house",
    12: "auction-house",
    13: "auction-house",
    14: "auction-house",
    15: "auction-house",
    16: "auction-house",
  },
  // Market-day: stall during market hours.
  market: {
    9: "peckham-market",
    10: "peckham-market",
    11: "peckham-market",
    12: "peckham-market",
    13: "peckham-market",
    14: "peckham-market",
  },
  // Pub-day: linger longer at the Nag's for haggling.
  pub: {
    13: "nags",
    14: "nags",
    15: "nags",
    16: "nags",
    17: "nags",
    18: "nags",
    19: "nags",
    20: "nags",
    21: "nags",
  },
  // Home-day: no overrides — fall through to the actor's home/lockup
  // default. Empty map = "leave the schedule alone".
  home: {},
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
  // Pub deals — bumped from 0.5 to widen the zone-of-agreement so more
  // negotiations actually get a back-and-forth instead of insta-walking
  // when seller floor sits just above buyer ceiling.
  pubBuyerCeilingFraction: 0.6,
  // Default keeps current behaviour (tests rely on this).
  pubBuyerTierMode: "real",
  pubAssumedTier: "fair",
  // Estimate spread bounds match the existing constants.
  estimateSpreadAtZeroAccuracy: 0.5,
  estimateSpreadAtFullAccuracy: 0.05,
  customerMismatchMultiplier: 0.4,
  flawDiscount: DEFAULT_FLAW_DISCOUNT,
  marketSale: {
    pricePerUnitFraction: 1.0,
    customerTypes: DEFAULT_MARKET_CUSTOMER_TYPES,
    hourlyFootfall: DEFAULT_MARKET_HOURLY_FOOTFALL,
  },
  dealerDayMode: {
    // Market dominates; pub and auction roughly equal; rare home day.
    baseWeights: { auction: 0.15, market: 0.45, pub: 0.30, home: 0.10 },
    auctionInterestBoost: 0.25,
    interestThreshold: 0.6,
    modeSchedules: DEFAULT_MODE_SCHEDULES,
  },
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
    marketSale: {
      ...DEFAULT_ECONOMICS_CONFIG.marketSale,
      ...(partial.marketSale ?? {}),
      customerTypes: {
        ...DEFAULT_ECONOMICS_CONFIG.marketSale.customerTypes,
        ...(partial.marketSale?.customerTypes ?? {}),
      },
      hourlyFootfall: {
        ...DEFAULT_ECONOMICS_CONFIG.marketSale.hourlyFootfall,
        ...(partial.marketSale?.hourlyFootfall ?? {}),
      },
    },
    dealerDayMode: {
      ...DEFAULT_ECONOMICS_CONFIG.dealerDayMode,
      ...(partial.dealerDayMode ?? {}),
      baseWeights: {
        ...DEFAULT_ECONOMICS_CONFIG.dealerDayMode.baseWeights,
        ...(partial.dealerDayMode?.baseWeights ?? {}),
      },
      modeSchedules: {
        ...DEFAULT_ECONOMICS_CONFIG.dealerDayMode.modeSchedules,
        ...(partial.dealerDayMode?.modeSchedules ?? {}),
      },
    },
  };
}

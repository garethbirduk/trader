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
   * RRP-value floor below which neither side bothers to haggle —
   * applied symmetrically. The buyer estimates max-available × their
   * appraised unit retail; the seller estimates their own bag × the
   * deterministic tier-anchored retail mid. If either side's number
   * is below this, walk with `pubdeal.skipped-too-small`. Default
   * £100 — small enough that ordinary trade still happens, large
   * enough that "two screwdriver sets for a quid" no-ops out.
   */
  readonly pubDealRrpFloor: number;
  /**
   * Minimum fraction of seller's available bag a deal must clear to
   * be worth breaking up the lot for. If both sides converge at a qty
   * below this fraction of what the seller has on hand, walk —
   * neither party wants to split a small slice. Default 0.25 (25%).
   */
  readonly pubDealMinSlicePct: number;
  /**
   * Forward-sell only engages on warm, pool-grounded supply leads
   * with hopCount at or below this. Beyond this, the rumour's too
   * mangled to commit on. Default 2 — first-hand or one-hop only.
   */
  readonly forwardSellMaxHopCount: number;
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
   * Per-hour planner for "flexible" actors. Each hour the planner picks
   * each actor's *next-hour* destination by scoring candidate locations
   * (auction / market / each shop / each pub / newspaper / home) with
   * inputs from inventory, cash, known docket lots, intrinsic
   * preferences, and travel cost. Replaces the older one-mode-per-day
   * picker — gives composed days like "morning at Sotheby's, afternoon
   * offloading at Sparks Electrical."
   */
  readonly planner: PlannerConfig;

  /**
   * Off-map auction populism. Controls how the wider trade scene
   * (named NPCs from neighbouring areas — Slough Stan, Croydon Carl,
   * etc.) participates in Sotheby's auctions and what they do with
   * what they buy. The off-map cast is pure auction-presence in v1:
   * they bid, they take stock home, and the daily off-map resale
   * handler liquidates that stock against a synthetic external-economy
   * account at the configured `resellMargin`.
   */
  readonly offMapAuction: OffMapAuctionConfig;

  /**
   * Per-hop mutation applied when one actor passes a lead to another.
   * Numeric drift is the texture; tier slip and side flip are the
   * cinematic bugs — "Boyce burned Trigger" becomes "Trigger burned
   * Boyce" two hops down the line. Set every chance to 0 to disable
   * mutation entirely (faithful retelling, useful for tests).
   */
  readonly gossipMutation: GossipMutationConfig;

  /**
   * Stage 7 — regional clearance lots flowing into the auction
   * independent of local pool flushes. Keeps Sotheby's busy every
   * auction day: locals engage on the affordable lots, whales clear
   * the rest. Disable by setting `lotsPerDay` to 0.
   */
  readonly regionalClearance: RegionalClearanceConfig;

  /**
   * Stage 8 — shop turnover. Mirrors `marketSale` but with a
   * smaller, less category-diverse footfall: a couple of customers
   * per hour wandering into the high-street shops. Without this
   * shops would be infinite sinks — dealers sell to keepers, keepers
   * never move it on. Set `enabled: false` to disable.
   */
  readonly shopSale: ShopSaleConfig;

  /**
   * Stage 8 — automatic write-off of unsellable rubbish. Lots in
   * broken/shoddy tier sitting in dealer bags past a threshold age
   * get written off: the dealer pays a small per-unit fee to the
   * off-map ledger and the stock leaves the world. Stops dealers
   * hoarding rubbish that no one will buy at any price.
   */
  readonly writeOff: WriteOffConfig;

  /**
   * Two-tier gossip — paid detail unlock. After a regular pub-chat
   * gossip exchange, the asker can spend an hour and a small £ on
   * a "drink session" with the partner, unlocking the detail tier
   * on the top-N locked headlines in their bag.
   */
  readonly detailUnlock: DetailUnlockConfig;

  /**
   * Judgement engine v1 (docs/judgement.md) — staged migration flag.
   * When false (default), auction-lot valuation runs through the
   * legacy `appraiseLot` pipeline. When true, the bidder pipeline
   * routes through `estimateLotValue` — the compositional
   * Identity ∘ Condition ∘ Price pathway that produces the four-case
   * behaviour (confidently-wrong / confidently-right / haphazardly-
   * wrong / hesitantly-right). Other call sites (pub-deal, market,
   * shop) still call legacy paths regardless of this flag; their
   * migration is gated on later phases.
   */
  readonly useJudgementForAppraisal: boolean;
}

export interface ShopSaleConfig {
  /** Set false to skip the shop-sale handler entirely. */
  readonly enabled: boolean;
  /** Per-shop hourly footfall. A small number per hour during open
   *  hours — these are high-street shops, not the Saturday market. */
  readonly hourlyFootfall: Readonly<Record<number, number>>;
  /** Price as a fraction of the keeper's retail mid. Higher than
   *  market because shop overhead is real but you get a proper
   *  shop-front. Default 1.1. */
  readonly pricePerUnitFraction: number;
}

export interface WriteOffConfig {
  /** Set false to skip the write-off handler. */
  readonly enabled: boolean;
  /** Tiers eligible for auto write-off. Default ["broken", "shoddy"]. */
  readonly eligibleTiers: readonly QualityTier[];
  /** Lots must have been acquired at least this many days ago. */
  readonly minDaysHeld: number;
  /** Per-unit fee paid by the owner to the off-map ledger. */
  readonly feePerUnit: number;
  /** Owners with cash below this won't be charged — their stock just
   *  disappears with the fee waived. Avoids pushing them into debt
   *  for what was already worthless. */
  readonly skipFeeBelowCash: number;
}

export interface RegionalClearanceConfig {
  /** How many regional-clearance lots to spawn each morning. Default
   *  3 — enough that even a quiet local-pool day has a docket. */
  readonly lotsPerDay: number;
  /** Floor price as a fraction of the lot's true tier-adjusted retail
   *  value. Higher = more restrictive; only whales can engage.
   *  Default 0.55 — most locals stretch to mid-range lots; whales
   *  scoop the top end. */
  readonly floorFractionOfRetail: number;
  /** Symmetric ±jitter on the floor price. Default 0.15. */
  readonly floorJitter: number;
  /** Bank of provenance phrases attached to the spawned lots. */
  readonly provenancePhrases: readonly string[];
}

export interface GossipMutationConfig {
  /** Symmetric multiplicative jitter applied to `estimatedQuantity` on
   *  every hop. 0.15 = result drawn uniformly in [85%, 115%] of the
   *  source value, then rounded to an integer >= 1. Always applied. */
  readonly quantityJitter: number;
  /** Symmetric multiplicative jitter on `estimatedUnitPrice`. */
  readonly priceJitter: number;
  /** Per-hop probability that `subjectQualityTier` slips by one step
   *  in the QUALITY_TIERS ordering (good → fair or good → mint).
   *  Bounded at the ends — a slip on `mint` can only go down to
   *  `good`. Leads with a null tier are never slipped. */
  readonly tierSlipChance: number;
  /** Per-hop probability that the lead's `side` flips from supply to
   *  demand or vice versa. The flipped lead also has its
   *  `subjectPoolId` cleared — a fact that's been semantically
   *  inverted is no longer grounded in the original supply pool. */
  readonly sideFlipChance: number;
}

export interface DetailUnlockConfig {
  /** Set false to disable the unlock mechanic globally. */
  readonly enabled: boolean;
  /** Flat cost the asker pays per unlock session, in pence.
   *  Default 300 (£3). */
  readonly pricePence: number;
  /** How many of the asker's locked headlines flip to detail tier per
   *  session. Default 3 — top-N most recent. */
  readonly unlockYield: number;
  /** Asker must have at least this much cash (pence) to consider
   *  initiating the action. Distinct from `pricePence`: this is the
   *  general-solvency floor that makes the £3 spend worthwhile
   *  in-character. Default 1000 (£10). */
  readonly minCashPence: number;
  /** Baseline probability per eligible chat that an NPC asker rolls
   *  to ask. Stacks multiplicatively with the per-actor and interest
   *  multipliers. Default 0.3. */
  readonly baseProb: number;
  /** Multiplier on baseProb when the asker is flagged as an
   *  information-trader (Mike, Sid, Albert — the bar-stool gossips).
   *  Default 2.0. */
  readonly infoTraderProbMultiplier: number;
  /** Probability bonus per locked headline whose subject category is
   *  in the asker's bidder-profile interest band (appraisal accuracy
   *  >= the planner's interestThreshold). Added linearly to baseProb
   *  before multipliers. Default 0.15. */
  readonly interestBonusPerMatch: number;
}

export interface OffMapAuctionConfig {
  /** Maximum number of off-map dealers eligible to bid on any single
   *  lot. Locals' presence is unchanged; only off-map bidders are
   *  capped. Set to 0 to suppress off-map participation entirely. */
  readonly maxBiddersPerLot: number;
  /** End-of-day liquidation multiplier applied to stock held by
   *  off-map dealers. Stock value = `item.baseValue × tierMult ×
   *  qty × resellMargin`. 1.0 = breakeven on retail; <1.0 imposes a
   *  small "transaction cost" so successful trades net positive but
   *  overbids still hurt. Default 0.95. */
  readonly resellMargin: number;
  /**
   * Days between off-map resale and the cash arriving back to the
   * dealer. Stage 7's finiteness lever: a whale that spent all their
   * cash bidding can't bid again for `payoutLagDays` after the
   * resale. Set to 0 for immediate payout (the pre-Stage-7 behaviour).
   * Default 2 — long enough that a single big spend forces a sit-out.
   */
  readonly payoutLagDays: number;
}

export type PlannerCandidateKind =
  | "auction"
  | "market"
  | "pub"
  | "shop"
  | "newspaper"
  | "home";

export interface PlannerConfig {
  /** Intrinsic base weight per candidate kind. Relative; the highest
   *  scoring candidate wins (no normalisation, no random draw — this
   *  is a deterministic argmax with optional jitter). */
  readonly baseWeights: Readonly<Record<PlannerCandidateKind, number>>;
  /** Bonus per known docket lot that falls in a category the actor's
   *  profile rates >= interestThreshold. Pulls strongly toward auction
   *  when an actor knows interesting lots are on. */
  readonly lotInterestWeight: number;
  /** Category-accuracy threshold above which a docket lot counts as
   *  "interesting". Default 0.6 (matches the legacy mode picker). */
  readonly interestThreshold: number;
  /** Auction baseline applied when the actor knows nothing about today's
   *  docket but a docket exists — "go and see" curiosity. Set to 0 to
   *  disable speculative attendance. */
  readonly speculativeAuctionWeight: number;
  /** Bonus to "go sell" candidates (market, shops) per unit of stock the
   *  actor currently holds. Encourages full-bag dealers to find buyers. */
  readonly inventoryFullDrive: number;
  /** Bonus to acquisition-side candidates (auction, market footfall) when
   *  the actor's inventory is below `inventoryEmptyThreshold` units.
   *  Reserved for future tuning; defaults to 0. */
  readonly inventoryEmptyDrive: number;
  /** Inventory-units threshold below which inventoryEmptyDrive applies. */
  readonly inventoryEmptyThreshold: number;
  /** Bonus to "go earn" candidates (market, shops) when actor cash is
   *  below `cashLowThreshold`. */
  readonly cashLowDrive: number;
  /** Cash-pence threshold below which cashLowDrive applies. */
  readonly cashLowThreshold: number;
  /** Bonus to a shop candidate per unit of stock the actor holds in a
   *  category the shop's keeper specialises in. The big lever for
   *  steering Boycie's furniture haul to Comfy Corner / Throne & Co. */
  readonly shopSpecialtyMatchWeight: number;
  /** Bonus to a newspaper candidate when the actor doesn't yet know
   *  today's docket. Combined with travel cost, keeps actors
   *  passively reading the paper if they happen to be passing through
   *  Sid's, but pulls them on a deliberate trip when curiosity bites. */
  readonly newspaperRunWeight: number;
  /** Per-unit penalty on Euclidean travel distance from the actor's
   *  current location to the candidate. Discourages cross-map detours
   *  unless the destination scores high. */
  readonly travelCostWeight: number;
  /** Per-kind weekend score modifier (added to base weight when
   *  planning for a Saturday or Sunday hour). Positive = more popular
   *  on weekends; negative = less. */
  readonly weekendModifier: Partial<Readonly<Record<PlannerCandidateKind, number>>>;
  /** Symmetric ±jitter added to each candidate score, drawn from the
   *  world RNG. Set to 0 for fully deterministic argmax. */
  readonly jitter: number;
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

const DEFAULT_PLANNER: PlannerConfig = {
  // Intrinsic prefs — market and pub are the bread & butter, auction is
  // a draw when info exists, shops are deliberate trips, home is the
  // fallback. Newspaper sits between home and pub: not a destination
  // unless there's a reason.
  baseWeights: {
    auction: 0.4,
    market: 0.6,
    pub: 0.45,
    shop: 0.35,
    newspaper: 0.2,
    home: 0.1,
  },
  lotInterestWeight: 0.6,
  interestThreshold: 0.6,
  speculativeAuctionWeight: 0.15,
  inventoryFullDrive: 0.04,
  inventoryEmptyDrive: 0.0,
  inventoryEmptyThreshold: 5,
  cashLowDrive: 0.4,
  cashLowThreshold: 200,
  shopSpecialtyMatchWeight: 0.05,
  newspaperRunWeight: 0.4,
  // Map is roughly 1500 px wide; 0.001/px means a full-map detour costs
  // ~1.5 score (enough to override a weak draw, not a strong one).
  travelCostWeight: 0.0015,
  weekendModifier: {
    market: -0.4,    // Peckham Market is closed weekends in v1.
    auction: -0.4,   // Sotheby's likewise.
    shop: -0.3,      // Most shops shut weekends; specialty bonus still pulls.
    pub: 0.3,        // Pubs busier.
    home: 0.2,       // More likely to chill at home.
  },
  jitter: 0.05,
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
  pubDealRrpFloor: 100,
  pubDealMinSlicePct: 0.25,
  forwardSellMaxHopCount: 2,
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
  planner: DEFAULT_PLANNER,
  offMapAuction: {
    maxBiddersPerLot: 3,
    resellMargin: 0.95,
    payoutLagDays: 2,
  },
  // Gentle defaults — every hop drifts the numbers ~10–15%, tiers slip
  // once in twenty retellings, side flips one in fifty. Combined over
  // a 4-hop chain that's roughly: numbers always wrong-but-close, ~20%
  // chance of tier confusion, ~8% chance of a flipped role. Calibrated
  // to make conflicts visibly emerge in the gossip ledger without
  // making every lead noise.
  gossipMutation: {
    quantityJitter: 0.15,
    priceJitter: 0.1,
    tierSlipChance: 0.05,
    sideFlipChance: 0.02,
  },
  regionalClearance: {
    lotsPerDay: 3,
    floorFractionOfRetail: 0.55,
    floorJitter: 0.15,
    provenancePhrases: [
      "Bexleyheath estate clearance",
      "Sevenoaks auction overflow",
      "Bromley bankruptcy stock",
      "Croydon warehouse closure",
      "Maidstone probate sale",
      "Sidcup garage clearout",
    ],
  },
  shopSale: {
    enabled: true,
    // Sparse footfall — a couple of customers per open hour. Smaller
    // than the market by design; the shop's specialty + persona
    // interest filter does most of the work.
    hourlyFootfall: {
      9: 1,
      10: 2,
      11: 3,
      12: 4,
      13: 4,
      14: 3,
      15: 3,
      16: 2,
      17: 1,
    },
    pricePerUnitFraction: 1.1,
  },
  writeOff: {
    enabled: true,
    eligibleTiers: ["broken", "shoddy"],
    minDaysHeld: 7,
    feePerUnit: 2,
    skipFeeBelowCash: 50,
  },
  detailUnlock: {
    enabled: true,
    pricePence: 300,
    unlockYield: 3,
    minCashPence: 1000,
    baseProb: 0.3,
    infoTraderProbMultiplier: 2.0,
    interestBonusPerMatch: 0.15,
  },
  // Off by default — the v1 PR-2 landing is a no-op behavioural change
  // until a skin / test explicitly flips this on. Once snapshot tests
  // pin the new four-case behaviour we default it to true (P8 in the
  // implementation plan).
  useJudgementForAppraisal: false,
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
    planner: {
      ...DEFAULT_ECONOMICS_CONFIG.planner,
      ...(partial.planner ?? {}),
      baseWeights: {
        ...DEFAULT_ECONOMICS_CONFIG.planner.baseWeights,
        ...(partial.planner?.baseWeights ?? {}),
      },
      weekendModifier: {
        ...DEFAULT_ECONOMICS_CONFIG.planner.weekendModifier,
        ...(partial.planner?.weekendModifier ?? {}),
      },
    },
    offMapAuction: {
      ...DEFAULT_ECONOMICS_CONFIG.offMapAuction,
      ...(partial.offMapAuction ?? {}),
    },
    gossipMutation: {
      ...DEFAULT_ECONOMICS_CONFIG.gossipMutation,
      ...(partial.gossipMutation ?? {}),
    },
    regionalClearance: {
      ...DEFAULT_ECONOMICS_CONFIG.regionalClearance,
      ...(partial.regionalClearance ?? {}),
    },
    shopSale: {
      ...DEFAULT_ECONOMICS_CONFIG.shopSale,
      ...(partial.shopSale ?? {}),
      hourlyFootfall: {
        ...DEFAULT_ECONOMICS_CONFIG.shopSale.hourlyFootfall,
        ...(partial.shopSale?.hourlyFootfall ?? {}),
      },
    },
    writeOff: {
      ...DEFAULT_ECONOMICS_CONFIG.writeOff,
      ...(partial.writeOff ?? {}),
    },
    detailUnlock: {
      ...DEFAULT_ECONOMICS_CONFIG.detailUnlock,
      ...(partial.detailUnlock ?? {}),
    },
  };
}

import type { SeededRNG } from "../core/rng.js";
import type {
  MarketCustomerType,
  MarketSaleConfig,
} from "../economics/config.js";

/**
 * The hour's customer histogram: how many of each persona pass by.
 * Total ≤ jittered footfall for the hour. The mix is drawn from the
 * persona populationWeights, so adding new personas at the skin level
 * doesn't require code changes here.
 */
export interface CustomerHistogram {
  readonly hour: number;
  readonly totalCount: number;
  /** Per-persona count, keyed by the customer-type id. */
  readonly counts: Readonly<Record<string, number>>;
}

const FOOTFALL_JITTER = 0.25;

/** Default clamp range for the realised customer willingness as a
 *  fraction of the lot's true per-unit RRP. The customer-drives-price
 *  model lands every sale in this window. */
export const DEFAULT_WILLINGNESS_LOW = 0.9;
export const DEFAULT_WILLINGNESS_HIGH = 1.1;

/**
 * Roll the histogram for a given market-hour. Footfall comes from the
 * config's `hourlyFootfall` map, jittered ±25% per draw. Composition is
 * drawn from the persona `populationWeight`s — each customer is rolled
 * independently so the mix has natural variance, not exact ratios.
 */
export function rollCustomerHistogram(
  hour: number,
  config: MarketSaleConfig,
  rng: SeededRNG,
): CustomerHistogram {
  const baseFootfall = config.hourlyFootfall[hour] ?? 0;
  if (baseFootfall <= 0) {
    return { hour, totalCount: 0, counts: {} };
  }
  const jitter = 1 - FOOTFALL_JITTER + rng.next() * 2 * FOOTFALL_JITTER;
  const totalCount = Math.max(0, Math.round(baseFootfall * jitter));
  if (totalCount === 0) {
    return { hour, totalCount: 0, counts: {} };
  }

  const personaIds = Object.keys(config.customerTypes);
  if (personaIds.length === 0) {
    return { hour, totalCount: 0, counts: {} };
  }

  const items = personaIds.map((id) => ({
    value: id,
    weight: config.customerTypes[id]!.populationWeight,
  }));
  const counts: Record<string, number> = {};
  for (let i = 0; i < totalCount; i += 1) {
    const id = rng.weighted(items);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return { hour, totalCount, counts };
}

/**
 * Walk a single customer's interaction with the displayed lot. Returns
 * the unit price the customer is prepared to pay (which IS the
 * realised sale price), or null if they walked.
 *
 * Decision pipeline:
 *   1. Interest in the item's category (per-persona weight, with a
 *      default fallback). Below 1 reduces engagement probability.
 *   2. Willingness-to-pay = `truePricePerUnit × factor`, where `factor`
 *      lands in `[minFraction, maxFraction]` (default `[0.9, 1.1]`) —
 *      biased by the persona's `willingnessToPayMid`. A "bargain
 *      hunter" persona (mid ≤ 0.5) sits at the bottom of the window;
 *      a "generous" persona (mid ≥ 1.0) sits at the top.
 *   3. The customer pays their willingness directly. Sellers don't
 *      negotiate at this scale — the price is taken or the customer
 *      walks (and the only walk vector now is the interest check).
 *
 * This is the **customer-drives-price** model: stocks sell at varying
 * prices depending on who walks in. Persona mix produces the
 * cinematic shape — a fancy-stall day sees realised prices skew high
 * (more dads / yuppies); a bargain-bin day skews low (more old-dears).
 */
export function resolveOneSale(args: {
  readonly persona: MarketCustomerType;
  readonly itemCategory: string;
  /** True retail per-unit price — `item.baseValue × tierMult[qualityTier]`.
   *  This is engine truth, unknown to the seller. */
  readonly truePricePerUnit: number;
  readonly rng: SeededRNG;
  /** Lower clamp on the realised willingness, as a fraction of
   *  truePricePerUnit. Defaults to 0.9. */
  readonly minFraction?: number;
  /** Upper clamp on the realised willingness. Defaults to 1.1. */
  readonly maxFraction?: number;
}): { readonly soldAt: number } | null {
  const interest =
    args.persona.categoryInterest[args.itemCategory] ??
    args.persona.defaultCategoryInterest;
  // Engage probability — clamp to [0, 1] but allow weights > 1 to
  // express above-baseline interest (will never exceed 1 in effect).
  const engageP = Math.min(1, Math.max(0, interest));
  if (!args.rng.chance(engageP)) return null;

  const lo = args.minFraction ?? DEFAULT_WILLINGNESS_LOW;
  const hi = args.maxFraction ?? DEFAULT_WILLINGNESS_HIGH;
  const factor = personaWillingnessFactor({
    persona: args.persona,
    rng: args.rng,
    lo,
    hi,
  });
  const soldAt = Math.max(1, Math.round(args.truePricePerUnit * factor));
  return { soldAt };
}

/**
 * Map a persona's `willingnessToPayMid` (historically 0.5..1.0) into
 * a fraction inside [lo, hi]. Bargain hunters (mid 0.5) anchor at lo;
 * generous personas (mid 1.0) anchor at hi. Jitter is applied around
 * the anchor and the result clamped back to [lo, hi].
 *
 * The mapping is intentionally linear and simple — it preserves the
 * relative ordering of personas in the existing skin without forcing
 * skin authors to re-tune mid/jitter for the narrower window.
 */
function personaWillingnessFactor(args: {
  persona: MarketCustomerType;
  rng: SeededRNG;
  lo: number;
  hi: number;
}): number {
  const { persona, rng, lo, hi } = args;
  // Normalise the persona's mid (historically in roughly [0.5, 1.0])
  // to [0, 1]. Personas outside that range get clamped — extreme
  // values still anchor cleanly at the edges of the window.
  const norm = clamp01((persona.willingnessToPayMid - 0.5) / 0.5);
  const anchor = lo + (hi - lo) * norm;
  // Persona jitter shrinks into the narrower window. Half of the
  // historical jitter sets a believable spread within [lo, hi]
  // without immediately punching through the clamps.
  const halfWidth = persona.willingnessToPayJitter * 0.5 * (hi - lo);
  const raw = anchor + (rng.next() * 2 * halfWidth - halfWidth);
  if (raw < lo) return lo;
  if (raw > hi) return hi;
  return raw;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

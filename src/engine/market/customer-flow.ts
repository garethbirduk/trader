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
 * the unit price the customer agreed to pay, or null if they walked.
 *
 * Decision pipeline:
 *   1. Interest in the item's category (per-persona weight, with a
 *      default fallback). Below 1 reduces engagement probability.
 *   2. Willingness-to-pay = trueRetailMidPerUnit × (mid ± jitter).
 *      Each customer rolls their own willingness in that band.
 *   3. Savviness gate: at low savviness the customer pays whatever the
 *      seller asks; at high savviness they walk if price > willingness.
 *      Continuous: the probability they'll pay an over-price falls
 *      linearly from 1 at savviness=0 to 0 at savviness=1.
 */
export function resolveOneSale(args: {
  readonly persona: MarketCustomerType;
  readonly itemCategory: string;
  /** True retail mid per unit — what the item is genuinely worth at
   *  retail given its real tier. */
  readonly trueRetailMidPerUnit: number;
  /** Seller's asking price per unit. */
  readonly sellerPricePerUnit: number;
  readonly rng: SeededRNG;
}): { readonly soldAt: number } | null {
  const interest =
    args.persona.categoryInterest[args.itemCategory] ??
    args.persona.defaultCategoryInterest;
  // Engage probability — clamp to [0, 1] but allow weights > 1 to
  // express above-baseline interest (will never exceed 1 in effect).
  const engageP = Math.min(1, Math.max(0, interest));
  if (!args.rng.chance(engageP)) return null;

  const j = args.persona.willingnessToPayJitter;
  const willingnessFactor =
    args.persona.willingnessToPayMid + (args.rng.next() * 2 * j - j);
  const willingnessPerUnit = Math.max(0, args.trueRetailMidPerUnit * willingnessFactor);

  if (args.sellerPricePerUnit <= willingnessPerUnit) {
    // Within budget — straight buy.
    return { soldAt: args.sellerPricePerUnit };
  }

  // Above budget. Savvy customers walk; unsavvy ones might still pay.
  // The probability of buying anyway falls linearly with savviness.
  const overpayP = Math.max(0, 1 - args.persona.savviness);
  if (args.rng.chance(overpayP)) {
    return { soldAt: args.sellerPricePerUnit };
  }
  return null;
}

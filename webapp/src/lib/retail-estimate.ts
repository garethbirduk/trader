import type { BidderProfileDump, RunItem } from "../types.js";

/**
 * Per-unit retail estimate band. Mirrors the engine's `RetailEstimate`
 * — kept in lockstep so the UI reflects the same pricing model the
 * bidder pipeline uses.
 */
export interface RetailEstimate {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

const TIER_MULT: Readonly<Record<string, number>> = {
  mint: 1.5,
  good: 1.1,
  fair: 0.8,
  shoddy: 0.5,
  broken: 0.25,
};

const SPREAD_AT_ZERO_ACCURACY = 0.5;
const SPREAD_AT_FULL_ACCURACY = 0.05;

/**
 * Compute a trader's per-unit retail estimate for an item at a given
 * tier. Pass `null` for tier when the trader doesn't know yet (an
 * un-inspected auction lot) — the band widens to span shoddy..good.
 *
 * Better category accuracy → narrower band. Mirrors the engine's
 * `estimateUnitRetail` exactly so the UI matches what the bidder
 * pipeline thinks.
 */
export function estimateUnitRetail(
  profile: BidderProfileDump,
  item: Pick<RunItem, "baseValue" | "category">,
  tier: string | null,
): RetailEstimate {
  const accuracyRaw =
    profile.appraisalAccuracy[item.category] ?? profile.defaultAppraisalAccuracy;
  const judgement = clamp01(accuracyRaw);
  const spread =
    SPREAD_AT_ZERO_ACCURACY +
    (SPREAD_AT_FULL_ACCURACY - SPREAD_AT_ZERO_ACCURACY) * judgement;

  if (tier !== null && TIER_MULT[tier] !== undefined) {
    const mid = item.baseValue * (TIER_MULT[tier] ?? 1);
    return {
      low: Math.max(0, Math.round(mid * (1 - spread))),
      mid: Math.max(0, Math.round(mid)),
      high: Math.max(0, Math.round(mid * (1 + spread))),
    };
  }

  const lowAnchor = item.baseValue * TIER_MULT.shoddy!;
  const midAnchor = item.baseValue * TIER_MULT.fair!;
  const highAnchor = item.baseValue * TIER_MULT.good!;
  return {
    low: Math.max(0, Math.round(lowAnchor * (1 - spread))),
    mid: Math.max(0, Math.round(midAnchor)),
    high: Math.max(0, Math.round(highAnchor * (1 + spread))),
  };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Format a retail estimate band as a compact string. Returns
 *  `~£18 (£14–£22)` style — mid prominent, range in parentheses.
 *  When low === high (perfect judgement) the parentheses are dropped. */
export function formatRetailEstimate(est: RetailEstimate): string {
  if (est.low === est.high) return `£${est.mid}`;
  return `£${est.mid} (£${est.low}–£${est.high})`;
}

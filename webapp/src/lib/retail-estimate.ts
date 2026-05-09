import type { BidderProfileDump, EconomicsDump, RunItem } from "../types.js";

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

/** Defaults that match the engine's `DEFAULT_ECONOMICS_CONFIG`. Used
 *  when a dump pre-dates the economics field. */
const FALLBACK_ECONOMICS: EconomicsDump = {
  tierMultipliers: { mint: 1.5, good: 1.1, fair: 0.8, shoddy: 0.5, broken: 0.25 },
  estimateSpreadAtZeroAccuracy: 0.5,
  estimateSpreadAtFullAccuracy: 0.05,
  pubBuyerCeilingFraction: 0.5,
};

/**
 * Compute a trader's per-unit retail estimate for an item at a given
 * tier. Pass `null` for tier when the trader doesn't know yet (an
 * un-inspected auction lot) — the band widens to span shoddy..good.
 *
 * Better category accuracy → narrower band. Mirrors the engine's
 * `estimateUnitRetail` exactly. Reads tier multipliers and spread
 * bounds from the dump's economics block when present (falls back to
 * defaults for older dumps).
 */
export function estimateUnitRetail(
  profile: BidderProfileDump,
  item: Pick<RunItem, "baseValue" | "category">,
  tier: string | null,
  economics: EconomicsDump = FALLBACK_ECONOMICS,
): RetailEstimate {
  const tierMult = economics.tierMultipliers;
  const accuracyRaw =
    profile.appraisalAccuracy[item.category] ?? profile.defaultAppraisalAccuracy;
  const judgement = clamp01(accuracyRaw);
  const spread =
    economics.estimateSpreadAtZeroAccuracy +
    (economics.estimateSpreadAtFullAccuracy -
      economics.estimateSpreadAtZeroAccuracy) *
      judgement;

  if (tier !== null && tierMult[tier] !== undefined) {
    const mid = item.baseValue * (tierMult[tier] ?? 1);
    return {
      low: Math.max(0, Math.round(mid * (1 - spread))),
      mid: Math.max(0, Math.round(mid)),
      high: Math.max(0, Math.round(mid * (1 + spread))),
    };
  }

  const lowAnchor = item.baseValue * (tierMult.shoddy ?? 0.5);
  const midAnchor = item.baseValue * (tierMult.fair ?? 0.8);
  const highAnchor = item.baseValue * (tierMult.good ?? 1.1);
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

import type { BidderProfile } from "./bidder-profile.js";
import type { QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

/**
 * The trader's mental price tag for a per-unit retail price band. Used
 * for UI display ("Boycie reckons fair-tier ladders go for ~£18 each")
 * and as the deterministic core that the noisy `appraiseLot` samples
 * around when a real bid ceiling is needed.
 *
 * `mid` is the trader's best guess. `low`/`high` flank it; the band's
 * width is set by the trader's category accuracy. Better judgement →
 * narrower band. When the lot's tier is unknown to the trader (no
 * inspection done), the band straddles a few tiers around the assumed
 * one to model genuine uncertainty about what's in the box.
 */
export interface RetailEstimate {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
}

/**
 * Compute the trader's per-unit retail estimate for an item at a given
 * tier. Pass `null` for tier when the trader doesn't know the tier yet
 * (un-inspected auction lot) — the band widens to span shoddy..good
 * around an assumed `fair` mid.
 *
 * Pure function: stable across calls with the same arguments. RNG-free
 * by design; the bidder pipeline samples around this band when it
 * needs a noisy ceiling. All numerical knobs (tier multipliers, spread
 * bounds) come from `EconomicsConfig` — defaulting to engine defaults.
 */
export function estimateUnitRetail(
  profile: BidderProfile,
  item: { readonly baseValue: number; readonly category: string },
  tier: QualityTier | null,
  economics: EconomicsConfig = DEFAULT_ECONOMICS_CONFIG,
): RetailEstimate {
  const tierMult = economics.tierMultipliers;
  const accuracyRaw =
    profile.appraisalAccuracy.get(item.category) ??
    profile.defaultAppraisalAccuracy;
  const judgement = clamp01(accuracyRaw);
  // Linear interpolation between the two extremes.
  const spread =
    economics.estimateSpreadAtZeroAccuracy +
    (economics.estimateSpreadAtFullAccuracy -
      economics.estimateSpreadAtZeroAccuracy) *
      judgement;

  if (tier !== null) {
    const mid = item.baseValue * tierMult[tier];
    return {
      low: Math.max(0, Math.round(mid * (1 - spread))),
      mid: Math.max(0, Math.round(mid)),
      high: Math.max(0, Math.round(mid * (1 + spread))),
    };
  }

  // Tier unknown: the trader's uncertainty stretches the band across
  // adjacent tiers. Anchor the low/high at the shoddy/good multipliers
  // and let accuracy still squeeze the band a bit.
  const lowAnchor = item.baseValue * tierMult.shoddy;
  const midAnchor = item.baseValue * tierMult.fair;
  const highAnchor = item.baseValue * tierMult.good;
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

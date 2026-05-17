import type { BidderProfile } from "../auction/bidder-profile.js";
import type { FlawType } from "../stock/types.js";
import type { KnowledgeProfile } from "./types.js";

/**
 * Map a five-axis KnowledgeProfile down to the legacy two-axis
 * BidderProfile so existing call sites (auction pipeline, market sale,
 * pub-deal autonomy, shop sale) keep working unchanged.
 *
 * The legacy `appraisalAccuracy` smushes together two of the new axes:
 * condition (how good is its state?) and price (what's the going rate?).
 * Either one being weak should noisy-up the legacy valuation, so the
 * mapping uses the *minimum* of the two — the actor's appraisal is
 * gated by whichever sub-skill is worse.
 *
 * The legacy `flawTypeDetection` and `customerTypes` map directly.
 *
 * `customerFitAccuracy` and `bandPlacementAccuracy` have no legacy
 * slot — they're only consulted by the new code paths (consultation
 * action, belief-band aggregator, v2 extraction band). Skipping them
 * here is correct; the legacy code never asked.
 */
export function toBidderProfile(p: KnowledgeProfile): BidderProfile {
  const mergedCategory = new Map<string, number>();
  const allCategories = new Set<string>([
    ...p.conditionAccuracy.keys(),
    ...p.priceAccuracy.keys(),
  ]);
  for (const cat of allCategories) {
    const cond = p.conditionAccuracy.get(cat) ?? p.defaultConditionAccuracy;
    const price = p.priceAccuracy.get(cat) ?? p.defaultPriceAccuracy;
    mergedCategory.set(cat, Math.min(cond, price));
  }
  const flawMap = new Map<FlawType, number>(p.flawDetection);
  return {
    appraisalAccuracy: mergedCategory,
    defaultAppraisalAccuracy: Math.min(
      p.defaultConditionAccuracy,
      p.defaultPriceAccuracy,
    ),
    flawTypeDetection: flawMap,
    defaultFlawTypeDetection: p.defaultFlawDetection,
    ...(p.customerTypes ? { customerTypes: p.customerTypes } : {}),
  };
}

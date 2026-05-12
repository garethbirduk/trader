import type { DB } from "../core/db.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import { persistKnowledgeProfile } from "./skills-repo.js";
import { FALLBACK_KNOWLEDGE_PROFILE, type KnowledgeProfile } from "./types.js";

/**
 * Derive a five-axis KnowledgeProfile from a legacy two-axis
 * BidderProfile. Used by skins that already publish bidderProfiles —
 * gives every actor a persisted five-axis grid in the new schema
 * without forcing the skin to re-declare its cast.
 *
 * Mapping rule (mirrors `legacy-bridge.toBidderProfile` in reverse):
 *   • appraisalAccuracy → both `conditionAccuracy` and `priceAccuracy`
 *     get the same value. (The legacy axis didn't separate them;
 *     splitting starts equal and skin tuning differentiates over time.)
 *   • flawTypeDetection → `flawDetection` 1:1.
 *   • defaultAppraisalAccuracy → both defaults.
 *   • defaultFlawTypeDetection → flaw default.
 *   • customerTypes → preserved.
 *
 * `idAccuracy` and `customerFitAccuracy` have no legacy counterpart;
 * they default to FALLBACK values. Skins can override per actor by
 * setting persisted skills directly after this call.
 */
export function deriveKnowledgeProfile(p: BidderProfile): KnowledgeProfile {
  const idAccuracy = new Map<string, number>();
  const conditionAccuracy = new Map<string, number>();
  const priceAccuracy = new Map<string, number>();
  const customerFitAccuracy = new Map<string, number>();
  for (const [cat, acc] of p.appraisalAccuracy) {
    conditionAccuracy.set(cat, acc);
    priceAccuracy.set(cat, acc);
  }
  const flawDetection = new Map(p.flawTypeDetection);
  return {
    idAccuracy,
    defaultIdAccuracy: FALLBACK_KNOWLEDGE_PROFILE.defaultIdAccuracy,
    conditionAccuracy,
    defaultConditionAccuracy: p.defaultAppraisalAccuracy,
    flawDetection,
    defaultFlawDetection: p.defaultFlawTypeDetection,
    priceAccuracy,
    defaultPriceAccuracy: p.defaultAppraisalAccuracy,
    customerFitAccuracy,
    defaultCustomerFitAccuracy:
      FALLBACK_KNOWLEDGE_PROFILE.defaultCustomerFitAccuracy,
    ...(p.customerTypes ? { customerTypes: p.customerTypes } : {}),
  };
}

/**
 * Seed actor_skills + actor_skill_defaults for every actor in the
 * supplied map. Idempotent: re-running with the same map overwrites
 * the same rows.
 */
export function seedKnowledgeProfiles(
  db: DB,
  bidderProfiles: ReadonlyMap<number, BidderProfile>,
): void {
  for (const [actorId, bidder] of bidderProfiles) {
    persistKnowledgeProfile(db, actorId, deriveKnowledgeProfile(bidder));
  }
}

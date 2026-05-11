import type { SeededRNG } from "../core/rng.js";
import { QUALITY_TIERS, type QualityTier } from "../stock/types.js";
import type { GossipMutationConfig } from "../economics/config.js";
import type { LeadSide } from "./types.js";

/**
 * Information mutation on every gossip hop. One pure function, one call
 * site (`shareLead`). Per the design:
 *
 *   • Numeric drift always: a fact retold gains ±jitter on the qty and
 *     price the speaker is claiming. The story stays in the right
 *     postcode but the digits slide.
 *   • Tier slip occasionally: "I heard Boyce had mint Casios" becomes
 *     "good ones," becomes "fair." Bounded ±1 step in the QUALITY_TIERS
 *     ordering.
 *   • Role reversal rarely but catastrophically: "Trigger needs Walkmans"
 *     becomes "Trigger has Walkmans," which sends people to talk to
 *     him for stock he doesn't carry. The flipped lead also drops its
 *     `subjectPoolId` — once the role is wrong, the pool grounding is
 *     no longer about the same fact.
 *
 * The original lead is untouched (shareLead always inserts a new row);
 * only the receiver's copy is mutated. Both stories persist in the
 * world. The information game is figuring out which one is right.
 */
export interface MutatableLeadFields {
  readonly side: LeadSide;
  readonly subjectQualityTier: QualityTier | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly subjectPoolId: number | null;
}

export function mutateLead(
  input: MutatableLeadFields,
  rng: SeededRNG,
  config: GossipMutationConfig,
): MutatableLeadFields {
  // Numeric jitter — applied unconditionally. A uniform draw across the
  // symmetric band, rounded, floored at 1 so a £0/qty=0 lead can't fall
  // out the bottom.
  const estimatedQuantity = jitter(
    input.estimatedQuantity,
    config.quantityJitter,
    rng,
  );
  const estimatedUnitPrice = jitter(
    input.estimatedUnitPrice,
    config.priceJitter,
    rng,
  );

  // Tier slip — bounded ±1 step. Direction is fair.
  let subjectQualityTier = input.subjectQualityTier;
  if (subjectQualityTier !== null && rng.chance(config.tierSlipChance)) {
    const idx = QUALITY_TIERS.indexOf(subjectQualityTier);
    if (idx !== -1) {
      const dir = rng.chance(0.5) ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(QUALITY_TIERS.length - 1, idx + dir));
      subjectQualityTier = QUALITY_TIERS[nextIdx]!;
    }
  }

  // Side flip — drops the pool grounding. The receiver's lead is now
  // about something that may or may not exist; tying it to the original
  // supply pool would be a category error.
  let side = input.side;
  let subjectPoolId = input.subjectPoolId;
  if (rng.chance(config.sideFlipChance)) {
    side = side === "supply" ? "demand" : "supply";
    subjectPoolId = null;
  }

  return {
    side,
    subjectQualityTier,
    estimatedQuantity,
    estimatedUnitPrice,
    subjectPoolId,
  };
}

function jitter(value: number, fraction: number, rng: SeededRNG): number {
  if (fraction <= 0) return value;
  const factor = 1 + (rng.next() * 2 - 1) * fraction;
  return Math.max(1, Math.round(value * factor));
}

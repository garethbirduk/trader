import type { SeededRNG } from "../core/rng.js";
import { QUALITY_TIERS, type QualityTier } from "../stock/types.js";
import type { GossipMutationConfig } from "../economics/config.js";
import type { LeadKind, LeadSide } from "./types.js";

/**
 * Information mutation on every gossip hop. One pure function, one call
 * site (`shareLead`). Per the design:
 *
 *   • Numeric drift always: a fact retold gains ±jitter on the qty and
 *     price the speaker is claiming. Same for commodity (quantity/price)
 *     and rep (severity count / £-damage).
 *   • Tier slip occasionally: commodity-only. "I heard Boyce had mint
 *     Casios" becomes "good ones," becomes "fair." Bounded ±1 step.
 *   • Role reversal rarely but catastrophically.
 *     - For commodity leads: supply↔demand flip; the flipped lead also
 *       drops its `subjectPoolId` since the role is now wrong.
 *     - For rep leads: subjectTarget↔counterparty swap — "Boyce burned
 *       Trigger" becomes "Trigger burned Boyce." Doesn't touch `side`
 *       or pool grounding (rep leads have no pool anyway).
 *
 * The original lead is untouched (shareLead always inserts a new row);
 * only the receiver's copy is mutated. Both stories persist in the
 * world. The information game is figuring out which one is right.
 */
export interface MutatableLeadFields {
  readonly kind: LeadKind;
  readonly side: LeadSide;
  readonly subjectQualityTier: QualityTier | null;
  readonly subjectTargetActorId: number | null;
  readonly counterpartyActorId: number | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly subjectPoolId: number | null;
}

export function mutateLead(
  input: MutatableLeadFields,
  rng: SeededRNG,
  config: GossipMutationConfig,
): MutatableLeadFields {
  // Numeric jitter — applied unconditionally for both kinds. A uniform
  // draw across the symmetric band, rounded, floored at 1 so a £0/qty=0
  // lead can't fall out the bottom.
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

  // Tier slip — commodity leads only, bounded ±1 step. Direction is fair.
  let subjectQualityTier = input.subjectQualityTier;
  if (
    input.kind === "commodity" &&
    subjectQualityTier !== null &&
    rng.chance(config.tierSlipChance)
  ) {
    const idx = QUALITY_TIERS.indexOf(subjectQualityTier);
    if (idx !== -1) {
      const dir = rng.chance(0.5) ? -1 : 1;
      const nextIdx = Math.max(0, Math.min(QUALITY_TIERS.length - 1, idx + dir));
      subjectQualityTier = QUALITY_TIERS[nextIdx]!;
    }
  }

  // Role reversal — different for each kind. Commodity flips side and
  // drops pool grounding (the receiver's lead is now about something
  // that may or may not exist; tying it to the original supply pool
  // would be a category error). Rep swaps the perpetrator and the
  // victim — "Boyce burned Trigger" ↔ "Trigger burned Boyce."
  let side = input.side;
  let subjectPoolId = input.subjectPoolId;
  let subjectTargetActorId = input.subjectTargetActorId;
  let counterpartyActorId = input.counterpartyActorId;
  if (rng.chance(config.sideFlipChance)) {
    if (input.kind === "commodity") {
      side = side === "supply" ? "demand" : "supply";
      subjectPoolId = null;
    } else {
      // Rep flip: swap subject and counterparty. If counterparty was
      // null (e.g. "Boyce is dodgy" with no named victim) the swap is
      // a no-op — there's nothing to invert with.
      if (counterpartyActorId !== null) {
        const tmp = subjectTargetActorId;
        subjectTargetActorId = counterpartyActorId;
        counterpartyActorId = tmp;
      }
    }
  }

  return {
    kind: input.kind,
    side,
    subjectQualityTier,
    subjectTargetActorId,
    counterpartyActorId,
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

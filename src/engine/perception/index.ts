/**
 * Judgement engine — public surface (docs/judgement.md). Every
 * perception call site in the engine routes through this module:
 *
 *   • `estimateLotValue` — Identity ∘ Condition ∘ Price composition
 *     for auction-lot and pubdeal-buyer appraisal. Returns a £
 *     valuation, the per-arm breakdown, and flaw / customer-fit
 *     multipliers.
 *   • `estimatePriceBand` — RNG-free centre + band for "what does
 *     this actor think this is worth" diagnostic surfaces and
 *     belief-anchored haggle floors / targets.
 *   • `estimate` — single-decision sample from the price arm
 *     directly. Used by the scenario snapshot to pin the four-case
 *     distributional shape.
 *   • `estimateIdentity` / `estimateCondition` — categorical and
 *     ordinal arms. Used by `estimateLotValue` internally; surfaced
 *     for any future call site that wants the per-arm result.
 *   • `colourFor(value, perceiverJ)` — band-collapsed palette index
 *     for the UI; resolution gated by the player-actor's j.
 *
 * The character arm wires in at pub-deal entry as a flawDetectionBonus
 * on estimateLotValue — see docs/judgement.md "the character arm —
 * bidirectional reading" and `pub-deal-autonomy.ts`.
 */

export {
  PERCEPTION_ARMS,
  isPerceptionArm,
  type Arm,
  type EstimateResult,
} from "./types.js";

export {
  PALETTE_STOPS,
  PALETTE_HEX,
  bandCount,
  colourFor,
} from "./palette.js";

export {
  estimate,
  computeEstimate,
  estimatePriceBand,
  computePriceBand,
  steppedJ,
  SHARPNESS_DAMPING,
  TIGHT_KERNEL_HALF_WIDTH_FRAC,
  type EstimateArgs,
  type PriceBandArgs,
  type PriceBandResult,
} from "./estimate.js";

export {
  resolvePerArmDials,
  resolvePerArmDialsPure,
  CHARACTER_DEFAULT_EXPERTISE,
  type PerArmDials,
  type ResolveDialsArgs,
} from "./expertise.js";

export {
  estimateIdentity,
  estimateCondition,
  estimateIdentityPure,
  estimateConditionPure,
  perceivedTierCentre,
  computePerceivedTierCentre,
  type IdentityArmResult,
  type ConditionArmResult,
  type IdentityArgs,
  type ConditionArgs,
} from "./arms.js";

export {
  estimateLotValue,
  type LotValuation,
  type EstimateLotValueArgs,
} from "./lot-value.js";

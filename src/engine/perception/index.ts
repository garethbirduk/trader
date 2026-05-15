/**
 * Judgement engine — public surface. v1 lands the numeric two-knob
 * band model behind `estimate()`; the UI palette ships alongside.
 * See docs/judgement.md for the full architectural brief.
 *
 * What's wired up in v1:
 *   • `estimate({ db, actorId, arm: 'price', category, truth, rng })`
 *     — produces a centred band + a mixture-shaped sample.
 *   • `colourFor(value, perceiverJ)` — band-collapsed palette index.
 *
 * What's NOT wired up yet (later phases):
 *   • `arm: 'identity' | 'condition' | 'character'` — the helper
 *     throws to keep call sites honest. Identity / condition will
 *     route through the same centred-band shape once the auction
 *     composition lands; character ships with the pub-deal social-
 *     delta phase.
 *   • Migration of `appraiseLot` / `estimateUnitRetail` / pub-deal /
 *     market / shop sale to call this helper. Today's call sites
 *     keep reading through the legacy bridge.
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
  steppedJ,
  SHARPNESS_DAMPING,
  TIGHT_KERNEL_HALF_WIDTH_FRAC,
  type EstimateArgs,
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

/**
 * Judgement / perception engine — public types.
 *
 * The architectural brief lives in `docs/judgement.md`. v1 lands the
 * numeric two-knob band model (centre from expertise, spread from j,
 * mixture-shaped sampling) behind a single `estimate()` helper. The
 * UI palette + perceiver-j-band collapse ships alongside as a pure
 * helper. Wider migration — auction lot composition, character arm,
 * pub-deal / market / shop call sites — is staged across later phases.
 */

/**
 * The three perception arms. Each runs the same two-knob machinery on
 * its own expertise and j; different decisions consume different
 * subsets (see docs/judgement.md "Which arms apply where").
 *
 * v1 PR lands the math but only the `price` arm is exercised through
 * `estimate`. Condition / character route through the same helper in
 * later phases; their slots exist now so the type surface doesn't
 * shift when those arms ship.
 */
export const PERCEPTION_ARMS = [
  "condition",
  "price",
  "character",
] as const;

export type Arm = (typeof PERCEPTION_ARMS)[number];

export function isPerceptionArm(value: unknown): value is Arm {
  return (
    typeof value === "string" &&
    (PERCEPTION_ARMS as readonly string[]).includes(value)
  );
}

/**
 * Result of one numeric estimate. The deterministic `{centre, low, high}`
 * band is what the UI renders; `sample` is the one number a single-shot
 * decision uses this turn. The mixture distribution producing `sample`
 * means repeated calls under the same RNG draw the same number, but
 * different RNG streams from the same actor on the same target produce
 * different samples — "usually right, occasionally a wild miss."
 *
 * `expertise` and `j` are echoed back for diagnostics / UI tooltips;
 * call sites should not derive behaviour from them directly.
 */
export interface EstimateResult {
  readonly arm: Arm;
  /** Belief centre — `lerp(genericAnchor[category], truth, expertise)`. */
  readonly centre: number;
  /** Lower edge of the band. `>= 0`. */
  readonly low: number;
  /** Upper edge of the band. `>= centre`. */
  readonly high: number;
  /** Single mixture-shaped draw — what a decision-this-turn uses. */
  readonly sample: number;
  /** Effective expertise that drove `centre`. Diagnostic. */
  readonly expertise: number;
  /** Effective j that drove spread + sampling. Diagnostic. */
  readonly j: number;
}

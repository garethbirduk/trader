import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import { getCategoryAnchor } from "./anchors-repo.js";
import { resolvePerArmDials } from "./expertise.js";
import type { Arm, EstimateResult } from "./types.js";

/**
 * Numeric judgement — produces a centred band and a mixture-shaped
 * sample. The doc's two-knob model in code (docs/judgement.md §1):
 *
 *   centre = lerp(genericAnchor[category], truth, expertise)
 *   spread = (1 - effectiveJ)   // higher j → narrower band
 *   sample ∼ mixture:
 *     • with prob j  → draw from tight kernel near centre
 *     • with prob 1-j → draw uniformly across [low, high]
 *
 * `effectiveJ` is the *stepped + damped* version of j used by engine
 * math: `floor(j*10)/10 + frac(j*10) * SHARPNESS_DAMPING`. Damping
 * (0.05, not the full 0.10) is critical — see the doc:
 *
 *   > if sharpness gets the full 0.10 weight, the formula
 *   > floor(j × 10)/10 + frac(j × 10) × 0.1 algebraically equals j
 *   > and the band model collapses back to a flat continuous multiplier.
 *
 * The damped band stops the model from being equivalent to today's
 * continuous-accuracy formula and produces the doc's "band-stepped"
 * behaviour at the visible scale while preserving sub-band
 * sharpness at the engine scale.
 */

/** Sub-band sharpness weight. See the comment above. */
export const SHARPNESS_DAMPING = 0.05;

/**
 * Tight-kernel half-width as a fraction of the band's full width.
 * A small but non-zero value gives the cinematic "almost on truth,
 * with a whisker of noise" shape without committing to a Gaussian.
 */
export const TIGHT_KERNEL_HALF_WIDTH_FRAC = 0.05;

export interface EstimateArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly arm: Arm;
  /**
   * Per-arm key used by the expertise resolver:
   *   • price / condition → category string
   *   • identity          → pair code "kind_a_code|kind_b_code"
   *   • character         → ignored (pass undefined)
   *
   * Also used for the anchor lookup — see `anchorCategory`.
   */
  readonly key?: string;
  /**
   * Category for the generic-anchor lookup. Defaults to `key` for
   * price/condition (which are category-keyed) but can be overridden
   * for arms where the lookup category differs from the per-arm key
   * (e.g. identity uses pair code as `key` but should lerp against
   * the item's category).
   */
  readonly anchorCategory?: string;
  /** Truth — what `estimate()` returns at expertise=1 *and* j=1. */
  readonly truth: number;
  readonly rng: SeededRNG;
  /**
   * Optional cached profile override. Hot loops (auction composition,
   * notebook recompute) should load the profile once and pass it
   * here to avoid the per-call DB roundtrip.
   */
  readonly profileOverride?: KnowledgeProfile;
}

export function estimate(args: EstimateArgs): EstimateResult {
  // v1 PR exercises the price arm only. Identity / condition route
  // through the same numeric shape in P5 (auction composition);
  // character is a later phase. Failing loud here keeps misuse from
  // silently producing nonsense.
  if (args.arm !== "price") {
    throw new Error(
      `perception.estimate: arm '${args.arm}' not wired yet in this phase. ` +
        `v1 PR supports 'price' only. See docs/judgement.md "Implementation order".`,
    );
  }

  if (!Number.isFinite(args.truth) || args.truth < 0) {
    throw new Error(
      `estimate: truth must be a finite non-negative number; got ${args.truth}`,
    );
  }

  const dials = resolvePerArmDials({
    db: args.db,
    actorId: args.actorId,
    arm: args.arm,
    ...(args.key !== undefined ? { key: args.key } : {}),
    ...(args.profileOverride !== undefined
      ? { profileOverride: args.profileOverride }
      : {}),
  });

  const anchorCat = args.anchorCategory ?? args.key;
  const anchor =
    anchorCat !== undefined ? getCategoryAnchor(args.db, anchorCat) : 0;

  return computeEstimate({
    arm: args.arm,
    truth: args.truth,
    anchor,
    expertise: dials.expertise,
    j: dials.j,
    rng: args.rng,
  });
}

/**
 * Pure mixture-sampling core — no DB. Tests against the four-case
 * matrix in docs/judgement.md §2 call this directly with explicit
 * `(expertise, j)` pairs.
 */
export function computeEstimate(args: {
  readonly arm: Arm;
  readonly truth: number;
  readonly anchor: number;
  readonly expertise: number;
  readonly j: number;
  readonly rng: SeededRNG;
}): EstimateResult {
  const expertise = clamp01(args.expertise);
  const j = clamp01(args.j);

  // ── Centre: lerp(anchor, truth, expertise) ─────────────────────
  const centre = args.anchor + (args.truth - args.anchor) * expertise;

  // ── Spread: stepped j with damped sub-band sharpness ───────────
  const effectiveJ = steppedJ(j);
  const spreadFactor = 1 - effectiveJ;
  const low = Math.max(0, centre * (1 - spreadFactor));
  const high = Math.max(low, centre * (1 + spreadFactor));

  // ── Sample: mixture (prob j tight | prob 1-j uniform) ──────────
  // Decompose the coin toss + draw into deterministic RNG sequence:
  // two calls regardless of branch, so the RNG stream advances the
  // same amount each invocation — keeps replay-determinism stable.
  const mixtureRoll = args.rng.next();
  const drawRoll = args.rng.next();
  let sample: number;
  if (mixtureRoll < j) {
    // Tight kernel — small uniform around centre. Width is a small
    // fraction of the band; at very-low-j the band is wide so the
    // tight kernel still has some texture.
    const tightHalf = (high - low) * TIGHT_KERNEL_HALF_WIDTH_FRAC;
    sample = Math.max(0, centre + (drawRoll - 0.5) * 2 * tightHalf);
  } else {
    // Wide draw — uniform across the full band.
    sample = low + drawRoll * (high - low);
  }

  return {
    arm: args.arm,
    centre,
    low,
    high,
    sample,
    expertise,
    j,
  };
}

/**
 * Stepped j with damped sub-band sharpness:
 *   effective = floor(j * 10) / 10 + frac(j * 10) * SHARPNESS_DAMPING
 *
 * Produces band-stepped behaviour at the visible scale (j=0.51 and
 * j=0.52 round to the same band) while preserving a tiny continuous
 * differentiator at the engine scale.
 */
export function steppedJ(j: number): number {
  const clamped = clamp01(j);
  const scaled = clamped * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  return floor / 10 + frac * SHARPNESS_DAMPING;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

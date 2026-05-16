/**
 * Universal belief-display palette — 10 stops running blue (low) →
 * green (mid) → red (high). See docs/judgement.md "Display — band-
 * collapsed colour palette."
 *
 * The palette is the ruler; what a perceiver can *distinguish* is
 * gated by their j. A perceiver at j=1.0 sees all 10 stops; at
 * j=0.5 they see 5; at j=0.1 they see 1. The same value renders the
 * same colour to a perceiver within their band — 0.95 and 0.85 are
 * visually identical to a j=0.2 perceiver (both fall in their upper
 * band), but visibly different to a j=1.0 perceiver.
 *
 * Sub-band sharpness — the continuous fractional part of `j * 10` —
 * is used by engine math (where j=0.51 and j=0.52 make marginally
 * different decisions hundreds of times per day) but NOT by colour
 * (where they're identical). The damping factor in the engine math
 * lives in `engine/perception/index.ts`.
 */

/** Number of palette stops. 10 = the doc's commitment. */
export const PALETTE_STOPS = 10;

/**
 * 10-stop hex palette running blue → green → red. Generated from a
 * cool→warm gradient; tweak in one place if the visual identity of
 * the game changes. Indices 0..9 are returned by `colourFor`; UI
 * code maps the index to whichever rendering primitive it uses
 * (CSS class, hex literal, SVG fill).
 */
export const PALETTE_HEX: readonly string[] = [
  "#1e3a8a", // 0  deep blue
  "#1d4ed8", // 1
  "#0ea5e9", // 2
  "#14b8a6", // 3
  "#22c55e", // 4  green (mid)
  "#84cc16", // 5
  "#eab308", // 6
  "#f59e0b", // 7
  "#ef4444", // 8
  "#991b1b", // 9  deep red
];

/**
 * How many bands a perceiver at this j can distinguish.
 * `bands = max(2, floor(j * 10))`. Minimum 2 because a single band
 * collapses every value to one colour — useless as a signal. At j=0
 * the perceiver still sees a binary "high vs low" split (worst band
 * vs best band); from j=0.2 upwards the formula scales smoothly to
 * the full 10 at j=1.0.
 */
export function bandCount(perceiverJ: number): number {
  const clamped = clamp01(perceiverJ);
  return Math.max(2, Math.floor(clamped * PALETTE_STOPS));
}

export interface ColourForOptions {
  /**
   * Flip the palette direction. When `false` (default) the palette
   * is value-monotonic — low value → blue end, high value → red end
   * — which is the natural ruler for "price", "accuracy", "cost".
   * When `true` the returned stop is mirrored across the midpoint so
   * low value → red, high value → blue. Use for surfaces where
   * "good for the viewer" sits at the low end of the value scale —
   * e.g. condition (broken=low=bad=red, mint=high=good=blue), or
   * demand-side prices viewed from the seller's perspective.
   */
  readonly invert?: boolean;
}

/**
 * Map a [0, 1] value to a palette index, gated by the perceiver's j.
 * The perceiver's band collapses the continuous belief to the band
 * midpoint; that midpoint then maps to the nearest of `PALETTE_STOPS`
 * stops.
 *
 *   colourFor(0.95, 0.2) → same index as colourFor(0.85, 0.2)
 *   colourFor(0.95, 1.0) ≠ colourFor(0.85, 1.0)
 *
 * Values outside [0, 1] are clamped. Caller is responsible for
 * normalising upstream — e.g. a £-band's mid divided by its truth-
 * adjusted max, an accuracy scalar, etc.
 */
export function colourFor(
  value: number,
  perceiverJ: number,
  opts?: ColourForOptions,
): number {
  const v = clamp01(value);
  const bands = bandCount(perceiverJ);
  // Which of the perceiver's `bands` bins does v fall into?
  // bin index i in [0, bands-1]
  const i = Math.min(bands - 1, Math.floor(v * bands));
  // Band midpoint, mapped onto the 10-stop ruler.
  const midpoint = (i + 0.5) / bands;
  const stop = Math.min(
    PALETTE_STOPS - 1,
    Math.floor(midpoint * PALETTE_STOPS),
  );
  return opts?.invert === true ? PALETTE_STOPS - 1 - stop : stop;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * UI palette — mirrors the engine's `src/engine/perception/palette.ts`.
 * Kept here (not imported across the webapp/engine bundle boundary)
 * so the webapp builds standalone. If the engine palette changes,
 * keep this in sync.
 *
 * 10-stop blue → green → red palette. The palette is the universal
 * ruler; what a perceiver can distinguish is gated by their j.
 * Playing Trigger (j ≈ 0.3) grains the screen to 3 visible bands;
 * playing Boyce (j ≈ 0.8) shows 8.
 */

export const PALETTE_STOPS = 10;

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

export function bandCount(perceiverJ: number): number {
  const clamped = clamp01(perceiverJ);
  return Math.max(1, Math.floor(clamped * PALETTE_STOPS));
}

/**
 * Map a [0, 1] value to a palette index, gated by perceiver j. The
 * perceiver's band collapses the continuous belief to the band
 * midpoint; that midpoint maps to the nearest of `PALETTE_STOPS` stops.
 */
export function colourFor(value: number, perceiverJ: number): number {
  const v = clamp01(value);
  const bands = bandCount(perceiverJ);
  const i = Math.min(bands - 1, Math.floor(v * bands));
  const midpoint = (i + 0.5) / bands;
  return Math.min(PALETTE_STOPS - 1, Math.floor(midpoint * PALETTE_STOPS));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

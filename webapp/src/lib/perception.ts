/**
 * Client-side mirror of the engine's `computePriceBand` (see
 * `src/engine/perception/estimate.ts`). Kept in sync manually — the
 * webapp/engine boundary doesn't import across, so changes to the
 * engine's price-band math need to land here too.
 *
 *   centre = anchor + (truth - anchor) × expertise
 *   spread = 1 - effectiveJ
 *   low    = max(0, centre × (1 - spread))
 *   high   = max(low, centre × (1 + spread))
 *
 * `effectiveJ` applies the same stepped + damped sub-band sharpness
 * as the engine, so j=0.51 and j=0.52 land in the same visible band
 * but a tiny continuous differentiator survives for engine math.
 * The webapp uses centres only (BeliefChip is a display, not a
 * decision-maker), so the sub-band damping is informationally inert
 * here — kept aligned for parity if a future call site samples.
 */

import type { BidderProfileDump, EconomicsDump, RunDump, RunItem } from "../types.js";

export interface PriceBandResult {
  readonly centre: number;
  readonly low: number;
  readonly high: number;
  readonly expertise: number;
  readonly j: number;
}

const SHARPNESS_DAMPING = 0.05;

/** Mirrors `steppedJ` in the engine. */
function steppedJ(j: number): number {
  const clamped = clamp01(j);
  const scaled = clamped * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  return floor / 10 + frac * SHARPNESS_DAMPING;
}

/**
 * Compute an actor's belief band for a (category, truth) pair.
 *
 *   • `expertise` is sourced from the actor's `appraisalAccuracy[category]`
 *     (falling back to `defaultAppraisalAccuracy`).
 *   • `j` reads from the actor's stored `armJ.price` override when
 *     present; otherwise falls back to expertise (matching the
 *     engine's `getActorArmJ ?? expertise` resolution in
 *     `perception/expertise.ts`).
 *   • `anchor` is the per-category prior; callers using tier-adjusted
 *     truth should pre-multiply by `tierMult[perceivedTier]` (see
 *     `tieredAnchorFor` helper).
 */
export function priceBandFor(
  profile: BidderProfileDump,
  category: string,
  truth: number,
  anchor: number,
  /** Optional stored j override for the price arm — usually
   *  `actor.armJ?.price`. */
  storedJ?: number,
): PriceBandResult {
  const expertise = clamp01(
    profile.appraisalAccuracy[category] ?? profile.defaultAppraisalAccuracy,
  );
  const j = storedJ !== undefined ? clamp01(storedJ) : expertise;
  return computePriceBand({ truth, anchor, expertise, j });
}

/** Pure variant — same shape as the engine's `computePriceBand`. */
export function computePriceBand(args: {
  readonly truth: number;
  readonly anchor: number;
  readonly expertise: number;
  readonly j: number;
}): PriceBandResult {
  const expertise = clamp01(args.expertise);
  const j = clamp01(args.j);
  const centre = args.anchor + (args.truth - args.anchor) * expertise;
  const effectiveJ = steppedJ(j);
  const spreadFactor = 1 - effectiveJ;
  const low = Math.max(0, centre * (1 - spreadFactor));
  const high = Math.max(low, centre * (1 + spreadFactor));
  return { centre, low, high, expertise, j };
}

/**
 * Resolve the anchor for a category from the dump, falling back to
 * the engine's `DEFAULT_ANCHOR_FALLBACK` (30) when the dump pre-dates
 * the categoryAnchors field or the category isn't seeded.
 */
export function anchorFor(dump: RunDump, category: string): number {
  return dump.categoryAnchors?.[category] ?? 30;
}

/**
 * Resolve the condition-arm anchor for a category — the v2 condition
 * arm's quality-scalar [0, 1] prior. Falls back to the engine's
 * `DEFAULT_CONDITION_ANCHOR_FALLBACK` (0.5) when the dump pre-dates
 * the field or the category isn't seeded. Surfaces that want to
 * show "what tier would a clueless actor expect here by default?"
 * read this.
 */
export function conditionAnchorFor(dump: RunDump, category: string): number {
  return dump.categoryConditionAnchors?.[category] ?? 0.5;
}

/**
 * Tier-adjusted anchor — `anchor × tierMult[tier]`. Use when the
 * truth value passed to `priceBandFor` is itself tier-adjusted
 * (i.e. `baseValue × tierMult[tier]`). Without this, a clueless
 * actor inspecting a broken item still anchors at the category
 * average and ends up massively over-estimating; with it the anchor
 * scales linearly with perceived condition.
 *
 * Falls back to the category anchor unchanged when tier is null or
 * not in the economics multiplier map (older dumps, exotic tiers).
 */
export function tieredAnchorFor(
  dump: RunDump,
  category: string,
  tier: string | null,
): number {
  const base = anchorFor(dump, category);
  if (tier === null) return base;
  const mult = dump.economics?.tierMultipliers?.[tier];
  if (mult === undefined || !Number.isFinite(mult)) return base;
  return base * mult;
}

/**
 * Resolve the tier-adjusted truth for an item at a quality tier.
 * Returns `null` when economics data is missing (very old dumps).
 */
export function tierTruth(
  item: Pick<RunItem, "baseValue">,
  tier: string | null,
  economics: EconomicsDump | undefined,
): number | null {
  if (economics === undefined) return null;
  if (tier === null) return null;
  const mult = economics.tierMultipliers[tier];
  if (mult === undefined) return null;
  return item.baseValue * mult;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Format the price-arm derivation as a multi-line string for a
 * browser-native `title` tooltip — the first slice of the judgement
 * audit trail (docs/judgement.md). Walks the same `centre =
 * lerp(anchor, truth, expertise)` and `spread = 1 - effectiveJ`
 * formula `priceBandFor` uses, so what the player reads matches the
 * computed centre exactly. Numbers stay raw (no localisation) to
 * match the engine's pence arithmetic.
 */
export function formatPriceArmMath(args: {
  readonly observerName: string;
  readonly itemName: string;
  readonly category: string;
  /** Tier the price band was computed against — drives the truth
   *  multiplier. Pass `null` for "no tier read" surfaces (the
   *  tooltip omits the tier-mult line in that case). */
  readonly truthTier: string | null;
  readonly truthUnit: number;
  readonly anchor: number;
  readonly band: PriceBandResult;
  readonly quantity: number;
}): string {
  const {
    observerName,
    itemName,
    category,
    truthTier,
    truthUnit,
    anchor,
    band,
    quantity,
  } = args;
  const ePct = (band.expertise * 100).toFixed(0);
  const jStr = band.j.toFixed(2);
  const centreR = Math.round(band.centre);
  const lowR = Math.round(band.low);
  const highR = Math.round(band.high);
  const truthR = Math.round(truthUnit);
  const anchorR = Math.round(anchor);
  const totalR = centreR * quantity;
  const tierLabel = truthTier ?? "—";
  return [
    `${observerName} · ${itemName} (${category}, ${tierLabel})`,
    `Price arm:`,
    `  truth   £${truthR}/u`,
    `  anchor  £${anchorR}/u (category prior × tier mult)`,
    `  centre = lerp(anchor, truth, expertise ${ePct}%) = £${centreR}/u`,
    `  j=${jStr} → band [£${lowR}, £${highR}]/u`,
    `  × ${quantity} = £${totalR} total`,
  ].join("\n");
}

import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import { getItemKindById } from "../stock/items-repo.js";
import { getStockLotById } from "../stock/lots-repo.js";
import { QUALITY_TIERS, type QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import {
  findBandContaining,
  findNearestBand,
  getActorBands,
  type CategoryBand,
} from "./bands-repo.js";
import { loadKnowledgeProfile } from "./skills-repo.js";
import { getTierMultiplierBelief } from "./tier-beliefs-repo.js";
import { FALLBACK_KNOWLEDGE_PROFILE, type KnowledgeProfile } from "./types.js";

/**
 * v2 extraction band — the four-skill aggregator.
 *
 * Four skills produce the actor's £ band for a lot:
 *
 *   1. **Band placement** — given the actor's mental partition for
 *      this category (from `actor_category_bands`), roll their
 *      placement-skill. On pass: the lot lands in the band that
 *      contains the lot's true mint-baseline RRP. On fail: it lands
 *      in an adjacent band (or the closest if outside their
 *      coverage).
 *
 *   2. **Band tightness** — given the placed band, narrow within it.
 *      Skill 1.0 → quote collapses to a point (the band's midpoint).
 *      Skill 0.0 → quote spans the whole band.
 *
 *   3. **Condition detection** — roll the actor's per-category (or
 *      transferable-default) skill to read the tier. Pass: lot's
 *      true tier. Fail: one tier off (slip up or down with equal
 *      probability, clamped at the endpoints). Cross-category
 *      transfer happens via the per-actor default; per-category
 *      overrides capture specialist learning.
 *
 *   4. **Condition impact** — look up the actor's stored belief of
 *      the tier multiplier for this category (from
 *      `actor_tier_beliefs`). If absent, fall back to the engine's
 *      truth multiplier. The discrepancy IS the actor's condition-
 *      impact skill, made explicit.
 *
 * The final band is the placed band's (low, high) narrowed by
 * tightness, then multiplied by the actor's believed-tier multiplier
 * for the perceived tier.
 *
 * **The actor's partition is at the mint-baseline RRP**. Condition
 * shifts the lot's price after placement, not the placement itself.
 * An idiot with one band (£2000–£10000) sees a mint Rolex (baseline
 * £8000) AND a broken Rolex (baseline still £8000) as the same band;
 * their condition multiplier then shifts the final number.
 */

export interface V2ExtractionBand {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  /** True when the actor has no band partition for this category. */
  readonly unsupported: boolean;
  /** The band the actor placed the lot in (or null if no coverage). */
  readonly placedBand: CategoryBand | null;
  /** The tier the actor perceived the lot to be in. */
  readonly perceivedTier: QualityTier;
  /** The multiplier the actor applied for that perceived tier. */
  readonly perceivedMultiplier: number;
}

export interface ComputeV2BandArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly lotId: number;
  readonly rng: SeededRNG;
  readonly economics?: EconomicsConfig;
  /**
   * Optional override of the actor's skill profile. Default loads
   * from DB. Test seam.
   */
  readonly profileOverride?: KnowledgeProfile;
}

export function computeV2ExtractionBand(
  args: ComputeV2BandArgs,
): V2ExtractionBand {
  const economics = args.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const lot = getStockLotById(args.db, args.lotId);
  if (!lot) throw new Error(`computeV2ExtractionBand: lot ${args.lotId} not found`);
  const item = getItemKindById(args.db, lot.itemKindId);
  if (!item) {
    throw new Error(
      `computeV2ExtractionBand: item_kind ${lot.itemKindId} not found`,
    );
  }

  const profile =
    args.profileOverride ?? loadKnowledgeProfile(args.db, args.actorId);
  const category = item.category;
  const trueBaselineRrp = item.baseValue; // mint-baseline RRP

  // ── Step 1: Band placement ─────────────────────────────────────
  const containing = findBandContaining(
    args.db,
    args.actorId,
    category,
    trueBaselineRrp,
  );

  // If the actor has no partition for this category at all, fall
  // back to the legacy prior: the whole tier-multiplied range.
  if (containing === null) {
    const nearest = findNearestBand(args.db, args.actorId, category, trueBaselineRrp);
    if (nearest === null) {
      return fallbackBand(item.baseValue, lot.qualityTier, economics);
    }
    // Mis-placed: lot falls outside any band. We use the nearest
    // band as the actor's best guess — they have a model, just an
    // imperfect one.
    return placeAndModulate({
      db: args.db,
      actorId: args.actorId,
      band: nearest,
      lot,
      profile,
      category,
      rng: args.rng,
      economics,
      placedCorrectly: false,
    });
  }

  // The actor's partition does cover the lot. Roll placement-skill:
  // on fail, slip to an adjacent band (one band off in band_idx).
  const placementSkillRaw =
    profile.idAccuracy.get(category) ?? profile.defaultIdAccuracy;
  const placementSkill = clamp01(
    // Reuse the v1 `idAccuracy` map for v2's `band_placement` keyed
    // by category — the upstream loader writes the new axis into
    // the existing map shape so we don't need a parallel field.
    placementSkillRaw,
  );

  let placedBand = containing;
  let placedCorrectly = true;
  if (args.rng.next() >= placementSkill) {
    // Mis-place. Nudge to the band whose band_idx differs by ±1.
    // Fetch the full partition to find the neighbour. If there's
    // only one band, mis-placement is a no-op (nowhere to slip to).
    const all = getActorBands(args.db, args.actorId, category);
    if (all.length > 1) {
      const idx = all.findIndex((b) => b.id === containing.id);
      const dir = args.rng.next() < 0.5 ? -1 : 1;
      let neighbourIdx = idx + dir;
      // Mirror at endpoints so a slip never falls off the partition.
      if (neighbourIdx < 0) neighbourIdx = idx + 1;
      if (neighbourIdx >= all.length) neighbourIdx = idx - 1;
      placedBand = all[neighbourIdx] ?? containing;
      placedCorrectly = false;
    }
  }

  return placeAndModulate({
    db: args.db,
    actorId: args.actorId,
    band: placedBand,
    lot,
    profile,
    category,
    rng: args.rng,
    economics,
    placedCorrectly,
  });
}

interface PlaceAndModulateArgs {
  db: DB;
  actorId: number;
  band: CategoryBand;
  lot: import("../stock/types.js").StockLot;
  profile: KnowledgeProfile;
  category: string;
  rng: SeededRNG;
  economics: EconomicsConfig;
  placedCorrectly: boolean;
}

function placeAndModulate(args: PlaceAndModulateArgs): V2ExtractionBand {
  // ── Step 2: Band tightness — narrow within the placed band ─────
  // Skill 1.0 collapses to the band midpoint; skill 0.0 keeps the
  // full band. We use the v1 `priceAccuracy[category]` slot as the
  // tightness scalar.
  const tightnessRaw =
    args.profile.priceAccuracy.get(args.category) ??
    args.profile.defaultPriceAccuracy;
  const tightness = clamp01(tightnessRaw);
  const midOfBand = (args.band.low + args.band.high) / 2;
  const halfWidth = (args.band.high - args.band.low) / 2;
  const narrowedHalfWidth = halfWidth * (1 - tightness);
  let narrowedLow = midOfBand - narrowedHalfWidth;
  let narrowedHigh = midOfBand + narrowedHalfWidth;
  // If placement was wrong, widen slightly to reflect the actor's
  // wobble. The wobble is small — the actor is confident in their
  // (wrong) placement; the band just leaks at the edges.
  if (!args.placedCorrectly) {
    narrowedLow *= 0.95;
    narrowedHigh *= 1.05;
  }

  // ── Step 3: Condition detection ────────────────────────────────
  const detectionSkillRaw =
    args.profile.conditionAccuracy.get(args.category) ??
    args.profile.defaultConditionAccuracy;
  const detection = clamp01(detectionSkillRaw);
  const passed = args.rng.next() < detection;
  const perceivedTier: QualityTier = passed
    ? args.lot.qualityTier
    : adjacentTier(args.lot.qualityTier, args.rng);

  // ── Step 4: Condition impact — use the actor's stored belief ──
  const multiplier = getTierMultiplierBelief(
    args.db,
    args.actorId,
    args.category,
    perceivedTier,
    args.economics,
  );

  const lowFinal = Math.max(0, Math.round(narrowedLow * multiplier));
  // Allow low === high — a tightness=1 expert produces a point quote
  // and that's the intended cinematic shape. Downstream haggle code
  // already allows floor === target.
  const highFinal = Math.max(lowFinal, Math.round(narrowedHigh * multiplier));
  const midFinal = Math.max(0, Math.round(((lowFinal + highFinal) / 2)));

  return {
    low: lowFinal,
    mid: midFinal,
    high: highFinal,
    unsupported: false,
    placedBand: args.band,
    perceivedTier,
    perceivedMultiplier: multiplier,
  };
}

function fallbackBand(
  baseValue: number,
  trueTier: QualityTier,
  economics: EconomicsConfig,
): V2ExtractionBand {
  // Actor has no partition for this category — return the
  // unconditional truth-prior at the true tier with wide skirt.
  const mid = baseValue * economics.tierMultipliers[trueTier];
  return {
    low: Math.max(0, Math.round(mid * 0.5)),
    mid: Math.max(0, Math.round(mid)),
    high: Math.max(1, Math.round(mid * 1.5)),
    unsupported: true,
    placedBand: null,
    perceivedTier: trueTier,
    perceivedMultiplier: economics.tierMultipliers[trueTier],
  };
}

function adjacentTier(tier: QualityTier, rng: SeededRNG): QualityTier {
  const idx = QUALITY_TIERS.indexOf(tier);
  if (idx === 0) return QUALITY_TIERS[1]!;
  if (idx === QUALITY_TIERS.length - 1) {
    return QUALITY_TIERS[QUALITY_TIERS.length - 2]!;
  }
  const dir = rng.next() < 0.5 ? -1 : 1;
  return QUALITY_TIERS[idx + dir]!;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Keep an explicit re-export of the fallback profile so tests can
// build minimal profile overrides without round-tripping the DB.
export { FALLBACK_KNOWLEDGE_PROFILE };

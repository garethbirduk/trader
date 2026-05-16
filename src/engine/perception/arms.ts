import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import { getConfusableNeighbours } from "../knowledge/confusable-pairs-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { ItemKind } from "../stock/types.js";
import type { QualityTier } from "../stock/types.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import { resolvePerArmDials, resolvePerArmDialsPure } from "./expertise.js";
import { steppedJ, TIGHT_KERNEL_HALF_WIDTH_FRAC } from "./estimate.js";

/**
 * Categorical / ordinal arms — identity and condition.
 *
 * The doc's "two-knob machinery" is fully specified for *numeric*
 * arms (price, character) where expertise drives the centre and j
 * drives the band's spread + sampling kernel. For *non-numeric* arms
 * the equivalent shape is less obvious: an identity claim is binary
 * (Rolex or Rulex), a condition claim picks one of five tiers.
 *
 *   • Identity — pass/fail roll. Pass rate =
 *       expertise × (1 - pair_difficulty). On pass: truth kind. On
 *       fail: the confusable neighbour. Multiple neighbours: pick
 *       uniformly. (Same shape as `consult.ts:sampleId`.) j is still
 *       a no-op here — a v2 identity arm would model "decisive call
 *       vs hedge between two kinds" but it's not built yet.
 *
 *   • Condition (v2) — band-over-categorical. Quality is mapped to
 *       [0, 1] (broken=0.1 … mint=0.9 at tier midpoints) and the
 *       same lerp + j-spread machinery as the price arm runs:
 *       centre = condAnchor + (truthQuality - condAnchor) × expertise;
 *       spreadFactor = 1 - effectiveJ; band straddles centre additively
 *       on the [0,1] quality scale; sample drawn from a mixture
 *       (tight kernel with prob j, uniform across band with prob 1-j);
 *       sample is snapped back to the nearest of the five tiers.
 *
 *       The result is the doc's "perceived tier as a distribution
 *       rather than a point pick" — a clueless low-j actor can see
 *       mint when truth is broken, not just adjacent.
 *       (Was: a pass/fail roll with j no-op'd and fails always
 *       sliding to an adjacent tier. v1 lived in commit 0ef3cff;
 *       this rewrite is the doc-anticipated v2.)
 */

export interface IdentityArmResult {
  /** The kindId the actor thinks the lot is. */
  readonly perceivedKindId: number;
  /** Effective expertise on the chosen confusable pair (already
   *  multiplied by `1 - pair difficulty`). 1.0 if no neighbours. */
  readonly effectivePassRate: number;
  /** True iff the actor identified the lot correctly. */
  readonly passed: boolean;
  /** The neighbour kind the actor risked confusing with (or null
   *  when no confusable pair exists). */
  readonly confusedWithKindId: number | null;
}

export interface ConditionArmResult {
  readonly perceivedTier: QualityTier;
  readonly expertise: number;
  /** Stored or fallback j for the condition arm — drives the band's
   *  spread and the tight/uniform mixture kernel. */
  readonly j: number;
  /** True when the actor perceived the truth tier exactly. Derived
   *  (`perceivedTier === truthTier`); kept for API stability with v1
   *  callers that read this directly. */
  readonly passed: boolean;
}

export interface IdentityArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly truthItemKindId: number;
  readonly rng: SeededRNG;
  readonly profileOverride?: KnowledgeProfile;
}

export interface ConditionArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly truthTier: QualityTier;
  readonly category: string;
  readonly rng: SeededRNG;
  readonly profileOverride?: KnowledgeProfile;
}

export function estimateIdentity(args: IdentityArgs): IdentityArmResult {
  const neighbours = getConfusableNeighbours(args.db, args.truthItemKindId);
  if (neighbours.length === 0) {
    return {
      perceivedKindId: args.truthItemKindId,
      effectivePassRate: 1,
      passed: true,
      confusedWithKindId: null,
    };
  }
  const chosen = args.rng.pick(neighbours);
  const dials = resolvePerArmDials({
    db: args.db,
    actorId: args.actorId,
    arm: "identity",
    key: chosen.pairCode,
    ...(args.profileOverride !== undefined
      ? { profileOverride: args.profileOverride }
      : {}),
  });
  const effective = dials.expertise * (1 - chosen.difficulty);
  const passed = args.rng.next() < effective;
  return {
    perceivedKindId: passed ? args.truthItemKindId : chosen.kindId,
    effectivePassRate: effective,
    passed,
    confusedWithKindId: chosen.kindId,
  };
}

export function estimateCondition(args: ConditionArgs): ConditionArmResult {
  const dials = resolvePerArmDials({
    db: args.db,
    actorId: args.actorId,
    arm: "condition",
    key: args.category,
    ...(args.profileOverride !== undefined
      ? { profileOverride: args.profileOverride }
      : {}),
  });
  return runConditionBand({
    truthTier: args.truthTier,
    expertise: dials.expertise,
    j: dials.j,
    rng: args.rng,
  });
}

/**
 * Pure variant — no DB. Tests pass an in-memory profile + an
 * explicit list of confusable neighbours.
 */
export function estimateIdentityPure(args: {
  readonly profile: KnowledgeProfile;
  readonly truthItemKindId: number;
  readonly neighbours: readonly {
    readonly kindId: number;
    readonly pairCode: string;
    readonly difficulty: number;
  }[];
  readonly rng: SeededRNG;
  readonly storedJ?: number | null;
}): IdentityArmResult {
  if (args.neighbours.length === 0) {
    return {
      perceivedKindId: args.truthItemKindId,
      effectivePassRate: 1,
      passed: true,
      confusedWithKindId: null,
    };
  }
  const chosen = args.rng.pick(args.neighbours);
  const dials = resolvePerArmDialsPure({
    profile: args.profile,
    arm: "identity",
    key: chosen.pairCode,
    storedJ: args.storedJ ?? null,
  });
  const effective = dials.expertise * (1 - chosen.difficulty);
  const passed = args.rng.next() < effective;
  return {
    perceivedKindId: passed ? args.truthItemKindId : chosen.kindId,
    effectivePassRate: effective,
    passed,
    confusedWithKindId: chosen.kindId,
  };
}

export function estimateConditionPure(args: {
  readonly profile: KnowledgeProfile;
  readonly truthTier: QualityTier;
  readonly category: string;
  readonly rng: SeededRNG;
  readonly storedJ?: number | null;
}): ConditionArmResult {
  const dials = resolvePerArmDialsPure({
    profile: args.profile,
    arm: "condition",
    key: args.category,
    storedJ: args.storedJ ?? null,
  });
  return runConditionBand({
    truthTier: args.truthTier,
    expertise: dials.expertise,
    j: dials.j,
    rng: args.rng,
  });
}

/**
 * Default condition anchor — the "uninformed prior" quality scalar.
 * A clueless actor's centre lerps from this toward truth. 0.5 = the
 * midpoint quality (the "fair" tier), which is the natural lay
 * person's assumption when they have no per-category condition eye.
 *
 * v1 of this arm uses a single global anchor. A per-category
 * `category_condition_anchors` table is the obvious extension if
 * play-testing shows certain categories need different priors (eg
 * tools tend to be beaten-up; electronics tend to be near-new) but
 * we don't have data to motivate that distinction yet.
 */
const CONDITION_ANCHOR = 0.5;

/** Tier midpoints on the [0, 1] quality scale — five tiers, five
 *  equal bands, midpoints at 0.1, 0.3, 0.5, 0.7, 0.9. Indexed by
 *  position in QUALITY_TIERS (which is mint→broken). We reverse the
 *  order so 0.0 = broken and 1.0 = mint, matching the "low quality
 *  = low value" convention that drives the inverted UI palette. */
const TIER_QUALITY: ReadonlyMap<QualityTier, number> = new Map<QualityTier, number>([
  ["broken", 0.1],
  ["shoddy", 0.3],
  ["fair", 0.5],
  ["good", 0.7],
  ["mint", 0.9],
]);

/**
 * Deterministic "centre tier" — what tier the actor's condition belief
 * centres on, given their expertise. RNG-free: doesn't sample from
 * the band, just snaps the centre quality to its nearest tier. Used
 * by gossip-lead seeders (`seed-from-stock`, `seed-from-pool`) to set
 * `subjectQualityTier` so that a clueless seeder propagates a wrong
 * tier through gossip, the same way `estimatePriceBand` already sets
 * `estimatedUnitPrice`.
 *
 * Note that j has no effect on the centre — it only widens the band
 * around it. So a clueless seeder always centres on the condition
 * anchor (≈ "fair"), regardless of their j. An expert seeder always
 * centres on truth.
 */
export function perceivedTierCentre(args: {
  readonly db: DB;
  readonly actorId: number;
  readonly truthTier: QualityTier;
  readonly category: string;
  readonly profileOverride?: KnowledgeProfile;
}): QualityTier {
  const dials = resolvePerArmDials({
    db: args.db,
    actorId: args.actorId,
    arm: "condition",
    key: args.category,
    ...(args.profileOverride !== undefined
      ? { profileOverride: args.profileOverride }
      : {}),
  });
  return computePerceivedTierCentre(args.truthTier, dials.expertise);
}

/** Pure variant — no DB. Tests and the snapshot-style internal
 *  recompute use this directly. */
export function computePerceivedTierCentre(
  truthTier: QualityTier,
  expertise: number,
): QualityTier {
  const e = clamp01(expertise);
  const truthQuality = TIER_QUALITY.get(truthTier) ?? 0.5;
  const centre = CONDITION_ANCHOR + (truthQuality - CONDITION_ANCHOR) * e;
  return tierForQuality(centre);
}

/** Snap a quality scalar in [0, 1] to the nearest tier (one of five
 *  equal bands). Sample at 0.05 → broken; at 0.95 → mint. */
function tierForQuality(q: number): QualityTier {
  const clamped = q < 0 ? 0 : q > 1 ? 1 : q;
  const idx = Math.min(4, Math.floor(clamped * 5));
  return ([
    "broken",
    "shoddy",
    "fair",
    "good",
    "mint",
  ] as const)[idx]!;
}

/** Pure band-and-sample core for the condition arm. Same shape as the
 *  price arm's `computeEstimate`, but on the [0, 1] quality scale
 *  with additive (not multiplicative) band-around-centre arithmetic
 *  — multiplicative would degenerate at centre=0 (broken truth). */
function runConditionBand(args: {
  readonly truthTier: QualityTier;
  readonly expertise: number;
  readonly j: number;
  readonly rng: SeededRNG;
}): ConditionArmResult {
  const expertise = clamp01(args.expertise);
  const j = clamp01(args.j);
  const truthQuality = TIER_QUALITY.get(args.truthTier) ?? 0.5;

  // Centre lerps from the uninformed anchor toward truth by expertise.
  const centre = CONDITION_ANCHOR + (truthQuality - CONDITION_ANCHOR) * expertise;

  // Spread tied to j: full quality range at j=0, collapses at j=1.
  // The full quality range is [0, 1], so spreadFactor is the
  // half-width of the band (clamped to [0, 0.5]).
  const effectiveJ = steppedJ(j);
  const spreadFactor = (1 - effectiveJ) / 2;
  const low = Math.max(0, centre - spreadFactor);
  const high = Math.min(1, centre + spreadFactor);

  // Mixture sample — two RNG draws regardless of branch so the stream
  // advances deterministically, matching the price arm's convention.
  const mixtureRoll = args.rng.next();
  const drawRoll = args.rng.next();
  let sample: number;
  if (mixtureRoll < j) {
    const tightHalf = (high - low) * TIGHT_KERNEL_HALF_WIDTH_FRAC;
    sample = centre + (drawRoll - 0.5) * 2 * tightHalf;
  } else {
    sample = low + drawRoll * (high - low);
  }

  const perceivedTier = tierForQuality(sample);
  return {
    perceivedTier,
    expertise,
    j,
    passed: perceivedTier === args.truthTier,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Convenience: load truth item kind by id. Throws on missing. */
export function requireItemKind(db: DB, kindId: number): ItemKind {
  const it = getItemKindById(db, kindId);
  if (!it) throw new Error(`requireItemKind: kind ${kindId} not found`);
  return it;
}

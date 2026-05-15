import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import { getConfusableNeighbours } from "../knowledge/confusable-pairs-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { ItemKind } from "../stock/types.js";
import { QUALITY_TIERS, type QualityTier } from "../stock/types.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import { resolvePerArmDials, resolvePerArmDialsPure } from "./expertise.js";

/**
 * Categorical / ordinal arms — identity and condition.
 *
 * The doc's "two-knob machinery" is fully specified for *numeric*
 * arms (price, character) where expertise drives the centre and j
 * drives the band's spread + sampling kernel. For *non-numeric* arms
 * the equivalent shape is less obvious: an identity claim is binary
 * (Rolex or Rulex), a condition claim picks one of five tiers. v1
 * uses a deliberate simplification:
 *
 *   • Identity — pass/fail roll. Pass rate =
 *       expertise × (1 - pair_difficulty). On pass: truth kind. On
 *       fail: the confusable neighbour. Multiple neighbours: pick
 *       uniformly. (Same shape as `consult.ts:sampleId`.)
 *
 *   • Condition — pass/fail roll on the actor's per-category
 *       condition-accuracy. On pass: truth tier. On fail: adjacent
 *       tier (one step up or down, clamped at the endpoints).
 *
 * j is currently a no-op on both arms. Once the UI palette ships and
 * we've felt a few sessions, we'll revisit — likely either as a
 * "commitment scalar" (high j = less hedging on a borderline call)
 * or as a band-over-categorical mapping (perceived tier as a
 * distribution rather than a point pick). For v1 this is enough to
 * land the compositional auction valuation.
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
  const passed = args.rng.next() < dials.expertise;
  const perceivedTier = passed ? args.truthTier : adjacentTier(args.truthTier, args.rng);
  return { perceivedTier, expertise: dials.expertise, passed };
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
  const passed = args.rng.next() < dials.expertise;
  const perceivedTier = passed ? args.truthTier : adjacentTier(args.truthTier, args.rng);
  return { perceivedTier, expertise: dials.expertise, passed };
}

function adjacentTier(tier: QualityTier, rng: SeededRNG): QualityTier {
  const idx = QUALITY_TIERS.indexOf(tier);
  if (idx === 0) return QUALITY_TIERS[1]!;
  if (idx === QUALITY_TIERS.length - 1) {
    return QUALITY_TIERS[QUALITY_TIERS.length - 2]!;
  }
  return rng.next() < 0.5 ? QUALITY_TIERS[idx - 1]! : QUALITY_TIERS[idx + 1]!;
}

/** Convenience: load truth item kind by id. Throws on missing. */
export function requireItemKind(db: DB, kindId: number): ItemKind {
  const it = getItemKindById(db, kindId);
  if (!it) throw new Error(`requireItemKind: kind ${kindId} not found`);
  return it;
}

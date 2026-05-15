import type { DB } from "../core/db.js";
import { loadKnowledgeProfile } from "../knowledge/skills-repo.js";
import type { KnowledgeProfile } from "../knowledge/types.js";
import { getActorArmJ } from "./arm-j-repo.js";
import type { Arm } from "./types.js";

/**
 * Per-actor per-arm dials — what the judgement engine needs to
 * produce a band + sample for a single decision. `expertise` drives
 * the centre (via `lerp(anchor, truth, expertise)`); `j` drives the
 * spread and the sampling kernel.
 *
 * `expertise` is sourced from the existing `KnowledgeProfile`'s
 * per-axis accuracy maps:
 *   • arm = 'price'     → priceAccuracy[category] ?? defaultPriceAccuracy
 *   • arm = 'condition' → conditionAccuracy[category] ?? defaultConditionAccuracy
 *   • arm = 'identity'  → idAccuracy keyed by *pair code*, not category
 *                         (callers must pass the pair code as `key`)
 *   • arm = 'character' → no existing slot; falls back to
 *                         `CHARACTER_DEFAULT_EXPERTISE`. Wired up
 *                         properly when the character arm ships.
 *
 * `j` is sourced from `actor_arm_j` if a row exists, else falls back
 * to the resolved expertise (the doc's "skin defaults set them equal"
 * rule).
 */

export interface PerArmDials {
  readonly expertise: number;
  readonly j: number;
}

/**
 * Fallback expertise for the character arm before that arm ships.
 * Mid-range so a v1 call doesn't produce degenerate behaviour if a
 * caller accidentally consults it.
 */
export const CHARACTER_DEFAULT_EXPERTISE = 0.5;

export interface ResolveDialsArgs {
  readonly db: DB;
  readonly actorId: number;
  readonly arm: Arm;
  /**
   * Per-arm key:
   *   • price / condition → category string
   *   • identity          → pair code "kind_a_code|kind_b_code"
   *   • character         → unused (passing it is fine; it's ignored)
   *
   * Required for price/condition/identity. Optional for character.
   */
  readonly key?: string;
  /**
   * Optional pre-loaded profile — saves a DB roundtrip when the
   * caller already has it (the auction composition pipeline will pass
   * a cached profile for hot loops).
   */
  readonly profileOverride?: KnowledgeProfile;
}

export function resolvePerArmDials(args: ResolveDialsArgs): PerArmDials {
  const profile =
    args.profileOverride ?? loadKnowledgeProfile(args.db, args.actorId);
  const expertise = resolveArmExpertise(profile, args.arm, args.key);
  const storedJ = getActorArmJ(args.db, args.actorId, args.arm);
  const j = storedJ ?? expertise;
  return { expertise: clamp01(expertise), j: clamp01(j) };
}

/**
 * Pure variant — no DB. Useful for tests that already hold a profile
 * + an explicit j, and for the auction-composition pipeline which
 * loads the profile once per bidder per lot.
 */
export function resolvePerArmDialsPure(args: {
  readonly profile: KnowledgeProfile;
  readonly arm: Arm;
  readonly key?: string;
  /** Stored j for this arm, or null to fall back to expertise. */
  readonly storedJ: number | null;
}): PerArmDials {
  const expertise = resolveArmExpertise(args.profile, args.arm, args.key);
  const j = args.storedJ ?? expertise;
  return { expertise: clamp01(expertise), j: clamp01(j) };
}

function resolveArmExpertise(
  profile: KnowledgeProfile,
  arm: Arm,
  key: string | undefined,
): number {
  switch (arm) {
    case "price":
      if (key === undefined) return profile.defaultPriceAccuracy;
      return profile.priceAccuracy.get(key) ?? profile.defaultPriceAccuracy;
    case "condition":
      if (key === undefined) return profile.defaultConditionAccuracy;
      return (
        profile.conditionAccuracy.get(key) ?? profile.defaultConditionAccuracy
      );
    case "identity":
      if (key === undefined) return profile.defaultIdAccuracy;
      return profile.idAccuracy.get(key) ?? profile.defaultIdAccuracy;
    case "character":
      // No legacy slot — the character arm is the doc's only genuinely
      // new perception arm. Until the character-expertise migration
      // lands, every actor reads as mid-range here.
      return CHARACTER_DEFAULT_EXPERTISE;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

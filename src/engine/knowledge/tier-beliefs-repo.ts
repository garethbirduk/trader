import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

/**
 * Per-(actor, category, tier) belief about the condition multiplier.
 * Truth lives in `EconomicsConfig.tierMultipliers`; the actor's mental
 * model may differ. Captures the "condition-impact skill" — an actor
 * who thinks a broken Bosch is ×0.7 (still salvageable) when the
 * truth is ×0.25 is bad at this axis for the dishwasher category.
 *
 * `condition-impact` skill from the design isn't stored as a scalar
 * here — the discrepancy *is* the skill, made concrete. Skin setup
 * seeds close-to-truth multipliers for experts and noisy ones for
 * novices.
 */

export interface TierBelief {
  readonly actorId: number;
  readonly category: string;
  readonly tier: QualityTier;
  readonly multiplier: number;
}

interface TierBeliefRow {
  actor_id: number;
  category: string;
  tier: string;
  multiplier: number;
}

function rowToBelief(r: TierBeliefRow): TierBelief {
  if (!isQualityTier(r.tier)) {
    throw new Error(`invalid tier in actor_tier_beliefs: ${r.tier}`);
  }
  return {
    actorId: r.actor_id,
    category: r.category,
    tier: r.tier,
    multiplier: r.multiplier,
  };
}

export function setTierBelief(
  db: DB,
  args: {
    actorId: number;
    category: string;
    tier: QualityTier;
    multiplier: number;
  },
): TierBelief {
  if (args.multiplier < 0) {
    throw new Error(`multiplier must be >= 0; got ${args.multiplier}`);
  }
  db.prepare(
    `INSERT INTO actor_tier_beliefs (actor_id, category, tier, multiplier)
     VALUES (@actor, @cat, @tier, @m)
     ON CONFLICT (actor_id, category, tier)
       DO UPDATE SET multiplier = excluded.multiplier`,
  ).run({
    actor: args.actorId,
    cat: args.category,
    tier: args.tier,
    m: args.multiplier,
  });
  return {
    actorId: args.actorId,
    category: args.category,
    tier: args.tier,
    multiplier: args.multiplier,
  };
}

/** All of an actor's tier beliefs for one category. */
export function getTierBeliefs(
  db: DB,
  actorId: number,
  category: string,
): Map<QualityTier, number> {
  const out = new Map<QualityTier, number>();
  for (const row of db
    .prepare<TierBeliefRow>(
      `SELECT * FROM actor_tier_beliefs
        WHERE actor_id = @actor AND category = @cat`,
    )
    .all({ actor: actorId, cat: category })) {
    const belief = rowToBelief(row);
    out.set(belief.tier, belief.multiplier);
  }
  return out;
}

/**
 * The believed multiplier for one tier, falling back to the engine's
 * truth multipliers when no belief is stored. Used by the v2
 * aggregator when computing the actor's price band for a placed lot
 * at a perceived tier.
 */
export function getTierMultiplierBelief(
  db: DB,
  actorId: number,
  category: string,
  tier: QualityTier,
  economics: EconomicsConfig = DEFAULT_ECONOMICS_CONFIG,
): number {
  const row = db
    .prepare<{ multiplier: number }>(
      `SELECT multiplier FROM actor_tier_beliefs
        WHERE actor_id = @actor AND category = @cat AND tier = @tier`,
    )
    .get({ actor: actorId, cat: category, tier });
  return row?.multiplier ?? economics.tierMultipliers[tier];
}

/**
 * Seed an actor's tier beliefs from the engine's truth multipliers
 * (perfect-knowledge actor). Used by skins to bootstrap the
 * specialist cast — they know what condition does.
 */
export function seedTierBeliefsAtTruth(
  db: DB,
  args: { actorId: number; category: string; economics?: EconomicsConfig },
): void {
  const economics = args.economics ?? DEFAULT_ECONOMICS_CONFIG;
  db.transaction(() => {
    for (const tier of Object.keys(economics.tierMultipliers) as QualityTier[]) {
      setTierBelief(db, {
        actorId: args.actorId,
        category: args.category,
        tier,
        multiplier: economics.tierMultipliers[tier],
      });
    }
  });
}

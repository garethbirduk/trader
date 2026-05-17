import type { DB } from "../core/db.js";
import type { FlawType } from "../stock/types.js";
import { isFlawType } from "../stock/types.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  isKnowledgeAxis,
  type KnowledgeAxis,
  type KnowledgeProfile,
} from "./types.js";

/**
 * Skill-grid persistence. Two tables:
 *   actor_skills          — per-(actor, axis, key) accuracy scores
 *   actor_skill_defaults  — per-(actor, axis) fallback when no key matches
 *
 * Together they reconstruct a full `KnowledgeProfile` for a given
 * actor. Setting a skill is upsert-shaped; reading is one query that
 * pulls all rows for the actor.
 */

interface SkillRow {
  actor_id: number;
  axis: string;
  key: string;
  accuracy: number;
}

interface DefaultRow {
  actor_id: number;
  axis: string;
  accuracy: number;
}

export function setActorSkill(
  db: DB,
  args: {
    actorId: number;
    axis: KnowledgeAxis;
    key: string;
    accuracy: number;
  },
): void {
  if (args.accuracy < 0 || args.accuracy > 1) {
    throw new Error(
      `accuracy must be in [0, 1]; got ${args.accuracy} for ` +
        `${args.axis}:${args.key}`,
    );
  }
  db.prepare(
    `INSERT INTO actor_skills (actor_id, axis, key, accuracy)
     VALUES (@actor, @axis, @key, @acc)
     ON CONFLICT (actor_id, axis, key) DO UPDATE SET accuracy = excluded.accuracy`,
  ).run({
    actor: args.actorId,
    axis: args.axis,
    key: args.key,
    acc: args.accuracy,
  });
}

export function setActorSkillDefault(
  db: DB,
  args: {
    actorId: number;
    axis: KnowledgeAxis;
    accuracy: number;
  },
): void {
  if (args.accuracy < 0 || args.accuracy > 1) {
    throw new Error(
      `default accuracy must be in [0, 1]; got ${args.accuracy} for ${args.axis}`,
    );
  }
  db.prepare(
    `INSERT INTO actor_skill_defaults (actor_id, axis, accuracy)
     VALUES (@actor, @axis, @acc)
     ON CONFLICT (actor_id, axis) DO UPDATE SET accuracy = excluded.accuracy`,
  ).run({ actor: args.actorId, axis: args.axis, acc: args.accuracy });
}

/**
 * Load the full five-axis skill grid for one actor. Axes with no
 * persisted default fall back to the engine fallback. Returns the
 * fallback profile (verbatim) when the actor has no rows at all.
 */
export function loadKnowledgeProfile(
  db: DB,
  actorId: number,
): KnowledgeProfile {
  const defaultsByAxis = new Map<KnowledgeAxis, number>();
  for (const row of db
    .prepare<DefaultRow>(
      `SELECT * FROM actor_skill_defaults WHERE actor_id = @actor`,
    )
    .all({ actor: actorId })) {
    if (!isKnowledgeAxis(row.axis)) continue;
    defaultsByAxis.set(row.axis, row.accuracy);
  }

  const bandPlacementAccuracy = new Map<string, number>();
  const conditionAccuracy = new Map<string, number>();
  const flawDetection = new Map<FlawType, number>();
  const priceAccuracy = new Map<string, number>();
  const customerFitAccuracy = new Map<string, number>();

  for (const row of db
    .prepare<SkillRow>(`SELECT * FROM actor_skills WHERE actor_id = @actor`)
    .all({ actor: actorId })) {
    if (!isKnowledgeAxis(row.axis)) continue;
    switch (row.axis) {
      case "band_placement":
        bandPlacementAccuracy.set(row.key, row.accuracy);
        break;
      case "condition":
        conditionAccuracy.set(row.key, row.accuracy);
        break;
      case "flaw":
        if (isFlawType(row.key)) flawDetection.set(row.key, row.accuracy);
        break;
      case "price":
        priceAccuracy.set(row.key, row.accuracy);
        break;
      case "customer_fit":
        customerFitAccuracy.set(row.key, row.accuracy);
        break;
    }
  }

  return {
    bandPlacementAccuracy,
    defaultBandPlacementAccuracy:
      defaultsByAxis.get("band_placement") ??
      FALLBACK_KNOWLEDGE_PROFILE.defaultBandPlacementAccuracy,
    conditionAccuracy,
    defaultConditionAccuracy:
      defaultsByAxis.get("condition") ??
      FALLBACK_KNOWLEDGE_PROFILE.defaultConditionAccuracy,
    flawDetection,
    defaultFlawDetection:
      defaultsByAxis.get("flaw") ??
      FALLBACK_KNOWLEDGE_PROFILE.defaultFlawDetection,
    priceAccuracy,
    defaultPriceAccuracy:
      defaultsByAxis.get("price") ??
      FALLBACK_KNOWLEDGE_PROFILE.defaultPriceAccuracy,
    customerFitAccuracy,
    defaultCustomerFitAccuracy:
      defaultsByAxis.get("customer_fit") ??
      FALLBACK_KNOWLEDGE_PROFILE.defaultCustomerFitAccuracy,
  };
}

/**
 * One-shot batch writer: load + apply + persist a full profile for an
 * actor. Skin setup calls this for each actor with their spec. Existing
 * rows are overwritten where the new profile defines them; rows for
 * unspecified keys are left in place.
 */
export function persistKnowledgeProfile(
  db: DB,
  actorId: number,
  profile: KnowledgeProfile,
): void {
  db.transaction(() => {
    setActorSkillDefault(db, {
      actorId,
      axis: "band_placement",
      accuracy: profile.defaultBandPlacementAccuracy,
    });
    setActorSkillDefault(db, {
      actorId,
      axis: "condition",
      accuracy: profile.defaultConditionAccuracy,
    });
    setActorSkillDefault(db, {
      actorId,
      axis: "flaw",
      accuracy: profile.defaultFlawDetection,
    });
    setActorSkillDefault(db, {
      actorId,
      axis: "price",
      accuracy: profile.defaultPriceAccuracy,
    });
    setActorSkillDefault(db, {
      actorId,
      axis: "customer_fit",
      accuracy: profile.defaultCustomerFitAccuracy,
    });
    for (const [key, acc] of profile.bandPlacementAccuracy) {
      setActorSkill(db, { actorId, axis: "band_placement", key, accuracy: acc });
    }
    for (const [key, acc] of profile.conditionAccuracy) {
      setActorSkill(db, { actorId, axis: "condition", key, accuracy: acc });
    }
    for (const [flaw, acc] of profile.flawDetection) {
      setActorSkill(db, { actorId, axis: "flaw", key: flaw, accuracy: acc });
    }
    for (const [key, acc] of profile.priceAccuracy) {
      setActorSkill(db, { actorId, axis: "price", key, accuracy: acc });
    }
    for (const [key, acc] of profile.customerFitAccuracy) {
      setActorSkill(db, {
        actorId,
        axis: "customer_fit",
        key,
        accuracy: acc,
      });
    }
  });
}

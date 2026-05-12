import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { getStockLotById } from "../stock/lots-repo.js";
import {
  QUALITY_TIERS,
  type FlawType,
  type QualityTier,
} from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import { recordBelief } from "./beliefs-repo.js";
import { getConfusableNeighbours } from "./confusable-pairs-repo.js";
import { loadKnowledgeProfile } from "./skills-repo.js";
import type { ActorBelief, KnowledgeAxis, KnowledgeProfile } from "./types.js";

/**
 * Paid per-axis consultation. The asker pays the expert £fee and
 * spends time (recorded by the caller via the world clock — this
 * primitive is time-cost-naive; wiring decides when an hour is
 * consumed). The expert rolls their per-axis skill against the
 * lot's truth and returns a possibly-wrong answer that's persisted
 * to `actor_beliefs`.
 *
 * Two key design properties (todolist:63–66):
 *
 *   (a) The expert's answer can be **catastrophically wrong** with no
 *       flag — a low-skill consultant returns a confident-looking
 *       answer that happens to be incorrect. The asker can only
 *       discover the error later through contradiction or onward
 *       resale.
 *   (b) The answer's `confidence` field reflects the **expert's
 *       skill on this axis**, not the truth. A weak expert reports
 *       low confidence; a strong expert reports high confidence; in
 *       neither case does the asker know whether the answer itself
 *       is correct.
 */
export interface ConsultArgs {
  readonly askerActorId: number;
  readonly expertActorId: number;
  readonly lotId: number;
  readonly axis: KnowledgeAxis;
  readonly fee: number;
  readonly atDay: number;
  readonly rng: SeededRNG;
  /**
   * Optional override of the expert's loaded profile. The default is
   * to read from DB. Useful for tests that want to assert on a known
   * skill grid without re-seeding.
   */
  readonly expertProfileOverride?: KnowledgeProfile;
  readonly economics?: EconomicsConfig;
}

export type ConsultResult =
  | {
      readonly type: "consulted";
      readonly belief: ActorBelief;
    }
  | {
      readonly type: "blocked";
      readonly reason: string;
    };

export class ConsultationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsultationError";
  }
}

export function consultActor(db: DB, args: ConsultArgs): ConsultResult {
  if (args.fee < 0) {
    throw new ConsultationError(`fee must be >= 0; got ${args.fee}`);
  }
  if (args.askerActorId === args.expertActorId) {
    return { type: "blocked", reason: "cannot consult with yourself" };
  }

  return db.transaction((): ConsultResult => {
    const asker = getActorById(db, args.askerActorId);
    if (!asker) {
      throw new ConsultationError(`asker ${args.askerActorId} not found`);
    }
    const expert = getActorById(db, args.expertActorId);
    if (!expert) {
      throw new ConsultationError(`expert ${args.expertActorId} not found`);
    }
    if (asker.cash < args.fee) {
      return {
        type: "blocked",
        reason: `asker cash £${asker.cash} < fee £${args.fee}`,
      };
    }
    const lot = getStockLotById(db, args.lotId);
    if (!lot) {
      throw new ConsultationError(`stock_lot ${args.lotId} not found`);
    }
    const item = getItemKindById(db, lot.itemKindId);
    if (!item) {
      throw new ConsultationError(`item_kind ${lot.itemKindId} not found`);
    }

    if (args.fee > 0) {
      adjustActorCash(db, args.askerActorId, -args.fee);
      adjustActorCash(db, args.expertActorId, args.fee);
    }

    const profile = args.expertProfileOverride
      ?? loadKnowledgeProfile(db, args.expertActorId);
    const economics = args.economics ?? DEFAULT_ECONOMICS_CONFIG;

    const sample = sampleAxis({
      db,
      profile,
      axis: args.axis,
      lot,
      item,
      rng: args.rng,
      economics,
    });

    const belief = recordBelief(db, {
      actorId: args.askerActorId,
      lotId: args.lotId,
      value: sample.value,
      confidence: sample.confidence,
      sourcedFromActorId: args.expertActorId,
      acquiredDay: args.atDay,
    });

    return { type: "consulted", belief };
  });
}

interface SampleAxisArgs {
  readonly db: DB;
  readonly profile: KnowledgeProfile;
  readonly axis: KnowledgeAxis;
  readonly lot: import("../stock/types.js").StockLot;
  readonly item: import("../stock/types.js").ItemKind;
  readonly rng: SeededRNG;
  readonly economics: EconomicsConfig;
}

interface AxisSample {
  readonly value: import("./types.js").BeliefValue;
  readonly confidence: number;
}

function sampleAxis(args: SampleAxisArgs): AxisSample {
  switch (args.axis) {
    case "id":
      return sampleId(args);
    case "condition":
      return sampleCondition(args);
    case "flaw":
      return sampleFlaw(args);
    case "price":
      return samplePrice(args);
    case "customer_fit":
      return sampleCustomerFit(args);
    default:
      // v2 axes (band_placement, band_tightness, condition_detection)
      // aren't consulted via this primitive — they're skill scalars
      // resolved by the v2 extraction-band path. Reaching here means
      // a v1 call site asked about a v2 axis.
      throw new Error(`consult: axis '${args.axis}' has no v1 sampler`);
  }
}

/**
 * Identity consultation. Look up the lot kind's confusable neighbours.
 * For each neighbour the expert has an id-skill — roll it. On a pass
 * the expert returns the truth. On a fail, they confidently name the
 * confusable. The harder the pair (higher `difficulty`) the harder
 * the roll: effective_pass = skill × (1 - difficulty).
 *
 * No neighbours = no confusion possible; the expert always names the
 * correct kind with full confidence.
 */
function sampleId(args: SampleAxisArgs): AxisSample {
  const neighbours = getConfusableNeighbours(args.db, args.item.id);
  if (neighbours.length === 0) {
    return {
      value: { axis: "id", kindId: args.item.id },
      confidence: 1,
    };
  }
  // Pick the neighbour the expert would confuse the lot with — for
  // multi-neighbour kinds, pick uniformly. The expert's effective
  // pass-rate is the per-pair skill × (1 - difficulty).
  const chosen = args.rng.pick(neighbours);
  const skillForPair =
    args.profile.idAccuracy.get(chosen.pairCode) ?? args.profile.defaultIdAccuracy;
  const effective = clamp01(skillForPair) * (1 - chosen.difficulty);
  const passed = args.rng.next() < effective;
  return {
    value: {
      axis: "id",
      kindId: passed ? args.item.id : chosen.kindId,
    },
    confidence: clamp01(skillForPair),
  };
}

/**
 * Condition consultation. Roll skill: on pass return the true tier;
 * on fail return an adjacent tier (one step up or down with equal
 * probability, clamped at the endpoints). Adjacent-tier-only is the
 * cinematic shape — a skilled-but-not-perfect appraiser confuses
 * "mint" with "good", not with "broken."
 */
function sampleCondition(args: SampleAxisArgs): AxisSample {
  const skill = args.profile.conditionAccuracy.get(args.item.category)
    ?? args.profile.defaultConditionAccuracy;
  const acc = clamp01(skill);
  const passed = args.rng.next() < acc;
  if (passed) {
    return {
      value: { axis: "condition", tier: args.lot.qualityTier },
      confidence: acc,
    };
  }
  const tier = adjacentTier(args.lot.qualityTier, args.rng);
  return {
    value: { axis: "condition", tier },
    confidence: acc,
  };
}

/**
 * Flaw consultation. Mirrors the existing flawTypeDetection mechanic:
 * if the item carries a flaw, roll the expert's detection for that
 * flaw type — on pass declare the flaw, on fail declare clean. If
 * the item is clean, the expert (correctly) declares clean.
 */
function sampleFlaw(args: SampleAxisArgs): AxisSample {
  const actualFlaw = args.item.flawType;
  if (actualFlaw === null) {
    return {
      value: { axis: "flaw", flawType: null },
      // High confidence on absence is appropriate — there's nothing
      // for the expert to miss.
      confidence: 1,
    };
  }
  const skill = args.profile.flawDetection.get(actualFlaw)
    ?? args.profile.defaultFlawDetection;
  const acc = clamp01(skill);
  const spotted = args.rng.next() < acc;
  return {
    value: {
      axis: "flaw",
      flawType: spotted ? actualFlaw : null,
    },
    confidence: acc,
  };
}

/**
 * Price consultation. The expert returns a unit-price band {low, high}
 * for the lot at its assumed (identity, condition). High skill → tight
 * band centred on the truth. Low skill → wide band, possibly shifted
 * off-truth.
 *
 * Truth here = baseValue × tierMultiplier[lot.qualityTier]. The
 * expert's perceived band is computed by jittering both centre and
 * width by (1 - skill).
 *
 * NOTE: This consultation assumes the expert is appraising the lot
 * at the asker's *believed* (identity, condition). The asker passes
 * the lot's actual record here; for Del-style "ask me about mint
 * Rulex prices specifically" the asker should consult against a
 * hypothetical-lot variant (future work — for v1 the lot's actual
 * record is the queryable subject).
 */
function samplePrice(args: SampleAxisArgs): AxisSample {
  const skill = args.profile.priceAccuracy.get(args.item.category)
    ?? args.profile.defaultPriceAccuracy;
  const acc = clamp01(skill);

  const tierMult = args.economics.tierMultipliers[args.lot.qualityTier];
  const trueMid = args.item.baseValue * tierMult;

  // Half-width as a fraction of mid. Expert → ±5%, clueless → ±50%.
  const halfWidth = 0.05 + (1 - acc) * 0.45;
  // Centre jitter — clueless experts misplace the centre by up to ±50%.
  const centreJitter = (args.rng.next() - 0.5) * 2 * (1 - acc) * 0.5;
  const centre = Math.max(0, trueMid * (1 + centreJitter));
  const low = Math.max(0, Math.round(centre * (1 - halfWidth)));
  const high = Math.max(low + 1, Math.round(centre * (1 + halfWidth)));

  return {
    value: { axis: "price", low, high },
    confidence: acc,
  };
}

/**
 * Customer-fit consultation. On pass, return the item's true target
 * customer set. On fail, return an empty set ("can't tell who'd buy
 * it") — the conservative wrong answer (rather than fabricated noise)
 * matches the cinematic shape.
 */
function sampleCustomerFit(args: SampleAxisArgs): AxisSample {
  const skill = args.profile.customerFitAccuracy.get(args.item.category)
    ?? args.profile.defaultCustomerFitAccuracy;
  const acc = clamp01(skill);
  const passed = args.rng.next() < acc;
  return {
    value: {
      axis: "customer_fit",
      types: passed ? [...args.item.targetCustomers] : [],
    },
    confidence: acc,
  };
}

function adjacentTier(tier: QualityTier, rng: SeededRNG): QualityTier {
  const idx = QUALITY_TIERS.indexOf(tier);
  // mint (idx 0) can only slip to good; broken (last idx) can only
  // slip to shoddy. Otherwise pick a direction.
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

// Re-export for callers that grep this file as the public surface.
export type { FlawType };

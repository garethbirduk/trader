import type { DB } from "../core/db.js";
import { getStockLotById } from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { QUALITY_TIERS, type FlawType, type QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import { getBeliefsForLot } from "./beliefs-repo.js";
import type { ActorBelief } from "./types.js";

/**
 * The single working belief the seller (or buyer) reads when haggling
 * — "what's the max I can extract per unit?" Derived on the fly from
 * the actor's persisted beliefs about this lot, integrated across the
 * plausible (identity, condition, flaw) combinations.
 *
 * `low` and `high` flank `mid`. `confidence` is a rough scalar across
 * axes — high when the actor has consulted on every axis and the
 * results don't conflict; low when there are unknowns or contradictions.
 *
 * `unsupported` is `true` when the actor has no beliefs at all about
 * the lot — the band falls back to the engine's tier-multiplier prior
 * with maximum uncertainty.
 */
export interface ExtractionBand {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  /**
   * The same band restricted to combinations the actor has a matching
   * price belief for — "what I've actually been quoted, not the
   * speculative priors." If no price beliefs exist, equals (low, high).
   * Sellers default to anchoring on `quotedHigh` so they can credibly
   * defend their ask; bands set purely by priors are speculation the
   * actor can't quote a source for.
   */
  readonly quotedLow: number;
  readonly quotedHigh: number;
  readonly confidence: number;
  readonly unsupported: boolean;
}

/**
 * Per-axis distributions extracted from the actor's belief log. Each
 * map's values sum to 1.0 (probability mass). When no beliefs exist
 * for an axis, the distribution is the prior:
 *   id     → 1.0 on the lot's actual kind (the actor knows what they
 *            bought, in absence of contradicting consultations).
 *   cond   → uniform over QUALITY_TIERS (the genuine "I don't know")
 *   flaw   → 1.0 on null (assume clean unless told otherwise)
 */
export interface BeliefDistributions {
  readonly idByKind: ReadonlyMap<number, number>;
  readonly conditionByTier: ReadonlyMap<QualityTier, number>;
  readonly flawByType: ReadonlyMap<FlawType | "_clean", number>;
  /** Whether any belief existed at all (false → uses pure prior). */
  readonly anyBeliefs: boolean;
  /** Max confidence seen per axis — surfaced into the band confidence. */
  readonly axisConfidence: {
    readonly id: number;
    readonly condition: number;
    readonly flaw: number;
    readonly price: number;
  };
}

const CLEAN = "_clean" as const;

/**
 * Build the per-axis distributions for one actor's view of one lot.
 * Multiple beliefs on the same axis combine by confidence-weighted
 * voting: each belief contributes its `confidence` mass to its value.
 * Mass is then normalised within the axis.
 */
export function buildBeliefDistributions(
  beliefs: readonly ActorBelief[],
  fallbackKindId: number,
): BeliefDistributions {
  const idVotes = new Map<number, number>();
  const condVotes = new Map<QualityTier, number>();
  const flawVotes = new Map<FlawType | typeof CLEAN, number>();
  let anyId = false;
  let anyCond = false;
  let anyFlaw = false;
  let maxIdConf = 0;
  let maxCondConf = 0;
  let maxFlawConf = 0;
  let maxPriceConf = 0;

  for (const b of beliefs) {
    switch (b.value.axis) {
      case "id":
        idVotes.set(
          b.value.kindId,
          (idVotes.get(b.value.kindId) ?? 0) + b.confidence,
        );
        anyId = true;
        if (b.confidence > maxIdConf) maxIdConf = b.confidence;
        break;
      case "condition":
        condVotes.set(
          b.value.tier,
          (condVotes.get(b.value.tier) ?? 0) + b.confidence,
        );
        anyCond = true;
        if (b.confidence > maxCondConf) maxCondConf = b.confidence;
        break;
      case "flaw": {
        const key = b.value.flawType ?? CLEAN;
        flawVotes.set(key, (flawVotes.get(key) ?? 0) + b.confidence);
        anyFlaw = true;
        if (b.confidence > maxFlawConf) maxFlawConf = b.confidence;
        break;
      }
      case "price":
        if (b.confidence > maxPriceConf) maxPriceConf = b.confidence;
        break;
      case "customer_fit":
        // Not part of the extraction-band computation directly; the
        // existing customer-fit multiplier consumes this elsewhere.
        break;
    }
  }

  const idDist = normaliseMap(idVotes, () => {
    return new Map([[fallbackKindId, 1]]);
  });
  const condDist = normaliseMap(condVotes, () => {
    const out = new Map<QualityTier, number>();
    const w = 1 / QUALITY_TIERS.length;
    for (const t of QUALITY_TIERS) out.set(t, w);
    return out;
  });
  const flawDist = normaliseMap(flawVotes, () => {
    return new Map<FlawType | typeof CLEAN, number>([[CLEAN, 1]]);
  });

  return {
    idByKind: idDist,
    conditionByTier: condDist,
    flawByType: flawDist,
    anyBeliefs: anyId || anyCond || anyFlaw || maxPriceConf > 0,
    axisConfidence: {
      id: maxIdConf,
      condition: maxCondConf,
      flaw: maxFlawConf,
      price: maxPriceConf,
    },
  };
}

function normaliseMap<K>(
  votes: Map<K, number>,
  prior: () => Map<K, number>,
): Map<K, number> {
  if (votes.size === 0) return prior();
  let total = 0;
  for (const v of votes.values()) total += v;
  // A vote with zero confidence is still a vote — the asker has been
  // told *something*, even if the consultant was unconfident. Fall
  // back to a uniform distribution over the values the asker has
  // actually been told about, rather than reverting to the truth-
  // prior (which would silently undo a wrong-but-low-confidence
  // consultation and erase the asymmetric-knowledge effect).
  if (total <= 0) {
    const out = new Map<K, number>();
    const w = 1 / votes.size;
    for (const k of votes.keys()) out.set(k, w);
    return out;
  }
  const out = new Map<K, number>();
  for (const [k, v] of votes) out.set(k, v / total);
  return out;
}

/**
 * Compute the actor's working extraction band for one lot. Reads the
 * belief log and integrates over plausible combinations:
 *
 *   For each (kind, tier, flaw) combo with non-zero joint probability:
 *     - Find a matching price belief (priceBeliefs whose for* tags
 *       align with the combo, or untagged price beliefs).
 *     - If matched, the combo's per-unit band is the price belief's
 *       {low, high} (or the union of matched beliefs).
 *     - Otherwise the combo's per-unit band is computed from the
 *       prior: kind.baseValue × tierMult[tier] × flawDiscount[flaw].
 *   The aggregated band is the weighted union across combos that
 *   carry > minComboWeight of the joint mass.
 *
 * The resulting (low, mid, high) is per-unit. Multiply by qty for the
 * total-extraction band.
 */
export function computeExtractionBand(
  db: DB,
  actorId: number,
  lotId: number,
  economics: EconomicsConfig = DEFAULT_ECONOMICS_CONFIG,
): ExtractionBand {
  const lot = getStockLotById(db, lotId);
  if (!lot) {
    throw new Error(`computeExtractionBand: stock_lot ${lotId} not found`);
  }
  const beliefs = getBeliefsForLot(db, actorId, lotId);
  const dist = buildBeliefDistributions(beliefs, lot.itemKindId);

  // Pre-extract price beliefs for the matching pass.
  const priceBeliefs = beliefs.filter(
    (b): b is ActorBelief & { value: { axis: "price"; low: number; high: number; forKindId?: number; forTier?: QualityTier; forFlaw?: FlawType | null } } =>
      b.value.axis === "price",
  );

  type ComboBand = {
    weight: number;
    low: number;
    high: number;
    matchedQuote: boolean;
  };
  const combos: ComboBand[] = [];

  const minComboWeight = 0.02; // skip vanishingly improbable combos

  // Iterate plausible (id × condition × flaw) combinations.
  for (const [kindId, idP] of dist.idByKind) {
    if (idP <= 0) continue;
    const kind = getItemKindById(db, kindId);
    if (!kind) continue;
    for (const [tier, condP] of dist.conditionByTier) {
      if (condP <= 0) continue;
      for (const [flawKey, flawP] of dist.flawByType) {
        if (flawP <= 0) continue;
        const weight = idP * condP * flawP;
        if (weight < minComboWeight) continue;

        const flawType = flawKey === CLEAN ? null : flawKey;

        // Match price beliefs to this combo.
        const matchedPrice = matchPriceBeliefs(priceBeliefs, {
          kindId,
          tier,
          flawType,
        });

        let low: number;
        let high: number;
        const matchedQuote = matchedPrice !== null;
        if (matchedPrice !== null) {
          low = matchedPrice.low;
          high = matchedPrice.high;
        } else {
          const tierMult = economics.tierMultipliers[tier];
          const flawDiscount = flawType
            ? economics.flawDiscount[flawType]
            : 1;
          const mid = kind.baseValue * tierMult * flawDiscount;
          // Spread the prior wider when we have no belief support —
          // ±25% if we have nothing else to go on.
          low = Math.max(0, Math.round(mid * 0.75));
          high = Math.max(low + 1, Math.round(mid * 1.25));
        }
        combos.push({ weight, low, high, matchedQuote });
      }
    }
  }

  if (combos.length === 0) {
    // Fallback: pure prior at the lot's actual tier.
    const k = getItemKindById(db, lot.itemKindId);
    const baseVal = k?.baseValue ?? 1;
    const mid = baseVal * economics.tierMultipliers[lot.qualityTier];
    const low = Math.max(0, Math.round(mid * 0.5));
    const high = Math.max(1, Math.round(mid * 1.5));
    return {
      low,
      mid: Math.max(0, Math.round(mid)),
      high,
      quotedLow: low,
      quotedHigh: high,
      confidence: 0,
      unsupported: true,
    };
  }

  // Aggregate: low = min over combos (any plausible scenario is a
  // floor on the seller's optimism), high = max over combos (the
  // ceiling of what they think they might extract), mid = weighted
  // average of combo midpoints.
  let aggLow = Infinity;
  let aggHigh = -Infinity;
  let quotedLow = Infinity;
  let quotedHigh = -Infinity;
  let anyQuoted = false;
  let weightedMidSum = 0;
  let totalWeight = 0;
  for (const c of combos) {
    if (c.low < aggLow) aggLow = c.low;
    if (c.high > aggHigh) aggHigh = c.high;
    if (c.matchedQuote) {
      anyQuoted = true;
      if (c.low < quotedLow) quotedLow = c.low;
      if (c.high > quotedHigh) quotedHigh = c.high;
    }
    const midC = (c.low + c.high) / 2;
    weightedMidSum += midC * c.weight;
    totalWeight += c.weight;
  }
  const mid = totalWeight > 0 ? weightedMidSum / totalWeight : (aggLow + aggHigh) / 2;

  // Confidence: harmonic blend across axes the actor has consulted.
  // Axes with no beliefs contribute 0, which drags confidence down.
  const confidence = blendConfidence(dist.axisConfidence);

  const low = Math.max(0, Math.round(aggLow));
  const high = Math.max(1, Math.round(aggHigh));
  return {
    low,
    mid: Math.max(0, Math.round(mid)),
    high,
    quotedLow: anyQuoted ? Math.max(0, Math.round(quotedLow)) : low,
    quotedHigh: anyQuoted ? Math.max(1, Math.round(quotedHigh)) : high,
    confidence,
    unsupported: !dist.anyBeliefs,
  };
}

interface PriceBeliefShape {
  readonly value: {
    readonly low: number;
    readonly high: number;
    readonly forKindId?: number;
    readonly forTier?: QualityTier;
    readonly forFlaw?: FlawType | null;
  };
  readonly confidence: number;
}

/**
 * Match price beliefs to a (kindId, tier, flaw) combination. A price
 * belief MATCHES iff every `for*` field it sets is consistent with
 * the combo (and fields it doesn't set are wildcards).
 *
 * Returns the **union** of all matched beliefs (low = min low, high =
 * max high). If no beliefs match, returns null and the caller falls
 * back to the prior.
 */
function matchPriceBeliefs(
  beliefs: readonly PriceBeliefShape[],
  combo: { kindId: number; tier: QualityTier; flawType: FlawType | null },
): { low: number; high: number } | null {
  let low = Infinity;
  let high = -Infinity;
  let matched = false;
  for (const b of beliefs) {
    const v = b.value;
    if (v.forKindId !== undefined && v.forKindId !== combo.kindId) continue;
    if (v.forTier !== undefined && v.forTier !== combo.tier) continue;
    if (v.forFlaw !== undefined && v.forFlaw !== combo.flawType) continue;
    matched = true;
    if (v.low < low) low = v.low;
    if (v.high > high) high = v.high;
  }
  return matched ? { low, high } : null;
}

function blendConfidence(axes: {
  id: number;
  condition: number;
  flaw: number;
  price: number;
}): number {
  // Weighted geometric mean — if any axis has zero confidence (no
  // consultation, no belief) the overall confidence is heavily
  // dragged down, matching the "you don't know what you don't know"
  // intuition. To keep it well-defined we floor zero at 0.05.
  const floor = 0.05;
  const a = Math.max(floor, axes.id);
  const b = Math.max(floor, axes.condition);
  const c = Math.max(floor, axes.flaw);
  const d = Math.max(floor, axes.price);
  return Math.pow(a * b * c * d, 0.25);
}

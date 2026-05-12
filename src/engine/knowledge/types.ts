import type { FlawType, QualityTier } from "../stock/types.js";

/**
 * The five independent knowledge axes — each a distinct cognitive
 * skill that an actor can be sharp or clueless on, and along which a
 * lot can be the subject of a separate belief.
 *
 *   id           — "what is this?" (Rolex vs Rulex). Per pair of
 *                  confusable kinds. Resolves to an item-kind claim.
 *   condition    — "what tier is it in?" (mint/good/fair/...). Per
 *                  category. Resolves to a QualityTier claim.
 *   flaw         — "is anything wrong with it?" (faulty/fake/...).
 *                  Per flaw type. Resolves to a FlawType-or-null
 *                  claim ("looks clean" = null).
 *   price        — "what's the going rate, given identity + condition?"
 *                  Per category. Resolves to a £ band {low, high}.
 *   customer_fit — "who would buy this?" Per category. Resolves to
 *                  a list of customer-type tags.
 *
 * The price axis is *conditional*: an honest answer presupposes a
 * known identity and condition. A separate consultation can be asked
 * about prices for arbitrary (identity, condition) hypotheticals,
 * which is how Del's price-oracle visit to Mickey works (todolist:73).
 */
export const KNOWLEDGE_AXES = [
  "id",
  "condition",
  "flaw",
  "price",
  "customer_fit",
] as const;

export type KnowledgeAxis = (typeof KNOWLEDGE_AXES)[number];

export function isKnowledgeAxis(value: unknown): value is KnowledgeAxis {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_AXES as readonly string[]).includes(value)
  );
}

/**
 * A complete five-axis skill grid for one actor — the persistence-
 * shaped sibling of `BidderProfile`. Each axis has a default scalar
 * (used when no specific key matches) and a per-key map.
 *
 * Key shape per axis:
 *   id           → pair code "kind_a_code|kind_b_code" (kind_a_code <
 *                  kind_b_code lexicographically). One score per pair.
 *   condition    → category string.
 *   flaw         → flaw_type string.
 *   price        → category string.
 *   customer_fit → category string.
 */
export interface KnowledgeProfile {
  readonly idAccuracy: ReadonlyMap<string, number>;
  readonly defaultIdAccuracy: number;
  readonly conditionAccuracy: ReadonlyMap<string, number>;
  readonly defaultConditionAccuracy: number;
  readonly flawDetection: ReadonlyMap<FlawType, number>;
  readonly defaultFlawDetection: number;
  readonly priceAccuracy: ReadonlyMap<string, number>;
  readonly defaultPriceAccuracy: number;
  readonly customerFitAccuracy: ReadonlyMap<string, number>;
  readonly defaultCustomerFitAccuracy: number;
  /**
   * The bidder's onward customer-type pool. Used by the existing
   * customerFit multiplier; mirrors the legacy field for back-compat
   * with the auction pipeline.
   */
  readonly customerTypes?: readonly string[];
}

/**
 * A passable generalist — what an actor without persisted skills
 * looks like. The defaults match the legacy FALLBACK_BIDDER_PROFILE
 * so the new system is observably backward-compatible.
 */
export const FALLBACK_KNOWLEDGE_PROFILE: KnowledgeProfile = {
  idAccuracy: new Map(),
  defaultIdAccuracy: 0.6,
  conditionAccuracy: new Map(),
  defaultConditionAccuracy: 0.7,
  flawDetection: new Map(),
  defaultFlawDetection: 0.5,
  priceAccuracy: new Map(),
  defaultPriceAccuracy: 0.6,
  customerFitAccuracy: new Map(),
  defaultCustomerFitAccuracy: 0.7,
};

/**
 * Canonical pair code derived from two item-kind codes. Always returns
 * the lexicographically-sorted pair so a skill stored under one
 * direction matches a lookup from either side.
 */
export function pairCode(kindCodeA: string, kindCodeB: string): string {
  if (kindCodeA === kindCodeB) {
    throw new Error(`pairCode: kinds must differ; got '${kindCodeA}' twice`);
  }
  return kindCodeA < kindCodeB
    ? `${kindCodeA}|${kindCodeB}`
    : `${kindCodeB}|${kindCodeA}`;
}

/**
 * Axis-specific belief value payloads. Stored as JSON in
 * actor_beliefs.value_json and parsed through `decodeBeliefValue`.
 */
export type BeliefValue =
  | { readonly axis: "id"; readonly kindId: number }
  | { readonly axis: "condition"; readonly tier: QualityTier }
  | { readonly axis: "flaw"; readonly flawType: FlawType | null }
  | {
      readonly axis: "price";
      readonly low: number;
      readonly high: number;
      /**
       * Optional hypothetical qualifiers — "this is what a scratched
       * Rolex would go for", which can be recorded even when the
       * actor doesn't think the lot IS a scratched Rolex. The
       * aggregator only contributes the belief to the extraction
       * band when the actor's id/condition/flaw distributions assign
       * non-negligible mass to the matching combination. An
       * unqualified price belief (all `for*` absent) is treated as
       * an unconditional going-rate claim about the lot at its
       * current believed identity.
       */
      readonly forKindId?: number;
      readonly forTier?: QualityTier;
      readonly forFlaw?: FlawType | null;
    }
  | { readonly axis: "customer_fit"; readonly types: readonly string[] };

/**
 * One stored belief: who holds it, about what lot, on which axis, with
 * what value and how confidently, attributed to which source (or
 * NULL = self).
 */
export interface ActorBelief {
  readonly id: number;
  readonly actorId: number;
  readonly lotId: number;
  readonly axis: KnowledgeAxis;
  readonly value: BeliefValue;
  readonly confidence: number;
  readonly sourcedFromActorId: number | null;
  readonly acquiredDay: number;
}

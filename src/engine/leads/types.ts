import type { QualityTier } from "../stock/types.js";

export type LeadSide = "supply" | "demand";
export type LeadConfidence = "warm" | "cold";

/**
 * Two flavours of lead share the same table:
 *
 *  • `commodity` — the original meaning: "who has / wants this kind of
 *    stock?" Subject is an item kind (+ optional tier). The numeric
 *    fields are quantity and unit price.
 *  • `rep` — a warning (or vouch) about a *person*. Subject is the
 *    target actor; the counterparty field optionally names the actor
 *    on the receiving end of the act ("Boyce stitched Trigger"). The
 *    numeric fields are repurposed as severity (count of recorded
 *    offences) and damage (total £ lost). No item kind or tier.
 *
 * Same hop/confidence/decay machinery; same gossip channels.
 */
export type LeadKind = "commodity" | "rep";

export interface Lead {
  readonly id: number;
  readonly holderActorId: number;
  readonly kind: LeadKind;
  readonly side: LeadSide;
  /** Commodity leads only — the item kind in question. NULL on rep leads. */
  readonly subjectItemKindId: number | null;
  readonly subjectQualityTier: QualityTier | null;
  /** Rep leads only — who the lead is *about*. NULL on commodity leads. */
  readonly subjectTargetActorId: number | null;
  /**
   * Commodity: the upstream supplier / downstream buyer the lead names,
   * if any. Rep: the actor on the receiving end of the reported act —
   * "Boyce burned Trigger" stores Trigger here.
   */
  readonly counterpartyActorId: number | null;
  /** Commodity: estimated quantity. Rep: severity (count of offences). */
  readonly estimatedQuantity: number;
  /** Commodity: estimated unit price. Rep: total £ damage in pence. */
  readonly estimatedUnitPrice: number;
  readonly confidence: LeadConfidence;
  readonly sourceActorId: number | null;
  readonly acquiredDay: number;
  readonly hopCount: number;
  readonly derivedFromLeadId: number | null;
  /**
   * If the lead is grounded in a real `world_pool`, this is its id.
   * The point of this column is shared-source detection: when two leads
   * from different counterparties carry the same pool id, the world is
   * revealing that they describe the *same* upstream stock — over-counting
   * is mathematically inevitable. Rep leads never set this.
   */
  readonly subjectPoolId: number | null;
}

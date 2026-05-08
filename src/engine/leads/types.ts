import type { QualityTier } from "../stock/types.js";

export type LeadSide = "supply" | "demand";
export type LeadConfidence = "warm" | "cold";

export interface Lead {
  readonly id: number;
  readonly holderActorId: number;
  readonly side: LeadSide;
  readonly subjectItemKindId: number;
  readonly subjectQualityTier: QualityTier | null;
  readonly counterpartyActorId: number | null;
  readonly estimatedQuantity: number;
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
   * is mathematically inevitable.
   */
  readonly subjectPoolId: number | null;
}

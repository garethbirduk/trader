import type { QualityTier } from "../stock/types.js";

/**
 * An auction lot — sold whole or not at all. Prices are totals for the
 * entire lot, not per-unit; a bidder's mental model is "I'll pay £X for
 * the box of microwaves," not "£Y per microwave."
 */
export interface AuctionLot {
  readonly id: number;
  readonly sourcePoolId: number | null;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  /** Reserve / starting price for the whole lot. */
  readonly floorPrice: number;
  readonly listedDay: number;
  readonly clearedDay: number | null;
  /** Final hammer price for the whole lot, when cleared. */
  readonly clearedPrice: number | null;
  readonly clearedToActorId: number | null;
}

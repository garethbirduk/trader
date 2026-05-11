import type { QualityTier } from "../stock/types.js";

/**
 * An auction lot — sold whole or not at all. Prices are totals for the
 * entire lot, not per-unit; a bidder's mental model is "I'll pay £X for
 * the box of microwaves," not "£Y per microwave."
 *
 * `scheduledHour` is set when the daily-auction handler picks the lot
 * for today's running docket (max 6 per day, hours 11–16). NULL means
 * the lot has never been on the docket — either still open from a
 * previous day, or waiting for a future picking.
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
  readonly scheduledHour: number | null;
  readonly clearedDay: number | null;
  /** Final hammer price for the whole lot, when cleared. */
  readonly clearedPrice: number | null;
  readonly clearedToActorId: number | null;
  /** Narrative tag, used by regional-clearance lots ("Bexleyheath
   *  estate clearance"). Null for legacy pool-sourced lots. */
  readonly provenance: string | null;
}

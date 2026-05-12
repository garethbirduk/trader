import type { QualityTier } from "../stock/types.js";

/**
 * #9 — House clearance opportunities.
 *
 * Three rows model the full lifecycle:
 *
 *   ClearanceListing  — the newspaper drop ("Mrs Smith's house").
 *                       Has a fee and a scheduled_day.
 *   ClearanceLot      — one row per (item_kind, tier, quantity) in
 *                       the predetermined haul. Created with the
 *                       listing; not revealed to bookers until the
 *                       winner takes possession.
 *   ClearanceBooking  — an actor's phone call locking in an arrival
 *                       hour. Earliest scheduled_hour on the
 *                       scheduled_day wins.
 */
export interface ClearanceListing {
  readonly id: number;
  readonly listedDay: number;
  readonly scheduledDay: number;
  readonly fee: number;
  readonly flavour: string | null;
  readonly resolvedDay: number | null;
  readonly resolvedHour: number | null;
  readonly winningBookingId: number | null;
}

export interface ClearanceLot {
  readonly id: number;
  readonly listingId: number;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
}

export type ClearanceBookingOutcome = "won" | "arrived-empty" | "no-show";

export interface ClearanceBooking {
  readonly id: number;
  readonly listingId: number;
  readonly bookerActorId: number;
  readonly bookedDay: number;
  readonly bookedHour: number;
  readonly scheduledHour: number;
  readonly bookedAtLocationId: number | null;
  readonly outcome: ClearanceBookingOutcome | null;
}

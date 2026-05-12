import type { DB } from "../core/db.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import { insertStockLot } from "../stock/lots-repo.js";
import {
  getBookingsForListing,
  getClearanceListing,
  getListingsScheduledFor,
  getLotsForListing,
  recordResolution,
} from "./clearance-repo.js";

/**
 * Run the scheduled clearance for the given day + hour. Picks the
 * winning booking (earliest scheduled_hour, ties broken by booked_at
 * timestamp), drops the haul into the winner's lockup, charges the
 * fee, marks losing bookings 'arrived-empty'.
 *
 * Designed to be called from a per-hour world handler. The autonomy
 * decides WHEN to call this (typically at the listing's
 * scheduled_hour); this primitive does the actual delivery.
 */

export interface RunClearanceArgs {
  readonly day: number;
  readonly hour: number;
}

export interface ClearanceRunResult {
  readonly listingId: number;
  readonly winnerActorId: number | null;
  readonly lotsDelivered: readonly { stockLotId: number; itemKindId: number; quantity: number }[];
  readonly feeCharged: number;
}

/**
 * Try to resolve every listing scheduled for `day` whose earliest
 * booking's scheduled_hour <= `hour`. (You'd call this once per hour
 * from the world; listings resolve when "their time has come.")
 *
 * Returns the runs that happened.
 */
export function runDueClearances(
  db: DB,
  args: RunClearanceArgs,
): ClearanceRunResult[] {
  return db.transaction(() => {
    const due = getListingsScheduledFor(db, args.day);
    const results: ClearanceRunResult[] = [];
    for (const listing of due) {
      const bookings = getBookingsForListing(db, listing.id);
      // No bookings → leave the listing open for the rest of today;
      // the off-ramp is when no one ever books (resolves the next
      // day in the spawner's housekeeping pass).
      if (bookings.length === 0) continue;
      // Earliest scheduled_hour wins. If that hour hasn't arrived
      // yet, wait — the listing isn't ripe.
      const earliest = bookings[0]!;
      if (earliest.scheduledHour > args.hour) continue;

      const lots = getLotsForListing(db, listing.id);
      const winnerActor = getActorById(db, earliest.bookerActorId);
      if (!winnerActor) {
        // Winner vanished (shouldn't happen). Mark resolved with no
        // winner; everyone shows up to nothing.
        recordResolution(db, {
          listingId: listing.id,
          resolvedDay: args.day,
          resolvedHour: args.hour,
          winningBookingId: null,
          loserBookingIds: bookings.map((b) => b.id),
        });
        results.push({
          listingId: listing.id,
          winnerActorId: null,
          lotsDelivered: [],
          feeCharged: 0,
        });
        continue;
      }
      // Charge the fee. If they can't afford it, the deal falls
      // through — they arrived but couldn't pay.
      if (winnerActor.cash < listing.fee) {
        recordResolution(db, {
          listingId: listing.id,
          resolvedDay: args.day,
          resolvedHour: args.hour,
          winningBookingId: null,
          loserBookingIds: bookings.map((b) => b.id),
        });
        results.push({
          listingId: listing.id,
          winnerActorId: winnerActor.id,
          lotsDelivered: [],
          feeCharged: 0,
        });
        continue;
      }
      if (listing.fee > 0) {
        adjustActorCash(db, winnerActor.id, -listing.fee);
      }

      const lockupId = winnerActor.lockupLocationId ?? winnerActor.currentLocationId;
      const delivered: ClearanceRunResult["lotsDelivered"][number][] = [];
      for (const lot of lots) {
        const stockLot = insertStockLot(db, {
          ownerActorId: winnerActor.id,
          itemKindId: lot.itemKindId,
          qualityTier: lot.qualityTier,
          // Allocate the fee evenly across the units as their cost
          // basis. For tax/accounting purposes the lot's
          // acquired_unit_price is the share-of-fee per unit.
          quantity: lot.quantity,
          acquiredUnitPrice: Math.max(
            0,
            Math.floor(
              listing.fee /
                Math.max(
                  1,
                  lots.reduce((sum, l) => sum + l.quantity, 0),
                ),
            ),
          ),
          acquiredDay: args.day,
          locationId: lockupId,
        });
        delivered.push({
          stockLotId: stockLot.id,
          itemKindId: lot.itemKindId,
          quantity: lot.quantity,
        });
      }
      const loserIds = bookings.filter((b) => b.id !== earliest.id).map((b) => b.id);
      recordResolution(db, {
        listingId: listing.id,
        resolvedDay: args.day,
        resolvedHour: args.hour,
        winningBookingId: earliest.id,
        loserBookingIds: loserIds,
      });
      results.push({
        listingId: listing.id,
        winnerActorId: winnerActor.id,
        lotsDelivered: delivered,
        feeCharged: listing.fee,
      });
    }
    return results;
  });
}

export { getClearanceListing };

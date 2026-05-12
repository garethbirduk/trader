import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import type {
  ClearanceBooking,
  ClearanceBookingOutcome,
  ClearanceListing,
  ClearanceLot,
} from "./types.js";

interface ListingRow {
  id: number;
  listed_day: number;
  scheduled_day: number;
  fee: number;
  flavour: string | null;
  resolved_day: number | null;
  resolved_hour: number | null;
  winning_booking_id: number | null;
}

interface LotRow {
  id: number;
  listing_id: number;
  item_kind_id: number;
  quality_tier: string;
  quantity: number;
}

interface BookingRow {
  id: number;
  listing_id: number;
  booker_actor_id: number;
  booked_day: number;
  booked_hour: number;
  scheduled_hour: number;
  booked_at_location_id: number | null;
  outcome: string | null;
}

function rowToListing(r: ListingRow): ClearanceListing {
  return {
    id: r.id,
    listedDay: r.listed_day,
    scheduledDay: r.scheduled_day,
    fee: r.fee,
    flavour: r.flavour,
    resolvedDay: r.resolved_day,
    resolvedHour: r.resolved_hour,
    winningBookingId: r.winning_booking_id,
  };
}

function rowToLot(r: LotRow): ClearanceLot {
  if (!isQualityTier(r.quality_tier)) {
    throw new Error(`invalid quality_tier on clearance lot: ${r.quality_tier}`);
  }
  return {
    id: r.id,
    listingId: r.listing_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
  };
}

function rowToBooking(r: BookingRow): ClearanceBooking {
  const outcome =
    r.outcome === "won" || r.outcome === "arrived-empty" || r.outcome === "no-show"
      ? (r.outcome as ClearanceBookingOutcome)
      : null;
  return {
    id: r.id,
    listingId: r.listing_id,
    bookerActorId: r.booker_actor_id,
    bookedDay: r.booked_day,
    bookedHour: r.booked_hour,
    scheduledHour: r.scheduled_hour,
    bookedAtLocationId: r.booked_at_location_id,
    outcome,
  };
}

/* ── Listings ───────────────────────────────────────────────────── */

export interface InsertListingArgs {
  readonly listedDay: number;
  readonly scheduledDay: number;
  readonly fee: number;
  readonly flavour?: string | null;
  readonly lots: readonly {
    readonly itemKindId: number;
    readonly qualityTier: QualityTier;
    readonly quantity: number;
  }[];
}

export function insertClearanceListing(
  db: DB,
  args: InsertListingArgs,
): { listing: ClearanceListing; lots: readonly ClearanceLot[] } {
  if (args.scheduledDay < args.listedDay) {
    throw new Error(
      `scheduled_day (${args.scheduledDay}) must be on/after listed_day (${args.listedDay})`,
    );
  }
  if (args.lots.length === 0) {
    throw new Error("clearance listing must include at least one lot");
  }
  return db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO clearance_listings
           (listed_day, scheduled_day, fee, flavour)
         VALUES (@listed, @scheduled, @fee, @flavour)`,
      )
      .run({
        listed: args.listedDay,
        scheduled: args.scheduledDay,
        fee: args.fee,
        flavour: args.flavour ?? null,
      });
    const listingId = result.lastInsertRowid;
    const insertLot = db.prepare(
      `INSERT INTO clearance_listing_lots
         (listing_id, item_kind_id, quality_tier, quantity)
       VALUES (@listing, @kind, @tier, @qty)`,
    );
    for (const lot of args.lots) {
      if (lot.quantity <= 0) {
        throw new Error(`clearance lot quantity must be > 0; got ${lot.quantity}`);
      }
      insertLot.run({
        listing: listingId,
        kind: lot.itemKindId,
        tier: lot.qualityTier,
        qty: lot.quantity,
      });
    }
    const listing = getClearanceListing(db, listingId);
    if (!listing) throw new Error("listing should exist after insert");
    return { listing, lots: getLotsForListing(db, listingId) };
  });
}

export function getClearanceListing(
  db: DB,
  id: number,
): ClearanceListing | null {
  const row = db
    .prepare<ListingRow>(`SELECT * FROM clearance_listings WHERE id = @id`)
    .get({ id });
  return row ? rowToListing(row) : null;
}

export function getLotsForListing(
  db: DB,
  listingId: number,
): ClearanceLot[] {
  return db
    .prepare<LotRow>(
      `SELECT * FROM clearance_listing_lots
         WHERE listing_id = @id ORDER BY id ASC`,
    )
    .all({ id: listingId })
    .map(rowToLot);
}

/** Listings that haven't been resolved yet — bookable. */
export function getOpenListings(db: DB): ClearanceListing[] {
  return db
    .prepare<ListingRow>(
      `SELECT * FROM clearance_listings
         WHERE resolved_day IS NULL
         ORDER BY scheduled_day ASC, id ASC`,
    )
    .all()
    .map(rowToListing);
}

/** Listings scheduled to resolve today. */
export function getListingsScheduledFor(
  db: DB,
  day: number,
): ClearanceListing[] {
  return db
    .prepare<ListingRow>(
      `SELECT * FROM clearance_listings
         WHERE scheduled_day = @day AND resolved_day IS NULL
         ORDER BY id ASC`,
    )
    .all({ day })
    .map(rowToListing);
}

/** Mark a listing expired (no booker, day is over). */
export function expireListing(
  db: DB,
  listingId: number,
  day: number,
  hour: number,
): void {
  db.prepare(
    `UPDATE clearance_listings
       SET resolved_day = @day, resolved_hour = @hour, winning_booking_id = NULL
       WHERE id = @id AND resolved_day IS NULL`,
  ).run({ day, hour, id: listingId });
}

/* ── Bookings ───────────────────────────────────────────────────── */

export interface BookClearanceArgs {
  readonly listingId: number;
  readonly bookerActorId: number;
  readonly bookedDay: number;
  readonly bookedHour: number;
  readonly scheduledHour: number;
  readonly bookedAtLocationId?: number | null;
}

export type BookClearanceResult =
  | { readonly type: "booked"; readonly booking: ClearanceBooking }
  | { readonly type: "blocked"; readonly reason: string };

/**
 * Place a booking on a listing. First-come-first-served on the
 * scheduled_hour at runtime — earlier slot wins. The booking call
 * itself doesn't gate by other bookers' choices; that's the point
 * (callers can race). What it does enforce:
 *
 *   • The listing exists and isn't already resolved.
 *   • The booker hasn't already booked this listing.
 *   • `scheduledHour` is in [0, 23] (CHECK constraint on the table).
 *   • The booker's call is recorded with `bookedAtLocationId` so
 *     downstream witness-lead seeding (#6) can find present actors.
 */
export function bookClearance(
  db: DB,
  args: BookClearanceArgs,
): BookClearanceResult {
  return db.transaction((): BookClearanceResult => {
    const listing = getClearanceListing(db, args.listingId);
    if (!listing) {
      return {
        type: "blocked",
        reason: `clearance listing ${args.listingId} not found`,
      };
    }
    if (listing.resolvedDay !== null) {
      return {
        type: "blocked",
        reason: `listing ${args.listingId} already resolved on day ${listing.resolvedDay}`,
      };
    }
    // Booker can't double-book the same listing.
    const existing = db
      .prepare<BookingRow>(
        `SELECT * FROM clearance_bookings
           WHERE listing_id = @listing AND booker_actor_id = @actor`,
      )
      .get({ listing: args.listingId, actor: args.bookerActorId });
    if (existing) {
      return {
        type: "blocked",
        reason: `actor ${args.bookerActorId} already has booking ${existing.id}`,
      };
    }
    const result = db
      .prepare(
        `INSERT INTO clearance_bookings
           (listing_id, booker_actor_id, booked_day, booked_hour,
            scheduled_hour, booked_at_location_id)
         VALUES (@listing, @actor, @bday, @bhour, @shour, @loc)`,
      )
      .run({
        listing: args.listingId,
        actor: args.bookerActorId,
        bday: args.bookedDay,
        bhour: args.bookedHour,
        shour: args.scheduledHour,
        loc: args.bookedAtLocationId ?? null,
      });
    const fetched = db
      .prepare<BookingRow>(
        `SELECT * FROM clearance_bookings WHERE id = @id`,
      )
      .get({ id: result.lastInsertRowid });
    if (!fetched) throw new Error("booking should exist after insert");
    return { type: "booked", booking: rowToBooking(fetched) };
  });
}

export function getBookingsForListing(
  db: DB,
  listingId: number,
): ClearanceBooking[] {
  return db
    .prepare<BookingRow>(
      `SELECT * FROM clearance_bookings WHERE listing_id = @id
         ORDER BY scheduled_hour ASC, booked_day ASC, booked_hour ASC, id ASC`,
    )
    .all({ id: listingId })
    .map(rowToBooking);
}

/** Mark a listing resolved and set its winning booking + outcomes. */
export function recordResolution(
  db: DB,
  args: {
    listingId: number;
    resolvedDay: number;
    resolvedHour: number;
    winningBookingId: number | null;
    loserBookingIds: readonly number[];
  },
): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE clearance_listings
         SET resolved_day = @day,
             resolved_hour = @hour,
             winning_booking_id = @winner
         WHERE id = @id`,
    ).run({
      day: args.resolvedDay,
      hour: args.resolvedHour,
      winner: args.winningBookingId,
      id: args.listingId,
    });
    if (args.winningBookingId !== null) {
      db.prepare(
        `UPDATE clearance_bookings SET outcome = 'won' WHERE id = @id`,
      ).run({ id: args.winningBookingId });
    }
    if (args.loserBookingIds.length > 0) {
      const stmt = db.prepare(
        `UPDATE clearance_bookings SET outcome = 'arrived-empty' WHERE id = @id`,
      );
      for (const id of args.loserBookingIds) stmt.run({ id });
    }
  });
}

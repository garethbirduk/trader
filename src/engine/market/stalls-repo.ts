import type { DB } from "../core/db.js";

/**
 * Daily market-stall registration (todolist #3).
 *
 * One row per (seller, market, day). The seller's mode is set at the
 * moment they first appear at the market with stock — legit (paid
 * the fee, no risk) or adhoc (free, Slater may turn up).
 *
 * patrol_arrived_hour stamps when Slater showed; resolved_hour stamps
 * when the situation ended (bribed / cleared / busted). Cash flows
 * (fee, fine, bribe) are recorded so the UI can show "Boycie's day
 * at the market: rented £20, sold £180, no patrol — net £160."
 */

export type StallMode = "legit" | "adhoc" | "cleared" | "bribed" | "busted";

export interface MarketStall {
  readonly id: number;
  readonly sellerActorId: number;
  readonly locationId: number;
  readonly day: number;
  readonly mode: StallMode;
  readonly feePaid: number;
  readonly patrolArrivedHour: number | null;
  readonly resolvedHour: number | null;
  readonly finePaid: number;
  readonly bribePaid: number;
  readonly unitsLost: number;
}

interface Row {
  id: number;
  seller_actor_id: number;
  location_id: number;
  day: number;
  mode: string;
  fee_paid: number;
  patrol_arrived_hour: number | null;
  resolved_hour: number | null;
  fine_paid: number;
  bribe_paid: number;
  units_lost: number;
}

function rowTo(r: Row): MarketStall {
  if (
    r.mode !== "legit" &&
    r.mode !== "adhoc" &&
    r.mode !== "cleared" &&
    r.mode !== "bribed" &&
    r.mode !== "busted"
  ) {
    throw new Error(`invalid stall mode: ${r.mode}`);
  }
  return {
    id: r.id,
    sellerActorId: r.seller_actor_id,
    locationId: r.location_id,
    day: r.day,
    mode: r.mode,
    feePaid: r.fee_paid,
    patrolArrivedHour: r.patrol_arrived_hour,
    resolvedHour: r.resolved_hour,
    finePaid: r.fine_paid,
    bribePaid: r.bribe_paid,
    unitsLost: r.units_lost,
  };
}

export function insertStall(
  db: DB,
  args: {
    sellerActorId: number;
    locationId: number;
    day: number;
    mode: "legit" | "adhoc";
    feePaid: number;
  },
): MarketStall {
  const result = db
    .prepare(
      `INSERT INTO market_stalls
         (seller_actor_id, location_id, day, mode, fee_paid)
       VALUES (@seller, @loc, @day, @mode, @fee)`,
    )
    .run({
      seller: args.sellerActorId,
      loc: args.locationId,
      day: args.day,
      mode: args.mode,
      fee: args.feePaid,
    });
  const row = db
    .prepare<Row>(`SELECT * FROM market_stalls WHERE id = @id`)
    .get({ id: result.lastInsertRowid });
  if (!row) throw new Error("market_stall insert failed to round-trip");
  return rowTo(row);
}

export function getStallForToday(
  db: DB,
  sellerActorId: number,
  locationId: number,
  day: number,
): MarketStall | null {
  const row = db
    .prepare<Row>(
      `SELECT * FROM market_stalls
         WHERE seller_actor_id = @seller AND location_id = @loc AND day = @day`,
    )
    .get({ seller: sellerActorId, loc: locationId, day });
  return row ? rowTo(row) : null;
}

export function getAdhocStallsAt(
  db: DB,
  locationId: number,
  day: number,
): MarketStall[] {
  return db
    .prepare<Row>(
      `SELECT * FROM market_stalls
         WHERE location_id = @loc AND day = @day
           AND mode = 'adhoc' AND resolved_hour IS NULL`,
    )
    .all({ loc: locationId, day })
    .map(rowTo);
}

export function stampPatrolArrived(
  db: DB,
  stallId: number,
  hour: number,
): void {
  db.prepare(
    `UPDATE market_stalls SET patrol_arrived_hour = @hour
       WHERE id = @id AND patrol_arrived_hour IS NULL`,
  ).run({ id: stallId, hour });
}

/**
 * Resolve a stall's patrol situation. Sets mode + resolved_hour and
 * records the cash/stock fallout.
 */
export function resolveStall(
  db: DB,
  args: {
    stallId: number;
    mode: "cleared" | "bribed" | "busted";
    hour: number;
    finePaid?: number;
    bribePaid?: number;
    unitsLost?: number;
  },
): void {
  db.prepare(
    `UPDATE market_stalls
       SET mode = @mode,
           resolved_hour = @hour,
           fine_paid = @fine,
           bribe_paid = @bribe,
           units_lost = @units
       WHERE id = @id`,
  ).run({
    id: args.stallId,
    mode: args.mode,
    hour: args.hour,
    fine: args.finePaid ?? 0,
    bribe: args.bribePaid ?? 0,
    units: args.unitsLost ?? 0,
  });
}

/** Unresolved adhoc stalls where Slater arrived BEFORE the given hour. */
export function getUnresolvedBusted(
  db: DB,
  locationId: number,
  day: number,
  beforeHour: number,
): MarketStall[] {
  return db
    .prepare<Row>(
      `SELECT * FROM market_stalls
         WHERE location_id = @loc AND day = @day
           AND mode = 'adhoc'
           AND resolved_hour IS NULL
           AND patrol_arrived_hour IS NOT NULL
           AND patrol_arrived_hour < @hour`,
    )
    .all({ loc: locationId, day, hour: beforeHour })
    .map(rowTo);
}

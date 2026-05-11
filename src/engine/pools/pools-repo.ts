import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import { insertStockLot } from "../stock/lots-repo.js";
import type { DumpDestination, WorldPool } from "./types.js";
import { poolUnitPriceOnDay } from "./types.js";

export interface InsertPoolInput {
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly createdDay: number;
  readonly expiryDay: number;
  readonly openingUnitPrice: number;
  readonly closingUnitPrice: number;
  readonly dumpDestination?: DumpDestination;
  readonly reachableBy?: readonly number[];
  readonly ownerActorId?: number | null;
  readonly provenance?: string | null;
}

interface PoolRow {
  id: number;
  item_kind_id: number;
  quality_tier: string;
  quantity_remaining: number;
  created_day: number;
  expiry_day: number;
  opening_unit_price: number;
  closing_unit_price: number;
  dump_destination: string;
  flushed_day: number | null;
  owner_actor_id: number | null;
  provenance: string | null;
}

function rowToPool(r: PoolRow): WorldPool {
  if (!isQualityTier(r.quality_tier)) {
    throw new Error(`invalid quality_tier on pool: ${r.quality_tier}`);
  }
  if (
    r.dump_destination !== "auction" &&
    r.dump_destination !== "market" &&
    r.dump_destination !== "write_off"
  ) {
    throw new Error(`invalid dump_destination: ${r.dump_destination}`);
  }
  return {
    id: r.id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantityRemaining: r.quantity_remaining,
    createdDay: r.created_day,
    expiryDay: r.expiry_day,
    openingUnitPrice: r.opening_unit_price,
    closingUnitPrice: r.closing_unit_price,
    dumpDestination: r.dump_destination,
    flushedDay: r.flushed_day,
    ownerActorId: r.owner_actor_id,
    provenance: r.provenance,
  };
}

export function insertPool(db: DB, input: InsertPoolInput): WorldPool {
  return db.transaction((): WorldPool => {
    const result = db
      .prepare(
        `INSERT INTO world_pools
          (item_kind_id, quality_tier, quantity_remaining, created_day,
           expiry_day, opening_unit_price, closing_unit_price, dump_destination,
           owner_actor_id, provenance)
         VALUES
          (@kind, @tier, @qty, @created, @expiry, @open, @close, @dest,
           @owner, @provenance)`,
      )
      .run({
        kind: input.itemKindId,
        tier: input.qualityTier,
        qty: input.quantity,
        created: input.createdDay,
        expiry: input.expiryDay,
        open: input.openingUnitPrice,
        close: input.closingUnitPrice,
        dest: input.dumpDestination ?? "auction",
        owner: input.ownerActorId ?? null,
        provenance: input.provenance ?? null,
      });
    const poolId = result.lastInsertRowid;
    if (input.reachableBy) {
      const stmt = db.prepare(
        `INSERT INTO pool_reachability (pool_id, actor_id) VALUES (@pool, @actor)`,
      );
      for (const actorId of input.reachableBy) {
        stmt.run({ pool: poolId, actor: actorId });
      }
    }
    const fetched = getPoolById(db, poolId);
    if (!fetched) throw new Error("failed to fetch newly inserted pool");
    return fetched;
  });
}

export function getPoolById(db: DB, id: number): WorldPool | null {
  const row = db
    .prepare<PoolRow>(`SELECT * FROM world_pools WHERE id = @id`)
    .get({ id });
  return row ? rowToPool(row) : null;
}

export function listActivePools(db: DB, today: number): WorldPool[] {
  return db
    .prepare<PoolRow>(
      `SELECT * FROM world_pools
       WHERE flushed_day IS NULL
         AND created_day <= @today
         AND expiry_day  >= @today
       ORDER BY id ASC`,
    )
    .all({ today })
    .map(rowToPool);
}

export function listPoolsExpiredBefore(db: DB, today: number): WorldPool[] {
  return db
    .prepare<PoolRow>(
      `SELECT * FROM world_pools
       WHERE flushed_day IS NULL AND expiry_day < @today
       ORDER BY id ASC`,
    )
    .all({ today })
    .map(rowToPool);
}

export function listReachableActiveByActor(
  db: DB,
  actorId: number,
  today: number,
): WorldPool[] {
  return db
    .prepare<PoolRow>(
      `SELECT p.* FROM world_pools p
       INNER JOIN pool_reachability r ON r.pool_id = p.id
       WHERE r.actor_id = @actor
         AND p.flushed_day IS NULL
         AND p.created_day <= @today
         AND p.expiry_day  >= @today
       ORDER BY p.id ASC`,
    )
    .all({ actor: actorId, today })
    .map(rowToPool);
}

export function isReachableBy(
  db: DB,
  poolId: number,
  actorId: number,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pool_reachability
       WHERE pool_id = @pool AND actor_id = @actor`,
    )
    .get({ pool: poolId, actor: actorId });
  return (row?.n ?? 0) > 0;
}

export class PoolUnreachableError extends Error {}
export class PoolExpiredError extends Error {}
export class PoolEmptyError extends Error {}
export class PoolNotYetAvailableError extends Error {}

export interface ClaimFromPoolResult {
  readonly stockLotId: number;
  readonly unitPriceCharged: number;
  readonly remainingInPool: number;
}

/**
 * Claim `quantity` units from a pool on behalf of `actorId`. Validates
 * reachability, that the pool isn't expired or flushed, and that there's
 * enough remaining stock. On success, decrements the pool, creates a new
 * stock_lot owned by the claimant, and returns the line item.
 *
 * The unit price charged is the pool's interpolated price for `atDay`.
 * Cash is NOT moved here — claims may be paid in advance, on delivery, or
 * not at all (in some skins). The caller wires the cash flow appropriate
 * to the surface mechanic that triggered the claim.
 */
export function claimFromPool(
  db: DB,
  args: {
    poolId: number;
    actorId: number;
    quantity: number;
    atDay: number;
  },
): ClaimFromPoolResult {
  if (args.quantity <= 0) {
    throw new Error(`claim quantity must be > 0; got ${args.quantity}`);
  }
  return db.transaction((): ClaimFromPoolResult => {
    const pool = getPoolById(db, args.poolId);
    if (!pool) throw new Error(`pool ${args.poolId} not found`);
    if (pool.flushedDay !== null) {
      throw new PoolExpiredError(`pool ${args.poolId} already flushed on day ${pool.flushedDay}`);
    }
    if (args.atDay < pool.createdDay) {
      throw new PoolNotYetAvailableError(
        `pool ${args.poolId} not available until day ${pool.createdDay}`,
      );
    }
    if (args.atDay > pool.expiryDay) {
      throw new PoolExpiredError(`pool ${args.poolId} expired on day ${pool.expiryDay}`);
    }
    if (!isReachableBy(db, args.poolId, args.actorId)) {
      throw new PoolUnreachableError(
        `actor ${args.actorId} cannot reach pool ${args.poolId}`,
      );
    }
    if (pool.quantityRemaining < args.quantity) {
      throw new PoolEmptyError(
        `pool ${args.poolId} has ${pool.quantityRemaining}, need ${args.quantity}`,
      );
    }

    const unitPrice = poolUnitPriceOnDay(pool, args.atDay);

    db.prepare(
      `UPDATE world_pools SET quantity_remaining = quantity_remaining - @q
       WHERE id = @id`,
    ).run({ id: args.poolId, q: args.quantity });

    // Stock is claimed *to* the actor's current location. If they're
    // at the lock-up they take it home; if they're out and about it
    // arrives wherever they're standing. Settlement-walks that source
    // through leads bypass this — they create stock directly at the
    // delivery location.
    const claimer = db
      .prepare<{ current_location_id: number | null }>(
        `SELECT current_location_id FROM actors WHERE id = @id`,
      )
      .get({ id: args.actorId });
    const lot = insertStockLot(db, {
      ownerActorId: args.actorId,
      itemKindId: pool.itemKindId,
      qualityTier: pool.qualityTier,
      quantity: args.quantity,
      acquiredUnitPrice: unitPrice,
      acquiredDay: args.atDay,
      locationId: claimer?.current_location_id ?? null,
    });

    const after = getPoolById(db, args.poolId);
    return {
      stockLotId: lot.id,
      unitPriceCharged: unitPrice,
      remainingInPool: after?.quantityRemaining ?? 0,
    };
  });
}

export function markPoolFlushed(db: DB, poolId: number, atDay: number): void {
  const r = db
    .prepare(
      `UPDATE world_pools SET flushed_day = @day
       WHERE id = @id AND flushed_day IS NULL`,
    )
    .run({ id: poolId, day: atDay });
  if (r.changes === 0) {
    throw new Error(`pool ${poolId} not found or already flushed`);
  }
}

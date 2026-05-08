import type { DB } from "../core/db.js";
import type { QualityTier, StockLot } from "./types.js";
import { isQualityTier } from "./types.js";

export interface InsertStockLotInput {
  readonly ownerActorId: number;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly acquiredUnitPrice: number;
  readonly acquiredDay: number;
  /** Physical location of the stock. Null = unknown / unset. */
  readonly locationId?: number | null;
}

interface StockLotRow {
  id: number;
  owner_actor_id: number;
  item_kind_id: number;
  quality_tier: string;
  quantity: number;
  acquired_unit_price: number;
  acquired_day: number;
  location_id: number | null;
}

function rowToLot(r: StockLotRow): StockLot {
  if (!isQualityTier(r.quality_tier)) {
    throw new Error(`invalid quality_tier in DB: ${r.quality_tier}`);
  }
  return {
    id: r.id,
    ownerActorId: r.owner_actor_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
    acquiredUnitPrice: r.acquired_unit_price,
    acquiredDay: r.acquired_day,
    locationId: r.location_id,
  };
}

export function insertStockLot(db: DB, input: InsertStockLotInput): StockLot {
  if (input.quantity <= 0) {
    throw new Error(`stock lot quantity must be > 0; got ${input.quantity}`);
  }
  if (input.acquiredUnitPrice < 0) {
    throw new Error(`acquired_unit_price must be >= 0; got ${input.acquiredUnitPrice}`);
  }

  const result = db
    .prepare(
      `INSERT INTO stock_lots
        (owner_actor_id, item_kind_id, quality_tier, quantity,
         acquired_unit_price, acquired_day, location_id)
       VALUES
        (@owner_actor_id, @item_kind_id, @quality_tier, @quantity,
         @acquired_unit_price, @acquired_day, @location_id)`,
    )
    .run({
      owner_actor_id: input.ownerActorId,
      item_kind_id: input.itemKindId,
      quality_tier: input.qualityTier,
      quantity: input.quantity,
      acquired_unit_price: input.acquiredUnitPrice,
      acquired_day: input.acquiredDay,
      location_id: input.locationId ?? null,
    });
  return {
    id: result.lastInsertRowid,
    ownerActorId: input.ownerActorId,
    itemKindId: input.itemKindId,
    qualityTier: input.qualityTier,
    quantity: input.quantity,
    acquiredUnitPrice: input.acquiredUnitPrice,
    acquiredDay: input.acquiredDay,
    locationId: input.locationId ?? null,
  };
}

export function getStockLotById(db: DB, id: number): StockLot | null {
  const row = db
    .prepare<StockLotRow>(`SELECT * FROM stock_lots WHERE id = @id`)
    .get({ id });
  return row ? rowToLot(row) : null;
}

export function getStockLotsByOwner(db: DB, ownerActorId: number): StockLot[] {
  return db
    .prepare<StockLotRow>(
      `SELECT * FROM stock_lots WHERE owner_actor_id = @owner_actor_id
       ORDER BY id ASC`,
    )
    .all({ owner_actor_id: ownerActorId })
    .map(rowToLot);
}

export function getStockLotsByOwnerAndKind(
  db: DB,
  ownerActorId: number,
  itemKindId: number,
): StockLot[] {
  return db
    .prepare<StockLotRow>(
      `SELECT * FROM stock_lots
       WHERE owner_actor_id = @owner_actor_id AND item_kind_id = @item_kind_id
       ORDER BY id ASC`,
    )
    .all({ owner_actor_id: ownerActorId, item_kind_id: itemKindId })
    .map(rowToLot);
}

/**
 * Decrement a lot's quantity by `by`. Throws if `by` is non-positive or
 * exceeds current quantity. Returns the updated lot, or null if the
 * decrement would have taken quantity to zero (in which case the row is
 * deleted by this call).
 */
export function decrementLotQuantity(
  db: DB,
  lotId: number,
  by: number,
): StockLot | null {
  if (by <= 0) throw new Error(`decrement amount must be > 0; got ${by}`);
  const current = getStockLotById(db, lotId);
  if (!current) throw new Error(`stock lot ${lotId} not found`);
  if (by > current.quantity) {
    throw new Error(
      `decrement ${by} exceeds lot ${lotId} quantity ${current.quantity}`,
    );
  }
  if (by === current.quantity) {
    db.prepare(`DELETE FROM stock_lots WHERE id = @id`).run({ id: lotId });
    return null;
  }
  const updated = db
    .prepare<StockLotRow>(
      `UPDATE stock_lots SET quantity = quantity - @by
       WHERE id = @id
       RETURNING *`,
    )
    .get({ id: lotId, by });
  if (!updated) throw new Error(`stock lot ${lotId} disappeared mid-update`);
  return rowToLot(updated);
}

export function deleteStockLot(db: DB, lotId: number): void {
  db.prepare(`DELETE FROM stock_lots WHERE id = @id`).run({ id: lotId });
}

/** Total quantity of a kind held by an actor across all quality tiers. */
export function totalQuantityForOwnerAndKind(
  db: DB,
  ownerActorId: number,
  itemKindId: number,
): number {
  const row = db
    .prepare<{ total: number | null }>(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM stock_lots
       WHERE owner_actor_id = @owner_actor_id AND item_kind_id = @item_kind_id`,
    )
    .get({ owner_actor_id: ownerActorId, item_kind_id: itemKindId });
  return row?.total ?? 0;
}

export function getStockLotsByOwnerKindAndTier(
  db: DB,
  ownerActorId: number,
  itemKindId: number,
  qualityTier: QualityTier,
): StockLot[] {
  return db
    .prepare<StockLotRow>(
      `SELECT * FROM stock_lots
       WHERE owner_actor_id = @owner_actor_id
         AND item_kind_id = @item_kind_id
         AND quality_tier = @quality_tier
       ORDER BY id ASC`,
    )
    .all({
      owner_actor_id: ownerActorId,
      item_kind_id: itemKindId,
      quality_tier: qualityTier,
    })
    .map(rowToLot);
}

/**
 * Same as `getStockLotsByOwnerKindAndTier` but only returns lots that
 * physically sit at the named location. Settlement uses this to find
 * stock the seller has *already* delivered (no fee).
 */
export function getStockLotsByOwnerKindTierAndLocation(
  db: DB,
  ownerActorId: number,
  itemKindId: number,
  qualityTier: QualityTier,
  locationId: number,
): StockLot[] {
  return db
    .prepare<StockLotRow>(
      `SELECT * FROM stock_lots
       WHERE owner_actor_id = @owner
         AND item_kind_id = @kind
         AND quality_tier = @tier
         AND location_id = @loc
       ORDER BY id ASC`,
    )
    .all({
      owner: ownerActorId,
      kind: itemKindId,
      tier: qualityTier,
      loc: locationId,
    })
    .map(rowToLot);
}

export function totalQuantityForOwnerKindAndTier(
  db: DB,
  ownerActorId: number,
  itemKindId: number,
  qualityTier: QualityTier,
): number {
  const row = db
    .prepare<{ total: number | null }>(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM stock_lots
       WHERE owner_actor_id = @owner_actor_id
         AND item_kind_id = @item_kind_id
         AND quality_tier = @quality_tier`,
    )
    .get({
      owner_actor_id: ownerActorId,
      item_kind_id: itemKindId,
      quality_tier: qualityTier,
    });
  return row?.total ?? 0;
}

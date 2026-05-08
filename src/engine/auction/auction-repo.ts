import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import type { AuctionLot } from "./types.js";

export interface InsertAuctionLotInput {
  readonly sourcePoolId?: number | null;
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  /** Reserve price for the whole lot. */
  readonly floorPrice: number;
  readonly listedDay: number;
}

interface AuctionLotRow {
  id: number;
  source_pool_id: number | null;
  item_kind_id: number;
  quality_tier: string;
  quantity: number;
  floor_price: number;
  listed_day: number;
  cleared_day: number | null;
  cleared_price: number | null;
  cleared_to_actor_id: number | null;
}

function rowToLot(r: AuctionLotRow): AuctionLot {
  if (!isQualityTier(r.quality_tier)) {
    throw new Error(`invalid quality_tier on auction lot: ${r.quality_tier}`);
  }
  return {
    id: r.id,
    sourcePoolId: r.source_pool_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
    floorPrice: r.floor_price,
    listedDay: r.listed_day,
    clearedDay: r.cleared_day,
    clearedPrice: r.cleared_price,
    clearedToActorId: r.cleared_to_actor_id,
  };
}

export function insertAuctionLot(
  db: DB,
  input: InsertAuctionLotInput,
): AuctionLot {
  const result = db
    .prepare(
      `INSERT INTO auction_lots
        (source_pool_id, item_kind_id, quality_tier, quantity,
         floor_price, listed_day)
       VALUES
        (@source, @kind, @tier, @qty, @floor, @listed)`,
    )
    .run({
      source: input.sourcePoolId ?? null,
      kind: input.itemKindId,
      tier: input.qualityTier,
      qty: input.quantity,
      floor: input.floorPrice,
      listed: input.listedDay,
    });
  const lot = getAuctionLotById(db, result.lastInsertRowid);
  if (!lot) throw new Error("failed to fetch newly inserted auction lot");
  return lot;
}

export function getAuctionLotById(db: DB, id: number): AuctionLot | null {
  const row = db
    .prepare<AuctionLotRow>(`SELECT * FROM auction_lots WHERE id = @id`)
    .get({ id });
  return row ? rowToLot(row) : null;
}

export function listOpenAuctionLots(db: DB): AuctionLot[] {
  return db
    .prepare<AuctionLotRow>(
      `SELECT * FROM auction_lots WHERE cleared_day IS NULL ORDER BY id ASC`,
    )
    .all()
    .map(rowToLot);
}

export function listAuctionLotsListedOn(db: DB, day: number): AuctionLot[] {
  return db
    .prepare<AuctionLotRow>(
      `SELECT * FROM auction_lots WHERE listed_day = @day ORDER BY id ASC`,
    )
    .all({ day })
    .map(rowToLot);
}

/**
 * Mark a lot as written off — taken off the floor with no buyer. Convention:
 * `cleared_day` set, `cleared_to_actor_id` and `cleared_price` both NULL.
 * The lot is closed but no stock or cash moved.
 */
export function writeOffAuctionLot(
  db: DB,
  lotId: number,
  atDay: number,
): AuctionLot {
  const updated = db
    .prepare<AuctionLotRow>(
      `UPDATE auction_lots
         SET cleared_day = @day, cleared_price = NULL, cleared_to_actor_id = NULL
       WHERE id = @id AND cleared_day IS NULL
       RETURNING *`,
    )
    .get({ id: lotId, day: atDay });
  if (!updated) throw new Error(`auction lot ${lotId} not found or already cleared`);
  return rowToLot(updated);
}

export function clearAuctionLot(
  db: DB,
  lotId: number,
  args: {
    atDay: number;
    toActorId: number;
    /** Hammer price — the total paid for the whole lot. */
    finalPrice: number;
  },
): AuctionLot {
  const updated = db
    .prepare<AuctionLotRow>(
      `UPDATE auction_lots
         SET cleared_day = @day, cleared_price = @price, cleared_to_actor_id = @actor
       WHERE id = @id AND cleared_day IS NULL
       RETURNING *`,
    )
    .get({
      id: lotId,
      day: args.atDay,
      price: args.finalPrice,
      actor: args.toActorId,
    });
  if (!updated) throw new Error(`auction lot ${lotId} not found or already cleared`);
  return rowToLot(updated);
}

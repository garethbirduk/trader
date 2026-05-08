import type { DB } from "../core/db.js";
import type { StockLot } from "./types.js";
import {
  decrementLotQuantity,
  getStockLotById,
  insertStockLot,
} from "./lots-repo.js";

export interface SplitResult {
  /** The remaining portion of the original lot (null if fully consumed). */
  readonly source: StockLot | null;
  /** The new lot carrying the split-off units. */
  readonly spinoff: StockLot;
}

/**
 * Split `removeQuantity` units off a lot into a new lot owned by the same
 * actor. The new lot inherits all of the source's fields except `id` and
 * (potentially) `quantity`. If `removeQuantity` equals the lot's quantity,
 * the source row is removed and the spinoff carries the full quantity.
 *
 * This is a primitive used by transferStockUnits and tests; most callers
 * want transferStockUnits directly.
 */
export function splitStockLot(
  db: DB,
  lotId: number,
  removeQuantity: number,
): SplitResult {
  return db.transaction((): SplitResult => {
    const source = getStockLotById(db, lotId);
    if (!source) throw new Error(`stock lot ${lotId} not found`);
    if (removeQuantity <= 0) {
      throw new Error(`removeQuantity must be > 0; got ${removeQuantity}`);
    }
    if (removeQuantity > source.quantity) {
      throw new Error(
        `cannot split ${removeQuantity} from lot ${lotId} of size ${source.quantity}`,
      );
    }

    const spinoff = insertStockLot(db, {
      ownerActorId: source.ownerActorId,
      itemKindId: source.itemKindId,
      qualityTier: source.qualityTier,
      quantity: removeQuantity,
      acquiredUnitPrice: source.acquiredUnitPrice,
      acquiredDay: source.acquiredDay,
      locationId: source.locationId,
    });
    const remaining = decrementLotQuantity(db, lotId, removeQuantity);
    return { source: remaining, spinoff };
  });
}

export interface TransferResult {
  /** The remaining portion of the source lot (null if fully transferred). */
  readonly remaining: StockLot | null;
  /** The lot received by the target actor (always a freshly created row). */
  readonly received: StockLot;
}

/**
 * Move `quantity` units from a lot to a new lot owned by `toActorId`. The
 * new lot is recorded with a fresh `acquiredUnitPrice` and `acquiredDay`,
 * representing the recipient's basis (not the sender's). Lots are not
 * auto-merged with existing identical lots in the target's inventory —
 * the target simply gains a new row.
 */
export function transferStockUnits(
  db: DB,
  args: {
    fromLotId: number;
    toActorId: number;
    quantity: number;
    newUnitPrice: number;
    transferDay: number;
    /**
     * Where the recipient's new lot ends up physically. If omitted, the
     * stock keeps the source lot's location (e.g. a quiet handover that
     * doesn't move the goods physically).
     */
    destinationLocationId?: number | null;
  },
): TransferResult {
  return db.transaction((): TransferResult => {
    const source = getStockLotById(db, args.fromLotId);
    if (!source) throw new Error(`stock lot ${args.fromLotId} not found`);
    if (args.quantity <= 0) {
      throw new Error(`transfer quantity must be > 0; got ${args.quantity}`);
    }
    if (args.quantity > source.quantity) {
      throw new Error(
        `cannot transfer ${args.quantity} from lot ${args.fromLotId} of size ${source.quantity}`,
      );
    }
    if (args.newUnitPrice < 0) {
      throw new Error(`newUnitPrice must be >= 0; got ${args.newUnitPrice}`);
    }
    if (args.transferDay < 1) {
      throw new Error(`transferDay must be >= 1; got ${args.transferDay}`);
    }
    if (source.ownerActorId === args.toActorId) {
      throw new Error(
        `transfer source and destination are the same actor (${args.toActorId})`,
      );
    }

    const received = insertStockLot(db, {
      ownerActorId: args.toActorId,
      itemKindId: source.itemKindId,
      qualityTier: source.qualityTier,
      quantity: args.quantity,
      acquiredUnitPrice: args.newUnitPrice,
      acquiredDay: args.transferDay,
      locationId:
        args.destinationLocationId !== undefined
          ? args.destinationLocationId
          : source.locationId,
    });
    const remaining = decrementLotQuantity(db, args.fromLotId, args.quantity);
    return { remaining, received };
  });
}

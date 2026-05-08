import type { DB } from "../core/db.js";
import type { Clock } from "../core/clock.js";
import type { EventLog } from "../core/events.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import {
  TRANSIT_DAYS_BY_TIER,
  TRANSPORT_LIMITS,
  type TransportCapacity,
} from "../actors/types.js";
import {
  getStockLotsByOwnerKindAndTier,
  getStockLotsByOwnerKindTierAndLocation,
  insertStockLot,
} from "../stock/lots-repo.js";
import { transferStockUnits } from "../stock/stock-operations.js";
import {
  getDealById,
  getDealLinesByDealId,
  updateDealState,
} from "./deals-repo.js";
import { getSupplyLeadsForItem } from "../leads/leads-repo.js";
import { getPoolById } from "../pools/pools-repo.js";
import { poolUnitPriceOnDay } from "../pools/types.js";
import type { Deal, DealLine } from "./types.js";
import { totalPriceOfLines } from "./types.js";

export class DealStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealStateError";
  }
}

export class ShortStockError extends Error {
  readonly dealId: number;
  readonly line: DealLine;
  readonly available: number;
  constructor(dealId: number, line: DealLine, available: number) {
    super(
      `seller short on deal ${dealId} line ${line.id}: have ${available}, need ${line.quantity}`,
    );
    this.name = "ShortStockError";
    this.dealId = dealId;
    this.line = line;
    this.available = available;
  }
}

export class InsufficientCashError extends Error {
  readonly dealId: number;
  readonly buyerCash: number;
  readonly required: number;
  constructor(dealId: number, buyerCash: number, required: number) {
    super(
      `buyer of deal ${dealId} has £${buyerCash}; deal requires £${required}`,
    );
    this.name = "InsufficientCashError";
    this.dealId = dealId;
    this.buyerCash = buyerCash;
    this.required = required;
  }
}

export class NoTransportError extends Error {
  readonly dealId: number;
  readonly capacity: number;
  readonly required: number;
  constructor(dealId: number, capacity: number, required: number) {
    super(
      `seller of deal ${dealId} can transport ${capacity}; deal requires ${required}`,
    );
    this.name = "NoTransportError";
    this.dealId = dealId;
    this.capacity = capacity;
    this.required = required;
  }
}

/**
 * Per-trip delivery fee charged when stock isn't already at the delivery
 * location. Higher tiers cost more (you're sending a lorry instead of
 * walking). Pocket = free (you already had it on you).
 */
export const DELIVERY_FEE_BY_TIER: Readonly<Record<TransportCapacity, number>> = {
  none: 0,
  pocket: 0,
  boot: 5,
  van: 20,
  truck: 50,
};

export interface SettleResult {
  readonly deal: Deal;
  readonly totalPrice: number;
}

export interface SettleOptions {
  /**
   * If the seller is short on a line, the engine walks their supply
   * leads (M6/M10) and tries to claim from referenced pools to satisfy
   * the obligation. Cash for these claims goes to this actor (a
   * "supplier" sink) if set, or is burned if null. Skins should set this
   * to keep the conservation invariant.
   */
  readonly procurementProceedsActorId?: number | null;
  /** Optional event log for emitting `settlement.lead-claim` events. */
  readonly events?: EventLog;
  /** Clock at settlement time, used for event timestamps. */
  readonly atClock?: Clock;
}

/**
 * Settle an `agreed` deal at `atDay`. The settlement walk is:
 *
 *   1. Verify the deal is in `agreed`.
 *   2. Verify the buyer has enough cash for the agreed total.
 *   3. For each line, consume from the seller's matching inventory FIFO.
 *      If still short, walk the seller's supply leads (closest-to-source
 *      first) and try to claim from each lead's referenced pool. Pool
 *      stock decrements; seller's cash drops by source cost. The lot
 *      moves to the buyer at the deal's agreed unit price.
 *   4. Transfer the buyer's cash to the seller.
 *   5. Mark the deal settled.
 *
 * Throws ShortStockError if the seller cannot satisfy the line even after
 * walking their leads (the engine's "physics catches up" beat). Throws
 * InsufficientCashError if the buyer cannot pay the agreed total.
 *
 * The lead-walk step is the heart of the cascading-failure comedy. If two
 * sellers both have supply leads pointing to the *same* `subject_pool_id`,
 * the first to settle drains the pool; the second settles short and
 * defaults — exactly the over-counted-stock dynamic the design was built
 * to produce.
 */
export function settleDeal(
  db: DB,
  dealId: number,
  atDay: number,
  opts: SettleOptions = {},
): SettleResult {
  return db.transaction((): SettleResult => {
    const deal = getDealById(db, dealId);
    if (!deal) throw new Error(`deal ${dealId} not found`);
    if (deal.state !== "agreed") {
      throw new DealStateError(
        `cannot settle deal ${dealId} in state '${deal.state}'`,
      );
    }
    const lines = getDealLinesByDealId(db, dealId);
    if (lines.length === 0) {
      throw new Error(`deal ${dealId} has no lines`);
    }

    // Verify buyer cash up front so we don't move stock unnecessarily.
    const totalPrice = totalPriceOfLines(lines);
    const buyer = getActorById(db, deal.buyerActorId);
    if (!buyer) throw new Error(`buyer ${deal.buyerActorId} not found`);
    if (buyer.cash < totalPrice) {
      throw new InsufficientCashError(deal.id, buyer.cash, totalPrice);
    }

    // Verify the seller can physically transport the goods. A coat
    // pocket can't shift a truckload, regardless of how many units the
    // seller has stashed.
    const seller = getActorById(db, deal.sellerActorId);
    if (!seller) throw new Error(`seller ${deal.sellerActorId} not found`);
    const totalUnits = lines.reduce((sum, l) => sum + l.quantity, 0);
    const transportLimit = TRANSPORT_LIMITS[seller.transportCapacity];
    if (totalUnits > transportLimit) {
      throw new NoTransportError(deal.id, transportLimit, totalUnits);
    }

    // Consume stock per line — inventory first, then leads if short.
    for (const line of lines) {
      consumeStockForLine(
        db,
        deal,
        line,
        atDay,
        opts,
      );
    }

    // Buyer pays seller the agreed total.
    adjustActorCash(db, deal.buyerActorId, -totalPrice);
    adjustActorCash(db, deal.sellerActorId, totalPrice);

    const settled = updateDealState(db, {
      id: deal.id,
      state: "settled",
      settledDay: atDay,
    });

    if (opts.events) {
      opts.events.emit({
        type: "deal.settled",
        at: opts.atClock ?? { day: atDay, hour: 0 },
        dealId: deal.id,
        buyerActorId: deal.buyerActorId,
        sellerActorId: deal.sellerActorId,
        totalPrice,
      });
    }

    return { deal: settled, totalPrice };
  });
}

function consumeStockForLine(
  db: DB,
  deal: Deal,
  line: DealLine,
  atDay: number,
  opts: SettleOptions,
): void {
  const sellerId = deal.sellerActorId;
  const buyerId = deal.buyerActorId;
  const deliveryLocationId = deal.deliveryLocationId;
  let remaining = line.quantity;

  // Phase 1a: stock the seller already has at the delivery location.
  // No fee — they brought it with them or had it pre-positioned.
  if (deliveryLocationId !== null) {
    const local = getStockLotsByOwnerKindTierAndLocation(
      db,
      sellerId,
      line.itemKindId,
      line.qualityTier,
      deliveryLocationId,
    );
    for (const lot of local) {
      if (remaining === 0) break;
      const take = Math.min(remaining, lot.quantity);
      transferStockUnits(db, {
        fromLotId: lot.id,
        toActorId: buyerId,
        quantity: take,
        newUnitPrice: line.unitPrice,
        transferDay: atDay,
        destinationLocationId: deliveryLocationId,
      });
      remaining -= take;
    }
  }

  if (remaining === 0) return;

  // Phase 1b: stock anywhere else — costs a per-trip delivery fee
  // based on the seller's transport tier. The path is *time-gated*:
  // the seller can only move remote stock if there's been enough days
  // since the deal was agreed for their transport tier to physically
  // make the trip. A truck-tier seller committing to deliver tomorrow
  // can't fall back here — the lorry can't make it in time.
  //
  // For deals with no delivery_location_id (legacy/test rows), this
  // path is the catch-all FIFO case at zero fee — those tests predate
  // Phase 2 so neither stamp the lots' location nor expect a fee, and
  // the time-gate doesn't apply.
  const allLots = getStockLotsByOwnerKindAndTier(
    db,
    sellerId,
    line.itemKindId,
    line.qualityTier,
  );
  const remote = deliveryLocationId === null
    ? allLots
    : allLots.filter((l) => l.locationId !== deliveryLocationId);

  let feeCharged = false;
  // Compute the lead-time gate up front. Seller might already be
  // resolved at this point but re-fetch defensively.
  let timeGatePassed = true;
  if (deliveryLocationId !== null) {
    const sellerForGate = getActorById(db, sellerId);
    if (sellerForGate) {
      const transit = TRANSIT_DAYS_BY_TIER[sellerForGate.transportCapacity];
      timeGatePassed = atDay - deal.agreedDay >= transit;
    }
  }

  for (const lot of remote) {
    if (remaining === 0) break;
    if (deliveryLocationId !== null && !timeGatePassed) break;

    if (deliveryLocationId !== null && !feeCharged) {
      const seller = getActorById(db, sellerId);
      if (!seller) throw new Error(`seller ${sellerId} not found`);
      const fee = DELIVERY_FEE_BY_TIER[seller.transportCapacity];
      if (fee > 0) {
        if (seller.cash < fee) {
          // Can't afford the trip. Skip remote lots; lead-walk may save us.
          break;
        }
        adjustActorCash(db, sellerId, -fee);
        if (
          opts.procurementProceedsActorId !== null &&
          opts.procurementProceedsActorId !== undefined
        ) {
          adjustActorCash(db, opts.procurementProceedsActorId, fee);
        }
        if (opts.events) {
          opts.events.emit({
            type: "delivery.fee",
            at: opts.atClock ?? { day: atDay, hour: 0 },
            dealId: deal.id,
            sellerActorId: sellerId,
            fee,
          });
        }
      }
      feeCharged = true;
    }

    const take = Math.min(remaining, lot.quantity);
    transferStockUnits(db, {
      fromLotId: lot.id,
      toActorId: buyerId,
      quantity: take,
      newUnitPrice: line.unitPrice,
      transferDay: atDay,
      destinationLocationId: deliveryLocationId,
    });
    remaining -= take;
  }

  if (remaining === 0) return;

  // Phase 2: walk supply leads and source from referenced pools.
  const leads = getSupplyLeadsForItem(db, sellerId, line.itemKindId).filter(
    (l) =>
      l.subjectPoolId !== null &&
      (l.subjectQualityTier === null ||
        l.subjectQualityTier === line.qualityTier),
  );

  for (const lead of leads) {
    if (remaining === 0) break;
    const poolId = lead.subjectPoolId;
    if (poolId === null) continue;
    const pool = getPoolById(db, poolId);
    if (!pool) continue;
    if (pool.flushedDay !== null) continue;
    if (pool.quantityRemaining === 0) continue;

    const wantQty = Math.min(remaining, pool.quantityRemaining);
    const unitPrice = poolUnitPriceOnDay(pool, atDay);
    const totalCost = unitPrice * wantQty;

    // Seller pays the source cost. If they can't afford this lead, skip
    // it — they may have cheaper leads available.
    const seller = getActorById(db, sellerId);
    if (!seller || seller.cash < totalCost) continue;

    db.prepare(
      `UPDATE world_pools SET quantity_remaining = quantity_remaining - @q
       WHERE id = @id`,
    ).run({ id: poolId, q: wantQty });

    adjustActorCash(db, sellerId, -totalCost);
    if (opts.procurementProceedsActorId !== null && opts.procurementProceedsActorId !== undefined) {
      adjustActorCash(db, opts.procurementProceedsActorId, totalCost);
    }

    // Stock goes straight to the buyer at the deal's agreed unit price,
    // appearing at the delivery location.
    insertStockLot(db, {
      ownerActorId: buyerId,
      itemKindId: line.itemKindId,
      qualityTier: line.qualityTier,
      quantity: wantQty,
      acquiredUnitPrice: line.unitPrice,
      acquiredDay: atDay,
      locationId: deliveryLocationId,
    });

    if (opts.events) {
      opts.events.emit({
        type: "settlement.lead-claim",
        at: opts.atClock ?? { day: atDay, hour: 0 },
        dealId: deal.id,
        sellerActorId: sellerId,
        poolId,
        quantity: wantQty,
        unitPrice,
        throughLeadId: lead.id,
      });
    }

    remaining -= wantQty;
  }

  if (remaining > 0) {
    throw new ShortStockError(deal.id, line, line.quantity - remaining);
  }
}

export function markDealDefaulted(
  db: DB,
  dealId: number,
  atDay: number,
  reason: string,
): Deal {
  return db.transaction((): Deal => {
    const deal = getDealById(db, dealId);
    if (!deal) throw new Error(`deal ${dealId} not found`);
    if (deal.state !== "agreed" && deal.state !== "proposed") {
      throw new DealStateError(
        `cannot default deal ${dealId} in state '${deal.state}'`,
      );
    }
    return updateDealState(db, {
      id: dealId,
      state: "defaulted",
      defaultedDay: atDay,
      defaultReason: reason,
    });
  });
}

export function cancelDeal(db: DB, dealId: number): Deal {
  return db.transaction((): Deal => {
    const deal = getDealById(db, dealId);
    if (!deal) throw new Error(`deal ${dealId} not found`);
    if (deal.state !== "proposed" && deal.state !== "agreed") {
      throw new DealStateError(
        `cannot cancel deal ${dealId} in state '${deal.state}'`,
      );
    }
    return updateDealState(db, { id: dealId, state: "cancelled" });
  });
}

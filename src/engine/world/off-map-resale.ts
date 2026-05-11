import type { World, Unsubscribe } from "../core/world.js";
import { getStockLotsByOwner, deleteStockLot } from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { adjustActorCash } from "../actors/actors-repo.js";
import { insertPendingPayout } from "../payouts/pending-payouts-repo.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface OffMapResaleOptions {
  /** Actor ids of off-map dealers whose stock liquidates each day. */
  readonly offMapDealerActorIds: ReadonlySet<number>;
  /** The synthetic "external economy" account that buys their stock.
   *  Pays out at end-of-day; exempted from cash conservation. */
  readonly offMapMarketActorId: number;
  /** Economic tuning bundle — pulls `offMapAuction.resellMargin` and
   *  `tierMultipliers` from here. */
  readonly economics?: EconomicsConfig;
}

/**
 * End-of-day liquidation for the wider trade scene. Each off-map
 * dealer's stock is sold back to a synthetic external-economy account
 * at `item.baseValue × tierMultiplier × quantity × resellMargin`. The
 * cash flows external→dealer; the stock lot is deleted. Models the
 * off-map dealer onward-selling in their own town to invisible
 * customers, returning to Sotheby's tomorrow with replenished capital.
 *
 * The external-economy account is configured (via the invariants test)
 * to be exempt from cash conservation, so this handler can mint cash
 * without breaking the conservation check — the account represents the
 * economy outside our simulated bubble.
 *
 * Registers as `onDayEnd` so it fires after the day's auctions and
 * any post-auction interactions have settled.
 */
export function registerOffMapResale(
  world: World,
  opts: OffMapResaleOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const tierMult = economics.tierMultipliers;
  const resellMargin = economics.offMapAuction.resellMargin;
  const payoutLagDays = Math.max(0, economics.offMapAuction.payoutLagDays);

  return world.onDayEnd((day) => {
    for (const dealerId of opts.offMapDealerActorIds) {
      const lots = getStockLotsByOwner(world.db, dealerId);
      if (lots.length === 0) continue;
      let totalValue = 0;
      let unitsSold = 0;
      let lotsSold = 0;
      for (const lot of lots) {
        const item = getItemKindById(world.db, lot.itemKindId);
        if (item === null) continue;
        const mult = tierMult[lot.qualityTier] ?? 1;
        const value = Math.max(
          0,
          Math.round(item.baseValue * mult * lot.quantity * resellMargin),
        );
        totalValue += value;
        unitsSold += lot.quantity;
        lotsSold += 1;
        deleteStockLot(world.db, lot.id);
      }
      if (totalValue === 0) continue;
      // Cash leaves the off-map market account immediately (the buyer
      // pays for goods at the moment of resale), but the dealer's
      // proceeds arrive with `payoutLagDays` lag — modelling cheques
      // clearing, wire transfers, etc. Conservation is preserved
      // because the pending_payouts row holds the cash in transit.
      adjustActorCash(world.db, opts.offMapMarketActorId, -totalValue);
      if (payoutLagDays === 0) {
        adjustActorCash(world.db, dealerId, totalValue);
      } else {
        insertPendingPayout(world.db, {
          actorId: dealerId,
          amount: totalValue,
          availableDay: day + payoutLagDays,
          source: "off-map-resale",
          createdDay: day,
        });
      }
      world.events.emit({
        type: "off-map.resold",
        at: { day, hour: 23 },
        dealerActorId: dealerId,
        marketActorId: opts.offMapMarketActorId,
        lotsSold,
        unitsSold,
        totalValue,
      });
    }
  });
}

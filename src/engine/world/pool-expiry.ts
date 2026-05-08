import type { World, Unsubscribe } from "../core/world.js";
import { insertAuctionLot } from "../auction/auction-repo.js";
import {
  listPoolsExpiredBefore,
  markPoolFlushed,
} from "../pools/pools-repo.js";

/**
 * Daily pool expiry: at the start of each day, find pools whose expiry
 * day was yesterday or earlier and dump their remaining stock to the
 * configured destination. The auction destination produces a new
 * auction_lot listed today; market and write_off destinations consume
 * the remaining stock without listing it.
 *
 * This is the engine's release valve — pools that don't clear privately
 * always end up somewhere, never accumulating as zombie stock.
 */
export function registerPoolExpiry(world: World): Unsubscribe {
  return world.onDayStart((day) => {
    const expired = listPoolsExpiredBefore(world.db, day);
    for (const pool of expired) {
      if (pool.quantityRemaining > 0 && pool.dumpDestination === "auction") {
        const lot = insertAuctionLot(world.db, {
          sourcePoolId: pool.id,
          itemKindId: pool.itemKindId,
          qualityTier: pool.qualityTier,
          quantity: pool.quantityRemaining,
          // Reserve = closing per-unit × remaining qty (the would-have-been
          // last-day price across the whole leftover stock).
          floorPrice: pool.closingUnitPrice * pool.quantityRemaining,
          listedDay: day,
        });
        world.events.emit({
          type: "pool.flushed",
          at: world.clock,
          poolId: pool.id,
          quantity: pool.quantityRemaining,
          destination: "auction",
          auctionLotId: lot.id,
        });
      } else {
        world.events.emit({
          type: "pool.flushed",
          at: world.clock,
          poolId: pool.id,
          quantity: pool.quantityRemaining,
          destination: pool.dumpDestination,
          auctionLotId: null,
        });
      }
      markPoolFlushed(world.db, pool.id, day);
    }
  });
}

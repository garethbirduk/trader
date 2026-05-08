import type { World, Unsubscribe } from "../core/world.js";
import {
  adjustActorCash,
  getActorById,
  listActors,
} from "../actors/actors-repo.js";
import {
  clearAuctionLot,
  listOpenAuctionLots,
  writeOffAuctionLot,
} from "../auction/auction-repo.js";
import type { AuctionLot } from "../auction/types.js";
import {
  resolveAuctionSession,
  type AuctionBidder,
} from "../auction/auction-session.js";
import { rungAtOrBelow } from "../auction/bid-ladder.js";
import { insertStockLot } from "../stock/lots-repo.js";
import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";

export type FindBiddersFn = (
  db: DB,
  lot: AuctionLot,
  day: number,
  rng: SeededRNG,
) => readonly AuctionBidder[];

export interface DailyAuctionOptions {
  /** How a skin/test surfaces interested bidders for a given lot. */
  readonly findBiddersForLot: FindBiddersFn;
  /**
   * Where auction proceeds go. If null, cash is burned (breaks conservation
   * — fine for tests, set this in real runs).
   */
  readonly proceedsActorId?: number | null;
  /**
   * Multiplicative floor decay applied each day a lot stays unsold. A
   * lot's effective floor on auction day N is `original_floor × decay^(N-1)`,
   * never going below 1. Default 0.7 (30% reduction per day).
   */
  readonly floorDecayPerDay?: number;
  /**
   * Maximum days a lot can stay open on the auction floor before being
   * written off (no buyer, no cash, lot is closed). Counted as
   * `today - listed_day`. Default 5.
   */
  readonly maxDaysOpen?: number;
  /**
   * Hour of day at which the auction fires (0..23). When set, the handler
   * runs once per day at that hour rather than at day-start — giving
   * NPCs time to travel to the auction room before bidding opens. When
   * undefined (default), retains the legacy day-start firing for
   * backwards compatibility with existing tests.
   */
  readonly auctionHour?: number;
  /**
   * The location ID where the auction is held. When set, the handler
   * snapshots all actors physically at that location at auction time
   * and emits them on the event as `attendees` — the room, not just the
   * subset who chose to bid. Bidders are always a subset of attendees.
   */
  readonly auctionLocationId?: number;
}

/**
 * Run the auction every morning over lots listed yesterday or earlier.
 * Lots listed today are held over so bidders have a day to consider them
 * (matches the natural rhythm: pool expires → lot listed → next day's
 * auction). Bid resolution snaps to the standard auction bid ladder
 * (see `bid-ladder.ts`) — bidders' total ceilings are snapped to rungs,
 * the floor is snapped to the lowest rung at or above it, and the hammer
 * price is always a ladder rung.
 */
export function registerDailyAuction(
  world: World,
  opts: DailyAuctionOptions,
): Unsubscribe {
  const proceedsActorId = opts.proceedsActorId ?? null;
  const floorDecay = opts.floorDecayPerDay ?? 0.7;
  const maxDaysOpen = opts.maxDaysOpen ?? 5;

  if (floorDecay <= 0 || floorDecay > 1) {
    throw new Error(`floorDecayPerDay must be in (0, 1]; got ${floorDecay}`);
  }

  const auctionLocationId = opts.auctionLocationId;

  const collectAttendees = (excludeIds: ReadonlySet<number>): number[] => {
    if (auctionLocationId === undefined) return [];
    const ids: number[] = [];
    for (const a of listActors(world.db)) {
      if (excludeIds.has(a.id)) continue;
      if (a.currentLocationId === auctionLocationId) ids.push(a.id);
    }
    return ids;
  };

  const runForDay = (day: number): void => {
    const lots = listOpenAuctionLots(world.db).filter((l) => l.listedDay < day);
    for (const lot of lots) {
      const daysOpen = day - lot.listedDay;
      if (daysOpen > maxDaysOpen) {
        writeOffAuctionLot(world.db, lot.id, day);
        world.events.emit({
          type: "auction.written_off",
          at: world.clock,
          auctionLotId: lot.id,
          daysOpen,
        });
        continue;
      }
      const effectiveFloor = Math.max(
        1,
        Math.round(lot.floorPrice * Math.pow(floorDecay, Math.max(0, daysOpen - 1))),
      );
      runOneLot(
        world,
        lot,
        day,
        effectiveFloor,
        opts.findBiddersForLot,
        proceedsActorId,
        collectAttendees,
      );
    }
  };

  if (opts.auctionHour !== undefined) {
    const auctionHour = opts.auctionHour;
    if (!Number.isInteger(auctionHour) || auctionHour < 0 || auctionHour > 23) {
      throw new Error(`auctionHour must be in 0..23; got ${auctionHour}`);
    }
    return world.onHour((clock) => {
      if (clock.hour !== auctionHour) return;
      runForDay(clock.day);
    });
  }
  return world.onDayStart((day) => runForDay(day));
}

function runOneLot(
  world: World,
  lot: import("../auction/types.js").AuctionLot,
  day: number,
  effectiveFloor: number,
  findBidders: FindBiddersFn,
  proceedsActorId: number | null,
  collectAttendees: (excludeIds: ReadonlySet<number>) => number[],
): void {
  // Bidder factories see the lot's *original* floorPrice; they decide
  // their ceilings against intrinsic value. The resolver compares those
  // ceilings against the *decayed* floor — bidders who couldn't afford
  // yesterday's floor may clear today's.
  const originalBidders = [...findBidders(world.db, lot, day, world.rng)];
  const biddersSnapshot = originalBidders.map((b) => ({
    actorId: b.actorId,
    ceiling: b.ceiling,
  }));
  // Attendees: everyone in the room except the bidders themselves. The
  // bidders are listed separately so the webapp can show "in the room"
  // (non-bidders) alongside "bidding" (bidders).
  const bidderIdSet = new Set(originalBidders.map((b) => b.actorId));
  const attendees = collectAttendees(bidderIdSet);
  // The opening ask snaps DOWN: a £144 floor opens at £125 (last rung at
  // or below the floor). Surfaced as `openingAsk` for visualisation.
  const openingAsk = rungAtOrBelow(Math.max(0, effectiveFloor));
  let bidders = [...originalBidders];
  let cashFailures = 0;

  while (true) {
    const session = resolveAuctionSession(bidders, effectiveFloor);
    if (session.type !== "won") {
      world.events.emit({
        type: "auction.unsold",
        at: world.clock,
        auctionLotId: lot.id,
        reason: cashFailures > 0 ? "winner-cant-pay" : session.type,
        floorPrice: lot.floorPrice,
        effectiveFloor,
        openingAsk,
        attendees,
        bidders: biddersSnapshot,
      });
      return;
    }

    const totalCost = session.finalPrice;
    const winner = getActorById(world.db, session.winnerActorId);
    if (!winner) {
      bidders = bidders.filter((b) => b.actorId !== session.winnerActorId);
      continue;
    }
    if (winner.cash < totalCost) {
      cashFailures += 1;
      bidders = bidders.filter((b) => b.actorId !== session.winnerActorId);
      continue;
    }

    // Winner can pay — close the lot.
    adjustActorCash(world.db, winner.id, -totalCost);
    if (proceedsActorId !== null) {
      adjustActorCash(world.db, proceedsActorId, totalCost);
    }
    // Derive a per-unit acquisition basis for the resulting stock lot.
    const acquiredUnitPrice = Math.max(0, Math.round(totalCost / lot.quantity));
    // Auction wins land at the buyer's current location — they wanted
    // the lot, they take it away from where they are.
    insertStockLot(world.db, {
      ownerActorId: winner.id,
      itemKindId: lot.itemKindId,
      qualityTier: lot.qualityTier,
      quantity: lot.quantity,
      acquiredUnitPrice,
      acquiredDay: day,
      locationId: winner.currentLocationId,
    });
    clearAuctionLot(world.db, lot.id, {
      atDay: day,
      toActorId: winner.id,
      finalPrice: totalCost,
    });
    world.events.emit({
      type: "auction.cleared",
      at: world.clock,
      auctionLotId: lot.id,
      winnerActorId: winner.id,
      unitPrice: acquiredUnitPrice,
      totalPrice: totalCost,
      floorPrice: lot.floorPrice,
      effectiveFloor,
      openingAsk,
      attendees,
      bidders: biddersSnapshot,
    });
    return;
  }
}

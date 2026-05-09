import type { World, Unsubscribe } from "../core/world.js";
import {
  adjustActorCash,
  getActorById,
  listActors,
} from "../actors/actors-repo.js";
import {
  clearAuctionLot,
  listAuctionLotsScheduledForHour,
  listOpenAuctionLots,
  setAuctionLotScheduledHour,
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
   * written off. Counted as `today - listed_day`. Default 5. Combined
   * with the docket pick (only 6 lots/day get auctioned), unpicked lots
   * may sit for several days waiting their turn — but if the docket
   * mode (`auctionStartHour` set) is on, lots that don't make today's
   * docket are written off immediately rather than rolled.
   */
  readonly maxDaysOpen?: number;
  /**
   * Legacy single-hour firing — when set without `auctionEndHour`, runs
   * all eligible lots in one batch at this hour (matching pre-docket
   * behaviour). Kept for backwards compatibility with tests that haven't
   * migrated.
   */
  readonly auctionHour?: number;
  /**
   * Docket mode: if `auctionStartHour` and `auctionEndHour` are both set,
   * auctions run one lot per hour from start..end inclusive (so a 11..16
   * window allows up to 6 lots/day). At day-start, up to (end-start+1)
   * eligible lots are picked at random and assigned an hour; the rest
   * are written off as "not chosen for today's docket".
   */
  readonly auctionStartHour?: number;
  /** See `auctionStartHour`. Inclusive endpoint of the docket window. */
  readonly auctionEndHour?: number;
  /**
   * The location ID where the auction is held. When set, the handler
   * snapshots all actors physically at that location at auction time
   * and emits them on the event as `attendees` — the room, not just the
   * subset who chose to bid. Bidders are always a subset of attendees.
   */
  readonly auctionLocationId?: number;
}

/**
 * Run the daily auction over open lots. Two modes:
 *
 *   - **legacy single-hour**: pass `auctionHour`. All eligible lots
 *     (listed yesterday or earlier, within the maxDaysOpen window) run
 *     at that hour. Original behaviour, retained for tests.
 *
 *   - **docket window** (preferred): pass `auctionStartHour` and
 *     `auctionEndHour`. At day-start the engine picks up to
 *     (end-start+1) random eligible lots, assigns each a unique hour
 *     in the window, and writes off any remaining open lots. Each
 *     hour H in the window then runs that hour's lot if any.
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

  const isDocketMode =
    opts.auctionStartHour !== undefined && opts.auctionEndHour !== undefined;

  // ── Docket mode ────────────────────────────────────────────────────
  if (isDocketMode) {
    const startHour = opts.auctionStartHour!;
    const endHour = opts.auctionEndHour!;
    if (
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      startHour < 0 ||
      endHour > 23 ||
      startHour > endHour
    ) {
      throw new Error(
        `auctionStartHour/auctionEndHour must satisfy 0 <= start <= end <= 23; got ${startHour}..${endHour}`,
      );
    }
    const slotCount = endHour - startHour + 1;

    const unsubDayStart = world.onDayStart((day) => {
      pickTodaysDocket(world, day, startHour, slotCount);
    });
    const unsubHour = world.onHour((clock) => {
      if (clock.hour < startHour || clock.hour > endHour) return;
      const lots = listAuctionLotsScheduledForHour(world.db, clock.hour);
      // Only run lots whose listed_day is < today (matches the legacy
      // "lots listed yesterday auction today" rhythm) and that haven't
      // yet been cleared.
      for (const lot of lots) {
        if (lot.listedDay >= clock.day) continue;
        const daysOpen = clock.day - lot.listedDay;
        const effectiveFloor = Math.max(
          1,
          Math.round(
            lot.floorPrice * Math.pow(floorDecay, Math.max(0, daysOpen - 1)),
          ),
        );
        runOneLot(
          world,
          lot,
          clock.day,
          effectiveFloor,
          opts.findBiddersForLot,
          proceedsActorId,
          collectAttendees,
        );
      }
    });
    return () => {
      unsubDayStart();
      unsubHour();
    };
  }

  // ── Legacy single-hour mode ────────────────────────────────────────
  const runForDay = (day: number): void => {
    const lots = listOpenAuctionLots(world.db).filter(
      (l) => l.listedDay < day,
    );
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

/**
 * Pick today's running docket: up to `slotCount` random open lots, each
 * assigned a unique hour starting at `startHour`. Any remaining open
 * lots are written off — they were "listed but not interesting enough
 * for the dealer crowd," in fiction.
 */
function pickTodaysDocket(
  world: World,
  day: number,
  startHour: number,
  slotCount: number,
): void {
  // Eligible = listed on a previous day and still open.
  const eligible = listOpenAuctionLots(world.db).filter(
    (l) => l.listedDay < day,
  );
  if (eligible.length === 0) {
    world.events.emit({
      type: "auction.docket-published",
      at: world.clock,
      lots: [],
    });
    return;
  }
  // Deterministic shuffle using the world RNG. Fisher-Yates on a copy.
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(world.rng.next() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  const picked = shuffled.slice(0, slotCount);
  const dropped = shuffled.slice(slotCount);

  // Assign hours to picked lots.
  const docket: { lotId: number; scheduledHour: number }[] = [];
  for (let i = 0; i < picked.length; i += 1) {
    const hour = startHour + i;
    const lot = picked[i]!;
    setAuctionLotScheduledHour(world.db, lot.id, hour);
    docket.push({ lotId: lot.id, scheduledHour: hour });
  }

  // Drop the rest — they aren't interesting enough today and won't
  // be reconsidered tomorrow either.
  for (const lot of dropped) {
    writeOffAuctionLot(world.db, lot.id, day);
    world.events.emit({
      type: "auction.written_off",
      at: world.clock,
      auctionLotId: lot.id,
      reason: "not-on-docket",
      daysOpen: day - lot.listedDay,
    });
  }

  world.events.emit({
    type: "auction.docket-published",
    at: world.clock,
    lots: docket,
  });
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

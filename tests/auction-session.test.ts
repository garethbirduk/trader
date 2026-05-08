import { describe, it, expect, afterEach } from "vitest";
import {
  resolveAuctionSession,
  type AuctionBidder,
} from "../src/engine/auction/auction-session.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertPool } from "../src/engine/pools/pools-repo.js";
import { registerPoolExpiry } from "../src/engine/world/pool-expiry.js";
import { registerDailyAuction } from "../src/engine/world/daily-auction.js";
import {
  getAuctionLotById,
  listOpenAuctionLots,
} from "../src/engine/auction/auction-repo.js";
import { totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("resolveAuctionSession", () => {
  it("no bidders → no-bidders", () => {
    expect(resolveAuctionSession([], 5).type).toBe("no-bidders");
  });

  it("all below floor → all-below-floor", () => {
    const bidders: AuctionBidder[] = [
      { actorId: 1, ceiling: 3 },
      { actorId: 2, ceiling: 4 },
    ];
    expect(resolveAuctionSession(bidders, 5).type).toBe("all-below-floor");
  });

  it("single valid bidder pays the floor (snapped up to a rung)", () => {
    const r = resolveAuctionSession([{ actorId: 1, ceiling: 50 }], 10);
    expect(r.type).toBe("won");
    if (r.type !== "won") return;
    expect(r.winnerActorId).toBe(1);
    expect(r.finalPrice).toBe(10);
  });

  it("highest ceiling wins, paying one ladder-rung above runner-up", () => {
    const r = resolveAuctionSession(
      [
        { actorId: 1, ceiling: 30 },
        { actorId: 2, ceiling: 50 },
        { actorId: 3, ceiling: 40 },
      ],
      10,
    );
    expect(r.type).toBe("won");
    if (r.type !== "won") return;
    expect(r.winnerActorId).toBe(2);
    // Runner-up's snapped ceiling is 40; next rung above 40 is 45.
    expect(r.finalPrice).toBe(45);
  });

  it("snaps non-rung ceilings down — winner pays a rung, not the raw value", () => {
    // Bidders' ceilings 73 and 41 snap to 70 and 40 respectively.
    // Winner pays nextRungAbove(40) = 45.
    const r = resolveAuctionSession(
      [
        { actorId: 1, ceiling: 73 },
        { actorId: 2, ceiling: 41 },
      ],
      10,
    );
    expect(r.type).toBe("won");
    if (r.type !== "won") return;
    expect(r.winnerActorId).toBe(1);
    expect(r.finalPrice).toBe(45);
  });

  it("ties at a rung resolve to whoever had the higher raw ceiling", () => {
    // Both snap to 100, but actor 9's raw ceiling is higher (more headroom).
    const r = resolveAuctionSession(
      [
        { actorId: 7, ceiling: 100 },
        { actorId: 9, ceiling: 105 },
      ],
      10,
    );
    expect(r.type).toBe("won");
    if (r.type !== "won") return;
    expect(r.winnerActorId).toBe(9);
    expect(r.finalPrice).toBe(100);
  });

  it("identical ceilings break to the earlier-listed bidder", () => {
    const r = resolveAuctionSession(
      [
        { actorId: 7, ceiling: 100 },
        { actorId: 9, ceiling: 100 },
      ],
      10,
    );
    expect(r.type).toBe("won");
    if (r.type !== "won") return;
    expect(r.winnerActorId).toBe(7);
    expect(r.finalPrice).toBe(100);
  });
});

describe("daily auction handler (pool → auction → bidder)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a pool that expires gets auctioned to the highest bidder the next day", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const boyce = insertActor(localDb, { code: "boyce", displayName: "Boyce", cash: 1000 });
    const bidderA = insertActor(localDb, { code: "a", displayName: "A", cash: 1000 });
    const house = insertActor(localDb, { code: "house", displayName: "Auction House" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 2, // expires after day 2
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("auction"),
      seed: "auction",
      maxDays: 6,
    });
    registerPoolExpiry(world);
    registerDailyAuction(world, {
      proceedsActorId: house.id,
      findBiddersForLot: (_db, lot) => {
        if (lot.itemKindId === vacuums.id && lot.qualityTier === "good") {
          // Total ceilings — what the bidder would pay for the WHOLE lot.
          // Ceilings 175 and 100 both land on rungs; runner-up is 100, so
          // nextRungAbove(100) = 125, capped by Boyce's snapped 175 → £125.
          return [
            { actorId: boyce.id, ceiling: 175 },
            { actorId: bidderA.id, ceiling: 100 },
          ];
        }
        return [];
      },
    });
    world.runToCompletion();

    const lots = listOpenAuctionLots(localDb);
    expect(lots).toHaveLength(0); // cleared
    expect(totalQuantityForOwnerAndKind(localDb, boyce.id, vacuums.id)).toBe(10);
    expect(getActorById(localDb, boyce.id)?.cash).toBe(875);
    expect(getActorById(localDb, house.id)?.cash).toBe(125);
  });

  it("emits auction.unsold when no bidders cover the floor", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 15,
      closingUnitPrice: 50,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("unsold"),
      seed: "unsold",
      maxDays: 5,
    });
    registerPoolExpiry(world);
    const events: string[] = [];
    world.events.subscribe((e) => events.push(e.type));
    registerDailyAuction(world, {
      findBiddersForLot: () => [], // nobody interested
    });
    world.runToCompletion();
    expect(events).toContain("auction.unsold");
    // Lot still exists, unsold.
    const lots = listOpenAuctionLots(localDb);
    expect(lots.length).toBeGreaterThan(0);
    expect(lots[0]?.clearedDay).toBeNull();
  });

  it("skips winners who can't afford and emits unsold", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const broke = insertActor(localDb, { code: "broke", displayName: "Broke", cash: 1 });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 50,
      closingUnitPrice: 50,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("broke"),
      seed: "broke",
      maxDays: 5,
    });
    registerPoolExpiry(world);
    const reasons: string[] = [];
    world.events.subscribe((e) => {
      if (e.type === "auction.unsold") reasons.push(e.reason);
    });
    registerDailyAuction(world, {
      // Total ceiling 6000 clears the £5000 reserve, but broke only has £1.
      findBiddersForLot: () => [{ actorId: broke.id, ceiling: 6000 }],
    });
    world.runToCompletion();
    expect(reasons).toContain("winner-cant-pay");
  });

  it("falls back to a poorer-but-affording bidder when the top bidder can't pay", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const flush = insertActor(localDb, { code: "flush", displayName: "Flush", cash: 10 });
    const rich = insertActor(localDb, { code: "rich", displayName: "Rich", cash: 10000 });
    const house = insertActor(localDb, { code: "house", displayName: "House" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 5,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("fallback"),
      seed: "fallback",
      maxDays: 5,
    });
    registerPoolExpiry(world);
    const cleared: number[] = [];
    world.events.subscribe((e) => {
      if (e.type === "auction.cleared") cleared.push(e.winnerActorId);
    });
    // Lot floor = closing £5/unit × 100 units = £500 reserve.
    // flush has the higher ceiling (£1000) but only £10 cash, so they win
    // the resolver and then fail the cash check. Rich has a lower ceiling
    // (£600) but the cash to back it. The fallback drops flush and clears
    // for rich at the £500 floor.
    registerDailyAuction(world, {
      proceedsActorId: house.id,
      findBiddersForLot: () => [
        { actorId: flush.id, ceiling: 1000 },
        { actorId: rich.id, ceiling: 600 },
      ],
    });
    world.runToCompletion();
    expect(cleared).toEqual([rich.id]);
  });

  it("writes off lots that stay open beyond maxDaysOpen", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 100,
      closingUnitPrice: 100, // unaffordable floor for nobody
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("writeoff"),
      seed: "writeoff",
      maxDays: 12,
    });
    registerPoolExpiry(world);
    const events: { type: string; auctionLotId?: number; daysOpen?: number }[] = [];
    world.events.subscribe((e) => {
      if (e.type === "auction.written_off")
        events.push({ type: e.type, auctionLotId: e.auctionLotId, daysOpen: e.daysOpen });
    });
    registerDailyAuction(world, {
      findBiddersForLot: () => [], // nobody wants it
      maxDaysOpen: 3,
    });
    world.runToCompletion();
    expect(events.length).toBe(1);
    expect(events[0]?.daysOpen).toBeGreaterThan(3);
  });

  it("decays the floor — lot that wouldn't sell on day 1 clears later", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const buyer = insertActor(localDb, { code: "buyer", displayName: "Buyer", cash: 10000 });
    const house = insertActor(localDb, { code: "house", displayName: "House" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    // Pool with high closing price → high reserve when flushed.
    insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 100,
      closingUnitPrice: 100,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("decay"),
      seed: "decay",
      maxDays: 8,
    });
    registerPoolExpiry(world);
    const cleared: { day: number; price: number }[] = [];
    world.events.subscribe((e) => {
      if (e.type === "auction.cleared")
        cleared.push({ day: e.at.day, price: e.totalPrice });
    });
    // Buyer's ceiling is below the original £1000 floor (100×10) but
    // above the day-3 decayed floor (1000 × 0.7^2 = 490).
    registerDailyAuction(world, {
      proceedsActorId: house.id,
      findBiddersForLot: () => [{ actorId: buyer.id, ceiling: 600 }],
      floorDecayPerDay: 0.7,
      maxDaysOpen: 5,
    });
    world.runToCompletion();
    expect(cleared.length).toBe(1);
    // Day-1 floor £1000 was above buyer's £600 ceiling; cleared after some decay.
    expect(cleared[0]!.price).toBeLessThanOrEqual(600);
  });
});

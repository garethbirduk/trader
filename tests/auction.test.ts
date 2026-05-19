import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  clearAuctionLot,
  getAuctionLotById,
  insertAuctionLot,
  listAuctionLotsListedOn,
  listOpenAuctionLots,
} from "../src/engine/auction/auction-repo.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { insertPool, getPoolById } from "../src/engine/pools/pools-repo.js";
import { registerPoolExpiry } from "../src/engine/world/pool-expiry.js";
import type { DB } from "../src/engine/core/db.js";

describe("auction lots repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves a lot", () => {
    db = freshDB();
    const vacuums = insertItemKind(db, {
      code: "v",
      displayName: "v",
      category: "x",
      baseValue: 1,
    });
    const lot = insertAuctionLot(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 50,
      listedDay: 3,
    });
    expect(lot.id).toBeGreaterThan(0);
    expect(getAuctionLotById(db, lot.id)).toEqual(lot);
  });

  it("clears a lot and tracks final price + buyer", () => {
    db = freshDB();
    const buyer = insertActor(db, { code: "b", firstName: "b", shortName: "b" });
    const vacuums = insertItemKind(db, {
      code: "v",
      displayName: "v",
      category: "x",
      baseValue: 1,
    });
    const lot = insertAuctionLot(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 50,
      listedDay: 3,
    });
    const cleared = clearAuctionLot(db, lot.id, {
      atDay: 4,
      toActorId: buyer.id,
      finalPrice: 80,
    });
    expect(cleared.clearedDay).toBe(4);
    expect(cleared.clearedPrice).toBe(80);
    expect(cleared.clearedToActorId).toBe(buyer.id);
    expect(() =>
      clearAuctionLot(db, lot.id, {
        atDay: 5,
        toActorId: buyer.id,
        finalPrice: 100,
      }),
    ).toThrow();
  });

  it("queries open lots and lots listed on a day", () => {
    db = freshDB();
    const vacuums = insertItemKind(db, {
      code: "v",
      displayName: "v",
      category: "x",
      baseValue: 1,
    });
    const a = insertAuctionLot(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 5,
      floorPrice: 25,
      listedDay: 1,
    });
    const b = insertAuctionLot(db, {
      itemKindId: vacuums.id,
      qualityTier: "fair",
      quantity: 5,
      floorPrice: 20,
      listedDay: 2,
    });
    const buyer = insertActor(db, { code: "buyer", firstName: "B", shortName: "B" });
    clearAuctionLot(db, a.id, { atDay: 2, toActorId: buyer.id, finalPrice: 30 });
    expect(listOpenAuctionLots(db).map((l) => l.id)).toEqual([b.id]);
    expect(listAuctionLotsListedOn(db, 1).map((l) => l.id)).toEqual([a.id]);
    expect(listAuctionLotsListedOn(db, 2).map((l) => l.id)).toEqual([b.id]);
  });
});

describe("pool expiry handler", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("flushes an expired pool's remaining stock to a new auction lot", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const denzil = insertActor(localDb, { code: "denzil", firstName: "Denzil", shortName: "Denzil" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 50,
      createdDay: 1,
      expiryDay: 2,
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("flush"),
      seed: "flush",
      maxDays: 5,
    });
    registerPoolExpiry(world);
    world.runToCompletion();

    const flushed = getPoolById(localDb, pool.id);
    expect(flushed?.flushedDay).toBeGreaterThanOrEqual(3);

    const lots = listOpenAuctionLots(localDb);
    expect(lots).toHaveLength(1);
    expect(lots[0]?.sourcePoolId).toBe(pool.id);
    expect(lots[0]?.quantity).toBe(50);
    // Reserve = closing per-unit (£5) × remaining quantity (50) = £250.
    expect(lots[0]?.floorPrice).toBe(250);
  });
});

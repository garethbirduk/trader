import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import {
  getActorById,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  getStockLotsByOwner,
  insertStockLot,
} from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { registerMarketStallAutonomy } from "../src/engine/world/market-stall-autonomy.js";
import { getStallForToday } from "../src/engine/market/stalls-repo.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("market-stall autonomy", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setupBasic() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const market = insertLocation(localDb, { code: "m", displayName: "Market" });
    const lockup = insertLocation(localDb, { code: "l", displayName: "Lockup" });
    const auctionHouse = insertActor(localDb, {
      code: "ah", displayName: "AH", cash: 0,
    });
    const item = insertItemKind(localDb, {
      code: "shirts", displayName: "Shirts", category: "clothing", baseValue: 30,
    });
    return { localDb, market, lockup, auctionHouse, item };
  }

  it("a cash-rich dealer registers a LEGIT stall on arrival", () => {
    const { localDb, market, lockup, auctionHouse, item } = setupBasic();
    const boyce = insertActor(localDb, {
      code: "boyce", displayName: "Boyce", cash: 5000, lockupLocationId: lockup.id,
    });
    setActorLocation(localDb, boyce.id, market.id);
    insertStockLot(localDb, {
      ownerActorId: boyce.id, itemKindId: item.id,
      qualityTier: "good", quantity: 10, acquiredUnitPrice: 10,
      acquiredDay: 1, locationId: market.id,
    });
    const slater = insertActor(localDb, {
      code: "slater", displayName: "Slater", cash: 0, bribable: true,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("legit"),
      seed: "legit",
      maxDays: 1, startDay: 1, startHour: 9,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerMarketStallAutonomy(world, {
      marketLocationId: market.id,
      marketOpenHours: [9, 10, 11, 12, 13, 14],
      sellerActorIds: new Set([boyce.id]),
      patrolOfficerActorId: slater.id,
      fineProceedsActorId: auctionHouse.id,
      patrolChancePerHour: 0, // no patrol — just registration
      adhocChanceWhenAffordable: 0, // pin to legit for the assertion
    });
    world.start();
    world.tickOnce();
    const stall = getStallForToday(localDb, boyce.id, market.id, 1);
    expect(stall).not.toBeNull();
    expect(stall!.mode).toBe("legit");
    expect(stall!.feePaid).toBe(20);
    expect(getActorById(localDb, boyce.id)!.cash).toBe(4980);
    expect(events.filter((e) => e.type === "market.stall-rented")).toHaveLength(1);
  });

  it("a cash-poor dealer registers an ADHOC stall — no fee", () => {
    const { localDb, market, lockup, auctionHouse, item } = setupBasic();
    const trigger = insertActor(localDb, {
      code: "trigger", displayName: "Trigger", cash: 30, lockupLocationId: lockup.id,
    });
    setActorLocation(localDb, trigger.id, market.id);
    insertStockLot(localDb, {
      ownerActorId: trigger.id, itemKindId: item.id,
      qualityTier: "fair", quantity: 5, acquiredUnitPrice: 8,
      acquiredDay: 1, locationId: market.id,
    });
    const slater = insertActor(localDb, {
      code: "slater", displayName: "Slater", cash: 0, bribable: true,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("adhoc"),
      seed: "adhoc",
      maxDays: 1, startDay: 1, startHour: 9,
    });
    registerMarketStallAutonomy(world, {
      marketLocationId: market.id,
      marketOpenHours: [9, 10, 11, 12, 13, 14],
      sellerActorIds: new Set([trigger.id]),
      patrolOfficerActorId: slater.id,
      fineProceedsActorId: auctionHouse.id,
      patrolChancePerHour: 0,
    });
    world.start();
    world.tickOnce();
    const stall = getStallForToday(localDb, trigger.id, market.id, 1);
    expect(stall).not.toBeNull();
    expect(stall!.mode).toBe("adhoc");
    expect(stall!.feePaid).toBe(0);
    // Cash unchanged.
    expect(getActorById(localDb, trigger.id)!.cash).toBe(30);
  });

  it("Slater patrol + bust: an adhoc seller who can't bribe loses stock and pays a fine", () => {
    const { localDb, market, lockup, auctionHouse, item } = setupBasic();
    const trigger = insertActor(localDb, {
      code: "trigger", displayName: "Trigger", cash: 30, lockupLocationId: lockup.id,
    });
    setActorLocation(localDb, trigger.id, market.id);
    insertStockLot(localDb, {
      ownerActorId: trigger.id, itemKindId: item.id,
      qualityTier: "fair", quantity: 5, acquiredUnitPrice: 8,
      acquiredDay: 1, locationId: market.id,
    });
    const slater = insertActor(localDb, {
      code: "slater", displayName: "Slater", cash: 0, bribable: true,
    });
    setActorLocation(localDb, slater.id, market.id);
    const world = new World({
      db: localDb,
      rng: createRNG("bust"),
      seed: "bust",
      maxDays: 1, startDay: 1, startHour: 9,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerMarketStallAutonomy(world, {
      marketLocationId: market.id,
      marketOpenHours: [9, 10, 11, 12, 13, 14],
      sellerActorIds: new Set([trigger.id]),
      patrolOfficerActorId: slater.id,
      fineProceedsActorId: auctionHouse.id,
      patrolChancePerHour: 1.0, // guaranteed patrol
      bribeWillingness: 0, // never try to bribe
      busFine: 50,
    });
    world.runToCompletion();

    const stall = getStallForToday(localDb, trigger.id, market.id, 1);
    expect(stall!.mode).toBe("busted");
    expect(stall!.unitsLost).toBe(5);
    expect(stall!.finePaid).toBe(30); // capped at trigger's cash
    expect(getActorById(localDb, trigger.id)!.cash).toBe(0);
    expect(getStockLotsByOwner(localDb, trigger.id)).toHaveLength(0);
    expect(events.filter((e) => e.type === "market.stall-busted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "market.patrol-arrived")).toHaveLength(1);
  });

  it("Slater patrol + bribe: an adhoc seller bribes Slater and avoids the bust", () => {
    const { localDb, market, lockup, auctionHouse, item } = setupBasic();
    // Cash 80 < legit threshold (£20 × 5 = £100) → registers adhoc.
    // Still enough for a £40 bribe.
    const del = insertActor(localDb, {
      code: "del", displayName: "Del", cash: 80, lockupLocationId: lockup.id,
    });
    setActorLocation(localDb, del.id, market.id);
    insertStockLot(localDb, {
      ownerActorId: del.id, itemKindId: item.id,
      qualityTier: "fair", quantity: 8, acquiredUnitPrice: 10,
      acquiredDay: 1, locationId: market.id,
    });
    const slater = insertActor(localDb, {
      code: "slater", displayName: "Slater", cash: 0, bribable: true,
    });
    setActorLocation(localDb, slater.id, market.id);
    const world = new World({
      db: localDb,
      rng: createRNG("bribe"),
      seed: "bribe",
      maxDays: 1, startDay: 1, startHour: 9,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerMarketStallAutonomy(world, {
      marketLocationId: market.id,
      marketOpenHours: [9, 10, 11, 12, 13, 14],
      sellerActorIds: new Set([del.id]),
      patrolOfficerActorId: slater.id,
      fineProceedsActorId: auctionHouse.id,
      patrolChancePerHour: 1.0,
      bribeWillingness: 1.0, // always try
      bribeFractionOfCash: 0.5, // big offer
      bribeBaseThreshold: 20,
    });
    world.runToCompletion();
    const stall = getStallForToday(localDb, del.id, market.id, 1);
    expect(stall!.mode).toBe("bribed");
    // Del's stock survives.
    expect(getStockLotsByOwner(localDb, del.id)).toHaveLength(1);
    // Slater pocketed the bribe.
    expect(getActorById(localDb, slater.id)!.cash).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "market.stall-bribed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "bribe.accepted")).toHaveLength(1);
  });

  it("an honest cop refuses every bribe — adhoc sellers still get busted", () => {
    const { localDb, market, lockup, auctionHouse, item } = setupBasic();
    // Cash 80 < legit threshold → adhoc.
    const del = insertActor(localDb, {
      code: "del", displayName: "Del", cash: 80, lockupLocationId: lockup.id,
    });
    setActorLocation(localDb, del.id, market.id);
    insertStockLot(localDb, {
      ownerActorId: del.id, itemKindId: item.id,
      qualityTier: "fair", quantity: 5, acquiredUnitPrice: 10,
      acquiredDay: 1, locationId: market.id,
    });
    const honestCop = insertActor(localDb, {
      code: "cop", displayName: "Honest Cop", cash: 0,
      // bribable defaults to false
    });
    setActorLocation(localDb, honestCop.id, market.id);
    const world = new World({
      db: localDb,
      rng: createRNG("honest"),
      seed: "honest",
      maxDays: 1, startDay: 1, startHour: 9,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerMarketStallAutonomy(world, {
      marketLocationId: market.id,
      marketOpenHours: [9, 10, 11, 12, 13, 14],
      sellerActorIds: new Set([del.id]),
      patrolOfficerActorId: honestCop.id,
      fineProceedsActorId: auctionHouse.id,
      patrolChancePerHour: 1.0,
      bribeWillingness: 1.0,
      bribeFractionOfCash: 0.5,
    });
    world.runToCompletion();
    expect(events.filter((e) => e.type === "bribe.refused")).toHaveLength(1);
    expect(events.filter((e) => e.type === "market.stall-busted")).toHaveLength(1);
    const stall = getStallForToday(localDb, del.id, market.id, 1);
    expect(stall!.mode).toBe("busted");
  });
});

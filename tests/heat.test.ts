import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import {
  insertActor,
  getActorById,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  insertStockLot,
  totalQuantityForOwnerAndKind,
} from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import { settleDeal } from "../src/engine/deals/settlement.js";
import {
  decayAllHeat,
  getHeat,
  raiseHeat,
} from "../src/engine/heat/heat-repo.js";
import { registerHeatReactions } from "../src/engine/world/heat-reactions.js";
import { registerHeatDecay } from "../src/engine/world/heat-decay.js";
import { registerAuthoritySweep } from "../src/engine/world/authority-sweep.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("heat repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("returns zero heat for actors with no record", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", displayName: "A" });
    expect(getHeat(localDb, a.id).score).toBe(0);
  });

  it("raises heat additively, clamped at zero", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", displayName: "A" });
    raiseHeat(localDb, a.id, 30, 1);
    expect(getHeat(localDb, a.id).score).toBe(30);
    raiseHeat(localDb, a.id, 50, 2);
    expect(getHeat(localDb, a.id).score).toBe(80);
    raiseHeat(localDb, a.id, -200, 3);
    expect(getHeat(localDb, a.id).score).toBe(0); // clamped
  });

  it("daily decay reduces every actor's score, clamped at zero", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", displayName: "A" });
    const b = insertActor(localDb, { code: "b", displayName: "B" });
    raiseHeat(localDb, a.id, 30, 1);
    raiseHeat(localDb, b.id, 3, 1);
    decayAllHeat(localDb, 5);
    expect(getHeat(localDb, a.id).score).toBe(25);
    expect(getHeat(localDb, b.id).score).toBe(0); // clamped
  });
});

describe("heat reactions on settlement", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("settling a deal of stolen goods raises both parties' heat", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, {
      code: "s", displayName: "S", cash: 0, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: 1000 });
    const stolenItem = insertItemKind(localDb, {
      code: "stolen-stuff",
      displayName: "Stolen stuff",
      category: "novelty",
      baseValue: 10,
      flawType: "stolen",
      risk: 4,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: stolenItem.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: stolenItem.id, qualityTier: "good", quantity: 10, unitPrice: 50 },
      ],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("heat"),
      seed: "heat",
      maxDays: 3,
    });
    registerHeatReactions(world);
    world.events.subscribe(() => {}); // ensure handlers fire even with subscribers
    world.start();

    settleDeal(localDb, deal.id, 2, {
      events: world.events,
      atClock: { day: 2, hour: 0 },
    });

    const sellerHeat = getHeat(localDb, seller.id).score;
    const buyerHeat = getHeat(localDb, buyer.id).score;
    // base = 0.5 × risk(4) × qty(10) = 20. Seller × 1.0 = 20, buyer × 0.5 = 10.
    expect(sellerHeat).toBe(20);
    expect(buyerHeat).toBe(10);
  });

  it("clean (non-stolen, non-dangerous) goods don't raise heat", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, {
      code: "s", displayName: "S", cash: 0, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: 1000 });
    const cleanItem = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: cleanItem.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: cleanItem.id, qualityTier: "good", quantity: 5, unitPrice: 50 },
      ],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("clean"),
      seed: "clean",
      maxDays: 3,
    });
    registerHeatReactions(world);
    world.start();

    settleDeal(localDb, deal.id, 2, {
      events: world.events,
      atClock: { day: 2, hour: 0 },
    });

    expect(getHeat(localDb, seller.id).score).toBe(0);
    expect(getHeat(localDb, buyer.id).score).toBe(0);
  });
});

describe("authority sweep", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("raids confiscate stolen stock and fine cash when heat is high", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const villain = insertActor(localDb, {
      code: "v", displayName: "V", cash: 1000,
    });
    const house = insertActor(localDb, { code: "h", displayName: "H" });
    const lockup = insertLocation(localDb, { code: "lockup", displayName: "Lockup" });
    setActorLocation(localDb, villain.id, lockup.id);
    const stolenItem = insertItemKind(localDb, {
      code: "stolen-radios",
      displayName: "Stolen radios",
      category: "electrical",
      baseValue: 10,
      flawType: "stolen",
      risk: 4,
    });
    const cleanItem = insertItemKind(localDb, {
      code: "tea",
      displayName: "Tea",
      category: "food",
      baseValue: 1,
    });
    insertStockLot(localDb, {
      ownerActorId: villain.id,
      itemKindId: stolenItem.id,
      qualityTier: "good",
      quantity: 50,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
      locationId: lockup.id,
    });
    insertStockLot(localDb, {
      ownerActorId: villain.id,
      itemKindId: cleanItem.id,
      qualityTier: "good",
      quantity: 100,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
      locationId: lockup.id,
    });
    raiseHeat(localDb, villain.id, 200, 1); // guaranteed raid

    const world = new World({
      db: localDb,
      rng: createRNG("raid"),
      seed: "raid",
      maxDays: 3,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerAuthoritySweep(world, {
      raidThreshold: 60,
      raidChanceScaler: 200,
      finePerUnit: 20,
      heatReductionAfterRaid: 50,
      fineProceedsActorId: house.id,
    });
    world.runToCompletion();

    const raidEvents = events.filter((e) => e.type === "authority.raid");
    expect(raidEvents.length).toBeGreaterThan(0);

    // Stolen stock confiscated; clean stock untouched.
    expect(totalQuantityForOwnerAndKind(localDb, villain.id, stolenItem.id)).toBe(0);
    expect(totalQuantityForOwnerAndKind(localDb, villain.id, cleanItem.id)).toBe(100);
    // Fine charged: 50 units × £20 = £1000. Villain had £1000, capped at cash.
    expect(getActorById(localDb, villain.id)?.cash).toBe(0);
    expect(getActorById(localDb, house.id)?.cash).toBe(1000);
    // Heat reduced after raid.
    expect(getHeat(localDb, villain.id).score).toBeLessThan(200);
  });

  it("doesn't raid actors below the threshold", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", displayName: "A", cash: 1000 });
    const stolenItem = insertItemKind(localDb, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 1,
      flawType: "stolen",
      risk: 1,
    });
    insertStockLot(localDb, {
      ownerActorId: a.id,
      itemKindId: stolenItem.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    raiseHeat(localDb, a.id, 30, 1); // below default threshold of 60

    const world = new World({
      db: localDb,
      rng: createRNG("nope"),
      seed: "nope",
      maxDays: 5,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerAuthoritySweep(world);
    world.runToCompletion();

    expect(events.filter((e) => e.type === "authority.raid")).toEqual([]);
    expect(totalQuantityForOwnerAndKind(localDb, a.id, stolenItem.id)).toBe(10);
  });
});

describe("heat decay over a multi-day run", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("an actor's heat drops to zero after enough quiet days", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", displayName: "A" });
    raiseHeat(localDb, a.id, 30, 1);
    const world = new World({
      db: localDb,
      rng: createRNG("decay"),
      seed: "decay",
      maxDays: 12,
    });
    registerHeatDecay(world, { perDay: 5 });
    world.runToCompletion();
    expect(getHeat(localDb, a.id).score).toBe(0);
  });
});

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
import { getStockLotsByOwner } from "../src/engine/stock/lots-repo.js";
import { insertLocation } from "../src/engine/locations/locations.js";
import { registerClearanceAutonomy } from "../src/engine/world/clearance-autonomy.js";
import {
  bookClearance,
  getOpenListings,
} from "../src/engine/clearance/clearance-repo.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("clearance autonomy", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("morning spawn drops listings into the world", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    insertItemKind(localDb, {
      code: "lamps", displayName: "Lamps", category: "furniture",
      baseValue: 28, spawnWeight: 10,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("spawn"),
      seed: "spawn",
      maxDays: 1,
      startDay: 1,
      startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, { listingsPerDay: 2 });
    world.start();

    const listed = events.filter((e) => e.type === "clearance.listed");
    expect(listed.length).toBe(2);
    expect(getOpenListings(localDb)).toHaveLength(2);
  });

  it("a booked listing resolves when its hour arrives in the run loop", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    const lockup = insertLocation(localDb, { code: "lockup", displayName: "Lockup" });
    const booker = insertActor(localDb, {
      code: "del", displayName: "Del", cash: 2000,
      lockupLocationId: lockup.id,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("auto-book"),
      seed: "auto-book",
      maxDays: 1,
      startDay: 1,
      startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, {
      listingsPerDay: 1,
      lotsPerListingRange: [2, 2],
      unitsPerLotRange: [1, 1],
    });
    world.start();

    // After day-start the listing exists. Have Del book it for hour 12.
    const listings = getOpenListings(localDb);
    expect(listings).toHaveLength(1);
    bookClearance(localDb, {
      listingId: listings[0]!.id,
      bookerActorId: booker.id,
      bookedDay: 1, bookedHour: 8, scheduledHour: 12,
    });

    // Tick through the day. Listing should resolve at hour 12.
    world.runToCompletion();

    const resolved = events.filter((e) => e.type === "clearance.resolved");
    expect(resolved.length).toBe(1);
    if (resolved[0]!.type !== "clearance.resolved") throw new Error();
    expect(resolved[0]!.winnerActorId).toBe(booker.id);

    // Booker now owns the haul + paid the fee.
    const lots = getStockLotsByOwner(localDb, booker.id);
    expect(lots.length).toBe(2);
    expect(getActorById(localDb, booker.id)!.cash).toBe(1500);
  });

  it("unbooked listings sit open through the day and don't resolve", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("noone"),
      seed: "noone",
      maxDays: 1,
      startDay: 1,
      startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, { listingsPerDay: 1 });
    world.runToCompletion();
    // Listing was published; no bookings → no resolution events.
    expect(events.filter((e) => e.type === "clearance.listed").length).toBe(1);
    expect(events.filter((e) => e.type === "clearance.resolved").length).toBe(0);
  });

  it("doesn't spawn on Sundays by default", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    // Day 7 = Sunday by the engine's "day 1 is Monday" convention.
    const world = new World({
      db: localDb,
      rng: createRNG("sun"),
      seed: "sun",
      maxDays: 1,
      startDay: 7,
      startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, { listingsPerDay: 1 });
    world.start();
    expect(events.filter((e) => e.type === "clearance.listed").length).toBe(0);
  });
});

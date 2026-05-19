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
      code: "del", firstName: "Del", shortName: "Del", cash: 2000,
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

  it("newspaper knowledge: actors at the newspaper venue learn about today's listings", async () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    const sids = insertLocation(localDb, { code: "sids", displayName: "Sid's" });
    const reader = insertActor(localDb, {
      code: "reader", firstName: "Reader", shortName: "Reader", cash: 0,
    });
    const { setActorLocation } = await import("../src/engine/locations/locations.js");
    setActorLocation(localDb, reader.id, sids.id);

    const world = new World({
      db: localDb,
      rng: createRNG("paper"),
      seed: "paper",
      maxDays: 1,
      startDay: 1,
      startHour: 6,
    });
    registerClearanceAutonomy(world, {
      listingsPerDay: 1,
      newspaperLocationIds: [sids.id],
      paperFromHour: 7,
    });
    world.start();
    world.tickOnce(); // hour 6 fires, advances to 7
    world.tickOnce(); // hour 7 fires (paper visible, Reader at Sid's)
    world.tickOnce(); // advance past so handler has run

    const { getKnownClearanceIdsForActor } = await import(
      "../src/engine/clearance/knowledge-repo.js"
    );
    const known = getKnownClearanceIdsForActor(localDb, reader.id);
    expect(known).toHaveLength(1);
  });

  it("NPC booking autonomy: dealer at the pub books a listing they know about, plants witness leads", async () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    const sids = insertLocation(localDb, { code: "sids", displayName: "Sid's" });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const lockup = insertLocation(localDb, { code: "lockup", displayName: "Lockup" });
    const del = insertActor(localDb, {
      code: "del", firstName: "Del", shortName: "Del", cash: 2000, lockupLocationId: lockup.id,
    });
    const trigger = insertActor(localDb, {
      code: "trigger", firstName: "Trigger", shortName: "Trigger", cash: 0,
    });
    const { setActorLocation } = await import("../src/engine/locations/locations.js");
    // Del at Sid's during paper hour. Trigger at Nag's the whole time.
    setActorLocation(localDb, del.id, sids.id);
    setActorLocation(localDb, trigger.id, nags.id);

    const world = new World({
      db: localDb,
      rng: createRNG("book-via-pub"),
      seed: "book-via-pub",
      maxDays: 1, startDay: 1, startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, {
      listingsPerDay: 1,
      newspaperLocationIds: [sids.id],
      paperFromHour: 7,
      phoneCapableLocationIds: [nags.id],
      bookerActorIds: new Set([del.id]),
      bookChancePerHour: 1.0,
      bookStartHour: 8,
      bookEndHour: 17,
    });
    world.start();
    world.tickOnce(); // hour 6 fires, → 7
    world.tickOnce(); // hour 7 fires: Del at Sid's, paper visible, learns. → 8
    // Now move Del to the Nag's for the booking handler.
    setActorLocation(localDb, del.id, nags.id);
    world.tickOnce(); // hour 8 fires: Del at Nag's, eligible, books. → 9
    // Drive through the rest of the day so resolution / events finalise.
    world.runToCompletion();

    const booked = events.filter((e) => e.type === "clearance.booked");
    expect(booked.length).toBeGreaterThan(0);
    // Trigger overheard the call → has an overheard knowledge row.
    const { getKnownClearancesForActor } = await import(
      "../src/engine/clearance/knowledge-repo.js"
    );
    const triggerKnown = getKnownClearancesForActor(localDb, trigger.id);
    expect(triggerKnown.length).toBeGreaterThan(0);
    expect(triggerKnown[0]!.learnedVia).toBe("overheard");
    // And Trigger has a witness lead.
    const { getLeadsByHolder } = await import(
      "../src/engine/leads/leads-repo.js"
    );
    const triggerLeads = getLeadsByHolder(localDb, trigger.id);
    const witnessLead = triggerLeads.find(
      (l) => l.subjectEventType === "clearance-booking",
    );
    expect(witnessLead).toBeDefined();
  });

  it("end-of-day: unbooked listings expire", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "tables", displayName: "Tables", category: "furniture",
      baseValue: 40, spawnWeight: 10,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("expire"),
      seed: "expire",
      maxDays: 1, startDay: 1, startHour: 6,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerClearanceAutonomy(world, { listingsPerDay: 1 });
    world.runToCompletion();
    const expired = events.filter((e) => e.type === "clearance.expired");
    expect(expired.length).toBe(1);
    // No clearance.resolved fired.
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

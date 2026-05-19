import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import { DiaryAlertRegistry } from "../src/engine/world/diary-alerts.js";
import { registerSlaterAlerts } from "../src/engine/world/slater-alerts.js";
import { PatrolPicker } from "../src/engine/world/patrol-picker.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("Slater alerts", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a pubdeal of stolen-flagged stock plants an alert and emits slater.alert", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const del = insertActor(localDb, { code: "del", firstName: "Del", shortName: "Del", cash: 100 });
    const boyce = insertActor(localDb, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 5000 });
    const slater = insertActor(localDb, { code: "slater", firstName: "Slater", shortName: "Slater", cash: 0 });
    // A stolen-flagged item kind.
    const radios = insertItemKind(localDb, {
      code: "stolen-radios", displayName: "Radios", category: "electronics",
      baseValue: 40, flawType: "stolen",
    });
    insertStockLot(localDb, {
      ownerActorId: del.id, itemKindId: radios.id,
      qualityTier: "good", quantity: 5, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    // Create the agreed deal directly — the test focuses on the
    // alert-emission path, not the negotiation.
    const deal = createAgreedDeal(localDb, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1, deadlineDay: 2,
      deliveryLocationId: nags.id,
      lines: [{
        itemKindId: radios.id, qualityTier: "good",
        quantity: 5, unitPrice: 10,
      }],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("alert"),
      seed: "alert",
      maxDays: 1, startDay: 1, startHour: 18,
    });
    const registry = new DiaryAlertRegistry();
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerSlaterAlerts(world, {
      slaterActorId: slater.id,
      registry,
      windowHours: 2,
      responseLagHours: 1,
    });

    // Manually emit the agreed event — equivalent to attemptPubDeal
    // doing so, sans the entire negotiation pipeline.
    world.events.emit({
      type: "pubdeal.agreed",
      at: { day: 1, hour: 18 },
      locationId: nags.id,
      dealId: deal.id,
      sellerActorId: del.id,
      buyerActorId: boyce.id,
      unitPrice: 10,
      quantity: 5,
      turns: [],
    });

    // Slater alert event fired and registry holds the alert for the
    // window (with the response-lag pushing the start to hour 19).
    const slaterAlerts = events.filter((e) => e.type === "slater.alert");
    expect(slaterAlerts).toHaveLength(1);
    if (slaterAlerts[0]!.type !== "slater.alert") throw new Error();
    expect(slaterAlerts[0]!.destinationLocationId).toBe(nags.id);
    expect(slaterAlerts[0]!.reason).toBe("stolen-goods-tip");

    expect(registry.getAlertAt(slater.id, { day: 1, hour: 18 })).toBeNull();
    expect(
      registry.getAlertAt(slater.id, { day: 1, hour: 19 })?.destinationLocationId,
    ).toBe(nags.id);
    expect(
      registry.getAlertAt(slater.id, { day: 1, hour: 20 })?.destinationLocationId,
    ).toBe(nags.id);
    expect(registry.getAlertAt(slater.id, { day: 1, hour: 21 })).toBeNull();
  });

  it("a pubdeal of clean stock does NOT alert Slater", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const del = insertActor(localDb, { code: "del", firstName: "Del", shortName: "Del", cash: 100 });
    const boyce = insertActor(localDb, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 5000 });
    const slater = insertActor(localDb, { code: "slater", firstName: "Slater", shortName: "Slater", cash: 0 });
    const widgets = insertItemKind(localDb, {
      code: "widgets", displayName: "Widgets", category: "tools",
      baseValue: 30,
      // no flawType — clean stock
    });
    insertStockLot(localDb, {
      ownerActorId: del.id, itemKindId: widgets.id,
      qualityTier: "good", quantity: 5, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    const deal = createAgreedDeal(localDb, {
      buyerActorId: boyce.id, sellerActorId: del.id,
      agreedDay: 1, deadlineDay: 2, deliveryLocationId: nags.id,
      lines: [{
        itemKindId: widgets.id, qualityTier: "good", quantity: 5, unitPrice: 10,
      }],
    });
    const world = new World({
      db: localDb, rng: createRNG("clean"), seed: "clean",
      maxDays: 1, startDay: 1, startHour: 18,
    });
    const registry = new DiaryAlertRegistry();
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerSlaterAlerts(world, {
      slaterActorId: slater.id, registry,
    });
    world.events.emit({
      type: "pubdeal.agreed",
      at: { day: 1, hour: 18 },
      locationId: nags.id,
      dealId: deal.id,
      sellerActorId: del.id, buyerActorId: boyce.id,
      unitPrice: 10, quantity: 5, turns: [],
    });
    expect(events.filter((e) => e.type === "slater.alert")).toHaveLength(0);
    expect(registry.snapshot()).toHaveLength(0);
  });
});

describe("PatrolPicker", () => {
  it("returns null until any officer is registered", () => {
    const p = new PatrolPicker();
    expect(p.pickFor(1, { day: 1, hour: 10 }, createRNG("a"))).toBeNull();
  });

  it("returns null for actors that haven't been registered", () => {
    const p = new PatrolPicker();
    p.register({
      actorId: 1,
      candidates: [{ locationId: 100, weight: 1 }],
      activeHours: new Set([10]),
    });
    expect(p.pickFor(2, { day: 1, hour: 10 }, createRNG("a"))).toBeNull();
    expect(p.pickFor(1, { day: 1, hour: 10 }, createRNG("a"))).toBe(100);
  });

  it("returns null outside the active-hours window", () => {
    const p = new PatrolPicker();
    p.register({
      actorId: 1,
      candidates: [{ locationId: 100, weight: 1 }],
      activeHours: new Set([10, 11, 12]),
    });
    expect(p.pickFor(1, { day: 1, hour: 9 }, createRNG("a"))).toBeNull();
    expect(p.pickFor(1, { day: 1, hour: 11 }, createRNG("a"))).toBe(100);
    expect(p.pickFor(1, { day: 1, hour: 13 }, createRNG("a"))).toBeNull();
  });

  it("weighted pick honours the relative weights across many rolls", () => {
    const p = new PatrolPicker();
    p.register({
      actorId: 1,
      candidates: [
        { locationId: 100, weight: 9 },
        { locationId: 200, weight: 1 },
      ],
      activeHours: new Set([10]),
    });
    const rng = createRNG("weighted");
    let count100 = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = p.pickFor(1, { day: 1, hour: 10 }, rng);
      if (id === 100) count100 += 1;
    }
    // Should be around 900; allow generous margin.
    expect(count100).toBeGreaterThan(800);
    expect(count100).toBeLessThan(950);
  });

  it("routes multiple registered officers to their own beats and windows", () => {
    const p = new PatrolPicker();
    p.register({
      actorId: 1,
      candidates: [{ locationId: 100, weight: 1 }],
      activeHours: new Set([8, 9, 10]),
    });
    p.register({
      actorId: 2,
      candidates: [{ locationId: 200, weight: 1 }],
      activeHours: new Set([12, 13, 14]),
    });
    const rng = createRNG("multi");
    // Officer 1 active 8-10, silent 12-14; officer 2 the opposite.
    expect(p.pickFor(1, { day: 1, hour: 9 }, rng)).toBe(100);
    expect(p.pickFor(1, { day: 1, hour: 13 }, rng)).toBeNull();
    expect(p.pickFor(2, { day: 1, hour: 9 }, rng)).toBeNull();
    expect(p.pickFor(2, { day: 1, hour: 13 }, rng)).toBe(200);
    // Unregistered actor still returns null.
    expect(p.pickFor(3, { day: 1, hour: 9 }, rng)).toBeNull();
  });

  it("re-registering the same actor replaces the previous config", () => {
    const p = new PatrolPicker();
    p.register({
      actorId: 1,
      candidates: [{ locationId: 100, weight: 1 }],
      activeHours: new Set([10]),
    });
    p.register({
      actorId: 1,
      candidates: [{ locationId: 999, weight: 1 }],
      activeHours: new Set([10]),
    });
    expect(p.pickFor(1, { day: 1, hour: 10 }, createRNG("r"))).toBe(999);
  });
});

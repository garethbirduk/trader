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
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import {
  claimFromPool,
  insertPool,
  isReachableBy,
  PoolUnreachableError,
} from "../src/engine/pools/pools-repo.js";
import { insertLead } from "../src/engine/leads/leads-repo.js";
import { registerBrokerMaterialisation } from "../src/engine/world/broker-materialisation.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("broker materialisation (Stage 6b)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const broker = insertActor(localDb, {
      code: "broker",
      firstName: "Broker", shortName: "Broker",
      cash: 1000,
    });
    const visitor = insertActor(localDb, {
      code: "visitor",
      firstName: "Visitor", shortName: "Visitor",
      cash: 10000,
    });
    const bob = insertActor(localDb, {
      code: "bob",
      firstName: "Trader Bob", shortName: "Trader Bob",
      isVirtual: true,
    });
    const proceeds = insertActor(localDb, {
      code: "proceeds",
      firstName: "Proceeds", shortName: "Proceeds",
      cash: 0,
    });
    setActorLocation(localDb, broker.id, nags.id);
    setActorLocation(localDb, visitor.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 7,
      closingUnitPrice: 4,
      ownerActorId: bob.id,
      reachableBy: [broker.id],
    });
    return { localDb, nags, broker, visitor, bob, proceeds, item, pool };
  }

  it("materialises the producer at the venue and lets co-located actors claim", () => {
    const { localDb, nags, broker, visitor, bob, proceeds, pool } = setup();

    // Before materialisation: visitor cannot claim from Bob's pool.
    expect(isReachableBy(localDb, pool.id, visitor.id)).toBe(false);
    expect(() =>
      claimFromPool(localDb, {
        poolId: pool.id,
        actorId: visitor.id,
        quantity: 5,
        atDay: 2,
      }),
    ).toThrow(PoolUnreachableError);

    const world = new World({
      db: localDb,
      rng: createRNG("materialise-yes"),
      seed: "materialise-yes",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerBrokerMaterialisation(world, {
      venueLocationIds: [nags.id],
      producersByBroker: new Map([[broker.id, [bob.id]]]),
      attemptChancePerHour: 1.0,
      fee: 25,
      feeProceedsActorId: proceeds.id,
    });

    // Tick once: hour 19 fires the attempt.
    world.start(); world.tickOnce();

    const materialised = events.find((e) => e.type === "broker.materialised");
    expect(materialised).toBeDefined();
    if (materialised && materialised.type === "broker.materialised") {
      expect(materialised.brokerActorId).toBe(broker.id);
      expect(materialised.producerActorId).toBe(bob.id);
      expect(materialised.locationId).toBe(nags.id);
    }

    // Producer is now at the venue; visitor can claim.
    expect(getActorById(localDb, bob.id)!.currentLocationId).toBe(nags.id);
    expect(isReachableBy(localDb, pool.id, visitor.id)).toBe(true);
    const claim = claimFromPool(localDb, {
      poolId: pool.id,
      actorId: visitor.id,
      quantity: 3,
      atDay: 2,
    });
    expect(claim.unitPriceCharged).toBeGreaterThan(0);

    // Fee moved.
    expect(getActorById(localDb, broker.id)!.cash).toBe(975);
    expect(getActorById(localDb, proceeds.id)!.cash).toBe(25);

    // Teardown: the next hour, producer's location clears.
    world.tickOnce();
    expect(getActorById(localDb, bob.id)!.currentLocationId).toBeNull();
  });

  it("aborts when someone present holds warm rep about the producer", () => {
    const { localDb, nags, broker, visitor, bob, proceeds, pool } = setup();
    void pool; // pool exists so producer has live stock to bring

    // Visitor holds a warm rep lead: "Bob burned me for £500."
    insertLead(localDb, {
      holderActorId: visitor.id,
      kind: "rep",
      side: "supply",
      subjectItemKindId: null,
      subjectTargetActorId: bob.id,
      counterpartyActorId: visitor.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 500,
      acquiredDay: 1,
      confidence: "warm",
    });

    const world = new World({
      db: localDb,
      rng: createRNG("materialise-abort"),
      seed: "materialise-abort",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerBrokerMaterialisation(world, {
      venueLocationIds: [nags.id],
      producersByBroker: new Map([[broker.id, [bob.id]]]),
      attemptChancePerHour: 1.0,
      fee: 25,
      feeProceedsActorId: proceeds.id,
    });
    world.start(); world.tickOnce();

    const aborted = events.find(
      (e) => e.type === "broker.materialisation-aborted",
    );
    expect(aborted).toBeDefined();
    if (aborted && aborted.type === "broker.materialisation-aborted") {
      expect(aborted.blockerActorId).toBe(visitor.id);
      expect(aborted.direction).toBe("blocker-knows-producer");
    }

    // No materialisation, no fee.
    expect(events.find((e) => e.type === "broker.materialised")).toBeUndefined();
    expect(getActorById(localDb, broker.id)!.cash).toBe(1000);
    expect(getActorById(localDb, bob.id)!.currentLocationId).toBeNull();
  });

  it("aborts when the producer holds warm rep about someone present", () => {
    const { localDb, nags, broker, visitor, bob, proceeds, pool } = setup();
    void pool;

    // Bob holds a warm rep lead about the visitor.
    insertLead(localDb, {
      holderActorId: bob.id,
      kind: "rep",
      side: "supply",
      subjectItemKindId: null,
      subjectTargetActorId: visitor.id,
      counterpartyActorId: bob.id,
      estimatedQuantity: 1,
      estimatedUnitPrice: 500,
      acquiredDay: 1,
      confidence: "warm",
    });

    const world = new World({
      db: localDb,
      rng: createRNG("producer-knows"),
      seed: "producer-knows",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerBrokerMaterialisation(world, {
      venueLocationIds: [nags.id],
      producersByBroker: new Map([[broker.id, [bob.id]]]),
      attemptChancePerHour: 1.0,
      fee: 25,
      feeProceedsActorId: proceeds.id,
    });
    world.start(); world.tickOnce();

    const aborted = events.find(
      (e) => e.type === "broker.materialisation-aborted",
    );
    expect(aborted).toBeDefined();
    if (aborted && aborted.type === "broker.materialisation-aborted") {
      expect(aborted.blockerActorId).toBe(visitor.id);
      expect(aborted.direction).toBe("producer-knows-blocker");
    }
  });

  it("doesn't fire when the producer has no live owned stock", () => {
    const { localDb, nags, broker, bob, proceeds } = setup();

    // Wipe the seed pool so the producer has nothing to bring.
    localDb.prepare(`DELETE FROM pool_reachability`).run();
    localDb.prepare(`DELETE FROM world_pools`).run();

    const world = new World({
      db: localDb,
      rng: createRNG("no-stock"),
      seed: "no-stock",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerBrokerMaterialisation(world, {
      venueLocationIds: [nags.id],
      producersByBroker: new Map([[broker.id, [bob.id]]]),
      attemptChancePerHour: 1.0,
      fee: 25,
      feeProceedsActorId: proceeds.id,
    });
    world.start(); world.tickOnce();

    expect(events.find((e) => e.type === "broker.materialised")).toBeUndefined();
    expect(events.find((e) => e.type === "broker.materialisation-aborted")).toBeUndefined();
  });

  it("doesn't fire when the broker can't afford the fee", () => {
    const { localDb, nags, broker, bob, proceeds } = setup();
    localDb.prepare(`UPDATE actors SET cash = 5 WHERE id = @id`).run({
      id: broker.id,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("skint"),
      seed: "skint",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerBrokerMaterialisation(world, {
      venueLocationIds: [nags.id],
      producersByBroker: new Map([[broker.id, [bob.id]]]),
      attemptChancePerHour: 1.0,
      fee: 25,
      feeProceedsActorId: proceeds.id,
    });
    world.start(); world.tickOnce();

    expect(events.find((e) => e.type === "broker.materialised")).toBeUndefined();
  });
});

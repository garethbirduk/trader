import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import {
  insertActor,
  getActorById,
  listLiveActors,
  listVirtualActors,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertLocation } from "../src/engine/locations/locations.js";
import { insertPool, claimFromPool, getPoolById, PoolUnreachableError } from "../src/engine/pools/pools-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("virtual actors + pool ownership (Stage 6)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("seeds an actor as virtual, defaults to non-virtual otherwise", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const live = insertActor(localDb, { code: "a", firstName: "Live A", shortName: "Live A", cash: 100 });
    const virtual = insertActor(localDb, {
      code: "bob",
      firstName: "Trader Bob", shortName: "Trader Bob",
      cash: 0,
      transportCapacity: "none",
      isVirtual: true,
    });
    expect(live.isVirtual).toBe(false);
    expect(virtual.isVirtual).toBe(true);

    // Round-trips correctly.
    expect(getActorById(localDb, live.id)!.isVirtual).toBe(false);
    expect(getActorById(localDb, virtual.id)!.isVirtual).toBe(true);

    // List helpers partition cleanly.
    const liveOnly = listLiveActors(localDb).map((a) => a.code);
    const virtualOnly = listVirtualActors(localDb).map((a) => a.code);
    expect(liveOnly).toEqual(["a"]);
    expect(virtualOnly).toEqual(["bob"]);
  });

  it("pool ownership + provenance round-trip through the repo", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const bob = insertActor(localDb, {
      code: "bob",
      firstName: "Trader Bob", shortName: "Trader Bob",
      isVirtual: true,
    });
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 7,
      closingUnitPrice: 4,
      ownerActorId: bob.id,
      provenance: "off a lorry on the A2",
    });
    expect(pool.ownerActorId).toBe(bob.id);
    expect(pool.provenance).toBe("off a lorry on the A2");
    expect(getPoolById(localDb, pool.id)!.ownerActorId).toBe(bob.id);
    expect(getPoolById(localDb, pool.id)!.provenance).toBe("off a lorry on the A2");
  });

  it("non-broker actor cannot claim from a producer-owned pool", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const bob = insertActor(localDb, {
      code: "bob",
      firstName: "Trader Bob", shortName: "Trader Bob",
      isVirtual: true,
    });
    const broker = insertActor(localDb, {
      code: "broker",
      firstName: "Broker", shortName: "Broker",
      cash: 10000,
    });
    const outsider = insertActor(localDb, {
      code: "outsider",
      firstName: "Outsider", shortName: "Outsider",
      cash: 10000,
    });
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });

    // Pool reachable only by `broker`. `outsider` has no relationship.
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

    // Broker can claim.
    const ok = claimFromPool(localDb, {
      poolId: pool.id,
      actorId: broker.id,
      quantity: 5,
      atDay: 1,
    });
    expect(ok.unitPriceCharged).toBeGreaterThan(0);

    // Outsider cannot.
    expect(() =>
      claimFromPool(localDb, {
        poolId: pool.id,
        actorId: outsider.id,
        quantity: 5,
        atDay: 1,
      }),
    ).toThrow(PoolUnreachableError);
  });

  it("ambient pools keep null owner + null provenance", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 20,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 5,
      closingUnitPrice: 3,
    });
    expect(pool.ownerActorId).toBeNull();
    expect(pool.provenance).toBeNull();
  });

  it("placeholder skin seeds the named virtual producer cast", async () => {
    // Re-uses the placeholder skin's setupWorld smoke. Asserts the new
    // shape ships out via the skin's `virtualProducers` array and that
    // each named producer was inserted as a virtual actor.
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const { createRNG } = await import("../src/engine/core/rng.js");
    const rng = createRNG("stage-6-smoke");
    const { seedPlaceholderSkin } = await import(
      "../src/skins/placeholder/index.js"
    );
    const skin = seedPlaceholderSkin(localDb, rng, {});
    expect(skin.virtualProducers.length).toBeGreaterThan(0);
    for (const p of skin.virtualProducers) {
      const a = getActorById(localDb, p.actorId);
      expect(a).not.toBeNull();
      expect(a!.isVirtual).toBe(true);
      expect(p.brokerActorIds.length).toBeGreaterThan(0);
      expect(p.categories.length).toBeGreaterThan(0);
    }
    // Every covered category should map to at least one producer.
    for (const [cat, list] of skin.virtualProducersByCategory) {
      expect(list.length).toBeGreaterThan(0);
      // And each listed producer must actually cover the category.
      for (const p of list) expect(p.categories).toContain(cat);
    }
  });
});

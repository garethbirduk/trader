import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import {
  PoolEmptyError,
  PoolExpiredError,
  PoolNotYetAvailableError,
  PoolUnreachableError,
  claimFromPool,
  getPoolById,
  insertPool,
  isReachableBy,
  listActivePools,
  listPoolsExpiredBefore,
  listReachableActiveByActor,
  markPoolFlushed,
} from "../src/engine/pools/pools-repo.js";
import { poolUnitPriceOnDay } from "../src/engine/pools/types.js";
import type { DB } from "../src/engine/core/db.js";

function setup(db: DB) {
  const del = insertActor(db, { code: "del", displayName: "Del" });
  const denzil = insertActor(db, { code: "denzil", displayName: "Denzil" });
  const monkey = insertActor(db, { code: "monkey", displayName: "Monkey" });
  const vacuums = insertItemKind(db, {
    code: "vacuums",
    displayName: "Vacuum cleaners",
    category: "electrical",
    baseValue: 30,
  });
  return { del, denzil, monkey, vacuums };
}

describe("pools repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts a pool with reachability set", () => {
    db = freshDB();
    const { denzil, monkey, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id, monkey.id],
    });
    expect(pool.quantityRemaining).toBe(100);
    expect(pool.dumpDestination).toBe("auction");
    expect(isReachableBy(db, pool.id, denzil.id)).toBe(true);
    expect(isReachableBy(db, pool.id, monkey.id)).toBe(true);
  });

  it("price interpolates linearly across the window", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 11,
      openingUnitPrice: 20,
      closingUnitPrice: 0,
      reachableBy: [denzil.id],
    });
    expect(poolUnitPriceOnDay(pool, 1)).toBe(20);
    expect(poolUnitPriceOnDay(pool, 6)).toBe(10);
    expect(poolUnitPriceOnDay(pool, 11)).toBe(0);
  });

  it("listActivePools and listPoolsExpiredBefore partition correctly", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const active = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 10,
      openingUnitPrice: 10,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });
    const expired = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "fair",
      quantity: 5,
      createdDay: 1,
      expiryDay: 3,
      openingUnitPrice: 10,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });
    expect(listActivePools(db, 5).map((p) => p.id)).toEqual([active.id]);
    expect(listPoolsExpiredBefore(db, 5).map((p) => p.id)).toEqual([expired.id]);
  });

  it("claimFromPool decrements pool and creates a stock lot at interpolated price", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 11,
      openingUnitPrice: 20,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    const result = claimFromPool(db, {
      poolId: pool.id,
      actorId: denzil.id,
      quantity: 30,
      atDay: 6,
    });
    expect(result.unitPriceCharged).toBe(15); // halfway between 20 and 10
    expect(result.remainingInPool).toBe(70);
    expect(getPoolById(db, pool.id)?.quantityRemaining).toBe(70);
    expect(totalQuantityForOwnerAndKind(db, denzil.id, vacuums.id)).toBe(30);
  });

  it("rejects claim when actor lacks reach", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 11,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    expect(() =>
      claimFromPool(db, {
        poolId: pool.id,
        actorId: del.id,
        quantity: 10,
        atDay: 2,
      }),
    ).toThrow(PoolUnreachableError);
  });

  it("rejects claim past expiry day", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 3,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    expect(() =>
      claimFromPool(db, {
        poolId: pool.id,
        actorId: denzil.id,
        quantity: 10,
        atDay: 5,
      }),
    ).toThrow(PoolExpiredError);
  });

  it("rejects claim when not enough stock", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 5,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    expect(() =>
      claimFromPool(db, {
        poolId: pool.id,
        actorId: denzil.id,
        quantity: 10,
        atDay: 2,
      }),
    ).toThrow(PoolEmptyError);
  });

  it("FIFO race: first claim wins remaining stock", () => {
    db = freshDB();
    const { denzil, monkey, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id, monkey.id],
    });
    claimFromPool(db, {
      poolId: pool.id,
      actorId: denzil.id,
      quantity: 80,
      atDay: 2,
    });
    expect(() =>
      claimFromPool(db, {
        poolId: pool.id,
        actorId: monkey.id,
        quantity: 30,
        atDay: 2,
      }),
    ).toThrow(PoolEmptyError);
    // But Monkey can take what's left.
    const r = claimFromPool(db, {
      poolId: pool.id,
      actorId: monkey.id,
      quantity: 20,
      atDay: 2,
    });
    expect(r.remainingInPool).toBe(0);
  });

  it("listReachableActiveByActor scopes to the actor's reach", () => {
    db = freshDB();
    const { del, denzil, vacuums } = setup(db);
    const reach = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "fair",
      quantity: 10,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [del.id],
    });
    expect(listReachableActiveByActor(db, denzil.id, 2).map((p) => p.id)).toEqual([
      reach.id,
    ]);
  });

  it("hides pools that haven't reached their createdDay yet", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const future = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 50,
      createdDay: 8,
      expiryDay: 12,
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });
    const present = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "fair",
      quantity: 50,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });
    // On day 2, only the present pool is visible.
    expect(listActivePools(db, 2).map((p) => p.id)).toEqual([present.id]);
    expect(listReachableActiveByActor(db, denzil.id, 2).map((p) => p.id)).toEqual([
      present.id,
    ]);
    // On day 8, both are visible (future has just become present).
    expect(listActivePools(db, 8).map((p) => p.id).sort()).toEqual(
      [future.id].sort(), // present has expired (expiryDay=5)
    );
  });

  it("rejects claims before the pool's createdDay", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 50,
      createdDay: 8,
      expiryDay: 12,
      openingUnitPrice: 15,
      closingUnitPrice: 5,
      reachableBy: [denzil.id],
    });
    expect(() =>
      claimFromPool(db, {
        poolId: pool.id,
        actorId: denzil.id,
        quantity: 10,
        atDay: 3,
      }),
    ).toThrow(PoolNotYetAvailableError);
  });

  it("markPoolFlushed sets flushed_day and rejects double-flush", () => {
    db = freshDB();
    const { denzil, vacuums } = setup(db);
    const pool = insertPool(db, {
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 10,
      createdDay: 1,
      expiryDay: 3,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    markPoolFlushed(db, pool.id, 4);
    expect(getPoolById(db, pool.id)?.flushedDay).toBe(4);
    expect(() => markPoolFlushed(db, pool.id, 5)).toThrow();
  });
});

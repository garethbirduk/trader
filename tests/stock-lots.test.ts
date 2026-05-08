import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  decrementLotQuantity,
  deleteStockLot,
  getStockLotById,
  getStockLotsByOwner,
  getStockLotsByOwnerAndKind,
  insertStockLot,
  totalQuantityForOwnerAndKind,
} from "../src/engine/stock/lots-repo.js";
import type { DB } from "../src/engine/core/db.js";

function seedBasics(db: DB) {
  const del = insertActor(db, { code: "del", displayName: "Del" });
  const boyce = insertActor(db, { code: "boyce", displayName: "Boyce" });
  const tables = insertItemKind(db, {
    code: "tables",
    displayName: "Tables",
    category: "furniture",
    baseValue: 20,
  });
  const vacuums = insertItemKind(db, {
    code: "vacuums",
    displayName: "Vacuum cleaners",
    category: "electrical",
    baseValue: 30,
  });
  return { del, boyce, tables, vacuums };
}

describe("stock_lots repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves a lot", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 100,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    expect(lot.id).toBeGreaterThan(0);
    expect(getStockLotById(db, lot.id)).toEqual(lot);
  });

  it("rejects non-positive quantity at the schema level", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    expect(() =>
      insertStockLot(db, {
        ownerActorId: del.id,
        itemKindId: tables.id,
        qualityTier: "good",
        quantity: 0,
        acquiredUnitPrice: 20,
        acquiredDay: 1,
      }),
    ).toThrow();
  });

  it("rejects unknown quality tier at the schema level", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    expect(() =>
      insertStockLot(db, {
        ownerActorId: del.id,
        itemKindId: tables.id,
        // @ts-expect-error — exercising the runtime check
        qualityTier: "bogus",
        quantity: 10,
        acquiredUnitPrice: 20,
        acquiredDay: 1,
      }),
    ).toThrow();
  });

  it("decrements partial quantity in place", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    const after = decrementLotQuantity(db, lot.id, 3);
    expect(after?.quantity).toBe(7);
    expect(getStockLotById(db, lot.id)?.quantity).toBe(7);
  });

  it("deletes the lot when decremented to zero", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    const after = decrementLotQuantity(db, lot.id, 5);
    expect(after).toBeNull();
    expect(getStockLotById(db, lot.id)).toBeNull();
  });

  it("rejects decrementing below zero", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    expect(() => decrementLotQuantity(db, lot.id, 6)).toThrow();
    expect(() => decrementLotQuantity(db, lot.id, 0)).toThrow();
  });

  it("queries by owner and by owner+kind", () => {
    db = freshDB();
    const { del, boyce, tables, vacuums } = seedBasics(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "broken",
      quantity: 90,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: vacuums.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 25,
      acquiredDay: 1,
    });
    insertStockLot(db, {
      ownerActorId: boyce.id,
      itemKindId: tables.id,
      qualityTier: "mint",
      quantity: 1,
      acquiredUnitPrice: 50,
      acquiredDay: 2,
    });

    expect(getStockLotsByOwner(db, del.id)).toHaveLength(3);
    expect(getStockLotsByOwnerAndKind(db, del.id, tables.id)).toHaveLength(2);
    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(100);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(1);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, vacuums.id)).toBe(0);
  });

  it("deletes a lot directly", () => {
    db = freshDB();
    const { del, tables } = seedBasics(db);
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    deleteStockLot(db, lot.id);
    expect(getStockLotById(db, lot.id)).toBeNull();
  });
});

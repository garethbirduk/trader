import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  getStockLotById,
  getStockLotsByOwner,
  insertStockLot,
  totalQuantityForOwnerAndKind,
} from "../src/engine/stock/lots-repo.js";
import {
  splitStockLot,
  transferStockUnits,
} from "../src/engine/stock/stock-operations.js";
import type { DB } from "../src/engine/core/db.js";

function setup(db: DB) {
  const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
  const boyce = insertActor(db, { code: "boyce", firstName: "Boyce", shortName: "Boyce" });
  const tables = insertItemKind(db, {
    code: "tables",
    displayName: "Tables",
    category: "furniture",
    baseValue: 20,
  });
  const lot = insertStockLot(db, {
    ownerActorId: del.id,
    itemKindId: tables.id,
    qualityTier: "good",
    quantity: 100,
    acquiredUnitPrice: 20,
    acquiredDay: 1,
  });
  return { del, boyce, tables, lot };
}

describe("splitStockLot", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("splits a lot, decrementing source and creating a spinoff", () => {
    db = freshDB();
    const { del, lot } = setup(db);
    const result = splitStockLot(db, lot.id, 30);
    expect(result.source?.quantity).toBe(70);
    expect(result.spinoff.quantity).toBe(30);
    expect(result.spinoff.id).not.toBe(lot.id);
    expect(result.spinoff.ownerActorId).toBe(del.id);
    expect(result.spinoff.acquiredUnitPrice).toBe(20);
    expect(result.spinoff.qualityTier).toBe("good");
    expect(getStockLotsByOwner(db, del.id)).toHaveLength(2);
  });

  it("removes the source when fully split", () => {
    db = freshDB();
    const { del, lot } = setup(db);
    const result = splitStockLot(db, lot.id, 100);
    expect(result.source).toBeNull();
    expect(result.spinoff.quantity).toBe(100);
    expect(getStockLotById(db, lot.id)).toBeNull();
    expect(getStockLotsByOwner(db, del.id)).toHaveLength(1);
  });

  it("rejects over-split and zero-split", () => {
    db = freshDB();
    const { lot } = setup(db);
    expect(() => splitStockLot(db, lot.id, 101)).toThrow();
    expect(() => splitStockLot(db, lot.id, 0)).toThrow();
    expect(() => splitStockLot(db, lot.id, -1)).toThrow();
  });

  it("rolls back if the split fails partway", () => {
    db = freshDB();
    const { lot } = setup(db);
    expect(() => splitStockLot(db, 9999, 1)).toThrow();
    // Original lot untouched.
    expect(getStockLotById(db, lot.id)?.quantity).toBe(100);
  });
});

describe("transferStockUnits", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("transfers a partial lot — source decremented, recipient gets a fresh lot", () => {
    db = freshDB();
    const { del, boyce, tables, lot } = setup(db);
    const result = transferStockUnits(db, {
      fromLotId: lot.id,
      toActorId: boyce.id,
      quantity: 30,
      newUnitPrice: 35,
      transferDay: 2,
    });
    expect(result.remaining?.quantity).toBe(70);
    expect(result.received.ownerActorId).toBe(boyce.id);
    expect(result.received.quantity).toBe(30);
    expect(result.received.acquiredUnitPrice).toBe(35);
    expect(result.received.acquiredDay).toBe(2);
    expect(result.received.qualityTier).toBe("good");
    expect(result.received.itemKindId).toBe(tables.id);

    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(70);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(30);
  });

  it("transfers the whole lot — source removed, recipient gets a fresh lot", () => {
    db = freshDB();
    const { del, boyce, tables, lot } = setup(db);
    const result = transferStockUnits(db, {
      fromLotId: lot.id,
      toActorId: boyce.id,
      quantity: 100,
      newUnitPrice: 35,
      transferDay: 2,
    });
    expect(result.remaining).toBeNull();
    expect(result.received.quantity).toBe(100);
    expect(getStockLotById(db, lot.id)).toBeNull();
    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(0);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(100);
  });

  it("preserves total quantity across a transfer (conservation invariant)", () => {
    db = freshDB();
    const { del, boyce, tables, lot } = setup(db);
    const totalBefore =
      totalQuantityForOwnerAndKind(db, del.id, tables.id) +
      totalQuantityForOwnerAndKind(db, boyce.id, tables.id);
    transferStockUnits(db, {
      fromLotId: lot.id,
      toActorId: boyce.id,
      quantity: 42,
      newUnitPrice: 30,
      transferDay: 2,
    });
    const totalAfter =
      totalQuantityForOwnerAndKind(db, del.id, tables.id) +
      totalQuantityForOwnerAndKind(db, boyce.id, tables.id);
    expect(totalAfter).toBe(totalBefore);
  });

  it("rejects transferring more than the lot holds", () => {
    db = freshDB();
    const { boyce, lot } = setup(db);
    expect(() =>
      transferStockUnits(db, {
        fromLotId: lot.id,
        toActorId: boyce.id,
        quantity: 200,
        newUnitPrice: 30,
        transferDay: 2,
      }),
    ).toThrow();
  });

  it("rejects same-actor transfers", () => {
    db = freshDB();
    const { del, lot } = setup(db);
    expect(() =>
      transferStockUnits(db, {
        fromLotId: lot.id,
        toActorId: del.id,
        quantity: 10,
        newUnitPrice: 30,
        transferDay: 2,
      }),
    ).toThrow();
  });

  it("rolls back if the transfer fails partway", () => {
    db = freshDB();
    const { del, boyce, tables, lot } = setup(db);
    expect(() =>
      transferStockUnits(db, {
        fromLotId: lot.id,
        toActorId: boyce.id,
        quantity: 10,
        newUnitPrice: -5,
        transferDay: 2,
      }),
    ).toThrow();
    // Source untouched, no recipient lot created.
    expect(getStockLotById(db, lot.id)?.quantity).toBe(100);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(0);
    // Sanity on Del's side.
    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(100);
  });
});

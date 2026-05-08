import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot, totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import { getActorById } from "../src/engine/actors/actors-repo.js";
import {
  createAgreedDeal,
  getAgreedDealsDueBy,
  getDealById,
  getDealLinesByDealId,
  getDealsByBuyer,
  getDealsBySeller,
  getDealsByState,
} from "../src/engine/deals/deals-repo.js";
import {
  cancelDeal,
  DealStateError,
  InsufficientCashError,
  markDealDefaulted,
  settleDeal,
  ShortStockError,
} from "../src/engine/deals/settlement.js";
import type { DB } from "../src/engine/core/db.js";

function setup(db: DB) {
  // Sellers default to 'truck' so quantity-focused tests aren't accidentally
  // gated by the pocket-cap. Transport behaviour is exercised in transport.test.ts.
  const del = insertActor(db, { code: "del", displayName: "Del", cash: 0, transportCapacity: "truck" });
  const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 1000 });
  const denzil = insertActor(db, { code: "denzil", displayName: "Denzil", cash: 0, transportCapacity: "truck" });
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
  return { del, boyce, denzil, tables, vacuums };
}

describe("deals repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates an agreed deal with multiple lines", () => {
    db = freshDB();
    const { del, boyce, tables, vacuums } = setup(db);
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [
        { itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 },
        { itemKindId: vacuums.id, qualityTier: "fair", quantity: 5, unitPrice: 25 },
      ],
    });
    expect(deal.state).toBe("agreed");
    const lines = getDealLinesByDealId(db, deal.id);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.unitPrice)).toEqual([30, 25]);
  });

  it("rejects buyer === seller", () => {
    db = freshDB();
    const { del, tables } = setup(db);
    expect(() =>
      createAgreedDeal(db, {
        buyerActorId: del.id,
        sellerActorId: del.id,
        agreedDay: 1,
        deadlineDay: 2,
        lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 1, unitPrice: 1 }],
      }),
    ).toThrow();
  });

  it("rejects deadline before agreed day", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    expect(() =>
      createAgreedDeal(db, {
        buyerActorId: boyce.id,
        sellerActorId: del.id,
        agreedDay: 5,
        deadlineDay: 3,
        lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 1, unitPrice: 1 }],
      }),
    ).toThrow();
  });

  it("rejects empty lines", () => {
    db = freshDB();
    const { del, boyce } = setup(db);
    expect(() =>
      createAgreedDeal(db, {
        buyerActorId: boyce.id,
        sellerActorId: del.id,
        agreedDay: 1,
        deadlineDay: 2,
        lines: [],
      }),
    ).toThrow();
  });

  it("queries by buyer, seller, state, and deadline", () => {
    db = freshDB();
    const { del, boyce, denzil, tables } = setup(db);
    const dealA = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    const dealB = createAgreedDeal(db, {
      buyerActorId: del.id,
      sellerActorId: denzil.id,
      agreedDay: 1,
      deadlineDay: 5,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 20 }],
    });

    expect(getDealsByBuyer(db, boyce.id).map((d) => d.id)).toEqual([dealA.id]);
    expect(getDealsBySeller(db, del.id).map((d) => d.id)).toEqual([dealA.id]);
    expect(getDealsByState(db, "agreed").map((d) => d.id)).toEqual([dealA.id, dealB.id]);
    expect(getAgreedDealsDueBy(db, 3).map((d) => d.id)).toEqual([dealA.id]);
    expect(getAgreedDealsDueBy(db, 10).map((d) => d.id)).toEqual([dealA.id, dealB.id]);
  });
});

describe("settlement", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("settles a clean deal: stock + cash transfer, state→settled", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });

    const result = settleDeal(db, deal.id, 3);
    expect(result.totalPrice).toBe(300);
    expect(result.deal.state).toBe("settled");
    expect(result.deal.settledDay).toBe(3);

    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(0);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(10);
    expect(getActorById(db, boyce.id)?.cash).toBe(700);
    expect(getActorById(db, del.id)?.cash).toBe(300);
  });

  it("settles across multiple lots (FIFO)", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 4,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 8,
      acquiredUnitPrice: 12,
      acquiredDay: 2,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 2,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    settleDeal(db, deal.id, 3);
    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(2);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(10);
  });

  it("throws ShortStockError when seller doesn't have enough — and rolls back", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    expect(() => settleDeal(db, deal.id, 3)).toThrow(ShortStockError);
    // Deal still agreed; no stock or cash moved.
    expect(getDealById(db, deal.id)?.state).toBe("agreed");
    expect(totalQuantityForOwnerAndKind(db, del.id, tables.id)).toBe(5);
    expect(totalQuantityForOwnerAndKind(db, boyce.id, tables.id)).toBe(0);
    expect(getActorById(db, boyce.id)?.cash).toBe(1000);
  });

  it("treats wrong-quality stock as a shortfall (tier-aware)", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    // Del has 100 broken tables but the deal asks for good ones.
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "broken",
      quantity: 100,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    expect(() => settleDeal(db, deal.id, 3)).toThrow(ShortStockError);
  });

  it("throws InsufficientCashError when buyer can't pay", () => {
    db = freshDB();
    const { del, denzil, tables } = setup(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    // Denzil is broke; he agrees to buy from Del anyway.
    const deal = createAgreedDeal(db, {
      buyerActorId: denzil.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    expect(() => settleDeal(db, deal.id, 3)).toThrow(InsufficientCashError);
  });

  it("rejects double settlement (state guard)", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 20,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });
    settleDeal(db, deal.id, 3);
    expect(() => settleDeal(db, deal.id, 3)).toThrow(DealStateError);
  });

  it("default and cancel transition correctly", () => {
    db = freshDB();
    const { del, boyce, tables } = setup(db);
    const dealA = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 1, unitPrice: 1 }],
    });
    const defaulted = markDealDefaulted(db, dealA.id, 3, "no stock");
    expect(defaulted.state).toBe("defaulted");
    expect(defaulted.defaultReason).toBe("no stock");
    expect(defaulted.defaultedDay).toBe(3);
    expect(() => markDealDefaulted(db, dealA.id, 4, "again")).toThrow(DealStateError);

    const dealB = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 1, unitPrice: 1 }],
    });
    const cancelled = cancelDeal(db, dealB.id);
    expect(cancelled.state).toBe("cancelled");
    expect(() => cancelDeal(db, dealB.id)).toThrow(DealStateError);
  });
});

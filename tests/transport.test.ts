import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getActorByCode,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import { TRANSPORT_LIMITS } from "../src/engine/actors/types.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import {
  NoTransportError,
  settleDeal,
} from "../src/engine/deals/settlement.js";
import { seedPlaceholderSkin } from "../src/skins/placeholder/index.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";

describe("transport tiers", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("limit table is monotonically increasing", () => {
    expect(TRANSPORT_LIMITS.none).toBe(0);
    expect(TRANSPORT_LIMITS.pocket).toBeGreaterThan(TRANSPORT_LIMITS.none);
    expect(TRANSPORT_LIMITS.boot).toBeGreaterThan(TRANSPORT_LIMITS.pocket);
    expect(TRANSPORT_LIMITS.van).toBeGreaterThan(TRANSPORT_LIMITS.boot);
    expect(TRANSPORT_LIMITS.truck).toBeGreaterThan(TRANSPORT_LIMITS.van);
  });

  it("inserts an actor with explicit transport capacity", () => {
    db = freshDB();
    const denzil = insertActor(db, {
      code: "denzil",
      displayName: "Denzil",
      transportCapacity: "truck",
    });
    expect(denzil.transportCapacity).toBe("truck");
  });

  it("defaults transport capacity to 'pocket' when not specified", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    expect(a.transportCapacity).toBe("pocket");
  });
});

describe("settleDeal — transport check", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("settles when seller's transport capacity is sufficient", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "boyce",
      displayName: "Boyce",
      cash: 0,
      transportCapacity: "boot", // 30 unit cap
    });
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 1000 });
    const item = insertItemKind(db, {
      code: "chains",
      displayName: "Gold chains",
      category: "novelty",
      baseValue: 50,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 25,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 25, unitPrice: 30 },
      ],
    });
    const r = settleDeal(db, deal.id, 2);
    expect(r.deal.state).toBe("settled");
  });

  it("throws NoTransportError when seller's tier can't move the deal", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "boyce",
      displayName: "Boyce",
      cash: 0,
      transportCapacity: "pocket", // 5 unit cap
    });
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 5000 });
    const item = insertItemKind(db, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 50, unitPrice: 30 },
      ],
    });
    expect(() => settleDeal(db, deal.id, 2)).toThrow(NoTransportError);
  });

  it("an actor with transport=none can never deliver anything", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "mike",
      displayName: "Mike",
      cash: 0,
      transportCapacity: "none",
    });
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 100 });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 1,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 1, unitPrice: 1 },
      ],
    });
    expect(() => settleDeal(db, deal.id, 2)).toThrow(NoTransportError);
  });

  it("multi-line deals sum across lines for the transport check", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "monkey",
      displayName: "Monkey",
      cash: 0,
      transportCapacity: "boot", // 30 cap
    });
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 1000 });
    const itemA = insertItemKind(db, {
      code: "a",
      displayName: "a",
      category: "x",
      baseValue: 1,
    });
    const itemB = insertItemKind(db, {
      code: "b",
      displayName: "b",
      category: "x",
      baseValue: 1,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: itemA.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: itemB.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    // 20 + 15 = 35 > boot's 30 cap.
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: itemA.id, qualityTier: "good", quantity: 20, unitPrice: 1 },
        { itemKindId: itemB.id, qualityTier: "good", quantity: 15, unitPrice: 1 },
      ],
    });
    expect(() => settleDeal(db, deal.id, 2)).toThrow(NoTransportError);
  });
});

describe("placeholder skin transport assignments", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("assigns each named character a sensible tier", () => {
    db = freshDB();
    seedPlaceholderSkin(db, createRNG("transport"));
    expect(getActorByCode(db, "boyce")?.transportCapacity).toBe("boot");
    expect(getActorByCode(db, "denzil")?.transportCapacity).toBe("truck");
    expect(getActorByCode(db, "monkey-harris")?.transportCapacity).toBe("van");
    expect(getActorByCode(db, "trigger")?.transportCapacity).toBe("pocket");
    expect(getActorByCode(db, "mike")?.transportCapacity).toBe("none");
    expect(getActorByCode(db, "player")?.transportCapacity).toBe("pocket");
  });
});

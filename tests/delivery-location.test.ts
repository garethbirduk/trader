import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  insertStockLot,
  totalQuantityForOwnerAndKind,
} from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import {
  DELIVERY_FEE_BY_TIER,
  settleDeal,
} from "../src/engine/deals/settlement.js";
import { claimFromPool, insertPool } from "../src/engine/pools/pools-repo.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("Phase 2 — physical stock location", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("stock claimed from a pool lands at the claimer's current location", () => {
    db = freshDB();
    const denzil = insertActor(db, { code: "denzil", firstName: "Denzil", shortName: "Denzil" });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    setActorLocation(db, denzil.id, lockup.id);
    const item = insertItemKind(db, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(db, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [denzil.id],
    });
    claimFromPool(db, {
      poolId: pool.id,
      actorId: denzil.id,
      quantity: 10,
      atDay: 2,
    });
    const lots = db
      .prepare<{ location_id: number | null }>(
        `SELECT location_id FROM stock_lots WHERE owner_actor_id = @id`,
      )
      .all({ id: denzil.id });
    expect(lots).toHaveLength(1);
    expect(lots[0]?.location_id).toBe(lockup.id);
  });

  it("settlement charges no fee when seller's stock is already at the delivery location", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 0,
      transportCapacity: "boot",
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 1000 });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    setActorLocation(db, seller.id, nags.id);
    setActorLocation(db, buyer.id, nags.id);
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
      locationId: nags.id, // seller has them on him
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      deliveryLocationId: nags.id,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 25, unitPrice: 30 },
      ],
    });
    const events: WorldEvent[] = [];
    settleDeal(db, deal.id, 2, {
      events: { emit: (e) => events.push(e), subscribe: () => () => {} },
    });
    // No fee event fired — seller's stock was already there.
    expect(events.find((e) => e.type === "delivery.fee")).toBeUndefined();
    // Seller pocketed the full revenue.
    expect(getActorById(db, seller.id)?.cash).toBe(750);
  });

  it("settlement charges a tier-based fee when stock is at a different location", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "denzil",
      firstName: "Denzil", shortName: "Denzil",
      cash: 100,
      transportCapacity: "truck",
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 5000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    const house = insertActor(db, { code: "house", firstName: "House", shortName: "House" });
    const item = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuums",
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
      locationId: lockup.id, // stock is at the lock-up
    });
    // Deadline 3 days out — gives the truck tier (2-day transit) enough
    // lead time to fall back to remote stock with a fee.
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 3,
      deliveryLocationId: nags.id, // delivery is at the pub
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 100, unitPrice: 20 },
      ],
    });
    const events: WorldEvent[] = [];
    settleDeal(db, deal.id, 3, {
      procurementProceedsActorId: house.id,
      events: { emit: (e) => events.push(e), subscribe: () => () => {} },
    });

    const feeEvent = events.find((e) => e.type === "delivery.fee");
    expect(feeEvent).toBeDefined();
    if (feeEvent && feeEvent.type === "delivery.fee") {
      expect(feeEvent.fee).toBe(DELIVERY_FEE_BY_TIER.truck);
    }
    // Seller paid £50 (truck fee), received £2000, started with £100.
    expect(getActorById(db, seller.id)?.cash).toBe(100 - 50 + 2000);
    expect(getActorById(db, house.id)?.cash).toBe(50);
    expect(totalQuantityForOwnerAndKind(db, buyer.id, item.id)).toBe(100);
  });

  it("seller who can't afford the fee skips remote stock and may default", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "denzil",
      firstName: "Denzil", shortName: "Denzil",
      cash: 10, // can't afford a £50 truck fee
      transportCapacity: "truck",
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 5000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
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
      locationId: lockup.id,
    });
    // Deadline 3 days out so the time-gate isn't what trips this test —
    // the cash shortage is.
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 3,
      deliveryLocationId: nags.id,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 50, unitPrice: 30 },
      ],
    });
    expect(() => settleDeal(db, deal.id, 3)).toThrow(/short/i);
    // No money moved.
    expect(getActorById(db, seller.id)?.cash).toBe(10);
    expect(getActorById(db, buyer.id)?.cash).toBe(5000);
  });

  it("delivery fees scale with transport tier", () => {
    expect(DELIVERY_FEE_BY_TIER.none).toBe(0);
    expect(DELIVERY_FEE_BY_TIER.pocket).toBe(0);
    expect(DELIVERY_FEE_BY_TIER.boot).toBeGreaterThan(DELIVERY_FEE_BY_TIER.pocket);
    expect(DELIVERY_FEE_BY_TIER.van).toBeGreaterThan(DELIVERY_FEE_BY_TIER.boot);
    expect(DELIVERY_FEE_BY_TIER.truck).toBeGreaterThan(DELIVERY_FEE_BY_TIER.van);
  });

  it("transit-time gate: a truck-tier seller can't fall back to remote stock if the deal is too soon", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "denzil",
      firstName: "Denzil", shortName: "Denzil",
      cash: 1000,
      transportCapacity: "truck", // transit = 2 days
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 5000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
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
      locationId: lockup.id, // not at delivery location
    });
    // Deal: agreedDay 1, deadline 2 (only 1 day, not enough for 2-day truck transit)
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      deliveryLocationId: nags.id,
      lines: [{ itemKindId: item.id, qualityTier: "good", quantity: 50, unitPrice: 30 }],
    });
    // Settlement at day 2: 2 - 1 = 1 day elapsed, but truck transit needs 2.
    // No way to source from the lockup in time → ShortStockError.
    expect(() => settleDeal(db, deal.id, 2)).toThrow(/short/i);
  });

  it("transit-time gate: same scenario clears when the deadline allows enough days", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "denzil",
      firstName: "Denzil", shortName: "Denzil",
      cash: 1000,
      transportCapacity: "truck",
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 5000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
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
      locationId: lockup.id,
    });
    // Deadline 3 days out: gives the truck enough time.
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 3,
      deliveryLocationId: nags.id,
      lines: [{ itemKindId: item.id, qualityTier: "good", quantity: 50, unitPrice: 30 }],
    });
    const r = settleDeal(db, deal.id, 3);
    expect(r.deal.state).toBe("settled");
  });

  it("transit-time gate doesn't apply to pocket/boot tiers (transit=0)", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 1000,
      transportCapacity: "boot", // transit = 0 days
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 1000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 10,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 25,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
      locationId: lockup.id,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 1, // same-day delivery, fine for boot tier
      deliveryLocationId: nags.id,
      lines: [{ itemKindId: item.id, qualityTier: "good", quantity: 25, unitPrice: 5 }],
    });
    const r = settleDeal(db, deal.id, 1);
    expect(r.deal.state).toBe("settled");
  });

  it("buyer's received lot is stamped at the delivery location", () => {
    db = freshDB();
    const seller = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 100,
      transportCapacity: "boot",
    });
    const buyer = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 1000 });
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 10,
    });
    insertStockLot(db, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
      locationId: lockup.id, // somewhere else
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      deliveryLocationId: nags.id,
      lines: [{ itemKindId: item.id, qualityTier: "good", quantity: 5, unitPrice: 5 }],
    });
    settleDeal(db, deal.id, 2);
    // Buyer's lot lives at the delivery location, not the source location.
    const buyerLots = db
      .prepare<{ location_id: number | null }>(
        `SELECT location_id FROM stock_lots WHERE owner_actor_id = @id`,
      )
      .all({ id: buyer.id });
    expect(buyerLots).toHaveLength(1);
    expect(buyerLots[0]?.location_id).toBe(nags.id);
  });
});

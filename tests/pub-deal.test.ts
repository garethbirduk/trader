import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { attemptPubDeal } from "../src/engine/mechanics/pub-deal/attempt.js";
import {
  bufferHandler,
  createEventLog,
} from "../src/engine/core/events.js";
import { createRNG } from "../src/engine/core/rng.js";
import {
  getDealById,
  getDealLinesByDealId,
} from "../src/engine/deals/deals-repo.js";
import type { DB } from "../src/engine/core/db.js";

function setup(db: DB) {
  const del = insertActor(db, { code: "del", displayName: "Del", cash: 0 });
  const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 1000 });
  const nags = insertLocation(db, { code: "nags", displayName: "Nag's Head" });
  const tables = insertItemKind(db, {
    code: "tables",
    displayName: "Tables",
    category: "furniture",
    baseValue: 20,
  });
  setActorLocation(db, del.id, nags.id);
  setActorLocation(db, boyce.id, nags.id);
  return { del, boyce, nags, tables };
}

describe("attemptPubDeal", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates an agreed deal when ranges overlap", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const events = createEventLog();
    const buf = bufferHandler();
    events.subscribe(buf.handler);

    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 1, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 20, target: 40, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 25, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      initiator: "seller",
      deadlineDay: 3,
    });

    expect(result.type).toBe("agreed");
    if (result.type !== "agreed") return;
    const deal = getDealById(db, result.dealId);
    expect(deal?.state).toBe("agreed");
    expect(deal?.deliveryLocationId).toBe(nags.id);
    expect(deal?.deadlineDay).toBe(3);
    const lines = getDealLinesByDealId(db, result.dealId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.unitPrice).toBe(result.unitPrice);
    expect(buf.events.map((e) => e.type)).toContain("pubdeal.agreed");
  });

  it("walks (no deal) when ranges don't overlap", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const events = createEventLog();
    const buf = bufferHandler();
    events.subscribe(buf.handler);

    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 1, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 100, target: 120, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 30, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      initiator: "seller",
      deadlineDay: 3,
    });

    expect(result.type).toBe("walked");
    expect(buf.events.map((e) => e.type)).toContain("pubdeal.walked");
    expect(buf.events.find((e) => e.type === "pubdeal.agreed")).toBeUndefined();
  });

  it("blocks if either actor isn't at the location", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const lockup = insertLocation(db, { code: "lockup", displayName: "Lockup" });
    setActorLocation(db, del.id, lockup.id);
    const events = createEventLog();

    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 1, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 20, target: 40, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 25, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      initiator: "seller",
      deadlineDay: 3,
    });

    expect(result.type).toBe("blocked");
  });

  it("blocks past-dated deadlines", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const events = createEventLog();
    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 5, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 20, target: 40, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 25, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      initiator: "seller",
      deadlineDay: 3,
    });
    expect(result.type).toBe("blocked");
  });

  it("forward-sale: deal created without seller having stock", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const events = createEventLog();
    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 1, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 20, target: 40, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 30, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 200, // way more than Del has (he has none)
      initiator: "seller",
      deadlineDay: 5,
    });
    expect(result.type).toBe("agreed");
    // No stock movement at this stage.
    expect(getActorById(db, del.id)?.cash).toBe(0);
    expect(getActorById(db, boyce.id)?.cash).toBe(1000);
  });

  it("end-to-end with later settlement when stock is sourced", () => {
    db = freshDB();
    const { del, boyce, nags, tables } = setup(db);
    const events = createEventLog();
    // Del has the stock right now.
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 15,
      acquiredDay: 1,
    });
    const result = attemptPubDeal({
      db,
      events,
      rng: createRNG("a"),
      clock: { day: 1, hour: 18 },
      locationId: nags.id,
      seller: { actorId: del.id, floor: 20, target: 40, concedeRate: 0.3 },
      buyer: { actorId: boyce.id, ceiling: 50, target: 25, concedeRate: 0.3 },
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      initiator: "seller",
      deadlineDay: 2,
    });
    expect(result.type).toBe("agreed");
    if (result.type !== "agreed") return;
    // Deal exists, settlement will happen via the daily handler — covered elsewhere.
    expect(getDealById(db, result.dealId)?.state).toBe("agreed");
  });
});

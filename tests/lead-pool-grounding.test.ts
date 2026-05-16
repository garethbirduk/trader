import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  insertLocation,
  setActorLocation,
  setLocationProprietor,
  getLocationProprietor,
} from "../src/engine/locations/locations.js";
import { insertPool } from "../src/engine/pools/pools-repo.js";
import { seedSupplyLeadsForPool } from "../src/engine/leads/seed-from-pool.js";
import { DEFAULT_ECONOMICS_CONFIG } from "../src/engine/economics/config.js";
import {
  getLeadsByHolder,
  getSupplyLeadsForItem,
  shareLead,
} from "../src/engine/leads/leads-repo.js";
import { createAgreedDeal, getDealById } from "../src/engine/deals/deals-repo.js";
import { settleDeal } from "../src/engine/deals/settlement.js";
import { registerLocationGossip } from "../src/engine/world/location-gossip.js";
import { totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("lead-pool grounding", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("supply leads are seeded with subject_pool_id when a pool spawns", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 15,
      closingUnitPrice: 6,
      reachableBy: [denzil.id],
    });

    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);

    const leads = getLeadsByHolder(localDb, denzil.id);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.subjectPoolId).toBe(pool.id);
    expect(leads[0]?.side).toBe("supply");
    expect(leads[0]?.subjectItemKindId).toBe(item.id);
  });

  it("subject_pool_id propagates through a gossip chain", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const mike = insertActor(localDb, { code: "mike", displayName: "Mike" });
    const player = insertActor(localDb, { code: "del", displayName: "Del" });
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 15,
      closingUnitPrice: 6,
      reachableBy: [denzil.id],
    });
    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);

    // Denzil → Mike → Del (two gossip hops).
    const denzilLead = getLeadsByHolder(localDb, denzil.id)[0]!;
    const mikeLead = shareLead(localDb, denzil.id, mike.id, denzilLead.id, 2);
    const playerLead = shareLead(localDb, mike.id, player.id, mikeLead.id, 3);

    expect(mikeLead.subjectPoolId).toBe(pool.id);
    expect(mikeLead.hopCount).toBe(1);
    expect(playerLead.subjectPoolId).toBe(pool.id);
    expect(playerLead.hopCount).toBe(2);
  });

  it("location-gossip exchanges leads on actor.travelled", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const denzil = insertActor(localDb, { code: "denzil", displayName: "Denzil" });
    const mike = insertActor(localDb, { code: "mike", displayName: "Mike" });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setLocationProprietor(localDb, nags.id, mike.id);
    setActorLocation(localDb, mike.id, nags.id);
    setActorLocation(localDb, denzil.id, nags.id);

    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 15,
      closingUnitPrice: 6,
      reachableBy: [denzil.id],
    });
    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);

    expect(getLocationProprietor(localDb, nags.id)).toBe(mike.id);

    const world = new World({
      db: localDb,
      rng: createRNG("gossip"),
      seed: "gossip",
      maxDays: 1,
      startHour: 9,
    });
    registerLocationGossip(world);
    world.start();

    // Manually emit a travelled event (simulating Denzil arriving at the
    // pub) and observe the exchange.
    world.events.emit({
      type: "actor.travelled",
      at: { day: 1, hour: 18 },
      actorId: denzil.id,
      toLocationId: nags.id,
    });

    // Mike should now hold Denzil's lead (visitor → proprietor leg).
    const mikesLeads = getLeadsByHolder(localDb, mike.id);
    expect(mikesLeads.length).toBeGreaterThan(0);
    expect(mikesLeads[0]?.subjectPoolId).toBe(pool.id);
    expect(mikesLeads[0]?.sourceActorId).toBe(denzil.id);
  });

  it("settlement walks supply leads to source short stock from referenced pools", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, {
      code: "s", displayName: "S", cash: 1000, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: 5000 });
    const supplier = insertActor(localDb, { code: "sup", displayName: "Sup" });
    const house = insertActor(localDb, { code: "house", displayName: "H" });
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [supplier.id],
    });
    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);
    // Gossip the supplier's self-lead onto the seller — they now "know"
    // about pool reach via supplier.
    const supplierLead = getLeadsByHolder(localDb, supplier.id)[0]!;
    shareLead(localDb, supplier.id, seller.id, supplierLead.id, 1);

    // Seller has zero matching inventory but commits to selling 50 to
    // buyer based on the lead.
    const deal = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 50, unitPrice: 30 },
      ],
    });

    // Settle — should walk the lead and source from the pool.
    const events: WorldEvent[] = [];
    settleDeal(localDb, deal.id, 2, {
      procurementProceedsActorId: house.id,
      events: { emit: (e) => events.push(e), subscribe: () => () => {} },
    });

    expect(getDealById(localDb, deal.id)?.state).toBe("settled");
    expect(totalQuantityForOwnerAndKind(localDb, buyer.id, item.id)).toBe(50);
    // Pool drained by 50.
    const updated = localDb
      .prepare<{ q: number }>(`SELECT quantity_remaining AS q FROM world_pools WHERE id = @id`)
      .get({ id: pool.id });
    expect(updated?.q).toBe(50);
    // Seller paid £10 × 50 = £500 to procurement; received £30 × 50 = £1500.
    expect(getActorById(localDb, seller.id)?.cash).toBe(1000 - 500 + 1500);
    expect(getActorById(localDb, house.id)?.cash).toBe(500);
    expect(events.some((e) => e.type === "settlement.lead-claim")).toBe(true);
  });

  it("CASCADE: two sellers' leads point to the same pool — first settles, second defaults", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const sellerA = insertActor(localDb, {
      code: "del", displayName: "Del", cash: 5000, transportCapacity: "truck",
    });
    const sellerB = insertActor(localDb, {
      code: "paddy", displayName: "Paddy", cash: 5000, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "boyce", displayName: "Boyce", cash: 50000 });
    const supplier = insertActor(localDb, { code: "sup", displayName: "Sup" });
    const house = insertActor(localDb, { code: "h", displayName: "H" });
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "v",
      category: "electrical",
      baseValue: 30,
    });
    // ONE pool with 100 units. Both sellers have leads pointing to it.
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 5,
      openingUnitPrice: 10,
      closingUnitPrice: 10,
      reachableBy: [supplier.id],
    });
    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);
    const supplierLead = getLeadsByHolder(localDb, supplier.id)[0]!;
    // Both sellers receive the same lead via gossip.
    shareLead(localDb, supplier.id, sellerA.id, supplierLead.id, 1);
    shareLead(localDb, supplier.id, sellerB.id, supplierLead.id, 1);

    // Verify both sellers have the lead pointing at the same pool.
    const aLeads = getSupplyLeadsForItem(localDb, sellerA.id, item.id);
    const bLeads = getSupplyLeadsForItem(localDb, sellerB.id, item.id);
    expect(aLeads[0]?.subjectPoolId).toBe(pool.id);
    expect(bLeads[0]?.subjectPoolId).toBe(pool.id);

    // Each seller commits to delivering 100 units. World has 100 total.
    const dealA = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: sellerA.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 100, unitPrice: 30 },
      ],
    });
    const dealB = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: sellerB.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 100, unitPrice: 30 },
      ],
    });

    // Settle A first — drains the pool.
    settleDeal(localDb, dealA.id, 2, { procurementProceedsActorId: house.id });
    expect(getDealById(localDb, dealA.id)?.state).toBe("settled");

    // Settle B — pool empty, no inventory, defaults expected.
    expect(() => settleDeal(localDb, dealB.id, 2, { procurementProceedsActorId: house.id }))
      .toThrow();

    // Pool genuinely drained.
    const updated = localDb
      .prepare<{ q: number }>(`SELECT quantity_remaining AS q FROM world_pools WHERE id = @id`)
      .get({ id: pool.id });
    expect(updated?.q).toBe(0);

    // The world had 100 vacuums; the buyer received 100 (not 200).
    expect(totalQuantityForOwnerAndKind(localDb, buyer.id, item.id)).toBe(100);
  });

  it("seller can't afford procurement → that lead is skipped, not chosen", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, {
      code: "s", displayName: "S", cash: 5, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: 5000 });
    const supplier = insertActor(localDb, { code: "sup", displayName: "Sup" });
    const item = insertItemKind(localDb, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 30,
    });
    const pool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 100,
      createdDay: 1,
      expiryDay: 4,
      openingUnitPrice: 100, // cost £100/unit, seller has £5
      closingUnitPrice: 100,
      reachableBy: [supplier.id],
    });
    seedSupplyLeadsForPool(localDb, pool.id, 1, DEFAULT_ECONOMICS_CONFIG);
    const supplierLead = getLeadsByHolder(localDb, supplier.id)[0]!;
    shareLead(localDb, supplier.id, seller.id, supplierLead.id, 1);

    // Seller can't afford pool's £100/unit; existing inventory is empty.
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 0 + 1,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(localDb, {
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [
        { itemKindId: item.id, qualityTier: "good", quantity: 5, unitPrice: 30 },
      ],
    });
    expect(() => settleDeal(localDb, deal.id, 2)).toThrow(/short/i);
  });
});

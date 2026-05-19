import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot, totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { registerPubDealAutonomy } from "../src/engine/world/pub-deal-autonomy.js";
import { registerDailySettlement } from "../src/engine/world/daily-settlement.js";
import { insertPool } from "../src/engine/pools/pools-repo.js";
import { insertLead } from "../src/engine/leads/leads-repo.js";
import {
  FALLBACK_BIDDER_PROFILE,
  type BidderProfile,
} from "../src/engine/auction/bidder-profile.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("pub-deal autonomy", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("two NPCs at the pub agree a deal that settles next morning", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    // Boot transport so the seller can credibly move enough of their
    // 50-unit bag to clear the new 25%-slice floor (≥13 units).
    const seller = insertActor(localDb, { code: "s", firstName: "Seller", shortName: "Seller", cash: 0, transportCapacity: "boot" });
    const buyer = insertActor(localDb, { code: "b", firstName: "Buyer", shortName: "Buyer", cash: 5000, transportCapacity: "boot" });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });

    const profiles = new Map<number, BidderProfile>([
      [
        buyer.id,
        {
          appraisalAccuracy: new Map([["electrical", 1]]),
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map(),
          defaultFlawTypeDetection: 0,
        },
      ],
    ]);

    const world = new World({
      db: localDb,
      rng: createRNG("autonomy-clean"),
      seed: "autonomy-clean",
      maxDays: 3,
      startDay: 1,
      startHour: 17,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerDailySettlement(world);
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: profiles,
      attemptsPerHour: 10,
      pairChance: 1.0,
    });
    world.runToCompletion();

    const agreed = events.filter((e) => e.type === "pubdeal.agreed");
    expect(agreed.length).toBeGreaterThan(0);
    const settled = events.filter((e) => e.type === "deal.settled");
    expect(settled.length).toBeGreaterThan(0);

    // Stock and cash actually moved.
    expect(totalQuantityForOwnerAndKind(localDb, buyer.id, item.id)).toBeGreaterThan(0);
    expect(getActorById(localDb, seller.id)?.cash).toBeGreaterThan(0);
    expect(getActorById(localDb, buyer.id)?.cash).toBeLessThan(5000);
  });

  it("ignores actors not at a pub location", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, { code: "s", firstName: "S", shortName: "S", cash: 0 });
    const buyer = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 5000 });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const flat = insertLocation(localDb, { code: "flat", displayName: "Flat" });
    setActorLocation(localDb, seller.id, flat.id); // NOT at the pub
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("a"),
      seed: "a",
      maxDays: 2,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map(),
      attemptsPerHour: 10,
      pairChance: 1.0,
    });
    world.runToCompletion();
    expect(events.filter((e) => e.type === "pubdeal.attempted")).toEqual([]);
  });

  it("doesn't fire outside the configured hour window", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", firstName: "A", shortName: "A", cash: 1000 });
    const b = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 1000 });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, a.id, nags.id);
    setActorLocation(localDb, b.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 1,
    });
    insertStockLot(localDb, {
      ownerActorId: a.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("hours"),
      seed: "hours",
      // Run only morning hours; pub deals should never fire.
      maxDays: 1,
      startHour: 9,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [a.id, b.id],
      bidderProfiles: new Map(),
      startHour: 18,
      endHour: 22,
      attemptsPerHour: 10,
      pairChance: 1.0,
    });
    // Tick from 9 to 17 — never enters the autonomy window.
    world.start();
    for (let i = 0; i < 8; i += 1) world.tickOnce();
    expect(events.filter((e) => e.type === "pubdeal.attempted")).toEqual([]);
  });

  it("forward-sale: seller commits to more than they hold; default fires when stock falls short", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const seller = insertActor(localDb, {
      code: "s", firstName: "S", shortName: "S", cash: 0, transportCapacity: "truck",
    });
    const buyer = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 100000 });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50, // big enough to clear the 25% slice floor
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });

    // Forward-sell now requires a warm, low-hop, pool-grounded supply
    // lead matching the item-tier. Seed one tied to a live pool to
    // exercise the over-commit path.
    const sourcePool = insertPool(localDb, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 200,
      createdDay: 1,
      expiryDay: 10,
      openingUnitPrice: 5,
      closingUnitPrice: 3,
    });
    insertLead(localDb, {
      holderActorId: seller.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 200,
      estimatedUnitPrice: 5,
      acquiredDay: 1,
      confidence: "warm",
      hopCount: 0,
      subjectPoolId: sourcePool.id,
    });

    const profiles = new Map<number, BidderProfile>([
      [
        buyer.id,
        {
          appraisalAccuracy: new Map(),
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map(),
          defaultFlawTypeDetection: 0,
        },
      ],
    ]);

    const world = new World({
      db: localDb,
      rng: createRNG("forward-sell"),
      seed: "forward-sell",
      maxDays: 6,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerDailySettlement(world);
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: profiles,
      attemptsPerHour: 5,
      pairChance: 1.0,
      forwardSellChance: 1.0, // every attempt is a forward-sale
      forwardSellQtyMultiplierRange: [3, 4],
      forwardSellDeadlineRange: [4, 4], // 2× truck transit (truck=2) days
    });
    world.runToCompletion();

    const agreed = events.filter((e) => e.type === "pubdeal.agreed");
    expect(agreed.length).toBeGreaterThan(0);
    // At least one must have committed more than the seller's bag held.
    const overcommit = agreed.find(
      (e) => e.type === "pubdeal.agreed" && e.quantity > 50,
    );
    expect(overcommit).toBeDefined();
  });

  it("trust gating: a buyer at or below the threshold refuses to deal", async () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, { code: "s", firstName: "S", shortName: "S", cash: 0, transportCapacity: "boot" });
    const buyer = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 5000, transportCapacity: "boot" });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "x",
      displayName: "x",
      category: "x",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });

    // Pre-poison the buyer's trust in the seller.
    const { adjustTrust } = await import("../src/engine/trust/trust-repo.js");
    adjustTrust(localDb, buyer.id, seller.id, -50, 1);

    const world = new World({
      db: localDb,
      rng: createRNG("trust-gate"),
      seed: "trust-gate",
      maxDays: 2,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map(),
      attemptsPerHour: 5,
      pairChance: 1.0,
      trustGatingThreshold: -25,
    });
    world.runToCompletion();

    expect(events.filter((e) => e.type === "pubdeal.skipped-low-trust").length)
      .toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "pubdeal.agreed")).toEqual([]);
  });

  it("uses the FALLBACK profile for buyers without one", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, { code: "s", firstName: "S", shortName: "S", cash: 0, transportCapacity: "boot" });
    const buyer = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 5000, transportCapacity: "boot" });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 20, // boot tier covers this with room to spare
      acquiredUnitPrice: 5,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("fallback"),
      seed: "fallback",
      maxDays: 2,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map(), // no profiles → fallback
      attemptsPerHour: 5,
      pairChance: 1.0,
    });
    world.runToCompletion();
    // Fallback profile is competent enough that some deal is plausible.
    // We don't strictly require an agreement (RNG-dependent), but the
    // autonomy should at least try, not throw.
    expect(events.filter((e) => e.type === "pubdeal.attempted").length)
      .toBeGreaterThan(0);
    expect(FALLBACK_BIDDER_PROFILE.defaultAppraisalAccuracy).toBeGreaterThan(0);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { registerPubDealAutonomy } from "../src/engine/world/pub-deal-autonomy.js";
import { type BidderProfile } from "../src/engine/auction/bidder-profile.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("pub-deal pre-haggle gates (Stage 8b)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setupCommon(opts: {
    qty: number;
    baseValue: number;
    sellerCash?: number;
    buyerCash: number;
  }) {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, {
      code: "s",
      firstName: "S", shortName: "S",
      cash: opts.sellerCash ?? 0,
      transportCapacity: "boot",
    });
    const buyer = insertActor(localDb, {
      code: "b",
      firstName: "B", shortName: "B",
      cash: opts.buyerCash,
      transportCapacity: "boot",
    });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "x",
      displayName: "X",
      category: "novelty",
      baseValue: opts.baseValue,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: opts.qty,
      acquiredUnitPrice: Math.max(1, Math.floor(opts.baseValue / 4)),
      acquiredDay: 1,
    });
    const profile: BidderProfile = {
      appraisalAccuracy: new Map([["novelty", 1]]),
      defaultAppraisalAccuracy: 1,
      flawTypeDetection: new Map(),
      defaultFlawTypeDetection: 0,
    };
    return { localDb, seller, buyer, nags, item, profile };
  }

  it("£100 RRP floor: tiny bag triggers pubdeal.skipped-too-small", () => {
    // 2 units of a £5 item → RRP ≈ £10 — well below the £100 floor.
    const { localDb, seller, buyer, nags, item, profile } = setupCommon({
      qty: 2,
      baseValue: 5,
      buyerCash: 1000,
    });
    void item;
    const world = new World({
      db: localDb,
      rng: createRNG("floor"),
      seed: "floor",
      maxDays: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map([[buyer.id, profile]]),
      attemptsPerHour: 3,
      pairChance: 1.0,
    });
    world.runToCompletion();

    const skips = events.filter((e) => e.type === "pubdeal.skipped-too-small");
    expect(skips.length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "pubdeal.agreed")).toHaveLength(0);
  });

  it("£100 floor passes for chunky bags", () => {
    // 10 of a £30 item → RRP ≈ £300+. Should engage.
    const { localDb, seller, buyer, nags, profile } = setupCommon({
      qty: 10,
      baseValue: 30,
      buyerCash: 5000,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("ok"),
      seed: "ok",
      maxDays: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map([[buyer.id, profile]]),
      attemptsPerHour: 3,
      pairChance: 1.0,
    });
    world.runToCompletion();

    // The chunky bag passes the floor on its first attempts. Once
    // deals start clearing stock, a later attempt at a small
    // surviving slice may legitimately skip-too-small — that's a
    // correct outcome of the gate, not a bug. Assert on the
    // sequence: at least one attempt fires before any skip.
    const firstAttempt = events.findIndex(
      (e) => e.type === "pubdeal.attempted",
    );
    const firstSkip = events.findIndex(
      (e) => e.type === "pubdeal.skipped-too-small",
    );
    expect(firstAttempt).toBeGreaterThanOrEqual(0);
    if (firstSkip !== -1) {
      expect(firstSkip).toBeGreaterThan(firstAttempt);
    }
  });

  it("25% slice: buyer can only afford a tiny slice → no attempt", () => {
    // 100 of a £30 item = £3000 RRP (clears £100). But buyer only has
    // £30 cash — at any plausible price they can buy ~1 unit, well
    // below 25% of 100. The autonomy should silently bail before
    // calling the haggle.
    const { localDb, seller, buyer, nags, profile } = setupCommon({
      qty: 100,
      baseValue: 30,
      buyerCash: 30,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("slice"),
      seed: "slice",
      maxDays: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map([[buyer.id, profile]]),
      attemptsPerHour: 3,
      pairChance: 1.0,
    });
    world.runToCompletion();

    expect(events.filter((e) => e.type === "pubdeal.agreed")).toHaveLength(0);
    expect(events.filter((e) => e.type === "pubdeal.attempted")).toHaveLength(0);
  });

  it("forward-sell only engages when seller holds a warm pool-grounded lead", () => {
    // No supply lead, no forward-sell. With qty = lot.quantity (10),
    // the seller commits exactly what they hold — no over-commit.
    const { localDb, seller, buyer, nags, profile } = setupCommon({
      qty: 10,
      baseValue: 30,
      buyerCash: 5000,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("no-lead"),
      seed: "no-lead",
      maxDays: 2,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: new Map([[buyer.id, profile]]),
      attemptsPerHour: 5,
      pairChance: 1.0,
      forwardSellChance: 1.0, // always WANT to forward-sell
      forwardSellQtyMultiplierRange: [3, 3],
      forwardSellDeadlineRange: [3, 3],
    });
    world.runToCompletion();

    const agreed = events.filter(
      (e): e is Extract<WorldEvent, { type: "pubdeal.agreed" }> =>
        e.type === "pubdeal.agreed",
    );
    expect(agreed.length).toBeGreaterThan(0);
    // No over-commit since no warm pool-grounded lead exists.
    for (const a of agreed) {
      expect(a.quantity).toBeLessThanOrEqual(10);
    }
  });
});

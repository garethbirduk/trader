import { describe, it, expect } from "vitest";
import { createRNG } from "../src/engine/core/rng.js";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertAuctionLot } from "../src/engine/auction/auction-repo.js";
import { persistKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import { setActorArmJ } from "../src/engine/perception/arm-j-repo.js";
import { seedCategoryAnchors } from "../src/engine/perception/anchors-repo.js";
import { estimateLotValue } from "../src/engine/perception/lot-value.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import { DEFAULT_ECONOMICS_CONFIG } from "../src/engine/economics/config.js";

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

function setup(
  args: {
    expertise: number;
    j: number;
    category: string;
    anchorValue: number;
    baseValue: number;
    tier: "mint" | "good" | "fair" | "shoddy" | "broken";
    quantity: number;
  },
) {
  const db = freshDB();
  const aid = insertActor(db, {
    code: "test",
    firstName: "Test", shortName: "Test",
    cash: 100000,
    role: "civilian",
    transportCapacity: "none",
    isVirtual: false,
  }).id;
  const item = insertItemKind(db, {
    code: "item",
    displayName: "Item",
    category: args.category,
    baseValue: args.baseValue,
    spawnWeight: 1,
    size: "small",
    targetCustomers: ["families"],
  });
  const lot = insertAuctionLot(db, {
    itemKindId: item.id,
    qualityTier: args.tier,
    quantity: args.quantity,
    floorPrice: 0,
    listedDay: 1,
  });
  persistKnowledgeProfile(
    db,
    aid,
    profileWith({
      priceAccuracy: new Map([[args.category, args.expertise]]),
      defaultPriceAccuracy: args.expertise,
      conditionAccuracy: new Map([[args.category, 1.0]]),
      defaultConditionAccuracy: 1.0,
      customerTypes: ["families"],
    }),
  );
  setActorArmJ(db, { actorId: aid, arm: "price", j: args.j });
  seedCategoryAnchors(db, new Map([[args.category, args.anchorValue]]));
  return { db, aid, lot };
}

const TRIALS = 800;

describe("estimateLotValue — composition", () => {
  it("expert (high expertise + high j) prices near truth", () => {
    const { db, aid, lot } = setup({
      expertise: 0.95,
      j: 0.95,
      category: "electrical",
      anchorValue: 50,
      baseValue: 1000,
      tier: "good",
      quantity: 10,
    });
    // truth per unit = 1000 * tierMult.good (1.1) = 1100
    // truth lot total = 1100 * 10 = 11000
    const totals: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`expert-${i}`),
        perceivedTierOverride: lot.qualityTier,
      });
      totals.push(r.perceivedLotValue);
    }
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
    const TRUTH = 1000 * 1.1 * 10;
    expect(Math.abs(mean - TRUTH) / TRUTH).toBeLessThan(0.05);
  });

  it("clueless (low expertise + high j) anchors near the category prior — confidently wrong", () => {
    const { db, aid, lot } = setup({
      expertise: 0.1,
      j: 0.95,
      category: "electrical",
      anchorValue: 50,
      baseValue: 1000,
      tier: "good",
      quantity: 10,
    });
    const totals: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`clueless-${i}`),
        perceivedTierOverride: lot.qualityTier,
      });
      totals.push(r.perceivedLotValue);
    }
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
    // truth/unit = 1100. centre/unit = lerp(50, 1100, 0.1) = 155.
    // centre lot total ≈ 1550 (well below truth's 11000).
    const TRUTH = 11000;
    expect(mean).toBeLessThan(TRUTH * 0.5);
  });

  it("haphazard (low expertise + low j) has wide spread, sometimes lands near truth by accident", () => {
    const { db, aid, lot } = setup({
      expertise: 0.1,
      j: 0.1,
      category: "electrical",
      anchorValue: 50,
      baseValue: 1000,
      tier: "good",
      quantity: 10,
    });
    const totals: number[] = [];
    for (let i = 0; i < TRIALS; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`haphazard-${i}`),
        perceivedTierOverride: lot.qualityTier,
      });
      totals.push(r.perceivedLotValue);
    }
    // sd should be huge relative to mean (uniform spread)
    const mean = totals.reduce((s, v) => s + v, 0) / totals.length;
    const sd = Math.sqrt(
      totals.reduce((s, v) => s + (v - mean) ** 2, 0) / totals.length,
    );
    expect(sd / mean).toBeGreaterThan(0.4);
  });

  it("scales linearly with quantity", () => {
    const seed = (qty: number) =>
      setup({
        expertise: 1.0,
        j: 1.0,
        category: "electrical",
        anchorValue: 50,
        baseValue: 100,
        tier: "fair",
        quantity: qty,
      });
    const one = seed(1);
    const ten = seed(10);
    const r1 = estimateLotValue({
      db: one.db,
      actorId: one.aid,
      lot: one.lot,
      rng: createRNG("scale-1"),
      perceivedTierOverride: one.lot.qualityTier,
    });
    const r10 = estimateLotValue({
      db: ten.db,
      actorId: ten.aid,
      lot: ten.lot,
      rng: createRNG("scale-10"),
      perceivedTierOverride: ten.lot.qualityTier,
    });
    expect(r10.perceivedLotValue).toBeCloseTo(r1.perceivedLotValue * 10, -1);
  });

  it("flaw detection: discounts when actor spots the flaw", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Test", shortName: "Test",
      cash: 100000,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const item = insertItemKind(db, {
      code: "fake",
      displayName: "Fake",
      category: "electrical",
      baseValue: 100,
      spawnWeight: 1,
      size: "small",
      flawType: "fake",
      targetCustomers: ["families"],
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 1,
      floorPrice: 0,
      listedDay: 1,
    });
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        priceAccuracy: new Map([["electrical", 1.0]]),
        defaultPriceAccuracy: 1.0,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
        flawDetection: new Map([["fake", 1.0]]),
        defaultFlawDetection: 1.0,
        customerTypes: ["families"],
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: 1.0 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));
    const r = estimateLotValue({
      db,
      actorId: aid,
      lot,
      rng: createRNG("flaw-detect"),
      perceivedTierOverride: lot.qualityTier,
    });
    expect(r.flawDetected).toBe(true);
    // fake discount default = 0.2
    expect(r.flawMultiplier).toBeCloseTo(
      DEFAULT_ECONOMICS_CONFIG.flawDiscount.fake,
    );
    // truth per unit = 100 * 0.8 = 80; with 0.2 multiplier = 16
    expect(r.perceivedLotValue).toBeCloseTo(16, 0);
  });

  it("customer-fit mismatch applies the discount multiplier", () => {
    // NOTE: customerTypes isn't persisted by `persistKnowledgeProfile`
    // — the v1 schema only carries the per-axis skill maps. Callers
    // who care about customer-fit (the auction wiring, today) merge
    // the in-memory customerTypes onto the loaded profile via
    // profileOverride. This test exercises that path.
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Test", shortName: "Test",
      cash: 100000,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const item = insertItemKind(db, {
      code: "yuppie-only",
      displayName: "Yuppie-only",
      category: "electrical",
      baseValue: 100,
      spawnWeight: 1,
      size: "small",
      targetCustomers: ["yuppies"], // doesn't overlap with profile.customerTypes
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 1,
      floorPrice: 0,
      listedDay: 1,
    });
    setActorArmJ(db, { actorId: aid, arm: "price", j: 1.0 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));
    const profileOverride = profileWith({
      priceAccuracy: new Map([["electrical", 1.0]]),
      defaultPriceAccuracy: 1.0,
      conditionAccuracy: new Map([["electrical", 1.0]]),
      defaultConditionAccuracy: 1.0,
      customerTypes: ["old-dears"], // mismatch
    });
    const r = estimateLotValue({
      db,
      actorId: aid,
      lot,
      rng: createRNG("cust-fit"),
      profileOverride,
      perceivedTierOverride: lot.qualityTier,
    });
    expect(r.customerFitMultiplier).toBeCloseTo(
      DEFAULT_ECONOMICS_CONFIG.customerMismatchMultiplier,
    );
    // truth = 80, customer-fit = 0.4 (default mismatch), result ≈ 32
    expect(r.perceivedLotValue).toBeCloseTo(32, 0);
  });

  it("knownFlawType short-circuits the detection roll to certain", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Test", shortName: "Test",
      cash: 100000,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const item = insertItemKind(db, {
      code: "fake",
      displayName: "Fake",
      category: "electrical",
      baseValue: 100,
      spawnWeight: 1,
      size: "small",
      flawType: "fake",
      targetCustomers: ["families"],
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 1,
      floorPrice: 0,
      listedDay: 1,
    });
    // Actor with ZERO flaw detection — but the auction wiring passes
    // `knownFlawType` because the actor previously learned about it.
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        priceAccuracy: new Map([["electrical", 1.0]]),
        defaultPriceAccuracy: 1.0,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
        flawDetection: new Map([["fake", 0.0]]),
        defaultFlawDetection: 0.0,
        customerTypes: ["families"],
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: 1.0 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));
    for (let i = 0; i < 20; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`known-${i}`),
        perceivedTierOverride: lot.qualityTier,
        knownFlawType: "fake",
      });
      expect(r.flawDetected).toBe(true);
    }
  });
});

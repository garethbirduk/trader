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

function setupScamBaitLot(opts: { baseDetection: number }) {
  const db = freshDB();
  const aid = insertActor(db, {
    code: "buyer",
    displayName: "Buyer",
    cash: 100000,
    role: "civilian",
    transportCapacity: "none",
    isVirtual: false,
  }).id;
  // scam_bait flaw → flawDiscount 0 → detected = ceiling collapses
  const item = insertItemKind(db, {
    code: "fake-rolex",
    displayName: "Fake Rolex",
    category: "luxury",
    baseValue: 100,
    spawnWeight: 1,
    size: "small",
    flawType: "scam_bait",
    targetCustomers: ["yuppies"],
  });
  const lot = insertAuctionLot(db, {
    itemKindId: item.id,
    qualityTier: "good",
    quantity: 10,
    floorPrice: 0,
    listedDay: 1,
  });
  persistKnowledgeProfile(
    db,
    aid,
    profileWith({
      priceAccuracy: new Map([["luxury", 1.0]]),
      defaultPriceAccuracy: 1.0,
      conditionAccuracy: new Map([["luxury", 1.0]]),
      defaultConditionAccuracy: 1.0,
      flawDetection: new Map([["scam_bait", opts.baseDetection]]),
      defaultFlawDetection: opts.baseDetection,
      customerTypes: ["yuppies"],
    }),
  );
  setActorArmJ(db, { actorId: aid, arm: "price", j: 1.0 });
  seedCategoryAnchors(db, new Map([["luxury", 50]]));
  return { db, aid, lot };
}

describe("character arm — flawDetectionBonus", () => {
  it("zero bonus → base detection rate", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    let detected = 0;
    const trials = 400;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`zero-bonus-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: 0,
      });
      if (r.flawDetected) detected += 1;
    }
    expect(detected / trials).toBeGreaterThan(0.4);
    expect(detected / trials).toBeLessThan(0.6);
  });

  it("positive bonus raises detection rate", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    let detected = 0;
    const trials = 400;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`pos-bonus-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: 0.4,
      });
      if (r.flawDetected) detected += 1;
    }
    // base 0.5 + 0.4 = 0.9 → ~90% detection
    expect(detected / trials).toBeGreaterThan(0.8);
  });

  it("negative bonus suppresses detection", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    let detected = 0;
    const trials = 400;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`neg-bonus-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: -0.4,
      });
      if (r.flawDetected) detected += 1;
    }
    // base 0.5 − 0.4 = 0.1 → ~10% detection
    expect(detected / trials).toBeLessThan(0.2);
  });

  it("clamps at certainty — saturates at 1.0 detection", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    let detected = 0;
    const trials = 100;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`saturate-up-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: 5,
      });
      if (r.flawDetected) detected += 1;
    }
    expect(detected).toBe(trials);
  });

  it("clamps at zero — saturates at 0 detection", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    let detected = 0;
    const trials = 100;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`saturate-down-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: -5,
      });
      if (r.flawDetected) detected += 1;
    }
    expect(detected).toBe(0);
  });

  it("knownFlawType wins over a negative bonus (the burned actor always spots it)", () => {
    const { db, aid, lot } = setupScamBaitLot({ baseDetection: 0.5 });
    for (let i = 0; i < 30; i += 1) {
      const r = estimateLotValue({
        db,
        actorId: aid,
        lot,
        rng: createRNG(`known-vs-neg-${i}`),
        perceivedKindIdOverride: lot.itemKindId,
        perceivedTierOverride: lot.qualityTier,
        flawDetectionBonus: -2,
        knownFlawType: "scam_bait",
      });
      expect(r.flawDetected).toBe(true);
    }
  });
});

describe("character arm — economics knob default", () => {
  it("characterArmAlpha defaults to 0.5", () => {
    expect(DEFAULT_ECONOMICS_CONFIG.characterArmAlpha).toBe(0.5);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import {
  FALLBACK_BIDDER_PROFILE,
  FLAW_DISCOUNT,
  appraiseLot,
  type BidderProfile,
} from "../src/engine/auction/bidder-profile.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { AuctionLot } from "../src/engine/auction/types.js";
import type { FlawType } from "../src/engine/stock/types.js";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertAuctionLot } from "../src/engine/auction/auction-repo.js";
import { makeBidders } from "../src/engine/auction/default-bidders.js";
import type { DB } from "../src/engine/core/db.js";

const FAKE_LOT: AuctionLot = {
  id: 1,
  sourcePoolId: null,
  itemKindId: 1,
  qualityTier: "good",
  quantity: 10,
  floorPrice: 50,
  listedDay: 1,
  clearedDay: null,
  clearedPrice: null,
  clearedToActorId: null,
};

function profile(over: Partial<BidderProfile> = {}): BidderProfile {
  return {
    appraisalAccuracy: new Map(),
    defaultAppraisalAccuracy: 0.7,
    flawTypeDetection: new Map(),
    defaultFlawTypeDetection: 0.5,
    ...over,
  };
}

describe("appraiseLot — appraisal", () => {
  it("perfect appraiser (accuracy=1) returns the true value exactly", () => {
    const p = profile({
      appraisalAccuracy: new Map([["electrical", 1]]),
      defaultAppraisalAccuracy: 0.5,
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "electrical",
      flawType: null,
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.valuation).toBe(1000);
    expect(r.errorFactor).toBe(1);
    expect(r.flawDetected).toBe(false);
    expect(r.flawMultiplier).toBe(1);
  });

  it("totally clueless appraiser (accuracy=0) returns a value within [0, 2x] of true", () => {
    for (let i = 0; i < 100; i += 1) {
      const r = appraiseLot({
        profile: profile({ defaultAppraisalAccuracy: 0 }),
        lot: FAKE_LOT,
        category: "anything",
        flawType: null,
        trueLotValue: 1000,
        rng: createRNG(`seed-${i}`),
      });
      expect(r.valuation).toBeGreaterThanOrEqual(0);
      expect(r.valuation).toBeLessThanOrEqual(2000);
    }
  });

  it("category-specific skill overrides the default", () => {
    const p = profile({
      appraisalAccuracy: new Map([["electrical", 1.0]]),
      defaultAppraisalAccuracy: 0.0,
    });
    const correct = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "electrical",
      flawType: null,
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(correct.accuracy).toBe(1);
    expect(correct.valuation).toBe(1000);

    const guessing = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "books",
      flawType: null,
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(guessing.accuracy).toBe(0);
  });

  it("inspection multiplier composes with appraisal", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      inspectionAdjustment: () => 0.25,
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "electrical",
      flawType: null,
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.valuation).toBe(250);
    expect(r.inspectionMultiplier).toBe(0.25);
  });

  it("clamps accuracy to [0, 1]", () => {
    const high = appraiseLot({
      profile: profile({
        appraisalAccuracy: new Map([["x", 5]]),
        defaultAppraisalAccuracy: 0.5,
      }),
      lot: FAKE_LOT,
      category: "x",
      flawType: null,
      trueLotValue: 100,
      rng: createRNG("a"),
    });
    expect(high.accuracy).toBe(1);
    expect(high.valuation).toBe(100);

    const low = appraiseLot({
      profile: profile({
        appraisalAccuracy: new Map([["y", -1]]),
        defaultAppraisalAccuracy: 0.5,
      }),
      lot: FAKE_LOT,
      category: "y",
      flawType: null,
      trueLotValue: 100,
      rng: createRNG("a"),
    });
    expect(low.accuracy).toBe(0);
  });
});

describe("appraiseLot — flaw detection", () => {
  it("perfect flaw detection (1.0) always spots the flaw and applies the discount", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1, // exact value sight
      flawTypeDetection: new Map([["faulty", 1]]),
    });
    for (const flaw of ["faulty", "fake", "stolen", "wrong_market", "wrong_season", "dangerous", "scam_bait"] as FlawType[]) {
      const r = appraiseLot({
        profile: profile({
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map([[flaw, 1]]),
          defaultFlawTypeDetection: 0,
        }),
        lot: FAKE_LOT,
        category: "x",
        flawType: flaw,
        trueLotValue: 1000,
        rng: createRNG(`s-${flaw}`),
      });
      expect(r.flawDetected).toBe(true);
      expect(r.flawMultiplier).toBe(FLAW_DISCOUNT[flaw]);
      expect(r.valuation).toBe(Math.round(1000 * FLAW_DISCOUNT[flaw]));
    }
  });

  it("zero flaw detection (0.0) never spots the flaw — pays full price for broken stock", () => {
    const r = appraiseLot({
      profile: profile({
        defaultAppraisalAccuracy: 1,
        flawTypeDetection: new Map([["faulty", 0]]),
        defaultFlawTypeDetection: 0,
      }),
      lot: FAKE_LOT,
      category: "x",
      flawType: "faulty",
      trueLotValue: 1000,
      rng: createRNG("trigger"),
    });
    expect(r.flawDetected).toBe(false);
    expect(r.flawMultiplier).toBe(1);
    expect(r.valuation).toBe(1000);
  });

  it("flaw detection probability is honoured across many seeds", () => {
    let detected = 0;
    const trials = 1000;
    for (let i = 0; i < trials; i += 1) {
      const r = appraiseLot({
        profile: profile({
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map([["faulty", 0.5]]),
          defaultFlawTypeDetection: 0,
        }),
        lot: FAKE_LOT,
        category: "x",
        flawType: "faulty",
        trueLotValue: 1000,
        rng: createRNG(`run-${i}`),
      });
      if (r.flawDetected) detected += 1;
    }
    expect(detected).toBeGreaterThan(trials * 0.4);
    expect(detected).toBeLessThan(trials * 0.6);
  });

  it("category-specific flaw detection overrides the default", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      flawTypeDetection: new Map([["dangerous", 1]]),
      defaultFlawTypeDetection: 0,
    });
    // Detects DANGEROUS reliably.
    const dangerous = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: "dangerous",
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(dangerous.flawDetected).toBe(true);
    // Misses FAKE (no per-flaw entry, fallback is 0).
    const fake = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: "fake",
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(fake.flawDetected).toBe(false);
  });
});

describe("makeBidders with profiles", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("falls back to FALLBACK_BIDDER_PROFILE for actors without a profile", () => {
    db = freshDB();
    insertActor(db, { code: "auction-house", displayName: "House" });
    const generalist = insertActor(db, { code: "g", displayName: "G", cash: 5000 });
    const electrical = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const lot = insertAuctionLot(db, {
      itemKindId: electrical.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 50,
      listedDay: 1,
    });
    const find = makeBidders();
    const bidders = find(db, lot, 2, createRNG("seed"));
    expect(bidders).toHaveLength(1);
    expect(bidders[0]?.actorId).toBe(generalist.id);
  });

  it("excludes actors below the cash threshold", () => {
    db = freshDB();
    insertActor(db, { code: "auction-house", displayName: "House" });
    insertActor(db, { code: "broke", displayName: "Broke", cash: 50 });
    const electrical = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const lot = insertAuctionLot(db, {
      itemKindId: electrical.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 50,
      listedDay: 1,
    });
    const find = makeBidders({ minCashToParticipate: 100 });
    expect(find(db, lot, 2, createRNG("seed"))).toHaveLength(0);
  });

  it("expert with high flaw detection drops the bid on flagged stock; mug pays full price", () => {
    db = freshDB();
    insertActor(db, { code: "auction-house", displayName: "House" });
    const expert = insertActor(db, { code: "expert", displayName: "Expert", cash: 100000 });
    const mug = insertActor(db, { code: "mug", displayName: "Mug", cash: 100000 });
    const item = insertItemKind(db, {
      code: "ee-stuff",
      displayName: "Ridiculous Easter Egg",
      category: "novelty",
      baseValue: 100,
      flawType: "fake",
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 1,
      listedDay: 1,
    });
    const profiles = new Map([
      [
        expert.id,
        {
          appraisalAccuracy: new Map([["novelty", 1]]),
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map<FlawType, number>([["fake", 1]]),
          defaultFlawTypeDetection: 0,
        },
      ],
      [
        mug.id,
        {
          appraisalAccuracy: new Map([["novelty", 1]]),
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map<FlawType, number>([["fake", 0]]),
          defaultFlawTypeDetection: 0,
        },
      ],
    ]);
    const find = makeBidders({ profiles });
    const bidders = find(db, lot, 2, createRNG("flaw"));
    const expertBid = bidders.find((b) => b.actorId === expert.id);
    const mugBid = bidders.find((b) => b.actorId === mug.id);
    // True lot value: 100 × 1.1 (good tier) × 10 = 1100. Expert sees fake
    // and applies 0.2 multiplier → ~£220. Mug pays full ~£1100.
    expect(expertBid?.ceiling).toBe(220);
    expect(mugBid?.ceiling).toBe(1100);
  });
});

describe("appraiseLot — customer-type fit", () => {
  it("an item targeting a customer the bidder doesn't serve gets a heavy discount", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      defaultFlawTypeDetection: 0,
      customerTypes: ["yuppies", "businesses"], // Boyce's market
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: null,
      itemTargetCustomers: ["old-dears"], // very much not Boyce's market
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.customerFitMultiplier).toBeLessThan(1);
    expect(r.valuation).toBe(400); // 1000 × 0.4 mismatch multiplier
  });

  it("an item targeting any of the bidder's customers values at full price", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      defaultFlawTypeDetection: 0,
      customerTypes: ["yuppies", "businesses"],
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: null,
      itemTargetCustomers: ["families", "yuppies"], // overlaps yuppies
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.customerFitMultiplier).toBe(1);
    expect(r.valuation).toBe(1000);
  });

  it("universal items (empty targets) value at full price for any bidder", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      defaultFlawTypeDetection: 0,
      customerTypes: ["yuppies"],
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: null,
      itemTargetCustomers: [],
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.customerFitMultiplier).toBe(1);
    expect(r.valuation).toBe(1000);
  });

  it("bidders with no customer types declared aren't penalised", () => {
    const p = profile({
      defaultAppraisalAccuracy: 1,
      defaultFlawTypeDetection: 0,
      // no customerTypes set
    });
    const r = appraiseLot({
      profile: p,
      lot: FAKE_LOT,
      category: "x",
      flawType: null,
      itemTargetCustomers: ["yuppies"],
      trueLotValue: 1000,
      rng: createRNG("a"),
    });
    expect(r.customerFitMultiplier).toBe(1);
    expect(r.valuation).toBe(1000);
  });
});

describe("FALLBACK_BIDDER_PROFILE", () => {
  it("is a passable generalist", () => {
    expect(FALLBACK_BIDDER_PROFILE.defaultAppraisalAccuracy).toBe(0.7);
    expect(FALLBACK_BIDDER_PROFILE.appraisalAccuracy.size).toBe(0);
    expect(FALLBACK_BIDDER_PROFILE.defaultFlawTypeDetection).toBe(0.5);
    expect(FALLBACK_BIDDER_PROFILE.flawTypeDetection.size).toBe(0);
  });
});

describe("FLAW_DISCOUNT", () => {
  it("orders the flaw types from least-discounted to most", () => {
    // Stolen goods retain most value; SCAM_BAIT drops to zero.
    expect(FLAW_DISCOUNT.stolen).toBeGreaterThan(FLAW_DISCOUNT.wrong_season);
    expect(FLAW_DISCOUNT.wrong_season).toBeGreaterThan(FLAW_DISCOUNT.wrong_market);
    expect(FLAW_DISCOUNT.wrong_market).toBeGreaterThan(FLAW_DISCOUNT.faulty);
    expect(FLAW_DISCOUNT.faulty).toBeGreaterThan(FLAW_DISCOUNT.fake);
    expect(FLAW_DISCOUNT.fake).toBeGreaterThan(FLAW_DISCOUNT.dangerous);
    expect(FLAW_DISCOUNT.dangerous).toBeGreaterThan(FLAW_DISCOUNT.scam_bait);
    expect(FLAW_DISCOUNT.scam_bait).toBe(0);
  });
});

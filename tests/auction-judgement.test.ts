import { describe, it, expect } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertAuctionLot } from "../src/engine/auction/auction-repo.js";
import { makeBidders } from "../src/engine/auction/default-bidders.js";
import { persistKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import { setActorArmJ } from "../src/engine/perception/arm-j-repo.js";
import { seedCategoryAnchors } from "../src/engine/perception/anchors-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import { createRNG } from "../src/engine/core/rng.js";

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

describe("default-bidders — judgement engine end-to-end", () => {
  it("expert with full skill produces ceiling close to truth", () => {
    const db = freshDB();
    insertActor(db, { code: "auction-house", firstName: "H", shortName: "H" });
    const aid = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 100000,
    }).id;
    const item = insertItemKind(db, {
      code: "v",
      displayName: "v",
      category: "electrical",
      baseValue: 100,
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
        priceAccuracy: new Map([["electrical", 1.0]]),
        defaultPriceAccuracy: 1.0,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: 1.0 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));

    // truth = 100 * 1.1 * 10 = 1100
    const TRUTH = 1100;
    const ceilings: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const find = makeBidders({
        profiles: new Map([
          [
            aid,
            {
              bandPlacementAccuracy: new Map(), defaultBandPlacementAccuracy: 1.0, conditionAccuracy: new Map(), defaultConditionAccuracy: 1.0, flawDetection: new Map(), defaultFlawDetection: 0.5, priceAccuracy: new Map(), defaultPriceAccuracy: 1.0, customerFitAccuracy: new Map(), defaultCustomerFitAccuracy: 0.7,
            },
          ],
        ]),
      });
      const bidders = find(db, lot, 1, createRNG(`expert-${i}`));
      expect(bidders).toHaveLength(1);
      ceilings.push(bidders[0]!.ceiling);
    }
    const mean = ceilings.reduce((s, v) => s + v, 0) / ceilings.length;
    expect(Math.abs(mean - TRUTH) / TRUTH).toBeLessThan(0.05);
  });

  it("clueless bidder with high j produces ceiling anchored near the prior, well below truth", () => {
    const db = freshDB();
    insertActor(db, { code: "auction-house", firstName: "H", shortName: "H" });
    const aid = insertActor(db, {
      code: "trigger",
      firstName: "Trigger", shortName: "Trigger",
      cash: 100000,
    }).id;
    const item = insertItemKind(db, {
      code: "hifi",
      displayName: "Hi-fi",
      category: "electrical",
      baseValue: 1000,
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
        priceAccuracy: new Map([["electrical", 0.1]]),
        defaultPriceAccuracy: 0.1,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.95 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));

    // truth = 1000 * 1.1 * 10 = 11000. anchor = 50.
    // centre/unit = lerp(50, 1100, 0.1) = 155. centre lot = ~1550.
    // tight band around centre with high j; ceiling far below truth.
    const TRUTH = 11000;
    const ceilings: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const find = makeBidders({
        profiles: new Map([
          [
            aid,
            {
              bandPlacementAccuracy: new Map(), defaultBandPlacementAccuracy: 0.1, conditionAccuracy: new Map(), defaultConditionAccuracy: 0.1, flawDetection: new Map(), defaultFlawDetection: 0.5, priceAccuracy: new Map(), defaultPriceAccuracy: 0.1, customerFitAccuracy: new Map(), defaultCustomerFitAccuracy: 0.7,
            },
          ],
        ]),
      });
      const bidders = find(db, lot, 1, createRNG(`clueless-${i}`));
      expect(bidders).toHaveLength(1);
      ceilings.push(bidders[0]!.ceiling);
    }
    const mean = ceilings.reduce((s, v) => s + v, 0) / ceilings.length;
    // Mean clearly below truth — they're confidently underbidding.
    expect(mean).toBeLessThan(TRUTH * 0.3);
  });

  it("head-to-head, expert beats clueless on a £1100 lot", () => {
    const db = freshDB();
    insertActor(db, { code: "auction-house", firstName: "H", shortName: "H" });
    const expert = insertActor(db, {
      code: "expert",
      firstName: "Expert", shortName: "Expert",
      cash: 100000,
    }).id;
    const clueless = insertActor(db, {
      code: "clueless",
      firstName: "Clueless", shortName: "Clueless",
      cash: 100000,
    }).id;
    const item = insertItemKind(db, {
      code: "v",
      displayName: "v",
      category: "electrical",
      baseValue: 100,
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 100, // exclude floor
      listedDay: 1,
    });
    persistKnowledgeProfile(
      db,
      expert,
      profileWith({
        priceAccuracy: new Map([["electrical", 0.95]]),
        defaultPriceAccuracy: 0.95,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
      }),
    );
    persistKnowledgeProfile(
      db,
      clueless,
      profileWith({
        priceAccuracy: new Map([["electrical", 0.1]]),
        defaultPriceAccuracy: 0.1,
        conditionAccuracy: new Map([["electrical", 1.0]]),
        defaultConditionAccuracy: 1.0,
      }),
    );
    setActorArmJ(db, { actorId: expert, arm: "price", j: 0.95 });
    setActorArmJ(db, { actorId: clueless, arm: "price", j: 0.95 });
    seedCategoryAnchors(db, new Map([["electrical", 50]]));

    let expertHigher = 0;
    let trials = 0;
    for (let i = 0; i < 60; i += 1) {
      const find = makeBidders({
        profiles: new Map([
          [
            expert,
            {
              bandPlacementAccuracy: new Map(), defaultBandPlacementAccuracy: 0.95, conditionAccuracy: new Map(), defaultConditionAccuracy: 0.95, flawDetection: new Map(), defaultFlawDetection: 0.5, priceAccuracy: new Map(), defaultPriceAccuracy: 0.95, customerFitAccuracy: new Map(), defaultCustomerFitAccuracy: 0.7,
            },
          ],
          [
            clueless,
            {
              bandPlacementAccuracy: new Map(), defaultBandPlacementAccuracy: 0.1, conditionAccuracy: new Map(), defaultConditionAccuracy: 0.1, flawDetection: new Map(), defaultFlawDetection: 0.5, priceAccuracy: new Map(), defaultPriceAccuracy: 0.1, customerFitAccuracy: new Map(), defaultCustomerFitAccuracy: 0.7,
            },
          ],
        ]),
      });
      const bidders = find(db, lot, 1, createRNG(`h2h-${i}`));
      const eb = bidders.find((b) => b.actorId === expert);
      const cb = bidders.find((b) => b.actorId === clueless);
      if (eb && cb) {
        trials += 1;
        if (eb.ceiling > cb.ceiling) expertHigher += 1;
      } else if (eb && !cb) {
        // Clueless didn't even make the floor — expert wins by default.
        trials += 1;
        expertHigher += 1;
      }
    }
    // Expert ceiling should beat clueless in the vast majority of trials.
    expect(expertHigher / trials).toBeGreaterThan(0.85);
  });
});

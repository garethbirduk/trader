import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  loadKnowledgeProfile,
  persistKnowledgeProfile,
  setActorSkill,
  setActorSkillDefault,
} from "../src/engine/knowledge/skills-repo.js";
import {
  getBeliefsForAxis,
  getBeliefsForLot,
  recordBelief,
} from "../src/engine/knowledge/beliefs-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import type { DB } from "../src/engine/core/db.js";

describe("actor_skills repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("loads the fallback profile for an actor with no rows", () => {
    db = freshDB();
    const a = insertActor(db, { code: "x", displayName: "X" });
    const profile = loadKnowledgeProfile(db, a.id);
    expect(profile.defaultBandPlacementAccuracy).toBe(
      FALLBACK_KNOWLEDGE_PROFILE.defaultBandPlacementAccuracy,
    );
    expect(profile.bandPlacementAccuracy.size).toBe(0);
    expect(profile.flawDetection.size).toBe(0);
  });

  it("round-trips a full skill profile through persistKnowledgeProfile + load", () => {
    db = freshDB();
    const a = insertActor(db, { code: "mickey", displayName: "Mickey" });
    const wanted: KnowledgeProfile = {
      bandPlacementAccuracy: new Map([["watches", 0.15]]),
      defaultBandPlacementAccuracy: 0.1,
      conditionAccuracy: new Map([["watches", 0.2]]),
      defaultConditionAccuracy: 0.3,
      flawDetection: new Map([["fake", 0.1]]),
      defaultFlawDetection: 0.2,
      priceAccuracy: new Map([["watches", 0.95]]),
      defaultPriceAccuracy: 0.4,
      customerFitAccuracy: new Map([["watches", 0.7]]),
      defaultCustomerFitAccuracy: 0.5,
      customerTypes: ["market-punters"],
    };
    persistKnowledgeProfile(db, a.id, wanted);
    const loaded = loadKnowledgeProfile(db, a.id);
    expect(loaded.defaultBandPlacementAccuracy).toBe(0.1);
    expect(loaded.bandPlacementAccuracy.get("watches")).toBe(0.15);
    expect(loaded.priceAccuracy.get("watches")).toBe(0.95);
    expect(loaded.defaultFlawDetection).toBe(0.2);
    expect(loaded.flawDetection.get("fake")).toBe(0.1);
    // customerTypes isn't persisted (kept on legacy-bridge side); the
    // skills load returns the schema-resident axes only.
  });

  it("upserts on duplicate skill keys", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setActorSkill(db, { actorId: a.id, axis: "price", key: "watches", accuracy: 0.5 });
    setActorSkill(db, { actorId: a.id, axis: "price", key: "watches", accuracy: 0.9 });
    const profile = loadKnowledgeProfile(db, a.id);
    expect(profile.priceAccuracy.get("watches")).toBe(0.9);
  });

  it("rejects out-of-range accuracy", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    expect(() =>
      setActorSkill(db!, { actorId: a.id, axis: "band_placement", key: "watches", accuracy: 1.5 }),
    ).toThrow();
    expect(() =>
      setActorSkillDefault(db!, { actorId: a.id, axis: "band_placement", accuracy: -0.1 }),
    ).toThrow();
  });
});

describe("actor_beliefs repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("round-trips beliefs across all axes", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const b = insertActor(db, { code: "b", displayName: "B" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 1,
      acquiredUnitPrice: 25,
      acquiredDay: 1,
    });

    recordBelief(db, {
      actorId: a.id,
      lotId: lot.id,
      value: { axis: "condition", tier: "mint" },
      confidence: 0.4,
      sourcedFromActorId: b.id,
      acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: a.id,
      lotId: lot.id,
      value: { axis: "flaw", flawType: null },
      confidence: 1.0,
      sourcedFromActorId: null,
      acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id,
      lotId: lot.id,
      value: { axis: "price", low: 100, high: 110, forTier: "mint" },
      confidence: 0.95,
      sourcedFromActorId: b.id,
      acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: a.id,
      lotId: lot.id,
      value: { axis: "customer_fit", types: ["yuppies"] },
      confidence: 0.5,
      sourcedFromActorId: null,
      acquiredDay: 1,
    });

    const all = getBeliefsForLot(db, a.id, lot.id);
    expect(all).toHaveLength(4);

    const priceOnly = getBeliefsForAxis(db, a.id, lot.id, "price");
    expect(priceOnly).toHaveLength(1);
    const priceVal = priceOnly[0]!.value;
    if (priceVal.axis !== "price") throw new Error("unexpected axis");
    expect(priceVal.low).toBe(100);
    expect(priceVal.high).toBe(110);
    expect(priceVal.forTier).toBe("mint");
  });

  it("preserves multiple conflicting beliefs on the same axis", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 1,
      acquiredUnitPrice: 25,
      acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.4,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "condition", tier: "fair" }, confidence: 0.8,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    const both = getBeliefsForAxis(db, a.id, lot.id, "condition");
    expect(both).toHaveLength(2);
  });
});

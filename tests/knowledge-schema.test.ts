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
  addConfusablePair,
  addConfusablePairByCodes,
  getConfusableNeighbours,
  getConfusablePair,
} from "../src/engine/knowledge/confusable-pairs-repo.js";
import {
  getBeliefsForAxis,
  getBeliefsForLot,
  recordBelief,
} from "../src/engine/knowledge/beliefs-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  pairCode,
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
    expect(profile.defaultIdAccuracy).toBe(
      FALLBACK_KNOWLEDGE_PROFILE.defaultIdAccuracy,
    );
    expect(profile.idAccuracy.size).toBe(0);
    expect(profile.flawDetection.size).toBe(0);
  });

  it("round-trips a full five-axis profile through persistKnowledgeProfile + load", () => {
    db = freshDB();
    const a = insertActor(db, { code: "mickey", displayName: "Mickey" });
    const wanted: KnowledgeProfile = {
      idAccuracy: new Map([["rolex|rulex", 0.15]]),
      defaultIdAccuracy: 0.1,
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
    expect(loaded.defaultIdAccuracy).toBe(0.1);
    expect(loaded.idAccuracy.get("rolex|rulex")).toBe(0.15);
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
      setActorSkill(db!, { actorId: a.id, axis: "id", key: "x|y", accuracy: 1.5 }),
    ).toThrow();
    expect(() =>
      setActorSkillDefault(db!, { actorId: a.id, axis: "id", accuracy: -0.1 }),
    ).toThrow();
  });
});

describe("confusable_item_pairs repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("canonicalises ordering — (a,b) and (b,a) collapse to one row", () => {
    db = freshDB();
    const rolex = insertItemKind(db, {
      code: "rolex",
      displayName: "Rolex",
      category: "watches",
      baseValue: 8000,
    });
    const rulex = insertItemKind(db, {
      code: "rulex",
      displayName: "Rulex",
      category: "watches",
      baseValue: 100,
    });
    addConfusablePair(db, { kindAId: rolex.id, kindBId: rulex.id, difficulty: 0.3 });
    addConfusablePair(db, { kindAId: rulex.id, kindBId: rolex.id, difficulty: 0.5 }); // replaces
    const pair = getConfusablePair(db, rolex.id, rulex.id);
    expect(pair).not.toBeNull();
    expect(pair?.difficulty).toBe(0.5);
    // Both lookup directions return the same row.
    const reverse = getConfusablePair(db, rulex.id, rolex.id);
    expect(reverse?.id).toBe(pair?.id);
  });

  it("by-codes helper resolves names to ids", () => {
    db = freshDB();
    insertItemKind(db, {
      code: "rolex",
      displayName: "Rolex",
      category: "watches",
      baseValue: 8000,
    });
    insertItemKind(db, {
      code: "rulex",
      displayName: "Rulex",
      category: "watches",
      baseValue: 100,
    });
    const p = addConfusablePairByCodes(db, {
      kindACode: "rolex",
      kindBCode: "rulex",
      difficulty: 0.2,
    });
    expect(p.pairCode).toBe(pairCode("rolex", "rulex"));
  });

  it("getConfusableNeighbours returns the other side for either kind", () => {
    db = freshDB();
    const a = insertItemKind(db, {
      code: "a", displayName: "A", category: "watches", baseValue: 100,
    });
    const b = insertItemKind(db, {
      code: "b", displayName: "B", category: "watches", baseValue: 200,
    });
    const c = insertItemKind(db, {
      code: "c", displayName: "C", category: "watches", baseValue: 300,
    });
    addConfusablePair(db, { kindAId: a.id, kindBId: b.id, difficulty: 0.2 });
    addConfusablePair(db, { kindAId: a.id, kindBId: c.id, difficulty: 0.5 });
    const fromA = getConfusableNeighbours(db, a.id).map((n) => n.kindCode).sort();
    expect(fromA).toEqual(["b", "c"]);
    const fromB = getConfusableNeighbours(db, b.id).map((n) => n.kindCode);
    expect(fromB).toEqual(["a"]);
  });
});

describe("actor_beliefs repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("round-trips beliefs across all five axes", () => {
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
      value: { axis: "id", kindId: item.id },
      confidence: 0.9,
      sourcedFromActorId: b.id,
      acquiredDay: 2,
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
      value: { axis: "price", low: 100, high: 110, forKindId: item.id, forTier: "mint" },
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
    expect(all).toHaveLength(5);

    const priceOnly = getBeliefsForAxis(db, a.id, lot.id, "price");
    expect(priceOnly).toHaveLength(1);
    const priceVal = priceOnly[0]!.value;
    if (priceVal.axis !== "price") throw new Error("unexpected axis");
    expect(priceVal.low).toBe(100);
    expect(priceVal.high).toBe(110);
    expect(priceVal.forKindId).toBe(item.id);
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

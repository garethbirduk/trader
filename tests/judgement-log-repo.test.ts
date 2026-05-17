import { describe, it, expect } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getJudgementById,
  getJudgementByContextRef,
  insertJudgement,
  listJudgementsByActorDay,
  listJudgementsByDay,
  pruneJudgementsOlderThan,
  type CompositePayload,
  type PriceArmPayload,
} from "../src/engine/perception/judgement-log-repo.js";

const PRICE_PAYLOAD: PriceArmPayload = {
  itemKindId: 7,
  category: "electrical",
  truthTier: "fair",
  truthUnit: 800,
  anchor: 64,
  tierMultiplier: 0.8,
  expertise: 0.85,
  j: 0.7,
  centre: 692,
  low: 277,
  high: 1107,
  sample: 695,
  quantity: 3,
};

const COMPOSITE_PAYLOAD: CompositePayload = {
  itemKindId: 7,
  category: "electrical",
  quantity: 3,
  truthTier: "good",
  perceivedTier: "fair",
  conditionOverridden: false,
  condition: { expertise: 0.6, j: 0.6, anchor: 0.5 },
  price: {
    truthUnit: 800,
    anchor: 64,
    tierMultiplier: 0.8,
    expertise: 0.85,
    j: 0.7,
    centre: 692,
    low: 277,
    high: 1107,
    sample: 695,
  },
  flaw: {
    itemFlawType: "SCAM_BAIT",
    knownFlawType: null,
    detected: false,
    multiplier: 1,
    detectionBonus: 0.065,
  },
  customerFitMultiplier: 1,
  perceivedUnitValue: 695,
  perceivedLotValue: 2085,
};

describe("judgement-log-repo", () => {
  it("inserts a price-arm judgement and round-trips via getById", () => {
    const db = freshDB();
    const id = insertJudgement(db, {
      day: 5,
      hour: 13,
      actorId: 42,
      arm: "price",
      contextKind: "lead-seed",
      contextRefId: 100,
      payload: PRICE_PAYLOAD,
    });
    expect(id).toBeGreaterThan(0);
    const rec = getJudgementById(db, id);
    expect(rec).not.toBeNull();
    expect(rec?.arm).toBe("price");
    expect(rec?.actorId).toBe(42);
    expect(rec?.day).toBe(5);
    expect(rec?.hour).toBe(13);
    expect(rec?.contextKind).toBe("lead-seed");
    expect(rec?.contextRefId).toBe(100);
    expect(rec?.payload).toEqual(PRICE_PAYLOAD);
  });

  it("inserts a composite judgement, round-trips, exposes via context lookup", () => {
    const db = freshDB();
    const id = insertJudgement(db, {
      day: 7,
      hour: 14,
      actorId: 99,
      arm: "composite",
      contextKind: "auction-bid",
      contextRefId: 555,
      payload: COMPOSITE_PAYLOAD,
    });
    const direct = getJudgementById(db, id);
    expect(direct?.payload).toEqual(COMPOSITE_PAYLOAD);
    const viaCtx = getJudgementByContextRef(db, "auction-bid", 555);
    expect(viaCtx?.id).toBe(id);
  });

  it("listByDay returns rows ordered by hour then id", () => {
    const db = freshDB();
    const a = insertJudgement(db, {
      day: 3, hour: 10, actorId: 1, arm: "price",
      contextKind: "lead-seed", contextRefId: 1, payload: PRICE_PAYLOAD,
    });
    const b = insertJudgement(db, {
      day: 3, hour: 9, actorId: 2, arm: "price",
      contextKind: "lead-seed", contextRefId: 2, payload: PRICE_PAYLOAD,
    });
    const c = insertJudgement(db, {
      day: 3, hour: 10, actorId: 3, arm: "price",
      contextKind: "lead-seed", contextRefId: 3, payload: PRICE_PAYLOAD,
    });
    const otherDay = insertJudgement(db, {
      day: 4, hour: 10, actorId: 1, arm: "price",
      contextKind: "lead-seed", contextRefId: 4, payload: PRICE_PAYLOAD,
    });
    const rows = listJudgementsByDay(db, 3);
    expect(rows.map((r) => r.id)).toEqual([b, a, c]);
    expect(rows.find((r) => r.id === otherDay)).toBeUndefined();
  });

  it("listByActorDay filters to actor + day", () => {
    const db = freshDB();
    insertJudgement(db, {
      day: 3, hour: 9, actorId: 1, arm: "price",
      contextKind: "lead-seed", contextRefId: 10, payload: PRICE_PAYLOAD,
    });
    insertJudgement(db, {
      day: 3, hour: 10, actorId: 2, arm: "price",
      contextKind: "lead-seed", contextRefId: 11, payload: PRICE_PAYLOAD,
    });
    const mine = listJudgementsByActorDay(db, 1, 3);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.contextRefId).toBe(10);
  });

  it("getJudgementByContextRef returns the most recent when duplicates exist", () => {
    const db = freshDB();
    insertJudgement(db, {
      day: 1, hour: 5, actorId: 1, arm: "price",
      contextKind: "auction-bid", contextRefId: 7, payload: PRICE_PAYLOAD,
    });
    const second = insertJudgement(db, {
      day: 1, hour: 6, actorId: 1, arm: "price",
      contextKind: "auction-bid", contextRefId: 7, payload: PRICE_PAYLOAD,
    });
    const found = getJudgementByContextRef(db, "auction-bid", 7);
    expect(found?.id).toBe(second);
  });

  it("prune drops rows older than the cutoff and leaves recent ones", () => {
    const db = freshDB();
    insertJudgement(db, {
      day: 1, hour: 0, actorId: 1, arm: "price",
      contextKind: "lead-seed", contextRefId: 1, payload: PRICE_PAYLOAD,
    });
    insertJudgement(db, {
      day: 5, hour: 0, actorId: 1, arm: "price",
      contextKind: "lead-seed", contextRefId: 2, payload: PRICE_PAYLOAD,
    });
    const deleted = pruneJudgementsOlderThan(db, /*currentDay*/ 7, /*keepDays*/ 3);
    expect(deleted).toBe(1);
    expect(listJudgementsByDay(db, 1)).toHaveLength(0);
    expect(listJudgementsByDay(db, 5)).toHaveLength(1);
  });
});

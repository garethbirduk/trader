import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import {
  findBandContaining,
  findNearestBand,
  getActorBands,
  setActorBands,
} from "../src/engine/knowledge/bands-repo.js";
import {
  getTierBeliefs,
  getTierMultiplierBelief,
  seedTierBeliefsAtTruth,
  setTierBelief,
} from "../src/engine/knowledge/tier-beliefs-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("actor_category_bands repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("round-trips an actor's partition for a category", () => {
    db = freshDB();
    const a = insertActor(db, { code: "skilled", displayName: "Skilled" });
    const bands = setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [
        { low: 5, high: 50 },
        { low: 100, high: 250 },
        { low: 500, high: 2000 },
        { low: 2000, high: 10000 },
        { low: 10000, high: 50000 },
      ],
    });
    expect(bands).toHaveLength(5);
    expect(bands.map((b) => b.bandIdx)).toEqual([0, 1, 2, 3, 4]);

    const loaded = getActorBands(db, a.id, "watches");
    expect(loaded).toHaveLength(5);
    expect(loaded[0]?.low).toBe(5);
    expect(loaded[4]?.high).toBe(50000);
  });

  it("setActorBands replaces existing partition atomically", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [{ low: 5, high: 50000 }],
    });
    expect(getActorBands(db, a.id, "watches")).toHaveLength(1);
    // Re-partition (novice → expert).
    setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [
        { low: 5, high: 5000 },
        { low: 5000, high: 50000 },
      ],
    });
    expect(getActorBands(db, a.id, "watches")).toHaveLength(2);
  });

  it("findBandContaining locates the band that wraps the price", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [
        { low: 5, high: 50 },        // 0: cheap
        { low: 100, high: 250 },     // 1: low
        { low: 500, high: 2000 },    // 2: mid
        { low: 2000, high: 10000 },  // 3: high
        { low: 10000, high: 50000 }, // 4: best
      ],
    });
    expect(findBandContaining(db, a.id, "watches", 8000)?.bandIdx).toBe(3);
    expect(findBandContaining(db, a.id, "watches", 200)?.bandIdx).toBe(1);
    expect(findBandContaining(db, a.id, "watches", 75)).toBeNull(); // in the gap
    expect(findBandContaining(db, a.id, "watches", 100000)).toBeNull(); // outside
  });

  it("findNearestBand returns the closest band when the price falls in a gap", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [
        { low: 5, high: 50 },
        { low: 100, high: 250 },
      ],
    });
    // £80 is in the gap; nearer to band-1 (100, dist 20) than
    // band-0 (50, dist 30).
    const near = findNearestBand(db, a.id, "watches", 80);
    expect(near?.bandIdx).toBe(1);
    // £60 is nearer to band-0 (50).
    const near2 = findNearestBand(db, a.id, "watches", 60);
    expect(near2?.bandIdx).toBe(0);
  });

  it("an actor with no partition for a category returns null", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    expect(getActorBands(db, a.id, "watches")).toEqual([]);
    expect(findBandContaining(db, a.id, "watches", 100)).toBeNull();
    expect(findNearestBand(db, a.id, "watches", 100)).toBeNull();
  });

  it("an idiot with one band that doesn't cover the price still gets it via findNearestBand", () => {
    db = freshDB();
    const a = insertActor(db, { code: "idiot", displayName: "Idiot" });
    setActorBands(db, {
      actorId: a.id,
      category: "watches",
      bands: [{ low: 2000, high: 10000 }],
    });
    // A £50 watch is outside their (£2000, £10000) one band.
    expect(findBandContaining(db, a.id, "watches", 50)).toBeNull();
    expect(findNearestBand(db, a.id, "watches", 50)?.low).toBe(2000);
  });

  it("rejects invalid band bounds at write time", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    expect(() =>
      setActorBands(db!, {
        actorId: a.id,
        category: "x",
        bands: [{ low: 100, high: 50 }],
      }),
    ).toThrow();
    expect(() =>
      setActorBands(db!, {
        actorId: a.id,
        category: "x",
        bands: [{ low: -5, high: 50 }],
      }),
    ).toThrow();
  });
});

describe("actor_tier_beliefs repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("round-trips per-(category, tier) multiplier beliefs", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setTierBelief(db, { actorId: a.id, category: "watches", tier: "mint", multiplier: 1.5 });
    setTierBelief(db, { actorId: a.id, category: "watches", tier: "broken", multiplier: 0.1 });
    const m = getTierBeliefs(db, a.id, "watches");
    expect(m.get("mint")).toBe(1.5);
    expect(m.get("broken")).toBe(0.1);
    expect(m.get("fair")).toBeUndefined();
  });

  it("getTierMultiplierBelief falls back to engine truth when no belief stored", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    // Engine truth for mint = 1.5.
    expect(getTierMultiplierBelief(db, a.id, "watches", "mint")).toBe(1.5);
    // Override to a noisy belief.
    setTierBelief(db, { actorId: a.id, category: "watches", tier: "mint", multiplier: 1.0 });
    expect(getTierMultiplierBelief(db, a.id, "watches", "mint")).toBe(1.0);
  });

  it("seedTierBeliefsAtTruth populates all five tiers for a category", () => {
    db = freshDB();
    const a = insertActor(db, { code: "specialist", displayName: "Specialist" });
    seedTierBeliefsAtTruth(db, { actorId: a.id, category: "watches" });
    const m = getTierBeliefs(db, a.id, "watches");
    expect(m.size).toBe(5);
    // The specialist's beliefs match truth exactly.
    expect(m.get("mint")).toBe(1.5);
    expect(m.get("good")).toBe(1.1);
    expect(m.get("fair")).toBe(0.8);
    expect(m.get("shoddy")).toBe(0.5);
    expect(m.get("broken")).toBe(0.25);
  });

  it("setTierBelief upserts on duplicate (actor, category, tier)", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    setTierBelief(db, { actorId: a.id, category: "watches", tier: "mint", multiplier: 1.5 });
    setTierBelief(db, { actorId: a.id, category: "watches", tier: "mint", multiplier: 1.7 });
    expect(getTierMultiplierBelief(db, a.id, "watches", "mint")).toBe(1.7);
  });

  it("rejects negative multipliers", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    expect(() =>
      setTierBelief(db!, {
        actorId: a.id, category: "x", tier: "mint", multiplier: -0.5,
      }),
    ).toThrow();
  });
});

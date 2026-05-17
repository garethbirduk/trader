import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { setActorBands } from "../src/engine/knowledge/bands-repo.js";
import {
  seedTierBeliefsAtTruth,
  setTierBelief,
} from "../src/engine/knowledge/tier-beliefs-repo.js";
import {
  computeV2ExtractionBand,
  FALLBACK_KNOWLEDGE_PROFILE,
} from "../src/engine/knowledge/v2-extraction-band.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { KnowledgeProfile } from "../src/engine/knowledge/types.js";
import type { DB } from "../src/engine/core/db.js";

function profile(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

describe("v2 extraction band — four-skill model", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a perfect expert nails the band tight to truth", () => {
    db = freshDB();
    const a = insertActor(db, { code: "expert", displayName: "Expert" });
    // True watch RRP = £8000 (Rolex baseline). Good condition.
    const watch = insertItemKind(db, {
      code: "watch-8k", displayName: "Watch", category: "watches",
      baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // Expert sees 5 bands and pins the watch to band 3 (£2000-£10000).
    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [
        { low: 5, high: 50 },
        { low: 100, high: 250 },
        { low: 500, high: 2000 },
        { low: 2000, high: 10000 },
        { low: 10000, high: 50000 },
      ],
    });
    seedTierBeliefsAtTruth(db, { actorId: a.id, category: "watches" });

    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("expert"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1,
        defaultPriceAccuracy: 1, // tightness → collapse to band midpoint
        defaultConditionAccuracy: 1,
      }),
    });
    // Band midpoint = (2000+10000)/2 = 6000. Tightness 1 → point.
    // Tier good → multiplier 1.1. Final mid = 6000 × 1.1 = 6600.
    expect(band.placedBand?.bandIdx).toBe(3);
    expect(band.perceivedTier).toBe("good");
    expect(band.perceivedMultiplier).toBe(1.1);
    expect(band.mid).toBe(6600);
    expect(band.low).toBe(6600);
    expect(band.high).toBeCloseTo(6600, -1);
  });

  it("an idiot with one wide band has a wide quote that still spans truth", () => {
    db = freshDB();
    const a = insertActor(db, { code: "idiot", displayName: "Idiot" });
    const watch = insertItemKind(db, {
      code: "watch-8k", displayName: "Watch", category: "watches",
      baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // Idiot: ONE band covering the whole global watch range.
    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [{ low: 5, high: 50000 }],
    });
    seedTierBeliefsAtTruth(db, { actorId: a.id, category: "watches" });

    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("idiot"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1, // perfect placement... in a one-band partition
        defaultPriceAccuracy: 0, // zero tightness → full band width
        defaultConditionAccuracy: 1,
      }),
    });
    // One band → placement always lands there. Tightness 0 → full
    // band width preserved. Multiplier 1.1. Band: (5, 50000) × 1.1.
    expect(band.placedBand?.low).toBe(5);
    expect(band.placedBand?.high).toBe(50000);
    expect(band.low).toBeGreaterThan(0);
    expect(band.high).toBeGreaterThanOrEqual(50000);
  });

  it("an idiot with the WRONG single band has a quote completely off the truth", () => {
    db = freshDB();
    const a = insertActor(db, { code: "narrow-idiot", displayName: "Narrow Idiot" });
    const watch = insertItemKind(db, {
      code: "watch-8k", displayName: "Watch", category: "watches",
      baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // Idiot: ONE band covering only the cheap end (£5-£50). They've
    // never seen a watch worth more than £50. A £8000 Rolex falls
    // OUTSIDE their entire mental model.
    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [{ low: 5, high: 50 }],
    });
    seedTierBeliefsAtTruth(db, { actorId: a.id, category: "watches" });

    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("narrow-idiot"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1,
        defaultPriceAccuracy: 1,
        defaultConditionAccuracy: 1,
      }),
    });
    // The lot falls outside any band → nearest band is (5, 50).
    // They quote a cheap watch price for a £8000 Rolex.
    expect(band.placedBand?.bandIdx).toBe(0);
    expect(band.high).toBeLessThan(100);
  });

  it("a wrong tier-impact belief shifts the final number even when placement is correct", () => {
    db = freshDB();
    const a = insertActor(db, { code: "wrong-impact", displayName: "Wrong Impact" });
    const watch = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches", baseValue: 8000,
    });
    // Broken Rolex — truth multiplier 0.25.
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "broken",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [{ low: 2000, high: 10000 }],
    });
    // Actor wrongly believes broken Rolex still goes for 70% of
    // baseline (collector logic, not physical-state truth).
    setTierBelief(db, {
      actorId: a.id, category: "watches", tier: "broken", multiplier: 0.7,
    });

    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("impact"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1,
        defaultPriceAccuracy: 1, // collapse to midpoint
        defaultConditionAccuracy: 1, // sees broken correctly
      }),
    });
    // Midpoint of (2000, 10000) = 6000. × 0.7 = 4200. (Truth would
    // be 6000 × 0.25 = 1500.)
    expect(band.perceivedTier).toBe("broken");
    expect(band.perceivedMultiplier).toBe(0.7);
    expect(band.mid).toBe(4200);
  });

  it("placement-skill 0 with only one band is harmless (nowhere to slip to)", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const watch = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [{ low: 5, high: 50000 }],
    });
    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("s"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 0, // always slips
        defaultPriceAccuracy: 1,
        defaultConditionAccuracy: 1,
      }),
    });
    // Only one band — slip has nowhere to go. Lands on the band
    // that contains the truth.
    expect(band.placedBand?.low).toBe(5);
  });

  it("no partition at all → unsupported, falls back to truth-prior", () => {
    db = freshDB();
    const a = insertActor(db, { code: "blank", displayName: "Blank" });
    const watch = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("blank"),
    });
    expect(band.unsupported).toBe(true);
    expect(band.placedBand).toBeNull();
    // Falls back to truth-prior at the lot's actual tier.
    expect(band.mid).toBeGreaterThan(0);
  });

  it("condition-detection slip moves the multiplier off-tier", () => {
    db = freshDB();
    const a = insertActor(db, { code: "slip", displayName: "Slip" });
    const watch = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 8000,
    });
    // Truth: shoddy (multiplier 0.5).
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: watch.id, qualityTier: "shoddy",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    setActorBands(db, {
      actorId: a.id, category: "watches",
      bands: [{ low: 2000, high: 10000 }],
    });
    seedTierBeliefsAtTruth(db, { actorId: a.id, category: "watches" });

    const band = computeV2ExtractionBand({
      db, actorId: a.id, lotId: lot.id,
      rng: createRNG("slip"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1,
        defaultPriceAccuracy: 1,
        defaultConditionAccuracy: 0, // always slips
      }),
    });
    // Truth shoddy → slip to fair or broken (adjacent tiers).
    expect(["fair", "broken"]).toContain(band.perceivedTier);
    // Multiplier corresponds to the slipped tier (0.8 or 0.25).
    expect([0.8, 0.25]).toContain(band.perceivedMultiplier);
  });
});

describe("v2 extraction band — canonical watch arc without brand identifiers", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("Del (idiot watches partition) and Boyce (skilled partition) form wildly different bands on the same lot", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", displayName: "Del", cash: 1000 });
    const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 20000 });
    // Single "watch" item — no brand identifier. True RRP £8000,
    // good condition. The engine doesn't know it's a Rolex; the
    // discrimination lives entirely in the actors' partitions.
    const watch = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches",
      baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: del.id, itemKindId: watch.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // Del's mental model: novice — two bands, cheap and best.
    // He sees the lot as falling in the £5000+ "best" band, with
    // zero tightness so he quotes the whole £5k-£50k swath.
    // BUT he's also got a wonky condition-impact belief: he thinks
    // good = 0.5 not 1.1 (he undervalues condition).
    setActorBands(db, {
      actorId: del.id, category: "watches",
      bands: [
        { low: 5, high: 5000 },
        { low: 5000, high: 50000 },
      ],
    });
    setTierBelief(db, {
      actorId: del.id, category: "watches", tier: "good", multiplier: 0.02,
    });

    // Boyce: skilled — five bands. Sees the lot in (2000, 10000)
    // and quotes tight. Knows the true multiplier.
    setActorBands(db, {
      actorId: boyce.id, category: "watches",
      bands: [
        { low: 5, high: 50 },
        { low: 100, high: 250 },
        { low: 500, high: 2000 },
        { low: 2000, high: 10000 },
        { low: 10000, high: 50000 },
      ],
    });
    seedTierBeliefsAtTruth(db, { actorId: boyce.id, category: "watches" });

    const delBand = computeV2ExtractionBand({
      db, actorId: del.id, lotId: lot.id,
      rng: createRNG("del"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1, // pins to right band
        defaultPriceAccuracy: 0, // no narrowing — full band width
        defaultConditionAccuracy: 1,
      }),
    });
    const boyceBand = computeV2ExtractionBand({
      db, actorId: boyce.id, lotId: lot.id,
      rng: createRNG("boyce"),
      profileOverride: profile({
        defaultBandPlacementAccuracy: 1,
        defaultPriceAccuracy: 1, // tight quote
        defaultConditionAccuracy: 1,
      }),
    });

    // Del's quote: huge range, AND wonky multiplier dragging it
    // down. (5000, 50000) × 0.02 = (100, 1000). He'd sell for ~£500.
    expect(delBand.placedBand?.bandIdx).toBe(1);
    expect(delBand.high).toBeLessThan(1500);

    // Boyce's quote: tight, at truth. Midpoint of (2000, 10000) =
    // 6000 × 1.1 = 6600. He knows what it's worth.
    expect(boyceBand.placedBand?.bandIdx).toBe(3);
    expect(boyceBand.mid).toBe(6600);

    // The information surplus dynamic: Boyce's mid ≈ 10× Del's high.
    expect(boyceBand.mid / Math.max(1, delBand.high)).toBeGreaterThan(5);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { recordBelief } from "../src/engine/knowledge/beliefs-repo.js";
import { computeExtractionBand } from "../src/engine/knowledge/extraction-band.js";
import type { DB } from "../src/engine/core/db.js";

describe("computeExtractionBand", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("with no beliefs, falls back to the prior at the lot's actual tier", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    const band = computeExtractionBand(db, a.id, lot.id);
    // No beliefs → uniform across tiers integrated. Band should
    // straddle the broken..mint range for a base-100 item:
    //   mint = 150, broken = 25, with ±25% widening.
    expect(band.unsupported).toBe(true);
    expect(band.low).toBeLessThan(50);
    expect(band.high).toBeGreaterThan(150);
  });

  it("a confident price belief collapses the band to that range", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    // Confident, untagged price belief — applies to every combo.
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "price", low: 100, high: 110 },
      confidence: 0.95,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    const band = computeExtractionBand(db, a.id, lot.id);
    expect(band.low).toBe(100);
    expect(band.high).toBe(110);
    expect(band.unsupported).toBe(false);
  });

  it("a tagged price belief only applies to matching (kind, tier) combos", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const rolex = insertItemKind(db, {
      code: "rolex", displayName: "Rolex", category: "watches", baseValue: 8000,
    });
    const rulex = insertItemKind(db, {
      code: "rulex", displayName: "Rulex", category: "watches", baseValue: 100,
    });
    // Lot is actually a Rolex.
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: rolex.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    // Owner has consulted: thinks it's a Rulex, mint condition.
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "id", kindId: rulex.id }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.7,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    // Price belief tagged for "mint Rulex" — should apply.
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: {
        axis: "price", low: 100, high: 110,
        forKindId: rulex.id, forTier: "mint",
      },
      confidence: 0.95,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    const band = computeExtractionBand(db, a.id, lot.id);
    expect(band.low).toBe(100);
    expect(band.high).toBe(110);
  });

  it("when belief mass is split across combos, the band spans both", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const rolex = insertItemKind(db, {
      code: "rolex", displayName: "Rolex", category: "watches", baseValue: 8000,
    });
    // Lot is a Rolex; owner is uncertain about condition (no belief
    // → uniform prior). With only id pinned and no price belief, the
    // band integrates kind.baseValue × tierMult across all tiers.
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: rolex.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    const band = computeExtractionBand(db, a.id, lot.id);
    // mint=12000 (high≈15000), broken=2000 (low≈1500).
    // Aggregated band should span roughly [1500, 15000].
    expect(band.low).toBeLessThan(2500);
    expect(band.high).toBeGreaterThan(13000);
    expect(band.unsupported).toBe(false);
  });

  it("multiple price beliefs union — Del's hedge scenario", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const rolex = insertItemKind(db, {
      code: "rolex", displayName: "Rolex", category: "watches", baseValue: 8000,
    });
    const rulex = insertItemKind(db, {
      code: "rulex", displayName: "Rulex", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: rolex.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    // Asker is uncertain about identity — gives both kinds weight.
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "id", kindId: rulex.id }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    // Asker has uncertain condition too.
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: { axis: "condition", tier: "shoddy" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    // Hypothetical price quotes: "mint Rulex" and "shoddy Rolex".
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: {
        axis: "price", low: 100, high: 110,
        forKindId: rulex.id, forTier: "mint",
      },
      confidence: 0.95,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    recordBelief(db, {
      actorId: a.id, lotId: lot.id,
      value: {
        axis: "price", low: 3800, high: 3900,
        forKindId: rolex.id, forTier: "shoddy",
      },
      confidence: 0.95,
      sourcedFromActorId: null, acquiredDay: 1,
    });
    const band = computeExtractionBand(db, a.id, lot.id);
    // Both endpoint combos plausible. The aggregator must span at
    // least the £100..£3900 union, with priors filling in the other
    // two combos (mint Rolex, shoddy Rulex).
    expect(band.low).toBeLessThanOrEqual(110);
    expect(band.high).toBeGreaterThanOrEqual(3900);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  insertActor,
  adjustActorCash,
  getActorById,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { recordBelief } from "../src/engine/knowledge/beliefs-repo.js";
import { computeExtractionBand } from "../src/engine/knowledge/extraction-band.js";
import {
  makeBuyerParty,
  makeSellerParty,
} from "../src/engine/knowledge/haggle-anchors.js";
import { runRuleBasedNegotiation } from "../src/engine/negotiation/rule-based.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";

/**
 * The canonical worked example — the information-asymmetry dynamic
 * demonstrated through *condition* misreading (not identity confusion;
 * goods in this game are *watches*, not Rolex-vs-Rulex).
 *
 *   1. Del comes into a mint watch at clearance cost £25.
 *   2. Del wrongly believes the watch is broken (he's not a watch expert).
 *   3. Mickey quotes him a price band for "broken watch" — tight £1800–£2000.
 *   4. Del's working belief: a broken watch worth £1800–£2000 per unit.
 *   5. Del sells to Boyce. Boyce sees on sight the watch is mint and plays
 *      inside Del's frame — opens below Del's ask, haggle settles in Del's
 *      frame.
 *   6. Boyce now refines: he confirms mint condition and gets a mint-watch
 *      price band — his extraction band lands around the true value
 *      (£12000-ish).
 *
 * What the test asserts:
 *   - Del's pre-sale extraction band is around £1800–£2000.
 *   - Boyce's pre-sale extraction band (condition-uncertain) spans wide.
 *   - The haggle settles inside Del's frame (under his target).
 *   - Boyce's post-refinement band lands near true mint value.
 *   - The information surplus accrues to Boyce.
 */
describe("canonical watch arc — condition asymmetry", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("Del-naive-anchor: the asymmetric-knowledge dynamic settles inside Del's frame", () => {
    db = freshDB();

    // ── Cast ──────────────────────────────────────────────────────
    const del = insertActor(db, {
      code: "del", displayName: "Del Boy", cash: 1000,
    });
    const boyce = insertActor(db, {
      code: "boyce", displayName: "Boyce", cash: 20000,
    });
    const mickey = insertActor(db, {
      code: "mickey", displayName: "Mickey Pearce",
    });

    // ── Catalogue ─────────────────────────────────────────────────
    const watch = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches",
      baseValue: 8000,
    });

    // ── Del's clearance haul: one mint watch, £25 cost. ──
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: watch.id,
      qualityTier: "mint",
      quantity: 1,
      acquiredUnitPrice: 25,
      acquiredDay: 1,
    });

    // ── Del's condition belief: he can't read watches; he reckons
    // it's broken. (Wrong: it's mint.) ──
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "broken" },
      confidence: 0.8,
      sourcedFromActorId: null,
      acquiredDay: 2,
    });

    // ── Mickey quotes a tight price band for "broken watch"
    // specifically. (broken-tier multiplier ≈ 0.25 × baseValue 8000 ≈
    // £2000.) ──
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price",
        low: 1800,
        high: 2000,
        forTier: "broken",
      },
      confidence: 0.95,
      sourcedFromActorId: mickey.id,
      acquiredDay: 2,
    });

    // ── Del's extraction band — driven entirely by the matched
    // price belief, since condition is pinned. ──
    const delBand = computeExtractionBand(db, del.id, lot.id);
    expect(delBand.low).toBe(1800);
    expect(delBand.high).toBe(2000);
    expect(delBand.unsupported).toBe(false);

    // ── Boyce sees the watch and has no condition belief yet —
    // uniform prior over tiers. ──
    const boyceBandPreSale = computeExtractionBand(db, boyce.id, lot.id);
    // Wide: spans watch × {broken..mint}.
    expect(boyceBandPreSale.low).toBeLessThan(3000);
    expect(boyceBandPreSale.high).toBeGreaterThan(10000);

    // ── Haggle: Del opens £2000, Boyce plays inside Del's frame
    // (informedQuietMode). ──
    const seller = makeSellerParty(del.id, delBand, {
      anchorAggression: 1.0,
      floorMultiplier: 0.7, // willing to drop to £1260
      concedeRate: 0.2,
    });
    expect(seller.target).toBe(2000);
    expect(seller.floor).toBe(1260);

    const buyer = makeBuyerParty({
      actorId: boyce.id,
      band: boyceBandPreSale,
      cashCap: 20000,
      sellerOpen: seller.target,
      opts: {
        informedQuietMode: true,
        ceilingFraction: 0.6,
        openFraction: 0.3,
        concedeRate: 0.2,
      },
    });
    // In informed-quiet mode, Boyce's effective opening is well
    // below Del's £2000 ask.
    expect(buyer.target).toBeLessThan(seller.target);

    // Cap the buyer's effective ceiling so the haggle stays in Del's
    // frame — informedQuietMode is about playing inside the seller's
    // number, not blasting through it.
    const cappedBuyer = {
      ...buyer,
      ceiling: Math.max(seller.target + 300, Math.round(seller.target * 1.5)),
    };

    const negotiated = runRuleBasedNegotiation(
      {
        itemKindId: watch.id,
        qualityTier: "mint",
        quantity: 1,
        seller,
        buyer: cappedBuyer,
        initiator: "seller",
        maxRounds: 30,
      },
      createRNG("haggle"),
    );

    expect(negotiated.type).toBe("agreed");
    if (negotiated.type !== "agreed") throw new Error();
    // Settles inside Del's belief frame: above his floor, at or
    // below his target.
    expect(negotiated.unitPrice).toBeGreaterThanOrEqual(seller.floor);
    expect(negotiated.unitPrice).toBeLessThanOrEqual(seller.target);

    // ── The information surplus dynamic: Boyce just bought a
    // £12000-true-value mint watch for under £2000. ──
    const settled = negotiated.unitPrice;

    // Simulate settlement — cash moves, stock transfers.
    adjustActorCash(db, del.id, settled);
    adjustActorCash(db, boyce.id, -settled);
    const boyceLot = insertStockLot(db, {
      ownerActorId: boyce.id,
      itemKindId: watch.id,
      qualityTier: "mint",
      quantity: 1,
      acquiredUnitPrice: settled,
      acquiredDay: 3,
    });

    // ── Boyce refines condition. He gets a confident mint-tier
    // belief and a tight price band on "mint watch". ──
    recordBelief(db, {
      actorId: boyce.id, lotId: boyceLot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 3,
    });
    recordBelief(db, {
      actorId: boyce.id, lotId: boyceLot.id,
      value: {
        axis: "price",
        low: 11500, high: 12500,
        forTier: "mint",
      },
      confidence: 0.95,
      sourcedFromActorId: mickey.id, acquiredDay: 3,
    });
    const boyceBandPostRefine = computeExtractionBand(db, boyce.id, boyceLot.id);
    // Tightly anchored on the post-refine band — many multiples
    // above his acquisition cost.
    expect(boyceBandPostRefine.low).toBe(11500);
    expect(boyceBandPostRefine.high).toBe(12500);
    expect(boyceBandPostRefine.low / Math.max(1, settled)).toBeGreaterThan(5);

    // ── Sanity: Del walks away "happy" (positive vs his cost),
    // never knowing what just happened. ──
    expect(getActorById(db, del.id)!.cash).toBeGreaterThan(1000);
    expect(settled - 25).toBeGreaterThan(0); // net profit on his books
  });

  it("Del-hedge-anchor variant: uncertain Del anchors high and captures most of the surplus", () => {
    db = freshDB();

    const del = insertActor(db, { code: "del", displayName: "Del", cash: 1000 });
    const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 20000 });
    const mickey = insertActor(db, { code: "m", displayName: "Mickey" });

    const watch = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches", baseValue: 8000,
    });

    const lot = insertStockLot(db, {
      ownerActorId: del.id, itemKindId: watch.id, qualityTier: "mint",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // ── Del's HEDGE state: he has BOTH condition beliefs (mint and
    // broken at 50/50) and quotes for both. The aggregator unions them. ──
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "broken" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price", low: 11500, high: 12500,
        forTier: "mint",
      },
      confidence: 0.95, sourcedFromActorId: mickey.id, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price", low: 1800, high: 2000,
        forTier: "broken",
      },
      confidence: 0.95, sourcedFromActorId: mickey.id, acquiredDay: 2,
    });

    const delHedgeBand = computeExtractionBand(db, del.id, lot.id);
    // The band spans roughly £1800..£12500.
    expect(delHedgeBand.low).toBeLessThanOrEqual(2000);
    expect(delHedgeBand.high).toBeGreaterThanOrEqual(11500);

    // Del anchors HIGH — opens at the top of his honest band.
    const seller = makeSellerParty(del.id, delHedgeBand, {
      anchorAggression: 1.0,
      floorMultiplier: 0.6,
      concedeRate: 0.15,
    });
    expect(seller.target).toBeGreaterThanOrEqual(11500);

    // ── Boyce knows nothing about condition yet — uniform prior. ──
    const boyceBand = computeExtractionBand(db, boyce.id, lot.id);
    const buyer = makeBuyerParty({
      actorId: boyce.id, band: boyceBand, cashCap: 20000,
      sellerOpen: seller.target,
      opts: { ceilingFraction: 0.9, openFraction: 0.3, concedeRate: 0.15 },
    });
    // Boyce's ceiling — comfortably above Del's ask given the
    // mint-end of the watch could push to £15000.
    expect(buyer.ceiling).toBeGreaterThan(seller.target);

    const negotiated = runRuleBasedNegotiation(
      {
        itemKindId: watch.id,
        qualityTier: "mint",
        quantity: 1,
        seller,
        buyer,
        initiator: "seller",
        maxRounds: 30,
      },
      createRNG("hedge"),
    );
    expect(negotiated.type).toBe("agreed");
    if (negotiated.type !== "agreed") throw new Error();

    // The hedge-anchor outcome: Del's profit is dramatically larger
    // than the naive-anchor case. He walks away with thousands net
    // on a £25 watch. The information surplus flips toward Del.
    const settled = negotiated.unitPrice;
    expect(settled).toBeGreaterThan(5000);
    expect(settled - 25).toBeGreaterThan(4000);
  });
});

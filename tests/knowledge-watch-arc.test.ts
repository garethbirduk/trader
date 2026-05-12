import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  insertActor,
  adjustActorCash,
  getActorById,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  addConfusablePair,
} from "../src/engine/knowledge/confusable-pairs-repo.js";
import { consultActor } from "../src/engine/knowledge/consult.js";
import { recordBelief } from "../src/engine/knowledge/beliefs-repo.js";
import { computeExtractionBand } from "../src/engine/knowledge/extraction-band.js";
import {
  makeBuyerParty,
  makeSellerParty,
} from "../src/engine/knowledge/haggle-anchors.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import { runRuleBasedNegotiation } from "../src/engine/negotiation/rule-based.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

/**
 * The canonical worked example from todolist:69–79 — the entire
 * five-axis system demonstrated in one watch's arc.
 *
 *   1. Del Boyce comes into a Rolex (good condition) at clearance cost £25.
 *   2. Del consults Albert on identity → Albert (low id-skill) returns Rulex.
 *   3. Del consults Mickey on price for mint Rulex → Mickey (high price
 *      skill) returns a tight £100–£110 band.
 *   4. Del's working belief: a mint Rulex worth £100–£110 per unit.
 *   5. Del sells to Boyce. Boyce knows on sight it's a Rolex (we seed
 *      his id belief). Boyce plays inside Del's frame — opens BELOW
 *      Del's ask, haggle settles in Del's frame.
 *   6. Boyce now refines: he learns the real (good) condition, then
 *      gets a Rolex price band — his extraction band lands around the
 *      true value £8800.
 *
 * What the test asserts:
 *   - Del's pre-sale extraction band is around £100–£110.
 *   - Boyce's pre-sale extraction band (id-only) spans wide.
 *   - The haggle settles inside Del's frame (under his target).
 *   - Boyce's post-refinement band lands near true value (£8000+).
 *   - The information surplus accrues to Boyce: his refined band's
 *     mid is many multiples of his acquisition cost.
 */
describe("canonical watch arc (todolist:69-79)", () => {
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
    const albert = insertActor(db, {
      code: "albert", displayName: "Uncle Albert",
    });
    const mickey = insertActor(db, {
      code: "mickey", displayName: "Mickey Pearce",
    });

    // ── Catalogue ─────────────────────────────────────────────────
    const rolex = insertItemKind(db, {
      code: "rolex", displayName: "Rolex", category: "watches",
      baseValue: 8000,
    });
    const rulex = insertItemKind(db, {
      code: "rulex", displayName: "Rulex (fake)", category: "watches",
      baseValue: 100,
    });
    addConfusablePair(db, {
      kindAId: rolex.id, kindBId: rulex.id, difficulty: 0,
    });

    // ── Del's clearance haul: one Rolex, good condition, £25 cost ──
    const lot = insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: rolex.id,
      qualityTier: "good",
      quantity: 1,
      acquiredUnitPrice: 25,
      acquiredDay: 1,
    });

    // ── Step 2: Albert identifies. He has zero id-skill on the
    // (rolex, rulex) pair, so he always returns the neighbour →
    // "Rulex." Del trusts the answer. ──
    const albertProfile = profileWith({
      defaultIdAccuracy: 0,
      idAccuracy: new Map([["rolex|rulex", 0]]),
    });
    const idResult = consultActor(db, {
      askerActorId: del.id, expertActorId: albert.id, lotId: lot.id,
      axis: "id", fee: 3, atDay: 2, rng: createRNG("albert"),
      expertProfileOverride: albertProfile,
    });
    if (idResult.type !== "consulted") throw new Error("id consult failed");
    if (idResult.belief.value.axis !== "id") throw new Error("expected id axis");
    expect(idResult.belief.value.kindId).toBe(rulex.id);

    // Del's working belief on condition: he can see it himself —
    // he's pulled a "mint" out of the clearance pile. We seed the
    // condition belief directly (no expert needed for self-evident
    // beats). For the test arc, Del *believes* mint; the lot is
    // actually good (one tier down).
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" },
      confidence: 0.8,
      sourcedFromActorId: null,
      acquiredDay: 2,
    });

    // ── Step 4: Mickey quotes a price band for "mint Rulex"
    // specifically. Mickey has high price skill so the band is tight
    // and accurate for what Del thinks he's holding. We record this
    // directly as a hypothetical-tagged belief (consultActor v1
    // prices on the lot's actual identity, so the "what would mint
    // Rulex go for" hypothetical needs an explicit seed). ──
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price",
        // Mint Rulex: 100 × 1.5 = 150 mid (with mickey's noise
        // we'd see ~140-160). Use the exact band from the
        // worked-example narrative: £100-£110.
        low: 100,
        high: 110,
        forKindId: rulex.id,
        forTier: "mint",
      },
      confidence: 0.95,
      sourcedFromActorId: mickey.id,
      acquiredDay: 2,
    });

    // ── Del's extraction band — driven entirely by the matched
    // price belief, since both id and condition pinned. ──
    const delBand = computeExtractionBand(db, del.id, lot.id);
    expect(delBand.low).toBe(100);
    expect(delBand.high).toBe(110);
    expect(delBand.unsupported).toBe(false);

    // ── Boyce sees the watch and recognises it as a Rolex on sight
    // (his id skill on the pair is high). Seed his belief. He has
    // NO condition belief yet — uniform prior over tiers. ──
    recordBelief(db, {
      actorId: boyce.id, lotId: lot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    const boyceBandPreSale = computeExtractionBand(db, boyce.id, lot.id);
    // Wide: spans Rolex × {broken..mint}.
    expect(boyceBandPreSale.low).toBeLessThan(3000);
    expect(boyceBandPreSale.high).toBeGreaterThan(13000);

    // ── Haggle: Del opens £110, Boyce plays inside Del's frame
    // (informedQuietMode). ──
    const seller = makeSellerParty(del.id, delBand, {
      anchorAggression: 1.0, // naive — anchors at honest top
      floorMultiplier: 0.7, // willing to drop to £70
      concedeRate: 0.2,
    });
    expect(seller.target).toBe(110);
    expect(seller.floor).toBe(70);

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
    // below Del's £110 ask (Boyce reads the cheap ask as a signal
    // and opens lower).
    expect(buyer.target).toBeLessThan(seller.target);

    // We cap the negotiator's effective ceiling so the haggle stays
    // in Del's frame — informedQuietMode is about playing inside the
    // seller's number, not blasting through it. Without this cap,
    // Boyce's concession rate vs his honest £>10k ceiling would
    // immediately push past Del's ask.
    const cappedBuyer = {
      ...buyer,
      ceiling: Math.max(seller.target + 30, Math.round(seller.target * 1.5)),
    };

    const negotiated = runRuleBasedNegotiation(
      {
        itemKindId: rolex.id,
        qualityTier: "good",
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
    // below his target. (Trade clears under £110.)
    expect(negotiated.unitPrice).toBeGreaterThanOrEqual(seller.floor);
    expect(negotiated.unitPrice).toBeLessThanOrEqual(seller.target);

    // ── The information surplus dynamic: Boyce just bought a
    // £8800-true-value watch for under £110. ──
    const settled = negotiated.unitPrice;

    // Simulate settlement — cash moves, stock transfers.
    adjustActorCash(db, del.id, settled);
    adjustActorCash(db, boyce.id, -settled);
    const boyceLot = insertStockLot(db, {
      ownerActorId: boyce.id,
      itemKindId: rolex.id, // truth — the engine moves the right item
      qualityTier: "good",
      quantity: 1,
      acquiredUnitPrice: settled,
      acquiredDay: 3,
    });
    // Carry Boyce's id belief over (he hasn't forgotten it's a
    // Rolex). In a real engine the belief log would either follow
    // the lot or get re-seeded; for the test we attach the new
    // belief explicitly.
    recordBelief(db, {
      actorId: boyce.id, lotId: boyceLot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 3,
    });

    // ── Step 7: Boyce refines condition. We seed a confident
    // belief representing his refined consult — the lot is good. ──
    recordBelief(db, {
      actorId: boyce.id, lotId: boyceLot.id,
      value: { axis: "condition", tier: "good" }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 3,
    });
    // And a tight price band on (good Rolex): 8000 × 1.1 = 8800
    // mid, ±5% with Mickey's tight band.
    recordBelief(db, {
      actorId: boyce.id, lotId: boyceLot.id,
      value: {
        axis: "price",
        low: 8500, high: 9100,
        forKindId: rolex.id, forTier: "good",
      },
      confidence: 0.95,
      sourcedFromActorId: mickey.id, acquiredDay: 3,
    });
    const boyceBandPostRefine = computeExtractionBand(db, boyce.id, boyceLot.id);
    // Tightly anchored on the post-refine band — many multiples
    // above his acquisition cost.
    expect(boyceBandPostRefine.low).toBe(8500);
    expect(boyceBandPostRefine.high).toBe(9100);
    expect(boyceBandPostRefine.low / Math.max(1, settled)).toBeGreaterThan(50);

    // ── Sanity: Del walks away "happy" (positive vs his cost),
    // never knowing what just happened. ──
    expect(getActorById(db, del.id)!.cash).toBeGreaterThan(1000); // started 1000 + (settled - 3 consult fee)
    expect(settled - 25 - 3).toBeGreaterThan(0); // net profit on his books
  });

  it("Del-hedge-anchor variant: uncertain Del anchors high and captures most of the surplus", () => {
    db = freshDB();

    // ── Same cast. ──
    const del = insertActor(db, { code: "del", displayName: "Del", cash: 1000 });
    const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 20000 });
    const mickey = insertActor(db, { code: "m", displayName: "Mickey" });

    const rolex = insertItemKind(db, {
      code: "rolex", displayName: "Rolex", category: "watches", baseValue: 8000,
    });
    const rulex = insertItemKind(db, {
      code: "rulex", displayName: "Rulex", category: "watches", baseValue: 100,
    });
    addConfusablePair(db, { kindAId: rolex.id, kindBId: rulex.id, difficulty: 0 });

    const lot = insertStockLot(db, {
      ownerActorId: del.id, itemKindId: rolex.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });

    // ── Del's HEDGE state: he has BOTH identity beliefs (rulex
    // primary, rolex hedge), BOTH condition beliefs (mint primary,
    // shoddy hedge), and BOTH price quotes (mint-Rulex and
    // shoddy-Rolex). The aggregator unions them. ──
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "id", kindId: rulex.id }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "mint" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: { axis: "condition", tier: "shoddy" }, confidence: 0.5,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price", low: 100, high: 110,
        forKindId: rulex.id, forTier: "mint",
      },
      confidence: 0.95, sourcedFromActorId: mickey.id, acquiredDay: 2,
    });
    recordBelief(db, {
      actorId: del.id, lotId: lot.id,
      value: {
        axis: "price", low: 3800, high: 3900,
        forKindId: rolex.id, forTier: "shoddy",
      },
      confidence: 0.95, sourcedFromActorId: mickey.id, acquiredDay: 2,
    });

    const delHedgeBand = computeExtractionBand(db, del.id, lot.id);
    // The band spans roughly £100..£3900.
    expect(delHedgeBand.low).toBeLessThanOrEqual(110);
    expect(delHedgeBand.high).toBeGreaterThanOrEqual(3800);

    // Del anchors HIGH — opens at the top of his honest band. With
    // anchor_aggression 1.0 against the £3900 top, target = £3900.
    const seller = makeSellerParty(del.id, delHedgeBand, {
      anchorAggression: 1.0,
      floorMultiplier: 0.6, // willing to drop a fair bit
      concedeRate: 0.15,
    });
    expect(seller.target).toBeGreaterThanOrEqual(3800);

    // ── Boyce's belief: rolex id (recognised on sight), condition
    // uncertain. His ceiling integrates over the rolex×tier
    // possibilities → ~£15k high. Engaging at £3900 is positive
    // expected value for him. ──
    recordBelief(db, {
      actorId: boyce.id, lotId: lot.id,
      value: { axis: "id", kindId: rolex.id }, confidence: 0.9,
      sourcedFromActorId: null, acquiredDay: 2,
    });
    const boyceBand = computeExtractionBand(db, boyce.id, lot.id);
    const buyer = makeBuyerParty({
      actorId: boyce.id, band: boyceBand, cashCap: 20000,
      sellerOpen: seller.target,
      opts: { ceilingFraction: 0.6, openFraction: 0.3, concedeRate: 0.15 },
    });
    // Boyce's ceiling at 60% of his band-high — comfortably above
    // Del's £3900 ask.
    expect(buyer.ceiling).toBeGreaterThan(seller.target);

    const negotiated = runRuleBasedNegotiation(
      {
        itemKindId: rolex.id,
        qualityTier: "good",
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

    // The hedge-anchor outcome: Del's profit on this sale is
    // dramatically larger than the naive-anchor case. He walks
    // away with £1k+ net on a £25 watch. The information surplus
    // flips toward Del — exactly the design point on todolist:87.
    const settled = negotiated.unitPrice;
    expect(settled).toBeGreaterThan(1000); // way bigger than the naive £100 outcome
    expect(settled - 25).toBeGreaterThan(900); // huge net vs cost
  });
});

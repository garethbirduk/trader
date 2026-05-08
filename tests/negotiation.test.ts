import { describe, it, expect } from "vitest";
import { createRNG } from "../src/engine/core/rng.js";
import { runRuleBasedNegotiation } from "../src/engine/negotiation/rule-based.ts";
import type {
  BuyerParty,
  NegotiationContext,
  SellerParty,
} from "../src/engine/negotiation/types.js";

function ctx(overrides: Partial<NegotiationContext> = {}): NegotiationContext {
  const seller: SellerParty = {
    actorId: 1,
    floor: 20,
    target: 40,
    concedeRate: 0.3,
    ...(overrides.seller ?? {}),
  };
  const buyer: BuyerParty = {
    actorId: 2,
    ceiling: 50,
    target: 25,
    concedeRate: 0.3,
    ...(overrides.buyer ?? {}),
  };
  return {
    itemKindId: 1,
    qualityTier: "good",
    quantity: 10,
    seller,
    buyer,
    initiator: "seller",
    maxRounds: 20,
    ...overrides,
  };
}

describe("rule-based negotiation", () => {
  it("walks immediately when seller floor exceeds buyer ceiling", () => {
    const r = runRuleBasedNegotiation(
      ctx({
        seller: { actorId: 1, floor: 100, target: 120, concedeRate: 0.3 },
        buyer: { actorId: 2, ceiling: 50, target: 30, concedeRate: 0.3 },
      }),
      createRNG("a"),
    );
    expect(r.type).toBe("walked");
    if (r.type === "walked") expect(r.reason).toMatch(/no overlap/);
  });

  it("agrees when ranges overlap", () => {
    const r = runRuleBasedNegotiation(ctx(), createRNG("a"));
    expect(r.type).toBe("agreed");
    if (r.type === "agreed") {
      // Final price must be inside the zone of possible agreement.
      expect(r.unitPrice).toBeGreaterThanOrEqual(20);
      expect(r.unitPrice).toBeLessThanOrEqual(50);
    }
  });

  it("agrees instantly when seller's opening price is already below buyer's target", () => {
    const r = runRuleBasedNegotiation(
      ctx({
        seller: { actorId: 1, floor: 10, target: 20, concedeRate: 0.3 },
        buyer: { actorId: 2, ceiling: 100, target: 25, concedeRate: 0.3 },
        initiator: "seller",
      }),
      createRNG("a"),
    );
    expect(r.type).toBe("agreed");
    if (r.type === "agreed") {
      // Buyer's first move sees seller's ask of 20; their position is 25 (>= 20), so they accept at 20.
      expect(r.unitPrice).toBe(20);
    }
  });

  it("favours the harder bargainer (lower concedeRate ⇒ better outcome for them)", () => {
    // Buyer is the hard bargainer; final price should be near seller's floor.
    const buyerHard = runRuleBasedNegotiation(
      ctx({
        seller: { actorId: 1, floor: 20, target: 50, concedeRate: 0.5 },
        buyer: { actorId: 2, ceiling: 50, target: 20, concedeRate: 0.05 },
      }),
      createRNG("a"),
    );
    // Seller is the hard bargainer; final price should be near buyer's ceiling.
    const sellerHard = runRuleBasedNegotiation(
      ctx({
        seller: { actorId: 1, floor: 20, target: 50, concedeRate: 0.05 },
        buyer: { actorId: 2, ceiling: 50, target: 20, concedeRate: 0.5 },
      }),
      createRNG("a"),
    );
    expect(buyerHard.type).toBe("agreed");
    expect(sellerHard.type).toBe("agreed");
    if (buyerHard.type === "agreed" && sellerHard.type === "agreed") {
      expect(buyerHard.unitPrice).toBeLessThan(sellerHard.unitPrice);
    }
  });

  it("walks if maxRounds is too tight for convergence", () => {
    const r = runRuleBasedNegotiation(
      ctx({
        seller: { actorId: 1, floor: 20, target: 1000, concedeRate: 0.05 },
        buyer: { actorId: 2, ceiling: 50, target: 21, concedeRate: 0.05 },
        maxRounds: 3,
      }),
      createRNG("a"),
    );
    expect(r.type).toBe("walked");
  });

  it("is deterministic for a given seed and inputs", () => {
    const a = runRuleBasedNegotiation(ctx(), createRNG("seed-x"));
    const b = runRuleBasedNegotiation(ctx(), createRNG("seed-x"));
    expect(a).toEqual(b);
  });

  it("emits a turn log: open → counters → accept", () => {
    const r = runRuleBasedNegotiation(ctx(), createRNG("a"));
    expect(r.turns[0]?.action).toBe("open");
    const last = r.turns[r.turns.length - 1];
    expect(last?.action === "accept" || last?.action === "walk").toBe(true);
  });

  it("never agrees outside the zone of possible agreement", () => {
    for (let i = 0; i < 50; i += 1) {
      const r = runRuleBasedNegotiation(
        ctx({
          seller: { actorId: 1, floor: 30, target: 80, concedeRate: 0.1 + i * 0.01 },
          buyer: { actorId: 2, ceiling: 60, target: 40, concedeRate: 0.05 + i * 0.01 },
        }),
        createRNG(`seed-${i}`),
      );
      if (r.type === "agreed") {
        expect(r.unitPrice).toBeGreaterThanOrEqual(30);
        expect(r.unitPrice).toBeLessThanOrEqual(60);
      }
    }
  });

  it("rejects invalid context", () => {
    const rng = createRNG("a");
    expect(() => runRuleBasedNegotiation(ctx({ quantity: 0 }), rng)).toThrow();
    expect(() =>
      runRuleBasedNegotiation(
        ctx({ seller: { actorId: 1, floor: 50, target: 30, concedeRate: 0.3 } }),
        rng,
      ),
    ).toThrow();
    expect(() =>
      runRuleBasedNegotiation(
        ctx({ buyer: { actorId: 2, ceiling: 30, target: 40, concedeRate: 0.3 } }),
        rng,
      ),
    ).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { createRNG } from "../src/engine/core/rng.js";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { addConfusablePair } from "../src/engine/knowledge/confusable-pairs-repo.js";
import { persistKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import {
  estimateCondition,
  estimateConditionPure,
  estimateIdentity,
  estimateIdentityPure,
} from "../src/engine/perception/arms.js";
import { pairCode } from "../src/engine/knowledge/types.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

const ROLEX_RULEX = pairCode("rolex", "rulex"); // "rolex|rulex"

describe("estimateIdentityPure", () => {
  it("kind with no neighbours: always returns truth, no confusion", () => {
    const r = estimateIdentityPure({
      profile: FALLBACK_KNOWLEDGE_PROFILE,
      truthItemKindId: 42,
      neighbours: [],
      rng: createRNG("id-pure-1"),
    });
    expect(r.perceivedKindId).toBe(42);
    expect(r.passed).toBe(true);
    expect(r.confusedWithKindId).toBeNull();
  });

  it("expert (1.0 expertise, easy pair) reliably gets truth", () => {
    const profile = profileWith({
      idAccuracy: new Map([[ROLEX_RULEX, 1.0]]),
    });
    let passes = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = estimateIdentityPure({
        profile,
        truthItemKindId: 1,
        neighbours: [{ kindId: 2, pairCode: ROLEX_RULEX, difficulty: 0 }],
        rng: createRNG(`id-expert-${i}`),
      });
      if (r.passed) passes += 1;
    }
    expect(passes).toBe(200);
  });

  it("clueless (0.0 expertise) always confuses with the neighbour", () => {
    const profile = profileWith({
      idAccuracy: new Map([[ROLEX_RULEX, 0]]),
    });
    let confused = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = estimateIdentityPure({
        profile,
        truthItemKindId: 1,
        neighbours: [{ kindId: 2, pairCode: ROLEX_RULEX, difficulty: 0 }],
        rng: createRNG(`id-clueless-${i}`),
      });
      if (!r.passed) {
        confused += 1;
        expect(r.perceivedKindId).toBe(2);
      }
    }
    expect(confused).toBe(200);
  });

  it("high pair difficulty caps even an expert's pass rate", () => {
    const profile = profileWith({
      idAccuracy: new Map([[ROLEX_RULEX, 1.0]]),
    });
    // difficulty 0.9 → effective pass rate = 1.0 * (1-0.9) = 0.1
    let passes = 0;
    for (let i = 0; i < 400; i += 1) {
      const r = estimateIdentityPure({
        profile,
        truthItemKindId: 1,
        neighbours: [{ kindId: 2, pairCode: ROLEX_RULEX, difficulty: 0.9 }],
        rng: createRNG(`id-diff-${i}`),
      });
      if (r.passed) passes += 1;
    }
    // Expect ~10% pass rate. Allow wide tolerance for the 400-sample stat.
    expect(passes / 400).toBeGreaterThan(0.03);
    expect(passes / 400).toBeLessThan(0.18);
  });
});

describe("estimateConditionPure", () => {
  it("expert always returns the truth tier", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 1.0]]),
    });
    for (let i = 0; i < 50; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "electrical",
        rng: createRNG(`cond-expert-${i}`),
      });
      expect(r.perceivedTier).toBe("good");
      expect(r.passed).toBe(true);
    }
  });

  it("clueless (expertise=0, j=0) produces a roughly uniform distribution across all five tiers", () => {
    // v2: centre lerps to the condition anchor (0.5 = fair) and the
    // band spans the full quality range. At j=0 the draw is uniform
    // — perceived tier is essentially a coin flip across all five.
    // Replaces v1's "always adjacent" pin.
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    const counts: Record<string, number> = {
      broken: 0, shoddy: 0, fair: 0, good: 0, mint: 0,
    };
    const trials = 1000;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "electrical",
        rng: createRNG(`cond-clueless-uniform-${i}`),
      });
      counts[r.perceivedTier]! += 1;
    }
    // Each tier sits in a 0.2-wide slice of [0, 1]; a true uniform
    // would land 20% each. Generous tolerance for sample noise.
    for (const tier of ["broken", "shoddy", "fair", "good", "mint"]) {
      const frac = counts[tier]! / trials;
      expect(frac).toBeGreaterThan(0.12);
      expect(frac).toBeLessThan(0.28);
    }
  });

  it("clueless with truth=mint can see any tier (not clamped to adjacent)", () => {
    // v1 pinned "mint → only good"; v2 lets the band span the full
    // quality range when expertise is 0, so the actor can see
    // anything including broken with bad luck.
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "mint",
        category: "electrical",
        rng: createRNG(`cond-mint-anything-${i}`),
      });
      seen.add(r.perceivedTier);
    }
    // All five tiers should appear at least once across 500 trials.
    expect(seen.size).toBe(5);
  });

  it("clueless with truth=broken can see any tier (not clamped to adjacent)", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "broken",
        category: "electrical",
        rng: createRNG(`cond-broken-anything-${i}`),
      });
      seen.add(r.perceivedTier);
    }
    expect(seen.size).toBe(5);
  });

  it("expertise sourced per-category — unknown category falls back to default", () => {
    // v2 derived `passed` semantically the same way, but the failure
    // distribution is no longer adjacent-only. We assert the
    // mechanical category fallback (zero expertise → noisy reads)
    // rather than a specific tier outcome.
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 1.0]]),
      defaultConditionAccuracy: 0,
    });
    let passesElec = 0;
    let passesFurn = 0;
    const trials = 100;
    for (let i = 0; i < trials; i += 1) {
      const elec = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "electrical",
        rng: createRNG(`cond-cat-elec-${i}`),
      });
      const furn = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "furniture",
        rng: createRNG(`cond-cat-furn-${i}`),
      });
      if (elec.passed) passesElec += 1;
      if (furn.passed) passesFurn += 1;
    }
    // Electrical specialist → all hits truth. Unknown category →
    // falls to default (0), so band is wide → ~20% chance of
    // landing on "good" by uniform luck.
    expect(passesElec).toBe(trials);
    expect(passesFurn / trials).toBeGreaterThan(0.05);
    expect(passesFurn / trials).toBeLessThan(0.35);
  });

  it("mid-expertise produces a band centred near truth, narrower than clueless", () => {
    // v2-specific: a 0.5-expertise / 0.5-j actor's centre sits
    // halfway between anchor and truth, and the band's half-width
    // is (1 - effectiveJ) / 2. At j=0.5 effectiveJ=0.5 → half-width
    // 0.25. Outcomes should cluster around truth, not span the full
    // range.
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0.5]]),
    });
    let onOrAdjacent = 0;
    const trials = 500;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "electrical",
        rng: createRNG(`cond-mid-${i}`),
      });
      if (["fair", "good", "mint"].includes(r.perceivedTier)) onOrAdjacent += 1;
    }
    // Most outcomes should be within one tier of truth.
    expect(onOrAdjacent / trials).toBeGreaterThan(0.7);
  });
});

describe("estimateIdentity (DB-backed)", () => {
  it("end-to-end: registered confusable pair + actor expertise drives outcome", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "rodney",
      displayName: "Rodney",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const rolex = insertItemKind(db, {
      code: "rolex",
      displayName: "Rolex",
      category: "luxury",
      baseValue: 1000,
      spawnWeight: 1,
      size: "small",
      targetCustomers: ["yuppies"],
    }).id;
    const rulex = insertItemKind(db, {
      code: "rulex",
      displayName: "Rulex",
      category: "luxury",
      baseValue: 50,
      spawnWeight: 1,
      size: "small",
      targetCustomers: ["yuppies"],
    }).id;
    addConfusablePair(db, { kindAId: rolex, kindBId: rulex, difficulty: 0.5 });

    // Expert on this pair: should mostly identify Rolex correctly.
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        idAccuracy: new Map([[pairCode("rolex", "rulex"), 1.0]]),
      }),
    );
    let passes = 0;
    const trials = 200;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateIdentity({
        db,
        actorId: aid,
        truthItemKindId: rolex,
        rng: createRNG(`e2e-id-${i}`),
      });
      if (r.passed) passes += 1;
    }
    // effective pass = 1.0 * (1 - 0.5) = 0.5 → ~50% passes
    expect(passes / trials).toBeGreaterThan(0.35);
    expect(passes / trials).toBeLessThan(0.65);
  });
});

describe("estimateCondition (DB-backed)", () => {
  it("loads expertise from persisted profile and produces band-and-sample reads", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "trigger",
      displayName: "Trigger",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        conditionAccuracy: new Map([["electrical", 0]]),
        defaultConditionAccuracy: 0,
      }),
    );
    // Truth = "fair" = quality 0.5 = the condition anchor. A clueless
    // actor at j=0 draws uniformly across [0, 1]. About 20% of trials
    // should snap back to "fair" by luck (the central tier slice).
    let onTier = 0;
    const seen = new Set<string>();
    const trials = 200;
    for (let i = 0; i < trials; i += 1) {
      const r = estimateCondition({
        db,
        actorId: aid,
        truthTier: "fair",
        category: "electrical",
        rng: createRNG(`e2e-cond-${i}`),
      });
      seen.add(r.perceivedTier);
      if (r.passed) onTier += 1;
    }
    // Should see a wide range of tier outcomes, not just adjacents.
    expect(seen.size).toBeGreaterThanOrEqual(4);
    // Passes happen at ~20% by uniform luck; assert it isn't zero or
    // everything.
    expect(onTier).toBeGreaterThan(0);
    expect(onTier).toBeLessThan(trials);
  });
});

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

  it("clueless always slips to an adjacent tier", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    for (let i = 0; i < 50; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "electrical",
        rng: createRNG(`cond-clueless-${i}`),
      });
      expect(r.passed).toBe(false);
      // 'good' is adjacent to 'mint' and 'fair'.
      expect(["mint", "fair"]).toContain(r.perceivedTier);
    }
  });

  it("mint slips only downwards to good (clamped at top)", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    for (let i = 0; i < 30; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "mint",
        category: "electrical",
        rng: createRNG(`cond-mint-${i}`),
      });
      expect(r.perceivedTier).toBe("good");
    }
  });

  it("broken slips only upwards to shoddy (clamped at bottom)", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 0]]),
    });
    for (let i = 0; i < 30; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "broken",
        category: "electrical",
        rng: createRNG(`cond-broken-${i}`),
      });
      expect(r.perceivedTier).toBe("shoddy");
    }
  });

  it("expertise sourced per-category, falls back to default for unknown category", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["electrical", 1.0]]),
      defaultConditionAccuracy: 0,
    });
    // Unknown category → default = 0 → always slips
    let passes = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = estimateConditionPure({
        profile,
        truthTier: "good",
        category: "furniture",
        rng: createRNG(`cond-unknown-${i}`),
      });
      if (r.passed) passes += 1;
    }
    expect(passes).toBe(0);
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
  it("loads expertise from persisted profile", () => {
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
    for (let i = 0; i < 30; i += 1) {
      const r = estimateCondition({
        db,
        actorId: aid,
        truthTier: "fair",
        category: "electrical",
        rng: createRNG(`e2e-cond-${i}`),
      });
      expect(r.passed).toBe(false);
      expect(["good", "shoddy"]).toContain(r.perceivedTier);
    }
  });
});

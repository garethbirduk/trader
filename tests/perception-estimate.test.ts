import { describe, it, expect } from "vitest";
import { createRNG, type SeededRNG } from "../src/engine/core/rng.js";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { persistKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import { setActorArmJ } from "../src/engine/perception/arm-j-repo.js";
import { seedCategoryAnchors } from "../src/engine/perception/anchors-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import {
  computeEstimate,
  estimate,
  steppedJ,
  SHARPNESS_DAMPING,
  TIGHT_KERNEL_HALF_WIDTH_FRAC,
} from "../src/engine/perception/estimate.js";
import type { EstimateResult } from "../src/engine/perception/types.js";

const TRUTH = 1000;
const ANCHOR = 80;
const TRIALS = 4000;

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

function runCase(args: {
  expertise: number;
  j: number;
  seed: string;
}): { results: EstimateResult[]; samples: number[] } {
  const rng = createRNG(args.seed);
  const results: EstimateResult[] = [];
  const samples: number[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: args.expertise,
      j: args.j,
      rng,
    });
    results.push(r);
    samples.push(r.sample);
  }
  return { results, samples };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function stdev(xs: readonly number[]): number {
  const m = mean(xs);
  return Math.sqrt(
    xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length,
  );
}

describe("steppedJ — band model", () => {
  it("at j=0 returns 0", () => {
    expect(steppedJ(0)).toBeCloseTo(0);
  });

  it("at j=1 returns 1", () => {
    expect(steppedJ(1)).toBeCloseTo(1);
  });

  it("j=0.5 → 0.5 exactly (band boundary)", () => {
    expect(steppedJ(0.5)).toBeCloseTo(0.5);
  });

  it("damping: j=0.5 and j=0.55 differ by ~0.025, not 0.05", () => {
    const a = steppedJ(0.5);
    const b = steppedJ(0.55);
    // SHARPNESS_DAMPING=0.05 means a 0.05 step in j inside a band
    // contributes 0.05 * 0.05 = 0.0025 ... wait, let me recompute.
    // frac(0.55*10) = frac(5.5) = 0.5; damping factor 0.05.
    // effective(0.55) = 0.5 + 0.5 * 0.05 = 0.525.
    // effective(0.50) = 0.5 + 0 = 0.500.
    // Difference: 0.025.
    expect(b - a).toBeCloseTo(0.025);
  });

  it("crossing a band boundary is a step", () => {
    // j=0.59 → 0.5 + 0.9*0.05 = 0.545
    // j=0.60 → 0.6 + 0     = 0.600
    const a = steppedJ(0.59);
    const b = steppedJ(0.6);
    expect(b - a).toBeGreaterThan(0.04);
  });

  it("if SHARPNESS_DAMPING were 0.1 the model would collapse to identity", () => {
    // Documenting the doc's algebraic note. With 0.1, j*10 = scaled,
    // floor/10 + frac*0.1 = j. With 0.05, that doesn't hold.
    expect(SHARPNESS_DAMPING).toBeLessThan(0.1);
  });
});

describe("computeEstimate — centre", () => {
  it("expertise=1 → centre on truth regardless of anchor", () => {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: 1.0,
      j: 0.5,
      rng: createRNG("centre-1"),
    });
    expect(r.centre).toBeCloseTo(TRUTH);
  });

  it("expertise=0 → centre on anchor (confidently wrong floor)", () => {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: 0.0,
      j: 0.5,
      rng: createRNG("centre-2"),
    });
    expect(r.centre).toBeCloseTo(ANCHOR);
  });

  it("expertise=0.5 → centre halfway between anchor and truth", () => {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: 0.5,
      j: 0.5,
      rng: createRNG("centre-3"),
    });
    expect(r.centre).toBeCloseTo((ANCHOR + TRUTH) / 2);
  });
});

describe("computeEstimate — spread", () => {
  it("j=1 → band collapses to centre", () => {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: 1.0,
      j: 1.0,
      rng: createRNG("spread-1"),
    });
    expect(r.low).toBeCloseTo(r.centre);
    expect(r.high).toBeCloseTo(r.centre);
  });

  it("j=0 → band spans [0, 2*centre]", () => {
    const r = computeEstimate({
      arm: "price",
      truth: TRUTH,
      anchor: ANCHOR,
      expertise: 1.0,
      j: 0,
      rng: createRNG("spread-2"),
    });
    expect(r.low).toBeCloseTo(0);
    expect(r.high).toBeCloseTo(TRUTH * 2);
  });
});

// ───────────────────────────────────────────────────────────────
// The four cases — docs/judgement.md §2.
// ───────────────────────────────────────────────────────────────

describe("the four cases — distributional shape", () => {
  it("case 1a: low expertise + high j → confidently wrong (peaked near anchor)", () => {
    const { samples } = runCase({ expertise: 0.1, j: 0.95, seed: "1a" });
    // Centre = lerp(80, 1000, 0.1) = 172. Most samples land within
    // a tight band of that.
    const centreExpected = ANCHOR + (TRUTH - ANCHOR) * 0.1;
    const m = mean(samples);
    expect(Math.abs(m - centreExpected) / centreExpected).toBeLessThan(0.1);
    // Sharply NOT near truth.
    expect(Math.abs(m - TRUTH)).toBeGreaterThan(0.5 * TRUTH);
    // Tight peak — sd small relative to centre.
    expect(stdev(samples) / centreExpected).toBeLessThan(0.2);
  });

  it("case 1b: high expertise + high j → confidently right (peaked near truth)", () => {
    const { samples } = runCase({ expertise: 0.95, j: 0.95, seed: "1b" });
    const m = mean(samples);
    // Within ~5% of truth.
    expect(Math.abs(m - TRUTH) / TRUTH).toBeLessThan(0.05);
    expect(stdev(samples) / TRUTH).toBeLessThan(0.15);
  });

  it("case 2a: low expertise + low j → haphazardly wrong (wide spread near anchor)", () => {
    const { samples } = runCase({ expertise: 0.1, j: 0.1, seed: "2a" });
    // Centre still near anchor; band much wider.
    const centreExpected = ANCHOR + (TRUTH - ANCHOR) * 0.1;
    const m = mean(samples);
    // Mean roughly near centre (uniform around it).
    expect(Math.abs(m - centreExpected) / centreExpected).toBeLessThan(0.5);
    // Wide spread — sd large.
    expect(stdev(samples) / centreExpected).toBeGreaterThan(0.3);
  });

  it("case 2b: high expertise + low j → hesitantly right (wide band around truth)", () => {
    const { samples } = runCase({ expertise: 0.95, j: 0.1, seed: "2b" });
    const m = mean(samples);
    // Centre near truth.
    expect(Math.abs(m - TRUTH) / TRUTH).toBeLessThan(0.2);
    // Wide spread — sd large relative to truth.
    expect(stdev(samples) / TRUTH).toBeGreaterThan(0.3);
  });

  it("case 1b is sharper than case 2b at the same expertise", () => {
    const { samples: s1b } = runCase({
      expertise: 0.9,
      j: 0.95,
      seed: "compare-1b",
    });
    const { samples: s2b } = runCase({
      expertise: 0.9,
      j: 0.1,
      seed: "compare-2b",
    });
    expect(stdev(s2b)).toBeGreaterThan(stdev(s1b) * 3);
  });

  it("case 1a is more committedly-wrong than case 2a (smaller std, similar centre)", () => {
    const { samples: s1a } = runCase({
      expertise: 0.1,
      j: 0.95,
      seed: "compare-1a",
    });
    const { samples: s2a } = runCase({
      expertise: 0.1,
      j: 0.1,
      seed: "compare-2a",
    });
    expect(stdev(s2a)).toBeGreaterThan(stdev(s1a) * 3);
  });
});

describe("mixture sampling — sample stays within band", () => {
  it("every sample lies in [low, high] (within tight-kernel epsilon)", () => {
    const { results } = runCase({ expertise: 0.5, j: 0.5, seed: "mixture-1" });
    for (const r of results) {
      // Tight-kernel can stray slightly above `high` if the kernel
      // half-width sits right at the band edge — but TIGHT_KERNEL is
      // capped at 5% of band width, so the slack is bounded.
      const slack = (r.high - r.low) * TIGHT_KERNEL_HALF_WIDTH_FRAC;
      expect(r.sample).toBeGreaterThanOrEqual(0);
      expect(r.sample).toBeLessThanOrEqual(r.high + slack + 1e-6);
    }
  });
});

// ───────────────────────────────────────────────────────────────
// Integration with the DB-backed estimate() entry point.
// ───────────────────────────────────────────────────────────────

describe("estimate (DB-backed)", () => {
  function setUp(args: {
    expertise: number;
    j: number;
    category: string;
    anchorValue: number;
  }) {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        priceAccuracy: new Map([[args.category, args.expertise]]),
        defaultPriceAccuracy: 0.5,
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: args.j });
    seedCategoryAnchors(db, new Map([[args.category, args.anchorValue]]));
    return { db, aid };
  }

  it("end-to-end: expertise 0.1 + j 0.95 produces confidently-wrong centre near anchor", () => {
    const { db, aid } = setUp({
      expertise: 0.1,
      j: 0.95,
      category: "electrical",
      anchorValue: ANCHOR,
    });
    const rng: SeededRNG = createRNG("e2e-1a");
    const r = estimate({
      db,
      actorId: aid,
      arm: "price",
      key: "electrical",
      truth: TRUTH,
      rng,
    });
    const centreExpected = ANCHOR + (TRUTH - ANCHOR) * 0.1;
    expect(r.centre).toBeCloseTo(centreExpected);
    expect(r.expertise).toBeCloseTo(0.1);
    expect(r.j).toBeCloseTo(0.95);
  });

  it("end-to-end: missing anchor row falls back to DEFAULT_ANCHOR_FALLBACK", () => {
    // Don't seed the anchor — verify default fallback is used.
    const db = freshDB();
    const aid = insertActor(db, {
      code: "boyce",
      firstName: "Boyce", shortName: "Boyce",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const r = estimate({
      db,
      actorId: aid,
      arm: "price",
      key: "electrical",
      truth: TRUTH,
      rng: createRNG("e2e-default-anchor"),
    });
    // Expertise default = 0.6 (fallback); anchor = 30 (default fallback).
    // centre = 30 + (1000 - 30) * 0.6 = 612
    expect(r.centre).toBeCloseTo(30 + (TRUTH - 30) * 0.6);
  });

  it("rejects arms other than 'price' until the auction-composition phase wires them up", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "x",
      firstName: "X", shortName: "X",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    expect(() =>
      estimate({
        db,
        actorId: aid,
        arm: "character",
        truth: 100,
        rng: createRNG("rejects-1"),
      }),
    ).toThrow(/not wired yet/);
  });

  it("rejects non-finite or negative truth", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "x",
      firstName: "X", shortName: "X",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    expect(() =>
      estimate({
        db,
        actorId: aid,
        arm: "price",
        truth: -1,
        rng: createRNG("invalid-truth-1"),
      }),
    ).toThrow();
    expect(() =>
      estimate({
        db,
        actorId: aid,
        arm: "price",
        truth: Number.NaN,
        rng: createRNG("invalid-truth-2"),
      }),
    ).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { createRNG } from "../src/engine/core/rng.js";

describe("seeded RNG", () => {
  it("is deterministic for a given seed", () => {
    const a = createRNG("seed-1");
    const b = createRNG("seed-1");
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("differs between seeds", () => {
    const a = createRNG("alpha");
    const b = createRNG("beta");
    // Extremely unlikely 10-element collision under different seeds.
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("int returns values within bounds", () => {
    const rng = createRNG("int-bounds");
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("int rejects bad bounds", () => {
    const rng = createRNG("int-bad");
    expect(() => rng.int(5, 5)).toThrow();
    expect(() => rng.int(5, 4)).toThrow();
    expect(() => rng.int(0.5, 10)).toThrow();
  });

  it("pick selects from the array", () => {
    const rng = createRNG("pick");
    const items = ["a", "b", "c", "d"] as const;
    for (let i = 0; i < 100; i++) {
      const v = rng.pick(items);
      expect(items).toContain(v);
    }
    expect(() => rng.pick([])).toThrow();
  });

  it("weighted pick honours weights distributionally", () => {
    const rng = createRNG("weighted");
    const items = [
      { value: "rare", weight: 1 },
      { value: "common", weight: 99 },
    ];
    const counts = { rare: 0, common: 0 };
    for (let i = 0; i < 10_000; i++) {
      counts[rng.weighted(items)]++;
    }
    // common should dominate, rare should be small but non-zero.
    expect(counts.common).toBeGreaterThan(counts.rare * 50);
    expect(counts.rare).toBeGreaterThan(0);
  });

  it("chance respects edge probabilities", () => {
    const rng = createRNG("chance");
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(-1)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(2)).toBe(true);
  });
});

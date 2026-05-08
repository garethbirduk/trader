import seedrandom from "seedrandom";

/**
 * Seeded pseudo-random source. The engine uses this for every non-deterministic
 * choice (pool spawns, NPC decisions, dice in negotiation) so that a given seed
 * produces a reproducible run — essential for testing, replays, and debugging.
 *
 * Never read `Math.random` directly inside engine code; always thread the RNG
 * through. This is enforced by convention, not by the type system.
 */
export interface SeededRNG {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniform pick from a non-empty array. Throws on empty. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick. Weights must be non-negative and sum to > 0. */
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  /** Bernoulli — true with probability p. */
  chance(p: number): boolean;
}

export function createRNG(seed: string): SeededRNG {
  const prng = seedrandom(seed);

  const rng: SeededRNG = {
    next: () => prng(),

    int(minInclusive, maxExclusive) {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
        throw new Error("int bounds must be integers");
      }
      if (maxExclusive <= minInclusive) {
        throw new Error(
          `int requires maxExclusive > minInclusive; got [${minInclusive}, ${maxExclusive})`,
        );
      }
      return minInclusive + Math.floor(prng() * (maxExclusive - minInclusive));
    },

    pick(items) {
      if (items.length === 0) throw new Error("pick from empty array");
      const idx = Math.floor(prng() * items.length);
      // safe: idx in [0, items.length)
      return items[idx] as (typeof items)[number];
    },

    weighted(items) {
      if (items.length === 0) throw new Error("weighted pick from empty array");
      let total = 0;
      for (const it of items) {
        if (it.weight < 0) throw new Error("weights must be non-negative");
        total += it.weight;
      }
      if (total <= 0) throw new Error("weighted pick: total weight must be > 0");
      let roll = prng() * total;
      for (const it of items) {
        roll -= it.weight;
        if (roll <= 0) return it.value;
      }
      // Floating-point fallthrough: return last.
      return items[items.length - 1]!.value;
    },

    chance(p) {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return prng() < p;
    },
  };

  return rng;
}

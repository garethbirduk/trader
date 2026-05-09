import type { World, Unsubscribe } from "../../engine/core/world.js";
import { listSpawnableItemKinds } from "../../engine/stock/items-repo.js";
import { insertPool } from "../../engine/pools/pools-repo.js";
import { seedSupplyLeadsForPool } from "../../engine/leads/seed-from-pool.js";
import type { ItemKind, QualityTier } from "../../engine/stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../../engine/economics/config.js";

export interface PoolSpawnerOptions {
  /**
   * Map of item category → actor ids who can source pools of that
   * category. Skin-specific (e.g. Denzil reaches electrical pools).
   * Items in categories not in the map use `defaultReachableActorIds`.
   */
  readonly reachableByCategory: ReadonlyMap<string, readonly number[]>;
  readonly defaultReachableActorIds: readonly number[];
  /** Probability distribution for "how many pools spawn this morning". */
  readonly spawnsPerDay?: readonly { value: number; weight: number }[];
  /** Economic tuning bundle. Tier multipliers + opening/closing fractions
   *  + jitter come from here. */
  readonly economics?: EconomicsConfig;
}

const DEFAULT_SPAWNS_PER_DAY = [
  { value: 0, weight: 25 },
  { value: 1, weight: 50 },
  { value: 2, weight: 20 },
  { value: 3, weight: 5 },
];

const TIER_DISTRIBUTION: readonly { value: QualityTier; weight: number }[] = [
  { value: "mint", weight: 8 },
  { value: "good", weight: 30 },
  { value: "fair", weight: 32 },
  { value: "shoddy", weight: 20 },
  { value: "broken", weight: 10 },
];

/**
 * Daily pool spawner. Each morning, rolls how many new pools appear, then
 * for each picks an item kind weighted by its `spawnWeight` (so easter
 * eggs are rare), randomises tier / quantity / window / prices within
 * sensible bands per item, and assigns reachability to the actors flagged
 * for that category. Emits `pool.spawned` per new pool, with the easter
 * egg's flavour text attached so the trace catches it.
 */
export function registerPoolSpawner(
  world: World,
  opts: PoolSpawnerOptions,
): Unsubscribe {
  const spawnsPerDayDist = opts.spawnsPerDay ?? DEFAULT_SPAWNS_PER_DAY;
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;

  return world.onDayStart((day) => {
    const spawnable = listSpawnableItemKinds(world.db);
    if (spawnable.length === 0) return;

    const itemWeights = spawnable.map((it) => ({ value: it, weight: it.spawnWeight }));
    const numToSpawn = world.rng.weighted(spawnsPerDayDist);

    for (let i = 0; i < numToSpawn; i += 1) {
      const item = world.rng.weighted(itemWeights);
      const tier = world.rng.weighted(TIER_DISTRIBUTION);
      const quantity = pickQuantity(item, world.rng);
      const windowDays = world.rng.int(2, 7);
      const opening = priceFor(item, tier, world.rng, economics);
      const closing = Math.max(1, Math.round(opening * economics.poolClosingFraction));
      const reachable = pickReachableActors(item, opts);

      if (reachable.length === 0) continue;

      const pool = insertPool(world.db, {
        itemKindId: item.id,
        qualityTier: tier,
        quantity,
        createdDay: day,
        expiryDay: day + windowDays - 1,
        openingUnitPrice: opening,
        closingUnitPrice: closing,
        reachableBy: reachable,
      });

      // Seed first-hand supply leads so reachable actors *know* about
      // the pool — and so the pool reference can propagate via gossip.
      seedSupplyLeadsForPool(world.db, pool.id, day);

      world.events.emit({
        type: "pool.spawned",
        at: world.clock,
        poolId: pool.id,
        itemKindId: item.id,
        itemCode: item.code,
        qualityTier: tier,
        quantity,
        openingUnitPrice: opening,
        closingUnitPrice: closing,
        expiryDay: pool.expiryDay,
        isEasterEgg: item.isEasterEgg,
        flavourText: item.flavourText ?? null,
      });
    }
  });
}

function pickQuantity(item: ItemKind, rng: import("../../engine/core/rng.js").SeededRNG): number {
  // Easter eggs tend to small lots; generic stock varies more.
  if (item.isEasterEgg) return rng.int(1, 30);
  // Cheaper items spawn in larger lots; expensive items in smaller ones.
  if (item.baseValue >= 100) return rng.int(1, 12);
  if (item.baseValue >= 30) return rng.int(5, 60);
  return rng.int(10, 200);
}

function priceFor(
  item: ItemKind,
  tier: QualityTier,
  rng: import("../../engine/core/rng.js").SeededRNG,
  economics: EconomicsConfig,
): number {
  // Tier-anchored retail mid × wholesale fraction × symmetric jitter.
  const retailMid = item.baseValue * economics.tierMultipliers[tier];
  const wholesaleAnchor = retailMid * economics.poolOpeningFraction;
  const j = economics.poolOpeningJitter;
  const jittered = wholesaleAnchor * (1 - j + rng.next() * 2 * j);
  return Math.max(1, Math.round(jittered));
}

function pickReachableActors(
  item: ItemKind,
  opts: PoolSpawnerOptions,
): readonly number[] {
  const candidates = opts.reachableByCategory.get(item.category);
  if (candidates && candidates.length > 0) {
    return candidates.length === 1 ? candidates : [...candidates];
  }
  return opts.defaultReachableActorIds;
}

import type { World, Unsubscribe } from "../core/world.js";
import { insertAuctionLot } from "../auction/auction-repo.js";
import { listSpawnableItemKinds } from "../stock/items-repo.js";
import type { QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface RegionalClearanceOptions {
  readonly economics?: EconomicsConfig;
  /** Days of the week the auction runs. Lots only spawn on these
   *  days — no point listing on a closed day. Default Mon–Fri. */
  readonly daysOfWeek?: readonly number[];
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

const TIER_DISTRIBUTION: readonly { value: QualityTier; weight: number }[] = [
  { value: "mint", weight: 6 },
  { value: "good", weight: 32 },
  { value: "fair", weight: 38 },
  { value: "shoddy", weight: 18 },
  { value: "broken", weight: 6 },
];

/**
 * Stage 7 — regional-clearance lots.
 *
 * Without this handler the auction was hostage to local pool flushes:
 * a quiet day produced no docket, and Sotheby's sat empty. Stage 7
 * fixes that by injecting a steady drip of "regional" lots every
 * auction day: estate clearances, bankruptcy stock, garage clearouts.
 * They're priced at a higher floor fraction of retail than the local
 * pool-derived lots so the whales (off-map dealers) clear the top end
 * while locals can still engage on the cheaper draws when the dice
 * land that way.
 *
 * Source-pool-id is NULL on these lots — they don't trace back to a
 * `world_pools` row. The `provenance` column distinguishes them at the
 * viewer layer.
 *
 * Registered as `onDayStart` so the lots land before the daily-auction
 * handler picks the day's running docket.
 */
export function registerRegionalClearance(
  world: World,
  opts: RegionalClearanceOptions = {},
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.regionalClearance;
  const tierMult = economics.tierMultipliers;
  const daysOfWeek = opts.daysOfWeek ?? DEFAULT_DAYS;
  const dowSet = new Set(daysOfWeek);

  return world.onDayStart((day) => {
    if (cfg.lotsPerDay <= 0) return;
    // 1=Mon..7=Sun. Day 1 in-world is a Monday by convention.
    const dow = ((day - 1) % 7) + 1;
    if (!dowSet.has(dow)) return;

    const spawnable = listSpawnableItemKinds(world.db).filter(
      (it) => !it.isEasterEgg,
    );
    if (spawnable.length === 0) return;
    const itemWeights = spawnable.map((it) => ({
      value: it,
      weight: it.spawnWeight,
    }));

    for (let i = 0; i < cfg.lotsPerDay; i += 1) {
      const item = world.rng.weighted(itemWeights);
      const tier = world.rng.weighted(TIER_DISTRIBUTION);
      const quantity = pickQuantity(item.baseValue, world.rng);
      const retail = item.baseValue * (tierMult[tier] ?? 1) * quantity;
      const j = cfg.floorJitter;
      const floor = Math.max(
        1,
        Math.round(
          retail * cfg.floorFractionOfRetail * (1 - j + world.rng.next() * 2 * j),
        ),
      );
      const provenance =
        cfg.provenancePhrases.length > 0
          ? world.rng.pick(cfg.provenancePhrases)
          : null;

      const lot = insertAuctionLot(world.db, {
        sourcePoolId: null,
        itemKindId: item.id,
        qualityTier: tier,
        quantity,
        floorPrice: floor,
        listedDay: day,
        provenance,
      });

      world.events.emit({
        type: "regional-clearance.listed",
        at: world.clock,
        auctionLotId: lot.id,
        itemKindId: item.id,
        qualityTier: tier,
        quantity,
        floorPrice: floor,
        provenance,
      });
    }
  });
}

function pickQuantity(
  baseValue: number,
  rng: import("../core/rng.js").SeededRNG,
): number {
  // Regional clearance lots tend slightly larger than pool spawns —
  // it's job-lot stock by definition.
  if (baseValue >= 100) return rng.int(2, 16);
  if (baseValue >= 30) return rng.int(8, 80);
  return rng.int(20, 250);
}

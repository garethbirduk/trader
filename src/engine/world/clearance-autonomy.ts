import type { World, Unsubscribe } from "../core/world.js";
import { listSpawnableItemKinds } from "../stock/items-repo.js";
import { QUALITY_TIERS, type QualityTier } from "../stock/types.js";
import {
  insertClearanceListing,
} from "../clearance/clearance-repo.js";
import { runDueClearances } from "../clearance/run-clearance.js";

/**
 * House-clearance autonomy (todolist #9).
 *
 * Two hooks:
 *
 *   onDayStart — spawns N clearance listings for the day, each with
 *     a randomised haul (3–7 lots) drawn from the spawnable catalogue
 *     with the design's tier mix (mint 10% / good 20% / fair 35% /
 *     shoddy 25% / broken 10%). Each listing schedules to resolve at
 *     a random hour in the configured window, on the same day.
 *
 *   onHour — calls `runDueClearances` so listings whose scheduled
 *     hour has arrived actually deliver their hauls (or expire empty).
 *
 * Booking is NOT autonomous in this pass — listings exist in the world
 * but no NPC picks up the phone yet. The player can book via UI; NPC
 * planner integration is a follow-up.
 */
export interface ClearanceAutonomyOptions {
  /** How many clearance listings appear per day. Default 1. */
  readonly listingsPerDay?: number;
  /** Fee charged to the winning booker. Default £500. */
  readonly fee?: number;
  /** Lots per listing — uniform random in this range. Default [3, 7]. */
  readonly lotsPerListingRange?: readonly [number, number];
  /** Units per lot — uniform random. Default [1, 3]. */
  readonly unitsPerLotRange?: readonly [number, number];
  /** Scheduled-hour window for resolution. Default 10..18 inclusive. */
  readonly scheduledHourMin?: number;
  readonly scheduledHourMax?: number;
  /** Flavour-phrase bank attached to the listing for the UI. */
  readonly flavourPhrases?: readonly string[];
  /** Days of the week to spawn on. Default Mon–Sat (no Sundays —
   *  the newspaper doesn't drop). */
  readonly daysOfWeek?: readonly number[];
}

const DEFAULT_FLAVOUR_PHRASES = [
  "Mrs Smith's house clearance",
  "Old Mr Thomas's flat",
  "End-of-terrace clearout",
  "Probate clearance — Forest Hill",
  "Late aunt's house, Dulwich",
  "Bachelor flat — Camberwell",
  "Retired widow's bungalow",
];

const DEFAULT_DAYS = [1, 2, 3, 4, 5, 6];

const TIER_DISTRIBUTION: readonly { value: QualityTier; weight: number }[] = [
  { value: "mint", weight: 10 },
  { value: "good", weight: 20 },
  { value: "fair", weight: 35 },
  { value: "shoddy", weight: 25 },
  { value: "broken", weight: 10 },
];

export function registerClearanceAutonomy(
  world: World,
  opts: ClearanceAutonomyOptions = {},
): Unsubscribe[] {
  const listingsPerDay = opts.listingsPerDay ?? 1;
  const fee = opts.fee ?? 500;
  const lotsRange = opts.lotsPerListingRange ?? ([3, 7] as const);
  const unitsRange = opts.unitsPerLotRange ?? ([1, 3] as const);
  const hourMin = opts.scheduledHourMin ?? 10;
  const hourMax = opts.scheduledHourMax ?? 18;
  const phrases = opts.flavourPhrases ?? DEFAULT_FLAVOUR_PHRASES;
  const dowSet = new Set(opts.daysOfWeek ?? DEFAULT_DAYS);

  const onSpawn = world.onDayStart((day) => {
    if (listingsPerDay <= 0) return;
    const dow = ((day - 1) % 7) + 1;
    if (!dowSet.has(dow)) return;

    const spawnable = listSpawnableItemKinds(world.db).filter(
      (it) => !it.isEasterEgg,
    );
    if (spawnable.length === 0) return;
    const kindWeights = spawnable.map((it) => ({
      value: it,
      weight: it.spawnWeight,
    }));

    for (let i = 0; i < listingsPerDay; i += 1) {
      const lotCount = world.rng.int(lotsRange[0], lotsRange[1] + 1);
      const lots: {
        itemKindId: number;
        qualityTier: QualityTier;
        quantity: number;
      }[] = [];
      for (let l = 0; l < lotCount; l += 1) {
        const kind = world.rng.weighted(kindWeights);
        const tier = world.rng.weighted(TIER_DISTRIBUTION);
        void QUALITY_TIERS; // tier already validated by the union
        const qty = world.rng.int(unitsRange[0], unitsRange[1] + 1);
        lots.push({ itemKindId: kind.id, qualityTier: tier, quantity: qty });
      }
      const flavour = phrases.length > 0 ? world.rng.pick(phrases) : null;
      // The listing has no inherent "when" — bookings drive the
      // resolution hour. A listing with no bookings simply sits open
      // until end of day.
      const { listing } = insertClearanceListing(world.db, {
        listedDay: day,
        scheduledDay: day,
        fee,
        flavour,
        lots,
      });
      world.events.emit({
        type: "clearance.listed",
        at: { day, hour: 6 }, // newspaper drop hour convention
        listingId: listing.id,
        scheduledDay: day,
        fee,
        flavour,
        lots: lots.map((l) => ({
          itemKindId: l.itemKindId,
          qualityTier: l.qualityTier,
          quantity: l.quantity,
        })),
      });
    }
    void hourMin;
    void hourMax;
  });

  const onTick = world.onHour((clock) => {
    runDueClearances(world.db, {
      day: clock.day,
      hour: clock.hour,
      events: world.events,
    });
  });

  return [onSpawn, onTick];
}

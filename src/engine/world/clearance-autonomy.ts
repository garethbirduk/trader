import type { World, Unsubscribe } from "../core/world.js";
import { listSpawnableItemKinds } from "../stock/items-repo.js";
import type { QualityTier } from "../stock/types.js";
import {
  bookClearance,
  expireListing,
  getBookingsForListing,
  getListingsScheduledFor,
  getOpenListings,
  insertClearanceListing,
} from "../clearance/clearance-repo.js";
import { runDueClearances } from "../clearance/run-clearance.js";
import {
  actorKnowsClearance,
  getKnownClearanceIdsForActor,
  recordClearanceKnowledge,
} from "../clearance/knowledge-repo.js";
import { getActorsAtLocation } from "../locations/locations.js";
import { getActorById, listActors } from "../actors/actors-repo.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import { seedWitnessLeads } from "../witness/seed-witness-leads.js";

/**
 * House-clearance autonomy (todolist #9).
 *
 * Five hooks compose the full lifecycle:
 *
 *   1. onDayStart: spawn N listings with predetermined hauls.
 *   2. onHour: at newspaper venues during paper hours, propagate
 *      listing knowledge to present actors.
 *   3. onHour: at phone-capable venues, eligible NPCs may roll to
 *      book one of today's listings they know about. The phone call
 *      seeds witness leads (#6) for present bystanders and grants
 *      them overheard-knowledge of the listing.
 *   4. onHour: runDueClearances delivers hauls to winners.
 *   5. onDayEnd: unresolved listings expire (no winner taken;
 *      stock simply doesn't enter the world).
 *
 * NPC booking eligibility (default): role tag includes "dealer" or
 * "fence", cash ≥ fee × 1.5, currently at a phone-capable venue,
 * pubdeal-ish hour window.
 */
export interface ClearanceAutonomyOptions {
  readonly listingsPerDay?: number;
  readonly fee?: number;
  readonly lotsPerListingRange?: readonly [number, number];
  readonly unitsPerLotRange?: readonly [number, number];
  readonly flavourPhrases?: readonly string[];
  /** Days of the week to spawn on. Default Mon–Sat. */
  readonly daysOfWeek?: readonly number[];
  /** Newspaper venues — listing knowledge propagates here during
   *  `paperFromHour..endOfDay`. Empty disables knowledge gating. */
  readonly newspaperLocationIds?: readonly number[];
  readonly paperFromHour?: number;
  /** Venues from which an actor can phone in a clearance booking. */
  readonly phoneCapableLocationIds?: readonly number[];
  /** Actor ids eligible to book (typically dealer/fence-roled cast). */
  readonly bookerActorIds?: ReadonlySet<number>;
  /** Probability an eligible NPC at a phone venue rolls to book each
   *  hour. Default 0.15 — sparse, so listings don't get snapped up
   *  the moment they're known. */
  readonly bookChancePerHour?: number;
  /** Floor on the booker's free cash multiplier of fee. Default 1.5. */
  readonly bookCashMultiplier?: number;
  /** Hour window during which NPCs phone in bookings. */
  readonly bookStartHour?: number;
  readonly bookEndHour?: number;
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
  const phrases = opts.flavourPhrases ?? DEFAULT_FLAVOUR_PHRASES;
  const dowSet = new Set(opts.daysOfWeek ?? DEFAULT_DAYS);
  const newspaperLocSet = new Set(opts.newspaperLocationIds ?? []);
  const phoneLocSet = new Set(opts.phoneCapableLocationIds ?? []);
  const bookerSet = opts.bookerActorIds ?? new Set<number>();
  const paperFromHour = opts.paperFromHour ?? 6;
  const bookChance = opts.bookChancePerHour ?? 0.15;
  const bookCashMult = opts.bookCashMultiplier ?? 1.5;
  const bookStartHour = opts.bookStartHour ?? 8;
  const bookEndHour = opts.bookEndHour ?? 17;

  // 1. Morning spawn.
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
        const qty = world.rng.int(unitsRange[0], unitsRange[1] + 1);
        lots.push({ itemKindId: kind.id, qualityTier: tier, quantity: qty });
      }
      const flavour = phrases.length > 0 ? world.rng.pick(phrases) : null;
      const { listing } = insertClearanceListing(world.db, {
        listedDay: day,
        scheduledDay: day,
        fee,
        flavour,
        lots,
      });
      world.events.emit({
        type: "clearance.listed",
        at: { day, hour: paperFromHour },
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
  });

  // 2. Newspaper knowledge propagation. Actors present at a newspaper
  // venue during paper hours learn about today's listings.
  const onPaper = world.onHour((clock) => {
    if (newspaperLocSet.size === 0) return;
    if (clock.hour < paperFromHour) return;
    const todays = getListingsScheduledFor(world.db, clock.day);
    if (todays.length === 0) return;
    for (const locId of newspaperLocSet) {
      const present = getActorsAtLocation(world.db, locId);
      for (const actorId of present) {
        for (const listing of todays) {
          if (actorKnowsClearance(world.db, actorId, listing.id)) continue;
          recordClearanceKnowledge(world.db, {
            actorId,
            listingId: listing.id,
            learnedDay: clock.day,
            learnedHour: clock.hour,
            learnedVia: "paper",
          });
        }
      }
    }
  });

  // 3. Booking autonomy. At phone-capable venues during the booking
  // window, eligible NPCs roll to book a listing they know about.
  const onBook = world.onHour((clock) => {
    if (bookerSet.size === 0 || phoneLocSet.size === 0) return;
    if (clock.hour < bookStartHour || clock.hour > bookEndHour) return;
    for (const locId of phoneLocSet) {
      const present = getActorsAtLocation(world.db, locId);
      for (const actorId of present) {
        if (!bookerSet.has(actorId)) continue;
        if (!world.rng.chance(bookChance)) continue;
        const actor = getActorById(world.db, actorId);
        if (!actor) continue;
        if (actor.cash < fee * bookCashMult) continue;

        const knownIds = getKnownClearanceIdsForActor(world.db, actorId);
        if (knownIds.length === 0) continue;
        // Filter to listings still open today.
        const candidates = getListingsScheduledFor(world.db, clock.day)
          .filter((l) => knownIds.includes(l.id));
        if (candidates.length === 0) continue;
        // Skip listings the actor has already booked.
        const fresh = candidates.filter((l) => {
          const bookings = getBookingsForListing(world.db, l.id);
          return !bookings.some((b) => b.bookerActorId === actorId);
        });
        if (fresh.length === 0) continue;

        // Bag-fullness gate — NPCs already drowning in stock don't
        // need more. Rough proxy: skip if total units on hand > 100.
        const lots = getStockLotsByOwner(world.db, actorId);
        const totalUnits = lots.reduce((s, l) => s + l.quantity, 0);
        if (totalUnits > 100) continue;

        const listing = world.rng.pick(fresh);
        // Pick the earliest reasonable scheduled hour the NPC can
        // realistically race for — at least 1h from now, capped at
        // 20:00 so the run loop has time to resolve.
        const earliest = Math.min(20, clock.hour + 1);
        const latest = Math.max(earliest, 20);
        const scheduledHour = world.rng.int(earliest, latest + 1);

        const result = bookClearance(world.db, {
          listingId: listing.id,
          bookerActorId: actorId,
          bookedDay: clock.day,
          bookedHour: clock.hour,
          scheduledHour,
          bookedAtLocationId: locId,
        });
        if (result.type !== "booked") continue;
        world.events.emit({
          type: "clearance.booked",
          at: clock,
          listingId: listing.id,
          bookingId: result.booking.id,
          bookerActorId: actorId,
          scheduledHour,
          atLocationId: locId,
        });
        // Witness leads: present bystanders overhear the call.
        const witnessResult = seedWitnessLeads(world.db, {
          locationId: locId,
          principalActorId: actorId,
          eventType: "clearance-booking",
          context: { listingId: listing.id, scheduledHour },
          atDay: clock.day,
        });
        // Witnesses also gain headline-level knowledge of the listing
        // so they can race for an earlier slot (after paying for the
        // detail tier).
        for (const witnessId of witnessResult.witnessActorIds) {
          recordClearanceKnowledge(world.db, {
            actorId: witnessId,
            listingId: listing.id,
            learnedDay: clock.day,
            learnedHour: clock.hour,
            learnedVia: "overheard",
            learnedFromActorId: actorId,
          });
        }
      }
    }
  });

  // 4. Hourly resolver.
  const onTick = world.onHour((clock) => {
    runDueClearances(world.db, {
      day: clock.day,
      hour: clock.hour,
      events: world.events,
    });
  });

  // 5. End-of-day expiry. Unresolved listings (no winning booker
  // showed up) get marked resolved=null so they don't dangle. Stock
  // simply doesn't enter the world.
  const onExpire = world.onDayEnd((day) => {
    const open = getOpenListings(world.db).filter((l) => l.scheduledDay <= day);
    for (const l of open) {
      // Skip listings that were resolved earlier today by the run loop.
      if (l.resolvedDay !== null) continue;
      expireListing(world.db, l.id, day, 23);
      world.events.emit({
        type: "clearance.expired",
        at: { day, hour: 23 },
        listingId: l.id,
        flavour: l.flavour,
      });
    }
    void listActors; // silence unused
  });

  return [onSpawn, onPaper, onBook, onTick, onExpire];
}

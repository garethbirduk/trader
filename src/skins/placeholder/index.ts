import type { DB } from "../../engine/core/db.js";
import type { SeededRNG } from "../../engine/core/rng.js";
import { insertActor } from "../../engine/actors/actors-repo.js";
import { insertItemKind } from "../../engine/stock/items-repo.js";
import { insertStockLot } from "../../engine/stock/lots-repo.js";
import { seedSupplyLeadForStockLot } from "../../engine/leads/seed-from-stock.js";
import {
  insertLocation,
  setActorLocation,
  setLocationProprietor,
} from "../../engine/locations/locations.js";
import type { LocationType } from "../../engine/locations/locations.js";
import { RuleBasedAIPolicy } from "../../engine/policy/rule-based.js";
import type { ActorPolicy } from "../../engine/policy/types.js";
import type { KnowledgeProfile } from "../../engine/knowledge/types.js";
import { seedKnowledgeProfiles } from "../../engine/knowledge/skin-seed.js";
import { seedCategoryAnchors } from "../../engine/perception/anchors-repo.js";
import { seedCategoryConditionAnchors } from "../../engine/perception/condition-anchors-repo.js";
import { setActorArmJ } from "../../engine/perception/arm-j-repo.js";
import type { FlawType, QualityTier } from "../../engine/stock/types.js";
import type { TransportCapacity } from "../../engine/actors/types.js";
import { EVERYDAY_ITEMS } from "./catalogue-everyday.js";
import { EASTER_EGG_ITEMS } from "./catalogue-easter-eggs.js";
import {
  ACTORS,
  type ActorSpec,
  DAYS_MON_FRI,
  DAYS_MON_SAT,
  HIGH_STREET_SHOPS,
  OFF_MAP_DEALER_CODES,
  OFF_MAP_MARKET_CODE,
  loadSkinJson,
} from "./cast.js";
import {
  resolveEconomicsConfig,
  type EconomicsConfig,
} from "../../engine/economics/config.js";

/**
 * Placeholder skin — the v1 content used for self-running simulations.
 * Loose genre flavour (player-stand-in dealer, a sharp middleman, a few
 * suppliers, a clueless regular, an auction house, three locations)
 * without committing to a specific show's IP. Skins replace this whole
 * folder, populating the same shape.
 *
 * Pools are no longer pre-scheduled — a daily spawner picks from a
 * catalogue of ~50 everyday items and ~37 easter-egg items, each weighted
 * by spawn frequency. Easter eggs surface rarely with their show flavour
 * text in the trace.
 */

export interface SkinSeedResult {
  readonly playerActorId: number;
  readonly auctionHouseActorId: number;
  readonly policies: ReadonlyMap<number, ActorPolicy>;
  readonly bidderProfiles: ReadonlyMap<number, KnowledgeProfile>;
  /**
   * Map of item category → actor ids who can source pools of that
   * category. The pool spawner consults this to decide reachability.
   */
  readonly reachableByCategory: ReadonlyMap<string, readonly number[]>;
  readonly defaultReachableActorIds: readonly number[];
  /** Locations where pub-deal autonomy fires (e.g. the Nag's Head). */
  readonly pubLocationIds: readonly number[];
  /** All pub-type locations — used by the planner as candidates,
   *  separate from `pubLocationIds` (which is just for autonomy). */
  readonly allPubLocationIds: readonly number[];
  /** High-street shop locations — pub-deal mechanism reused with a
   *  higher buyer-ceiling and a buyer constrained to shopkeepers. */
  readonly shopLocationIds: readonly number[];
  /** Per-shop category specialties (shop locId → category list) so the
   *  planner can score "matched stock" bonuses for steering dealers
   *  to the right shop. */
  readonly shopSpecialtiesByLocation: ReadonlyMap<number, ReadonlyArray<string>>;
  /** Per-shop hourly footfall override (todolist #2). Shops not in
   *  this map fall back to the global `shopSale.hourlyFootfall`. */
  readonly shopFootfallByLocation: ReadonlyMap<number, Readonly<Record<number, number>>>;
  /** Per-shop persona-weight multipliers (todolist #1). Shops not in
   *  this map use the global persona bank unmodified. */
  readonly shopPersonaMultipliersByLocation: ReadonlyMap<
    number,
    Readonly<Record<string, number>>
  >;
  /** Actor ids of shopkeepers that own the high-street shops. The
   *  shop-deal autonomy uses this set to force the buyer side. */
  readonly shopkeeperActorIds: readonly number[];
  /** Locations that carry the morning paper (Sid's + high-street
   *  newsagents). Auction-listing-knowledge propagates here. */
  readonly newspaperLocationIds: readonly number[];
  /** The wider trade scene — actors who travel in from neighbouring
   *  areas to bid at Sotheby's. Capped per lot via
   *  `economics.offMapAuction.maxBiddersPerLot`. */
  readonly offMapDealerActorIds: readonly number[];
  /** Synthetic external-economy account that buys whatever the
   *  off-map dealers bring home each night. Exempted from the cash
   *  conservation invariant — represents the economy outside our
   *  simulated bubble. */
  readonly offMapMarketActorId: number;
  /** Where the daily auction is held; bidders must be physically present. */
  readonly auctionLocationId: number;
  /** First and last hour of the daily auction window. One lot per hour
   *  runs in this inclusive range. */
  readonly auctionStartHour: number;
  readonly auctionEndHour: number;
  /** Where the morning newspaper publishes the day's lot listing. */
  readonly newspaperLocationId: number;
  /** Peckham Market — where dealers run stalls during the day. */
  readonly marketLocationId: number;
  /** Actor ids eligible to run a market stall (dealer / fence /
   *  player). Civilians passing through aren't sellers. */
  readonly marketSellerActorIds: readonly number[];
  /** The patrolling officer who busts adhoc stalls. Optional —
   *  skins without a police character omit it. This is the *bust*
   *  officer specifically (today: Slater); the wider patrol roster
   *  is `patrolOfficers` below. */
  readonly patrolOfficerActorId?: number;
  /** Patrol roster — every officer who walks a weighted beat during
   *  their active-hours window. Beats may overlap. Skins without
   *  police pass an empty array. Each entry feeds one
   *  `PatrolPicker.register` call. */
  readonly patrolOfficers: readonly PatrolOfficerSpec[];
  /** Actor ids whose flex hours are filled in by the per-hour planner
   *  (auction / market / each shop / each pub / newspaper / home). */
  readonly flexibleDailyModeActorIds: readonly number[];
  /** Location code → id map. Skins use codes; engine uses ids. */
  readonly locationByCode: ReadonlyMap<string, number>;
  /** Location code → normalised opening schedule (one or more
   *  per-day-group sessions). Only present for locations with explicit
   *  scheduling data — absent codes fall back to the engine's
   *  `openHours` plus a type-based weekend heuristic in the viewer. */
  readonly openSessionsByCode: ReadonlyMap<string, readonly OpenSession[]>;
  /** Per-actor lunch destinations to roll at run-setup time. Keyed by
   *  actor id; each entry says "on these weekdays, at these hours,
   *  roll one of these locations". Setup.ts consumes this with the
   *  world RNG and writes overrides into the schedule registry. */
  readonly lunchSpecsByActorId: ReadonlyMap<
    number,
    {
      readonly hours: readonly number[];
      readonly daysOfWeek: readonly number[];
      readonly candidateLocIds: readonly number[];
    }
  >;
  /** Hour from which the paper is on the table at Sid's. */
  readonly paperFromHour: number;
  /** Hour from which the listing is on display at Sotheby's. */
  readonly galleryFromHour: number;
  readonly runLengthDays: number;
  /**
   * Actor ids that participate in trading autonomy (pub-deal /
   * pool-claim). The wider cast still has policies and routines, but
   * civilians (Cassandra, Marlene, Albert…) don't initiate deals.
   */
  readonly tradingActorIds: readonly number[];
  /**
   * Actor ids flagged as information-traders. In chat-side gossip
   * (`registerVisitorChat`) any pair containing one of these yields
   * the boosted per-encounter lead count rather than the baseline.
   * The cast is the skin's choice — for placeholder/OFAH it's
   * Denzil, Mike, Sid, Uncle Albert.
   */
  readonly infoTraderActorIds: readonly number[];
  /**
   * Stage 6 — virtual external producers (Trader Bob, Wholesaler
   * Cyril, Reggie's Estate, Salvage Sid). Each maps a stock category
   * to the producer who supplies it, plus the broker actor ids who
   * can claim from that producer's pools, plus a phrase bank for
   * provenance. The pool spawner consults this to attribute new
   * pools to a named producer and wire their broker list as
   * reachability. Producers with no category coverage fall back to
   * ambient (legacy `reachableByCategory`) behaviour.
   */
  readonly virtualProducers: readonly VirtualProducerInfo[];
  /** Category → list of producers (in order of preference). */
  readonly virtualProducersByCategory: ReadonlyMap<string, readonly VirtualProducerInfo[]>;
  /**
   * Resolved economics config, exposed back to the caller so the
   * world-setup wiring (pool spawner, pub-deal autonomy, bidders) can
   * read the same bundle. Defaults applied where the skin caller
   * didn't override.
   */
  readonly economics: EconomicsConfig;
  /**
   * Per-actor metadata for diary / profile views. Includes home location
   * id, the hour→location schedule, and the awake window for diary
   * rendering.
   */
  readonly actorRoutines: ReadonlyMap<number, ActorRoutineInfo>;
  /**
   * Tags describing what each actor *is* in the fiction (dealer,
   * civilian, police, …). Purely presentational — used by the
   * webapp's filter rail to slice the cast. Keyed by actor id.
   */
  readonly rolesByActorId: ReadonlyMap<number, readonly string[]>;
  /**
   * Optional short / nickname per actor. Used by the webapp for chip-
   * sized UI surfaces (selection chips, mini actor rows, owner labels).
   * Falls back to displayName when an actor isn't listed.
   */
  readonly shortNameByActorId: ReadonlyMap<number, string>;
  /**
   * Pairs of actors whose calendars are implicitly shared at all times
   * (close family, business partners). The viewer treats each pair-member
   * as having continuous co-presence with their partner — they always
   * know each other's actual position. Resolved from pairs.json
   * (skin-data file) at seed time.
   */
  readonly pairs: readonly (readonly [number, number])[];
}

/**
 * Resolved metadata about a seeded virtual producer. The pool spawner
 * picks a producer per category (using these `categories`), attributes
 * the pool's owner_actor_id to `actorId`, sets reachability to
 * `brokerActorIds`, and pulls a random phrase from `provenancePhrases`.
 */
export interface VirtualProducerInfo {
  readonly actorId: number;
  readonly code: string;
  readonly displayName: string;
  readonly categories: readonly string[];
  readonly brokerActorIds: readonly number[];
  readonly provenancePhrases: readonly string[];
}

/**
 * One officer's patrol beat. Each entry feeds a single
 * `PatrolPicker.register` call: the picker runs a weighted-random
 * hour-by-hour pick within `activeHours`, drawing from
 * `candidates`. Beats may overlap between officers.
 */
export interface PatrolOfficerSpec {
  readonly officerActorId: number;
  readonly candidates: readonly { readonly locationId: number; readonly weight: number }[];
  readonly activeHours: ReadonlySet<number>;
}

export interface ActorRoutineInfo {
  readonly homeLocationId: number | null;
  readonly schedule: ReadonlyMap<number, number>;
  readonly flexibleHours: ReadonlySet<number>;
  /** Optional weekend overrides. When `weekendSchedule` is set, the
   *  policy callback uses it for Saturday/Sunday hours; otherwise the
   *  weekday `schedule` applies all week. */
  readonly weekendSchedule?: ReadonlyMap<number, number>;
  readonly weekendFlexibleHours?: ReadonlySet<number>;
  readonly awakeHours: { readonly start: number; readonly end: number };
}

interface LocationSpec {
  readonly code: string;
  readonly displayName: string;
  readonly type: LocationType;
  /** Engine-facing single-window opening hours. Used by the engine
   *  planner's candidate filtering (an actor won't be scheduled into
   *  a closed venue). For locations with day-varying hours this is
   *  the conservative outer envelope; the per-day truth lives in
   *  `openSessions`. */
  readonly openHours?: { readonly start: number; readonly end: number };
  /** Days of the week the location is open at its `openHours`.
   *  1=Mon..7=Sun. Shortcut for the common case of "same hours every
   *  open day". When unset, falls back to a type-based heuristic in
   *  the viewer (auction + business close weekends). */
  readonly openDaysOfWeek?: readonly number[];
  /** Multiple per-day-group sessions, for venues with different hours
   *  on different days (e.g. clubs that open late on Fri/Sat). When
   *  set, this is the canonical schedule; openHours/openDaysOfWeek
   *  are ignored for viewer-side open/closed decisions. */
  readonly openSessions?: readonly OpenSession[];
}

/** One opening window on a set of weekdays. `end > 24` means the
 *  session continues past midnight into the next day (e.g. a Friday
 *  19→02 club night runs as { daysOfWeek: [5], start: 19, end: 26 }
 *  and the small-hours portion is attributed to Friday's session,
 *  not Saturday's). */
export interface OpenSession {
  readonly daysOfWeek: readonly number[];
  readonly start: number;
  readonly end: number;
}

/**
 * Per-category "uninformed prior" anchors for the judgement engine
 * (docs/judgement.md). These are the £ values a member of the public
 * with zero expertise on the category would guess an average item is
 * worth. Used as the floor of `lerp(anchor, truth, expertise)` in
 * every numeric `estimate()` call.
 *
 * Numbers are deliberately blunt — round-tens median-ish baselines
 * across each category's catalogue, not careful averages. Tuning
 * lives in the same play-testing loop as the rest of the economics
 * knobs. Authors who want a category's clueless-guess to feel sharply
 * different (e.g. a yuppie's "average electronics" anchor) can split
 * per-archetype later; v1 is one number per category.
 */
// Per-category "uninformed prior" anchors — data moved to JSON (TBD).
const CATEGORY_ANCHORS: ReadonlyMap<string, number> = new Map();

/**
 * Per-category condition anchor in [0, 1] — the v2 condition arm's
 * "what does a clueless actor's centre quality lerp toward?" prior.
 * Read in `arms.ts` via `getCategoryConditionAnchor`. Numbers are the
 * skin author's hunch about a category's typical condition; play-
 * testing will reshape them.
 *
 *   0.0 → broken-end prior ("most of this category is junk")
 *   0.5 → fair-end prior (engine fallback when a row is missing)
 *   1.0 → mint-end prior ("most of this category is near-new")
 *
 * Tools, vehicles, and food anchor below 0.5 — tools and motors get
 * thrashed; food spoils. Electronics and safety gear anchor slightly
 * above — these were mostly engineered to last and the survivors look
 * passable. Clothing and decor sit at the global default — wide
 * variance, no clueless-prior lean. Toys, novelty, and luggage anchor
 * slightly below — knock-off and second-hand outflow is the dominant
 * channel.
 */
// Per-category condition anchor — data moved to JSON (TBD).
const CATEGORY_CONDITION_ANCHORS: ReadonlyMap<string, number> = new Map();

const DAYS_MON_SUN: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
const DAYS_THU_SUN: readonly number[] = [4, 5, 6, 7];
const DAYS_SUN_THU: readonly number[] = [7, 1, 2, 3, 4];
const DAYS_FRI_SAT: readonly number[] = [5, 6];

/**
 * Institutional accounting actors. Sotheby's and the off-map market
 * are locations in the fiction; they live in `data/locations.json`.
 * The engine still needs an actor id to route auction proceeds and
 * off-map cash through, so each location gets a synthetic virtual
 * actor seeded at run-setup time. `code` here must match the lookups
 * downstream (`actorByCode.get("auction-house")` etc).
 */
interface AccountingActorSpec {
  readonly code: string;
  readonly firstName: string;
  readonly shortName: string;
  readonly locationCode: string;
}
const ACCOUNTING_ACTORS: readonly AccountingActorSpec[] = [
  {
    code: "auction-house",
    firstName: "Sotheby's",
    shortName: "Sotheby's",
    locationCode: "auction-house",
  },
  {
    code: OFF_MAP_MARKET_CODE,
    firstName: "Off-map Market",
    shortName: "Off-map Market",
    locationCode: "off-map",
  },
];

// Location specs — loaded from ./data/locations.json at module load.
interface LocationJson {
  readonly code: string;
  readonly displayName: string;
  readonly type: LocationType;
  readonly openHours?: { readonly start: number; readonly end: number };
  readonly openDaysOfWeek?: readonly number[];
  readonly openSessions?: readonly OpenSession[];
}
const LOCATIONS: readonly LocationSpec[] = loadSkinJson<readonly LocationJson[]>(
  "data/locations.json",
).map(
  (j): LocationSpec => ({
    code: j.code,
    displayName: j.displayName,
    type: j.type,
    ...(j.openHours !== undefined ? { openHours: j.openHours } : {}),
    ...(j.openDaysOfWeek !== undefined ? { openDaysOfWeek: j.openDaysOfWeek } : {}),
    ...(j.openSessions !== undefined ? { openSessions: j.openSessions } : {}),
  }),
);

/**
 * The item categories each shop "deals in" — drives the planner's
 * per-shop matched-stock bonus, so a dealer with a bag of drills steers
 * to Sparks Electrical / Hi-Tech Hut rather than the jeweller. Mirrors
 * the corresponding shopkeeper's bidder-profile high-accuracy slots.
 * Generalist shops (Patel's, Corner Shop) get a wide net so any stock
 * matches a little.
 */
// Shop specialties — data moved to JSON (TBD).
const SHOP_SPECIALTIES_BY_CODE: Readonly<Record<string, readonly string[]>> = {};

/**
 * Per-shop hourly footfall curves (todolist #2). Replaces the
 * default `shopSale.hourlyFootfall` for each shop so the day reads
 * cinematically — newsagents at school-run o'clock, jewellers
 * around lunchtime, furniture stores all afternoon.
 *
 * Hours not listed default to 0 (shop quiet that hour). All shops
 * close before 18:00.
 */
// Shop hourly footfall — data moved to JSON (TBD).
const SHOP_FOOTFALL_BY_CODE: Readonly<Record<string, Readonly<Record<number, number>>>> = {};

/**
 * Per-shop persona-weight multipliers (todolist #1). Biases the
 * shared persona bank for each shop so a jeweller pulls a different
 * crowd than the electrical place. Personas not listed take 1.0;
 * 0 effectively excludes them.
 *
 * Personas in the default bank: old-dears, students, mums, dads.
 */
// Shop persona multipliers — data moved to JSON (TBD).
const SHOP_PERSONA_MULTIPLIERS_BY_CODE: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {};

/**
 * Daily auction window. The engine picks up to (END-START+1) lots
 * randomly each morning and runs them one per hour during this range.
 * Combined with the listing knowledge mechanic, dealers must visit
 * Sid's Café (newspaper) or the gallery to learn what's on the docket
 * — without that, they can't bid.
 */
const AUCTION_START_HOUR = 11;
const AUCTION_END_HOUR = 16;
/** Hour the newspaper drops at Sid's Café. */
const PAPER_FROM_HOUR = 6;
/** Hour the listing goes up in Sotheby's gallery. */
const GALLERY_FROM_HOUR = 8;

interface ProfileSpec {
  readonly defaultAccuracy: number;
  readonly perCategory?: Readonly<Record<string, number>>;
  readonly defaultFlawDetection: number;
  readonly perFlawDetection?: Readonly<Partial<Record<FlawType, number>>>;
  readonly customerTypes?: readonly string[];
}

// ACTOR_PROFILES — data moved to JSON (TBD).
const ACTOR_PROFILES: Readonly<Record<string, ProfileSpec>> = {};


// Which actor codes participate in pub-deal / pool-claim autonomy. The
// wider cast follows routines but stays out of the trading loop —
// civilians don't claim pools, and Mike doesn't run pubdeals from
// behind the bar.
// Trading actor codes — data moved to JSON (TBD).
const TRADING_CODES: readonly string[] = [];

/**
 * Information-trader actors. They aren't necessarily traders of stock —
 * Mike runs a pub, Sid a caff, Albert nurses pints at the Legion —
 * their value to the player is the relationship and the rumour
 * pipeline that comes with it. In chat-side gossip the per-encounter
 * lead yield jumps when either party is one of these. Per
 * design.md → Stage 2: "Denzil (mobile), Mike (Nag's), Sid (café),
 * Albert (Legion) — outsized lead capacity per encounter and a
 * location-flavoured gossip slant."
 */
// Information-trader codes — data moved to JSON (TBD).
const INFO_TRADER_CODES: readonly string[] = [];

/**
 * Stage 6 — named external producers. Each has a category roster (the
 * kinds of stock they supply), a broker list (the local actors who
 * hold the relationship and can therefore claim from a pool the
 * producer owns), and a bank of provenance phrases attached to each
 * spawned pool for narrative flavour.
 *
 * Pools spawned for a category covered here become "owned" pools —
 * `world_pools.owner_actor_id` is set, reachability is the producer's
 * broker list, and the pool carries a provenance string. Pools for
 * categories not covered fall back to the legacy ambient flow
 * (`REACHABLE_BY_CATEGORY`).
 */
interface VirtualProducerSpec {
  readonly code: string;
  readonly displayName: string;
  readonly categories: readonly string[];
  readonly brokerCodes: readonly string[];
  readonly provenancePhrases: readonly string[];
}

// Virtual producers — data moved to JSON (TBD).
const VIRTUAL_PRODUCERS: readonly VirtualProducerSpec[] = [];

// Reachability by category — data moved to JSON (TBD).
const REACHABLE_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {};

const DEFAULT_REACHABLE_CODES: readonly string[] = [];

/**
 * Free-form descriptive tags per character. Used by the webapp filter
 * rail (no engine logic depends on these). Order in each list is just
 * for readability — primary identity first, secondary tags after.
 *
 * Keys must match an actor `code` in ACTORS above. New code → empty
 * roles unless added here.
 */
// Actor roles — sourced from each actor's `roles` field in actors.json.
const ACTOR_ROLES: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, readonly string[]> = {};
  for (const spec of ACTORS) {
    if (spec.roles !== undefined && spec.roles.length > 0) {
      out[spec.code] = spec.roles;
    }
  }
  return out;
})();

export interface SkinSeedOptions {
  readonly runLengthDays?: number;
  /**
   * Per-actor delivery override consulted by the AI policy before its
   * regular schedule. Returns the location id the actor should be at
   * for that hour, or null to use the regular schedule. The delivery
   * scheduler injects this so pickup/dropoff trips land at the right
   * hour.
   */
  readonly hourOverrideForActor?: (
    actorId: number,
  ) => ((clock: { day: number; hour: number }) => number | null) | null;
  /**
   * Economic tuning bundle. Override individual fields to change pool
   * wholesale ratios, pub-deal ceilings, tier multipliers, etc. without
   * touching engine code. Pass `resolveEconomicsConfig({ poolOpeningFraction: 0.25 })`
   * to override one knob and inherit defaults for the rest.
   */
  readonly economics?: EconomicsConfig;
}

export function seedPlaceholderSkin(
  db: DB,
  rng: SeededRNG,
  opts: SkinSeedOptions = {},
): SkinSeedResult {
  const runLengthDays = opts.runLengthDays ?? 14;
  const economics = resolveEconomicsConfig(opts.economics);

  // Locations.
  const locByCode = new Map<string, number>();
  const openSessionsByCode = new Map<string, readonly OpenSession[]>();
  for (const spec of LOCATIONS) {
    const loc = insertLocation(db, {
      code: spec.code,
      displayName: spec.displayName,
      type: spec.type,
      openHours: spec.openHours ?? null,
    });
    locByCode.set(spec.code, loc.id);
    // Normalise scheduling info into openSessions: explicit
    // openSessions wins; otherwise build one from openHours +
    // openDaysOfWeek if either is present; otherwise leave the map
    // empty for this code (viewer falls back to the type heuristic).
    if (spec.openSessions !== undefined) {
      openSessionsByCode.set(spec.code, spec.openSessions);
    } else if (
      spec.openHours !== undefined &&
      spec.openDaysOfWeek !== undefined
    ) {
      openSessionsByCode.set(spec.code, [
        {
          daysOfWeek: spec.openDaysOfWeek,
          start: spec.openHours.start,
          end: spec.openHours.end,
        },
      ]);
    }
  }

  // Items. Track everyday item ids so we can seed starter stock from
  // the same catalogue.
  const everydayItemIds: number[] = [];
  for (const spec of EVERYDAY_ITEMS) {
    const k = insertItemKind(db, spec);
    everydayItemIds.push(k.id);
  }
  for (const spec of EASTER_EGG_ITEMS) insertItemKind(db, spec);

  // Actors.
  const actorByCode = new Map<string, number>();
  const actorDefaultLocByCode = new Map<string, number>();
  const actorLockupLocByCode = new Map<string, number>();
  const policies = new Map<number, ActorPolicy>();
  const actorRoutines = new Map<number, ActorRoutineInfo>();
  for (const spec of ACTORS) {
    const homeId = locByCode.get(spec.homeLocation);
    if (homeId === undefined) {
      throw new Error(`unknown home location for ${spec.code}: ${spec.homeLocation}`);
    }
    const lockupCode = spec.lockupLocation ?? spec.homeLocation;
    const lockupId = locByCode.get(lockupCode);
    if (lockupId === undefined) {
      throw new Error(`unknown lockup location for ${spec.code}: ${lockupCode}`);
    }
    const a = insertActor(db, {
      code: spec.code,
      firstName: spec.firstName,
      ...(spec.lastName !== undefined ? { lastName: spec.lastName } : {}),
      shortName: spec.shortName,
      cash: spec.cash,
      transportCapacity: spec.transportCapacity,
      homeLocationId: homeId,
      lockupLocationId: lockupId,
      ...(spec.bribable === true ? { bribable: true } : {}),
      ...(spec.socialScore !== undefined ? { socialScore: spec.socialScore } : {}),
    });
    actorByCode.set(spec.code, a.id);
    actorLockupLocByCode.set(spec.code, lockupId);

    const defaultLocId = locByCode.get(spec.defaultLocation);
    if (defaultLocId === undefined) {
      throw new Error(`unknown default location for ${spec.code}: ${spec.defaultLocation}`);
    }
    setActorLocation(db, a.id, defaultLocId);
    actorDefaultLocByCode.set(spec.code, defaultLocId);

    const scheduleByHour = new Map<number, number>();
    for (const [hour, locCode] of spec.schedule) {
      const locId = locByCode.get(locCode);
      if (locId === undefined) {
        throw new Error(`unknown location in schedule for ${spec.code}: ${locCode}`);
      }
      scheduleByHour.set(hour, locId);
    }

    let weekendScheduleByHour: Map<number, number> | undefined;
    if (spec.weekendSchedule !== undefined) {
      weekendScheduleByHour = new Map();
      for (const [hour, locCode] of spec.weekendSchedule) {
        const locId = locByCode.get(locCode);
        if (locId === undefined) {
          throw new Error(
            `unknown location in weekendSchedule for ${spec.code}: ${locCode}`,
          );
        }
        weekendScheduleByHour.set(hour, locId);
      }
    }

    actorRoutines.set(a.id, {
      homeLocationId: homeId,
      schedule: scheduleByHour,
      flexibleHours: spec.flexibleHours,
      awakeHours: spec.awakeHours,
      ...(weekendScheduleByHour !== undefined
        ? { weekendSchedule: weekendScheduleByHour }
        : {}),
      ...(spec.weekendFlexibleHours !== undefined
        ? { weekendFlexibleHours: spec.weekendFlexibleHours }
        : {}),
    });

    if (spec.code !== "del-boy") {
      const hourOverride = opts.hourOverrideForActor?.(a.id) ?? null;
      const policyOpts: {
        schedule: Map<number, number>;
        weekendSchedule?: Map<number, number>;
        defaultLocationId: number | null;
        hourOverride?: (clock: { day: number; hour: number }) => number | null;
      } = {
        schedule: scheduleByHour,
        defaultLocationId: defaultLocId,
      };
      if (weekendScheduleByHour !== undefined) {
        policyOpts.weekendSchedule = weekendScheduleByHour;
      }
      if (hourOverride !== null) {
        policyOpts.hourOverride = hourOverride;
      }
      policies.set(
        a.id,
        new RuleBasedAIPolicy(`policy-${spec.code}`, policyOpts),
      );
    }
  }

  // Institutional accounting actors. Sotheby's and the Off-map Market
  // are locations in the fiction, not characters — but the engine
  // needs an actor id to route auction proceeds and off-map cash
  // through. Seeded as virtual actors so the cast UI keeps them out
  // of the main roster.
  for (const acc of ACCOUNTING_ACTORS) {
    const locId = locByCode.get(acc.locationCode);
    if (locId === undefined) {
      throw new Error(
        `accounting actor ${acc.code} references unknown location ${acc.locationCode}`,
      );
    }
    const a = insertActor(db, {
      code: acc.code,
      firstName: acc.firstName,
      shortName: acc.shortName,
      cash: 0,
      transportCapacity: "none",
      homeLocationId: locId,
      lockupLocationId: locId,
      isVirtual: true,
    });
    actorByCode.set(acc.code, a.id);
    setActorLocation(db, a.id, locId);
  }

  const playerId = actorByCode.get("del-boy");
  const auctionHouseId = actorByCode.get("auction-house");
  // Resolve role tags: skin-defined codes → live actor ids.
  const rolesByActorId = new Map<number, readonly string[]>();
  for (const [code, roles] of Object.entries(ACTOR_ROLES)) {
    const id = actorByCode.get(code);
    if (id !== undefined && roles.length > 0) rolesByActorId.set(id, roles);
  }
  // Short / nickname forms — actor ids → short label for chip UI.
  const shortNameByActorId = new Map<number, string>();
  for (const spec of ACTORS) {
    if (spec.shortName === undefined) continue;
    const id = actorByCode.get(spec.code);
    if (id !== undefined) shortNameByActorId.set(id, spec.shortName);
  }
  for (const acc of ACCOUNTING_ACTORS) {
    const id = actorByCode.get(acc.code);
    if (id !== undefined) shortNameByActorId.set(id, acc.shortName);
  }
  if (playerId === undefined || auctionHouseId === undefined) {
    throw new Error("placeholder skin must seed del-boy and auction-house actors");
  }

  // Knowledge profiles — five-axis (per-axis accuracy on condition /
  // flaw / price / band-placement / customer-fit). Authored as the new
  // shape directly; the old two-axis `BidderProfile` smushed condition
  // and price into one number with a runtime fan-out helper, which is
  // gone now.
  const bidderProfiles = new Map<number, KnowledgeProfile>();
  for (const [code, spec] of Object.entries(ACTOR_PROFILES)) {
    const id = actorByCode.get(code);
    if (id === undefined) continue;
    const perCat = new Map<string, number>();
    if (spec.perCategory) {
      for (const [cat, acc] of Object.entries(spec.perCategory)) perCat.set(cat, acc);
    }
    const flawMap = new Map<FlawType, number>();
    if (spec.perFlawDetection) {
      for (const [flaw, score] of Object.entries(spec.perFlawDetection)) {
        if (score !== undefined) flawMap.set(flaw as FlawType, score);
      }
    }
    const profileEntry: KnowledgeProfile = {
      bandPlacementAccuracy: new Map(perCat),
      defaultBandPlacementAccuracy: spec.defaultAccuracy,
      conditionAccuracy: new Map(perCat),
      defaultConditionAccuracy: spec.defaultAccuracy,
      flawDetection: flawMap,
      defaultFlawDetection: spec.defaultFlawDetection,
      priceAccuracy: new Map(perCat),
      defaultPriceAccuracy: spec.defaultAccuracy,
      customerFitAccuracy: new Map(),
      defaultCustomerFitAccuracy: 0.7,
      ...(spec.customerTypes ? { customerTypes: spec.customerTypes } : {}),
    };
    bidderProfiles.set(id, profileEntry);
  }

  // Persist the five-axis grid into actor_skills / actor_skill_defaults.
  // The in-memory map above remains the runtime carrier passed to the
  // auction / pub-deal / market pipelines; the DB rows back consultations
  // / belief aggregator / haggle anchors.
  seedKnowledgeProfiles(db, bidderProfiles);

  // Per-category "uninformed prior" — the floor of the
  // `lerp(anchor, truth, expertise)` centre computation used by the
  // judgement engine (docs/judgement.md). Tuning the table is part of
  // the same play-testing loop as the rest of the economics knobs;
  // numbers here are median-ish baselines for each category's
  // catalogue, rounded to feel like "what would a punter on the
  // street guess?" rather than a careful average.
  seedCategoryAnchors(db, CATEGORY_ANCHORS);
  seedCategoryConditionAnchors(db, CATEGORY_CONDITION_ANCHORS);

  // Per-actor arm-j overrides — characters whose decisiveness is
  // explicitly decoupled from their expertise (docs/judgement.md "Per-arm
  // dials"). Without a row in `actor_arm_j`, j falls back to expertise
  // (the doc's "skin defaults set them equal" rule). The placeholder
  // skin uses these sparingly — only when a character's distinctive
  // trait is the decisiveness gap, not the expertise level.
  //
  // Mickey Pearce — the confident schemer. Low price-expertise paired
  // with a deliberately high price-j: he commits tightly to his
  // anchor-drifted centre and sounds sure of himself while talking
  // wheeler-dealer nonsense. The narrative read: he KNOWS what he
  // thinks; he just doesn't know what it's worth.
  const mickeyId = actorByCode.get("mickey-pearce");
  if (mickeyId !== undefined) {
    setActorArmJ(db, { actorId: mickeyId, arm: "price", j: 0.85 });
  }

  // Reachability map — resolve actor codes to ids.
  const reachableByCategory = new Map<string, readonly number[]>();
  for (const [cat, codes] of Object.entries(REACHABLE_BY_CATEGORY)) {
    const ids = codes
      .map((c) => actorByCode.get(c))
      .filter((id): id is number => id !== undefined);
    if (ids.length > 0) reachableByCategory.set(cat, ids);
  }
  const defaultReachableActorIds = DEFAULT_REACHABLE_CODES
    .map((c) => actorByCode.get(c))
    .filter((id): id is number => id !== undefined);

  const nagsId = locByCode.get("nags");
  const pubLocationIds = nagsId !== undefined ? [nagsId] : [];

  // All pub-type locations — exposed separately so the planner can use
  // them as candidate destinations even though pub-deal autonomy
  // currently only fires at the Nag's.
  const allPubLocationIds: number[] = [];
  for (const spec of LOCATIONS) {
    if (spec.type === "pub") {
      const id = locByCode.get(spec.code);
      if (id !== undefined) allPubLocationIds.push(id);
    }
  }

  const shopLocationIds: number[] = [];
  const shopkeeperActorIds: number[] = [];
  const shopSpecialtiesByLocation = new Map<number, ReadonlyArray<string>>();
  const shopFootfallByLocation = new Map<
    number,
    Readonly<Record<number, number>>
  >();
  const shopPersonaMultipliersByLocation = new Map<
    number,
    Readonly<Record<string, number>>
  >();
  for (const { shopCode, keeperCode } of HIGH_STREET_SHOPS) {
    const shopId = locByCode.get(shopCode);
    const keeperId = actorByCode.get(keeperCode);
    if (shopId !== undefined && keeperId !== undefined) {
      shopLocationIds.push(shopId);
      shopkeeperActorIds.push(keeperId);
      setLocationProprietor(db, shopId, keeperId);
      const specialties = SHOP_SPECIALTIES_BY_CODE[shopCode];
      if (specialties !== undefined) {
        shopSpecialtiesByLocation.set(shopId, specialties);
      }
      const footfall = SHOP_FOOTFALL_BY_CODE[shopCode];
      if (footfall !== undefined) {
        shopFootfallByLocation.set(shopId, footfall);
      }
      const personaMults = SHOP_PERSONA_MULTIPLIERS_BY_CODE[shopCode];
      if (personaMults !== undefined) {
        shopPersonaMultipliersByLocation.set(shopId, personaMults);
      }
    }
  }

  // Locations carrying the morning paper. Sid's is the original drop;
  // newsagent-style high-street shops also stock it.
  const newspaperLocationIds: number[] = [];
  for (const code of ["sids-cafe", "patels", "corner-shop"]) {
    const id = locByCode.get(code);
    if (id !== undefined) newspaperLocationIds.push(id);
  }

  // Off-map dealer ids resolved from codes; market actor id resolved
  // for cash-flow plumbing. Both flow through to run-sim wiring.
  const offMapDealerActorIds: number[] = [];
  for (const code of OFF_MAP_DEALER_CODES) {
    const id = actorByCode.get(code);
    if (id !== undefined) offMapDealerActorIds.push(id);
  }
  const offMapMarketActorId = actorByCode.get(OFF_MAP_MARKET_CODE);
  if (offMapMarketActorId === undefined) {
    throw new Error(
      "placeholder skin must seed the off-map-market accounting actor",
    );
  }

  const mikeId = actorByCode.get("mike");
  if (nagsId !== undefined && mikeId !== undefined) {
    setLocationProprietor(db, nagsId, mikeId);
  }
  const sidsId = locByCode.get("sids-cafe");
  const sidId = actorByCode.get("sid");
  if (sidsId !== undefined && sidId !== undefined) {
    setLocationProprietor(db, sidsId, sidId);
  }

  const auctionLocationId = locByCode.get("auction-house");
  if (auctionLocationId === undefined) {
    throw new Error("placeholder skin must seed the auction-house location");
  }

  const tradingActorIds = TRADING_CODES.map((c) => actorByCode.get(c)).filter(
    (id): id is number => id !== undefined,
  );
  const infoTraderActorIds = INFO_TRADER_CODES.map((c) => actorByCode.get(c)).filter(
    (id): id is number => id !== undefined,
  );

  // Starter stock — every dealer/fence opens day 1 with 2-3 lots from
  // the everyday catalogue. Each lot also seeds a first-hand "I have
  // this" supply lead, so gossip starts with something to circulate.
  // Stock lives at the actor's *lockup*, not their day-time location.
  seedStarterStock(db, rng, {
    actorByCode,
    actorLockupLocByCode,
    everydayItemIds,
    economics,
  });

  const newspaperLocationId = sidsId;
  if (newspaperLocationId === undefined) {
    throw new Error("placeholder skin must seed the sids-cafe location");
  }

  const marketLocationId = locByCode.get("peckham-market");
  if (marketLocationId === undefined) {
    throw new Error("placeholder skin must seed the peckham-market location");
  }
  // Anyone tagged dealer / fence / player runs a stall when at the market.
  const marketSellerActorIds: number[] = [];
  for (const [code, roles] of Object.entries(ACTOR_ROLES)) {
    const id = actorByCode.get(code);
    if (id === undefined) continue;
    if (
      roles.includes("dealer") ||
      roles.includes("fence") ||
      roles.includes("player")
    ) {
      marketSellerActorIds.push(id);
    }
  }

  // Actors that opted into the daily mode picker (set their flag in
  // the spec). Resolved against actorByCode here for downstream use.
  const flexibleDailyModeActorIds: number[] = [];
  for (const spec of ACTORS) {
    if (spec.flexibleDailyMode === true) {
      const id = actorByCode.get(spec.code);
      if (id !== undefined) flexibleDailyModeActorIds.push(id);
    }
  }

  // Lunch-slot specs: resolve candidate codes → ids so setup.ts can
  // just roll an index. Spec entries with unresolvable codes are
  // skipped silently (e.g. if a skin tweak drops a venue).
  const lunchSpecsByActorId = new Map<
    number,
    {
      hours: readonly number[];
      daysOfWeek: readonly number[];
      candidateLocIds: readonly number[];
    }
  >();
  for (const spec of ACTORS) {
    if (spec.lunchSlot === undefined) continue;
    const actorId = actorByCode.get(spec.code);
    if (actorId === undefined) continue;
    const candidateLocIds: number[] = [];
    for (const code of spec.lunchSlot.candidateCodes) {
      const locId = locByCode.get(code);
      if (locId !== undefined) candidateLocIds.push(locId);
    }
    if (candidateLocIds.length === 0) continue;
    lunchSpecsByActorId.set(actorId, {
      hours: spec.lunchSlot.hours,
      daysOfWeek: spec.lunchSlot.daysOfWeek,
      candidateLocIds,
    });
  }

  // Stage 6 — seed the named virtual producers. They don't tick, don't
  // pubdeal, don't have a routine; they're records whose ids appear on
  // owned-pool `owner_actor_id` and (eventually) on rep/commodity leads
  // as `counterparty_actor_id`. Broker codes are resolved against the
  // already-seeded local cast; producers with no resolvable brokers are
  // skipped (defensive — shouldn't fire for the shipping cast).
  const virtualProducers: VirtualProducerInfo[] = [];
  for (const spec of VIRTUAL_PRODUCERS) {
    const brokerActorIds = spec.brokerCodes
      .map((c) => actorByCode.get(c))
      .filter((id): id is number => id !== undefined);
    if (brokerActorIds.length === 0) continue;
    const a = insertActor(db, {
      code: spec.code,
      firstName: spec.displayName,
      shortName: spec.displayName,
      cash: 0,
      transportCapacity: "none",
      isVirtual: true,
    });
    actorByCode.set(spec.code, a.id);
    rolesByActorId.set(a.id, ["virtual-producer"]);
    virtualProducers.push({
      actorId: a.id,
      code: spec.code,
      displayName: spec.displayName,
      categories: spec.categories,
      brokerActorIds,
      provenancePhrases: spec.provenancePhrases,
    });
  }
  const virtualProducersByCategory = new Map<string, VirtualProducerInfo[]>();
  for (const p of virtualProducers) {
    for (const cat of p.categories) {
      const list = virtualProducersByCategory.get(cat) ?? [];
      list.push(p);
      virtualProducersByCategory.set(cat, list);
    }
  }

  // Pair-sync: load pairs.json, resolve codes → ids, drop any pair with
  // an unknown member. Used by the viewer's calendar-knowledge model
  // (continuous co-presence between partners).
  const pairsJson = loadSkinJson<readonly (readonly [string, string])[]>(
    "data/pairs.json",
  );
  const resolvedPairs: (readonly [number, number])[] = [];
  for (const [aCode, bCode] of pairsJson) {
    const aId = actorByCode.get(aCode);
    const bId = actorByCode.get(bCode);
    if (aId === undefined || bId === undefined) continue;
    resolvedPairs.push([aId, bId]);
  }

  return {
    playerActorId: playerId,
    auctionHouseActorId: auctionHouseId,
    policies,
    bidderProfiles,
    reachableByCategory,
    defaultReachableActorIds,
    pubLocationIds,
    allPubLocationIds,
    shopLocationIds,
    shopSpecialtiesByLocation,
    shopFootfallByLocation,
    shopPersonaMultipliersByLocation,
    shopkeeperActorIds,
    newspaperLocationIds,
    offMapDealerActorIds,
    offMapMarketActorId,
    auctionLocationId,
    auctionStartHour: AUCTION_START_HOUR,
    auctionEndHour: AUCTION_END_HOUR,
    newspaperLocationId,
    paperFromHour: PAPER_FROM_HOUR,
    galleryFromHour: GALLERY_FROM_HOUR,
    marketLocationId,
    marketSellerActorIds,
    ...(actorByCode.get("slater") !== undefined
      ? { patrolOfficerActorId: actorByCode.get("slater")! }
      : {}),
    // Patrol officers — data moved to JSON (TBD).
    patrolOfficers: [] as PatrolOfficerSpec[],
    flexibleDailyModeActorIds,
    locationByCode: locByCode,
    openSessionsByCode,
    lunchSpecsByActorId,
    runLengthDays,
    tradingActorIds,
    infoTraderActorIds,
    virtualProducers,
    virtualProducersByCategory,
    economics,
    actorRoutines,
    rolesByActorId,
    shortNameByActorId,
    pairs: resolvedPairs,
  };
}

/** Actor codes that get starter stock — anyone tagged dealer or fence. */
const STARTER_STOCK_CODES: readonly string[] = (() => {
  const out: string[] = [];
  for (const [code, roles] of Object.entries(ACTOR_ROLES)) {
    if (roles.includes("dealer") || roles.includes("fence")) out.push(code);
  }
  return out;
})();

const STARTER_TIERS: readonly QualityTier[] = ["good", "fair"];

interface SeedStarterStockArgs {
  readonly actorByCode: ReadonlyMap<string, number>;
  readonly actorLockupLocByCode: ReadonlyMap<string, number>;
  readonly everydayItemIds: readonly number[];
  readonly economics: EconomicsConfig;
}

function seedStarterStock(
  db: DB,
  rng: SeededRNG,
  args: SeedStarterStockArgs,
): void {
  const { actorByCode, actorLockupLocByCode, everydayItemIds, economics } = args;
  if (everydayItemIds.length === 0) return;
  const fmin = economics.starterStockAcquisitionFractionMin;
  const fmax = economics.starterStockAcquisitionFractionMax;
  const fspan = Math.max(0, fmax - fmin);

  for (const code of STARTER_STOCK_CODES) {
    const ownerId = actorByCode.get(code);
    if (ownerId === undefined) continue;
    const locId = actorLockupLocByCode.get(code) ?? null;

    const lotCount = rng.int(4, 7); // 4–6 lots
    const usedItemIds = new Set<number>();
    for (let i = 0; i < lotCount; i += 1) {
      // Pick a distinct item per actor — multiple lots of the same item
      // would just collapse together for gossip purposes.
      let itemId: number;
      let guard = 0;
      do {
        itemId = rng.pick(everydayItemIds);
        guard += 1;
      } while (usedItemIds.has(itemId) && guard < 8);
      usedItemIds.add(itemId);

      const item = EVERYDAY_ITEMS.find(
        (_, idx) => everydayItemIds[idx] === itemId,
      );
      if (item === undefined) continue;

      const tier = rng.pick(STARTER_TIERS);
      // Target each starter lot at £80–£400 RRP so it clears the
      // pub-deal £100 floor immediately and gives the dealer something
      // worth actually haggling about. Quantity is derived from the
      // item's tier-anchored retail mid; small high-value items end
      // up as tiny lots, cheap commodity items as big ones.
      const tierMult = economics.tierMultipliers[tier];
      const retailPerUnit = Math.max(1, item.baseValue * tierMult);
      const targetRrp = 80 + rng.next() * 320; // [£80, £400]
      const quantity = Math.max(1, Math.round(targetRrp / retailPerUnit));
      const priceFactor = fmin + rng.next() * fspan;
      const acquiredUnitPrice = Math.max(
        1,
        Math.round(item.baseValue * priceFactor),
      );

      const lot = insertStockLot(db, {
        ownerActorId: ownerId,
        itemKindId: itemId,
        qualityTier: tier,
        quantity,
        acquiredUnitPrice,
        acquiredDay: 1,
        locationId: locId,
      });

      seedSupplyLeadForStockLot(db, lot, 1, economics);
    }
  }
}

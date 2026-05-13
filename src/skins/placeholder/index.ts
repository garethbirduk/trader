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
import type { BidderProfile } from "../../engine/auction/bidder-profile.js";
import { seedKnowledgeProfiles } from "../../engine/knowledge/skin-seed.js";
import type { FlawType, QualityTier } from "../../engine/stock/types.js";
import type { TransportCapacity } from "../../engine/actors/types.js";
import { EVERYDAY_ITEMS } from "./catalogue-everyday.js";
import { EASTER_EGG_ITEMS } from "./catalogue-easter-eggs.js";
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
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
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

interface ActorSpec {
  readonly code: string;
  readonly displayName: string;
  readonly cash: number;
  /** Weekday schedule (Mon-Fri). */
  readonly schedule: ReadonlyMap<number, string>;
  /** Hours where the actor's routine is flexible (defaults to home but
   *  can be repurposed for ad-hoc tasks like delivery trips). Filled in
   *  automatically by makeRoutineFromSpans(). */
  readonly flexibleHours: ReadonlySet<number>;
  /** Optional weekend (Sat/Sun) schedule. If omitted, weekday schedule
   *  applies all week. Fixed-job actors with closed venues on weekends
   *  (council yard, banks, shops) supply this to "stay home / pub". */
  readonly weekendSchedule?: ReadonlyMap<number, string>;
  /** Optional weekend flexibleHours set. Defaults to `flexibleHours`. */
  readonly weekendFlexibleHours?: ReadonlySet<number>;
  readonly defaultLocation: string;
  readonly homeLocation: string;
  /** Where this actor stores stock. Defaults to homeLocation. */
  readonly lockupLocation?: string;
  readonly transportCapacity: TransportCapacity;
  readonly awakeHours: { readonly start: number; readonly end: number };
  /** When true, the per-hour planner picks this actor's next-hour
   *  destination during their flexible hours. Fixed-job actors
   *  (Mike, Sid, Slater, shopkeepers, …) leave this unset and their
   *  routine runs as written. */
  readonly flexibleDailyMode?: boolean;
  /** Whether this actor accepts bribes. Defaults to false. */
  readonly bribable?: boolean;
  /** Per-day random lunch destination for employed civilians whose
   *  schedule is otherwise fixed. On each day in `daysOfWeek` the
   *  seed rolls one pick from `candidateCodes` and applies it to
   *  every hour in `hours` for that day. Lets Cassandra alternate
   *  between staying at the bank, going home, hitting Sid's, or
   *  popping into the Nag's without making her a fully-flexible
   *  actor. */
  readonly lunchSlot?: {
    readonly hours: readonly number[];
    readonly daysOfWeek: readonly number[];
    readonly candidateCodes: readonly string[];
  };
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

const DAYS_MON_FRI: readonly number[] = [1, 2, 3, 4, 5];
const DAYS_MON_SAT: readonly number[] = [1, 2, 3, 4, 5, 6];
const DAYS_MON_SUN: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
const DAYS_THU_SUN: readonly number[] = [4, 5, 6, 7];
const DAYS_SUN_THU: readonly number[] = [7, 1, 2, 3, 4];
const DAYS_FRI_SAT: readonly number[] = [5, 6];

const LOCATIONS: readonly LocationSpec[] = [
  // Original cast's spaces.
  { code: "peckham-flat", displayName: "Del's Flat", type: "home" },
  { code: "lockup", displayName: "The Lock-up", type: "business", openHours: { start: 8, end: 20 } },
  { code: "nags", displayName: "The Nag's Head", type: "pub", openHours: { start: 11, end: 23 }, openDaysOfWeek: DAYS_MON_SUN },
  { code: "auction-house", displayName: "Sotheby's", type: "auction", openHours: { start: 8, end: 17 } },
  { code: "boyce-auto-sales", displayName: "Boyce Autos", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "transworld-depot", displayName: "Transworld Depot", type: "business", openHours: { start: 6, end: 18 } },
  { code: "lambeth-council-yard", displayName: "Council Yard", type: "civic", openHours: { start: 6, end: 17 } },
  // Added from the wider canon.
  { code: "peckham-market", displayName: "Peckham Market", type: "business", openHours: { start: 8, end: 16 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "sids-cafe", displayName: "Sid's Café", type: "business", openHours: { start: 6, end: 16 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "boycie-house", displayName: "Boyce's", type: "home" },
  { code: "denzil-house", displayName: "Denzil's", type: "home" },
  {
    code: "one-eleven-club",
    displayName: "The 111 Club",
    type: "pub",
    // Engine envelope: 19→02 covers the late nights; planner sees a
    // single span. Truth is the openSessions below.
    openHours: { start: 19, end: 26 },
    openSessions: [
      { daysOfWeek: DAYS_SUN_THU, start: 19, end: 23 },
      { daysOfWeek: DAYS_FRI_SAT, start: 19, end: 26 },
    ],
  },
  { code: "starlight-rooms", displayName: "Starlight Rooms", type: "pub", openHours: { start: 20, end: 26 } },
  { code: "police-station", displayName: "The Nick", type: "civic" },
  { code: "post-office", displayName: "Post Office", type: "civic", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "betting-shop", displayName: "The Bookies", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "shamrock-club", displayName: "Shamrock Club", type: "pub", openHours: { start: 19, end: 26 } },
  {
    code: "riverside-club",
    displayName: "Down By The Riverside Club",
    type: "pub",
    // Envelope covers the wider Fri/Sat session (18→02); planner sees
    // a single window. openSessions below is the truth — closed Sun/Mon.
    openHours: { start: 18, end: 26 },
    openSessions: [
      { daysOfWeek: [2, 3, 4], start: 20, end: 24 },     // Tue–Thu 20:00–00:00
      { daysOfWeek: DAYS_FRI_SAT, start: 18, end: 26 },  // Fri–Sat 18:00–02:00
    ],
  },
  { code: "dirty-barrys", displayName: "Dirty Barry's", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "raquel-flat", displayName: "Raquel's", type: "home" },
  { code: "cassandra-bank", displayName: "The Bank", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "parry-printers", displayName: "Parry Print", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "trigger-flat", displayName: "Trigger's", type: "home" },
  { code: "albert-legion", displayName: "The Legion", type: "pub", openHours: { start: 12, end: 21 }, openDaysOfWeek: DAYS_THU_SUN },
  { code: "mickey-jevon-flat", displayName: "Mickey & Jevon's", type: "home" },
  { code: "cassandra-flat", displayName: "Cassandra's", type: "home" },
  { code: "parry-house", displayName: "Parry's", type: "home" },
  { code: "slater-flat", displayName: "Slater's", type: "home" },
  { code: "off-map", displayName: "Off-map", type: "abstract" },
  // ─── high-street shops (sell-direct destinations for dealers) ──────
  // Two of each type to foster choice and competition. Each runs 9-17;
  // their shopkeeper lives off-map and is at the shop during these hours.
  { code: "goldfingers", displayName: "Goldfingers", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "ratners-peckham", displayName: "Ratners of Peckham", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "patels", displayName: "Patel's Newsagent", type: "business", openHours: { start: 7, end: 18 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "corner-shop", displayName: "The Corner Shop", type: "business", openHours: { start: 7, end: 18 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "wooden-soldier", displayName: "Wooden Soldier", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "toyland", displayName: "Toyland", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "sparks-electrical", displayName: "Sparks Electrical", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "hi-tech-hut", displayName: "Hi-Tech Hut", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "comfy-corner", displayName: "Comfy Corner", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
  { code: "throne-co", displayName: "Throne & Co", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
];

/**
 * High-street shop codes paired with their resident shopkeeper code.
 * Both are seeded together — one shopkeeper per shop, working 9-17,
 * living off-map. The pub-deal autonomy uses the location list to
 * decide where shop-sale attempts can fire, and the actor list to
 * constrain who can be the *buyer* (dealer-sells-to-shopkeeper only).
 */
const HIGH_STREET_SHOPS: readonly { readonly shopCode: string; readonly keeperCode: string }[] = [
  { shopCode: "goldfingers", keeperCode: "cyril-diamond" },
  { shopCode: "ratners-peckham", keeperCode: "margaret-bracelet" },
  { shopCode: "patels", keeperCode: "ranjit-patel" },
  { shopCode: "corner-shop", keeperCode: "doreen-wicks" },
  { shopCode: "wooden-soldier", keeperCode: "albert-pickering" },
  { shopCode: "toyland", keeperCode: "linda-beasley" },
  { shopCode: "sparks-electrical", keeperCode: "eric-sparks" },
  { shopCode: "hi-tech-hut", keeperCode: "brian-yardley" },
  { shopCode: "comfy-corner", keeperCode: "doris-whittle" },
  { shopCode: "throne-co", keeperCode: "reg-throne" },
];

const SHOPKEEPER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "cyril-diamond": "Cyril Diamond",
  "margaret-bracelet": "Margaret Bracelet",
  "ranjit-patel": "Ranjit Patel",
  "doreen-wicks": "Doreen Wicks",
  "albert-pickering": "Albert Pickering",
  "linda-beasley": "Linda Beasley",
  "eric-sparks": "Eric Sparks",
  "brian-yardley": "Brian Yardley",
  "doris-whittle": "Doris Whittle",
  "reg-throne": "Reg Throne",
};

/**
 * The item categories each shop "deals in" — drives the planner's
 * per-shop matched-stock bonus, so a dealer with a bag of drills steers
 * to Sparks Electrical / Hi-Tech Hut rather than the jeweller. Mirrors
 * the corresponding shopkeeper's bidder-profile high-accuracy slots.
 * Generalist shops (Patel's, Corner Shop) get a wide net so any stock
 * matches a little.
 */
const SHOP_SPECIALTIES_BY_CODE: Readonly<Record<string, readonly string[]>> = {
  goldfingers: ["decor", "novelty"],
  "ratners-peckham": ["decor", "novelty"],
  patels: ["food", "novelty", "clothing"],
  "corner-shop": ["food", "novelty", "clothing", "tools", "safety"],
  "wooden-soldier": ["toys", "novelty"],
  toyland: ["toys", "novelty"],
  "sparks-electrical": ["electrical", "tools"],
  "hi-tech-hut": ["electrical", "tools"],
  "comfy-corner": ["furniture", "decor"],
  "throne-co": ["furniture", "decor"],
};

/**
 * Per-shop hourly footfall curves (todolist #2). Replaces the
 * default `shopSale.hourlyFootfall` for each shop so the day reads
 * cinematically — newsagents at school-run o'clock, jewellers
 * around lunchtime, furniture stores all afternoon.
 *
 * Hours not listed default to 0 (shop quiet that hour). All shops
 * close before 18:00.
 */
const SHOP_FOOTFALL_BY_CODE: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  // Jewellers — lunchtime crowd, light browsing, gift hunters.
  goldfingers: { 11: 1, 12: 3, 13: 4, 14: 3, 15: 2, 16: 2, 17: 1 },
  "ratners-peckham": { 11: 1, 12: 3, 13: 4, 14: 3, 15: 2, 16: 2, 17: 1 },
  // Corner shops — school run + lunch + after-work errands.
  patels: { 7: 3, 8: 5, 9: 3, 12: 3, 13: 3, 15: 2, 16: 4, 17: 3 },
  "corner-shop": { 7: 3, 8: 5, 9: 3, 12: 3, 13: 3, 15: 2, 16: 4, 17: 3 },
  // Toy shops — after-school surge, mid-morning trickle.
  "wooden-soldier": { 9: 1, 10: 2, 11: 2, 12: 2, 13: 2, 15: 4, 16: 5, 17: 3 },
  toyland: { 9: 1, 10: 2, 11: 2, 12: 2, 13: 2, 15: 4, 16: 5, 17: 3 },
  // Electrical / tools — tradesmen morning runs + after-work DIY.
  "sparks-electrical": { 9: 3, 10: 3, 11: 2, 12: 2, 13: 2, 14: 2, 16: 3, 17: 4 },
  "hi-tech-hut": { 9: 3, 10: 3, 11: 2, 12: 2, 13: 2, 14: 2, 16: 3, 17: 4 },
  // Furniture — a long flat afternoon, couples browsing.
  "comfy-corner": { 10: 1, 11: 2, 12: 3, 13: 3, 14: 3, 15: 3, 16: 2, 17: 2 },
  "throne-co": { 10: 1, 11: 2, 12: 3, 13: 3, 14: 3, 15: 3, 16: 2, 17: 2 },
};

/**
 * Per-shop persona-weight multipliers (todolist #1). Biases the
 * shared persona bank for each shop so a jeweller pulls a different
 * crowd than the electrical place. Personas not listed take 1.0;
 * 0 effectively excludes them.
 *
 * Personas in the default bank: old-dears, students, mums, dads.
 */
const SHOP_PERSONA_MULTIPLIERS_BY_CODE: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  // Jewellers — old-dears (gift shoppers, aspirational) and mums
  // dominate; students rarely buy jewellery; dads window-shop only.
  goldfingers: { "old-dears": 1.8, mums: 1.3, students: 0.1, dads: 0.4 },
  "ratners-peckham": { "old-dears": 1.8, mums: 1.3, students: 0.1, dads: 0.4 },
  // Corner shops — mums and old-dears do the daily household runs;
  // dads and students chip in but at a lower rate.
  patels: { mums: 1.6, "old-dears": 1.4, students: 0.8, dads: 0.7 },
  "corner-shop": { mums: 1.6, "old-dears": 1.4, students: 0.8, dads: 0.7 },
  // Toy shops — mums and dads buying for kids, old-dears for
  // grandkids, students barely register.
  "wooden-soldier": { mums: 2.0, dads: 1.4, "old-dears": 0.9, students: 0.2 },
  toyland: { mums: 2.0, dads: 1.4, "old-dears": 0.9, students: 0.2 },
  // Electrical / tools — dads and tradesmen lean. Mums shop here
  // for kettles and irons; old-dears rarely; students for fans and
  // alarm clocks.
  "sparks-electrical": { dads: 2.2, mums: 0.9, students: 1.1, "old-dears": 0.3 },
  "hi-tech-hut": { dads: 2.2, mums: 0.9, students: 1.1, "old-dears": 0.3 },
  // Furniture — mums and dads decide together; old-dears refresh
  // a chair occasionally; students don't.
  "comfy-corner": { mums: 1.4, dads: 1.3, "old-dears": 0.8, students: 0.2 },
  "throne-co": { mums: 1.4, dads: 1.3, "old-dears": 0.8, students: 0.2 },
};

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

/**
 * Build an hour-by-hour schedule from an explicit list of {from, to,
 * location} spans expressed in 24-hour clock floats (e.g. 8.5 = 08:30).
 * Hours not covered fall back to `homeCode`. Spans whose location is the
 * placeholder `FLEXIBLE` / `TRAVELLING` / `OFF_SCREEN` / `ROAMING` leave
 * the underlying default in place — they're not real locations.
 */
interface ScheduleSpan {
  readonly from: number;
  readonly to: number;
  readonly location: string;
}
const PLACEHOLDER_LOCATIONS = new Set([
  "FLEXIBLE",
  "TRAVELLING",
  "OFF_SCREEN",
  "ROAMING",
]);

interface BuiltRoutine {
  readonly schedule: Map<number, string>;
  /** Hours where the actor isn't fixed by a non-placeholder span — they
   *  default to home, but the engine is free to override these for
   *  ad-hoc tasks like delivery trips. */
  readonly flexibleHours: ReadonlySet<number>;
}

/**
 * Build the weekend half of a spec — returns the keys
 * `weekendSchedule` + `weekendFlexibleHours` that get spread into
 * an ActorSpec alongside the weekday `schedule` and `flexibleHours`.
 * Use for actors whose weekday venue closes Sat/Sun (Trigger's
 * council yard, Cassandra's bank, the high-street shops).
 */
function weekendSpans(
  homeCode: string,
  spans: readonly ScheduleSpan[],
): {
  weekendSchedule: Map<number, string>;
  weekendFlexibleHours: ReadonlySet<number>;
} {
  const built = makeRoutineFromSpans(homeCode, spans);
  return {
    weekendSchedule: built.schedule,
    weekendFlexibleHours: built.flexibleHours,
  };
}

function makeRoutineFromSpans(
  homeCode: string,
  spans: readonly ScheduleSpan[],
  options?: { readonly attendsAuction?: boolean },
): BuiltRoutine {
  const schedule = new Map<number, string>();
  const fixed = new Set<number>();
  for (let h = 0; h < 24; h += 1) schedule.set(h, homeCode);
  for (const sp of spans) {
    if (PLACEHOLDER_LOCATIONS.has(sp.location)) continue;
    const f = Math.floor(sp.from);
    const t = Math.ceil(sp.to);
    const apply = (h: number) => {
      schedule.set(h, sp.location);
      fixed.add(h);
    };
    if (f < t) {
      for (let h = f; h < t && h < 24; h += 1) apply(h);
    } else {
      for (let h = f; h < 24; h += 1) apply(h);
      for (let h = 0; h < t && h < 24; h += 1) apply(h);
    }
  }
  // Note: the legacy `attendsAuction` flag once forced fixed paper +
  // auction hours every day. With the dealer-day-mode picker that
  // decision is now made each morning based on actor preferences and
  // the day's docket, so the option is a no-op. Kept on the signature
  // so the call sites still compile while we migrate the cast.
  void options;
  const flexibleHours = new Set<number>();
  for (let h = 0; h < 24; h += 1) {
    if (!fixed.has(h)) flexibleHours.add(h);
  }
  return { schedule, flexibleHours };
}

interface ProfileSpec {
  readonly defaultAccuracy: number;
  readonly perCategory?: Readonly<Record<string, number>>;
  readonly defaultFlawDetection: number;
  readonly perFlawDetection?: Readonly<Partial<Record<FlawType, number>>>;
  readonly customerTypes?: readonly string[];
}

const ACTOR_PROFILES: Readonly<Record<string, ProfileSpec>> = {
  player: {
    defaultAccuracy: 0.7,
    defaultFlawDetection: 0.5,
    perFlawDetection: { scam_bait: 0.2 },
    customerTypes: ["market-punters", "families"],
  },
  boyce: {
    defaultAccuracy: 0.7,
    perCategory: { vehicles: 1.0, furniture: 0.8, luggage: 0.85, electrical: 0.4 },
    defaultFlawDetection: 0.7,
    perFlawDetection: { scam_bait: 0.4 },
    customerTypes: ["yuppies", "businesses"],
  },
  denzil: {
    defaultAccuracy: 0.6,
    perCategory: { electrical: 0.9, luggage: 0.85, tools: 0.8 },
    defaultFlawDetection: 0.5,
    perFlawDetection: { dangerous: 0.85, fake: 0.4 },
    customerTypes: ["tradesmen", "specialists"],
  },
  "monkey-harris": {
    defaultAccuracy: 0.55,
    perCategory: { decor: 0.85, toys: 0.8, novelty: 0.85 },
    defaultFlawDetection: 0.5,
    customerTypes: ["families", "market-punters"],
  },
  trigger: {
    defaultAccuracy: 0.2,
    defaultFlawDetection: 0.2,
    perFlawDetection: {
      faulty: 0.05,
      fake: 0.05,
      scam_bait: 0.05,
      wrong_market: 0.05,
    },
    customerTypes: ["old-dears", "market-punters"],
  },
  mike: {
    defaultAccuracy: 0.5,
    perCategory: { food: 0.7 },
    defaultFlawDetection: 0.4,
    perFlawDetection: { faulty: 0.3, scam_bait: 0.3 },
    customerTypes: ["market-punters"],
  },
  "auction-house": {
    defaultAccuracy: 0.5,
    defaultFlawDetection: 0.5,
  },
  // ─── shopkeeper profiles ────────────────────────────────────────────
  // Specialists are sharp inside their lane and noisy outside it. The
  // wider buyer-ceiling fraction (75%, set per-call in run-sim.ts) plus
  // accurate appraisals on their category means dealers can offload
  // matched stock at near-RRP. General-store keepers are generalists
  // with moderate accuracy across the board.
  "cyril-diamond": {
    defaultAccuracy: 0.3,
    perCategory: { decor: 0.95, novelty: 0.85, clothing: 0.5 },
    defaultFlawDetection: 0.7,
    customerTypes: ["yuppies"],
  },
  "margaret-bracelet": {
    defaultAccuracy: 0.3,
    perCategory: { decor: 0.95, novelty: 0.85, clothing: 0.5 },
    defaultFlawDetection: 0.7,
    customerTypes: ["yuppies", "old-dears"],
  },
  "ranjit-patel": {
    defaultAccuracy: 0.65,
    defaultFlawDetection: 0.5,
    customerTypes: ["market-punters", "families"],
  },
  "doreen-wicks": {
    defaultAccuracy: 0.65,
    defaultFlawDetection: 0.5,
    customerTypes: ["market-punters", "old-dears"],
  },
  "albert-pickering": {
    defaultAccuracy: 0.3,
    perCategory: { toys: 0.95, novelty: 0.8 },
    defaultFlawDetection: 0.7,
    customerTypes: ["families"],
  },
  "linda-beasley": {
    defaultAccuracy: 0.3,
    perCategory: { toys: 0.95, novelty: 0.8 },
    defaultFlawDetection: 0.7,
    customerTypes: ["families"],
  },
  "eric-sparks": {
    defaultAccuracy: 0.3,
    perCategory: { electrical: 0.95, tools: 0.7 },
    defaultFlawDetection: 0.8,
    perFlawDetection: { dangerous: 0.9, faulty: 0.8 },
    customerTypes: ["tradesmen", "businesses"],
  },
  "brian-yardley": {
    defaultAccuracy: 0.3,
    perCategory: { electrical: 0.95, tools: 0.7 },
    defaultFlawDetection: 0.8,
    perFlawDetection: { dangerous: 0.9, faulty: 0.8 },
    customerTypes: ["yuppies", "tradesmen"],
  },
  "doris-whittle": {
    defaultAccuracy: 0.3,
    perCategory: { furniture: 0.95, decor: 0.7 },
    defaultFlawDetection: 0.7,
    customerTypes: ["families", "old-dears"],
  },
  "reg-throne": {
    defaultAccuracy: 0.3,
    perCategory: { furniture: 0.95, decor: 0.7 },
    defaultFlawDetection: 0.7,
    customerTypes: ["yuppies", "businesses"],
  },
  // ─── off-map dealers (the wider trade scene) ─────────────────────────
  // Sharp inside their lane, generalist-noisy outside it. Each appears
  // at Sotheby's during gallery+auction hours on weekdays, bids on
  // categories they specialise in, and resells whatever they buy
  // overnight (off-map resale handler) so they're back tomorrow with
  // replenished cash.
  "slough-stan": {
    defaultAccuracy: 0.3,
    perCategory: { electrical: 0.95, tools: 0.85 },
    defaultFlawDetection: 0.65,
    customerTypes: ["tradesmen"],
  },
  "croydon-carl": {
    defaultAccuracy: 0.3,
    perCategory: { vehicles: 0.95, furniture: 0.85 },
    defaultFlawDetection: 0.6,
    customerTypes: ["yuppies"],
  },
  "maidstone-maureen": {
    defaultAccuracy: 0.3,
    perCategory: { decor: 0.95, novelty: 0.85 },
    defaultFlawDetection: 0.7,
    customerTypes: ["yuppies", "old-dears"],
  },
  "wandsworth-wally": {
    defaultAccuracy: 0.3,
    perCategory: { clothing: 0.95, food: 0.85 },
    defaultFlawDetection: 0.5,
    customerTypes: ["market-punters"],
  },
  "brighton-bernie": {
    defaultAccuracy: 0.3,
    perCategory: { toys: 0.95, novelty: 0.85 },
    defaultFlawDetection: 0.6,
    customerTypes: ["families"],
  },
  "watford-wendy": {
    defaultAccuracy: 0.3,
    perCategory: { electrical: 0.85, decor: 0.85 },
    defaultFlawDetection: 0.65,
    customerTypes: ["yuppies"],
  },
  "romford-reg": {
    defaultAccuracy: 0.3,
    perCategory: { furniture: 0.95, tools: 0.85 },
    defaultFlawDetection: 0.6,
    customerTypes: ["tradesmen", "families"],
  },
  "kingston-kev": {
    defaultAccuracy: 0.3,
    perCategory: { decor: 0.85, toys: 0.85 },
    defaultFlawDetection: 0.55,
    customerTypes: ["families"],
  },
};

const OFF_MAP_DEALER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "slough-stan": "Slough Stan",
  "croydon-carl": "Croydon Carl",
  "maidstone-maureen": "Maidstone Maureen",
  "wandsworth-wally": "Wandsworth Wally",
  "brighton-bernie": "Brighton Bernie",
  "watford-wendy": "Watford Wendy",
  "romford-reg": "Romford Reg",
  "kingston-kev": "Kingston Kev",
};

const OFF_MAP_DEALER_CODES: readonly string[] = [
  "slough-stan",
  "croydon-carl",
  "maidstone-maureen",
  "wandsworth-wally",
  "brighton-bernie",
  "watford-wendy",
  "romford-reg",
  "kingston-kev",
];

/** Synthetic external-economy account — receives stock the off-map
 *  dealers buy and pays them out at end-of-day. Exempted from cash
 *  conservation by the invariants test. */
const OFF_MAP_MARKET_CODE = "off-map-market";

const ACTORS: readonly ActorSpec[] = [
  // ─── core trader cast ────────────────────────────────────────────────
  {
    code: "player",
    displayName: "Del Boy",
    cash: 2000,
    ...makeRoutineFromSpans("peckham-flat", [
      { from: 6, to: 8, location: "peckham-flat" },
      { from: 8, to: 8.5, location: "sids-cafe" },
      { from: 8.5, to: 9, location: "lockup" },
      { from: 9, to: 17, location: "FLEXIBLE" },
      { from: 17, to: 18.5, location: "peckham-flat" },
      { from: 18.5, to: 23.5, location: "nags" },
      { from: 23.5, to: 6, location: "peckham-flat" },
    ]),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 6, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "boyce",
    displayName: "Boyce",
    cash: 5000,
    ...makeRoutineFromSpans("boycie-house", [
      { from: 8, to: 9, location: "boycie-house" },
      { from: 9, to: 17, location: "FLEXIBLE" },
      { from: 17, to: 19, location: "FLEXIBLE" },
      { from: 19.5, to: 22.5, location: "nags" },
      { from: 22.5, to: 8, location: "boycie-house" },
    ]),
    defaultLocation: "boyce-auto-sales",
    homeLocation: "boycie-house",
    lockupLocation: "boyce-auto-sales",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "denzil",
    displayName: "Denzil",
    cash: 1500,
    ...makeRoutineFromSpans("denzil-house", [
      { from: 5, to: 6, location: "denzil-house" },
      { from: 6, to: 14, location: "TRAVELLING" },
      { from: 14, to: 15, location: "transworld-depot" },
      { from: 15, to: 18, location: "FLEXIBLE" },
      { from: 19, to: 22, location: "nags" },
      { from: 22, to: 5, location: "denzil-house" },
    ]),
    defaultLocation: "transworld-depot",
    homeLocation: "denzil-house",
    lockupLocation: "transworld-depot",
    transportCapacity: "truck",
    awakeHours: { start: 5, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "monkey-harris",
    displayName: "Monkey Harris",
    cash: 800,
    ...makeRoutineFromSpans("lockup", [
      { from: 11, to: 17, location: "FLEXIBLE" },
      { from: 19, to: 23, location: "nags" },
    ]),
    defaultLocation: "lockup",
    homeLocation: "lockup",
    transportCapacity: "van",
    awakeHours: { start: 9, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "trigger",
    displayName: "Trigger",
    cash: 200,
    // Trigger sweeps a beat — hourly diary of real spots along the
    // round (no abstract "council-streets" pseudo-location).
    ...makeRoutineFromSpans("trigger-flat", [
      { from: 7, to: 8, location: "lambeth-council-yard" }, // pick up broom
      { from: 8, to: 9, location: "post-office" },
      { from: 9, to: 10, location: "peckham-market" },
      { from: 10, to: 11, location: "albert-legion" },
      { from: 11, to: 12, location: "betting-shop" },
      { from: 12, to: 13, location: "sids-cafe" }, // lunch
      { from: 13, to: 14, location: "post-office" },
      { from: 14, to: 15, location: "peckham-market" },
      { from: 15, to: 16, location: "dirty-barrys" },
      { from: 16, to: 17, location: "lambeth-council-yard" }, // clock off
      { from: 17, to: 23, location: "nags" },
      { from: 23, to: 7, location: "trigger-flat" },
    ]),
    // Council yard closed weekends — Trigger goes nowhere for work,
    // mooches at the bookies / Nag's instead.
    ...weekendSpans("trigger-flat", [
      { from: 11, to: 13, location: "betting-shop" },
      { from: 13, to: 14, location: "sids-cafe" },
      { from: 14, to: 17, location: "betting-shop" },
      { from: 17, to: 23, location: "nags" },
    ]),
    defaultLocation: "lambeth-council-yard",
    homeLocation: "trigger-flat",
    lockupLocation: "lockup",
    transportCapacity: "pocket",
    awakeHours: { start: 6, end: 23 },
  },
  {
    code: "mike",
    displayName: "Mike Fisher",
    cash: 600,
    ...makeRoutineFromSpans("nags", [
      { from: 7, to: 23, location: "nags" },
      { from: 23, to: 7, location: "nags" }, // sleeps above the pub
    ]),
    defaultLocation: "nags",
    homeLocation: "nags",
    transportCapacity: "none",
    awakeHours: { start: 7, end: 23 },
  },
  {
    code: "auction-house",
    displayName: "Sotheby's",
    cash: 0,
    ...makeRoutineFromSpans("auction-house", []),
    defaultLocation: "auction-house",
    homeLocation: "auction-house",
    transportCapacity: "none",
    awakeHours: { start: 8, end: 22 },
  },

  // ─── Trotter household ───────────────────────────────────────────────
  {
    code: "rodney",
    displayName: "Rodney Trotter",
    cash: 200,
    ...makeRoutineFromSpans("peckham-flat", [
      { from: 8, to: 9, location: "peckham-flat" },
      { from: 9, to: 17, location: "FLEXIBLE" },
      { from: 19, to: 22, location: "nags" },
      { from: 22, to: 8, location: "peckham-flat" },
    ]),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "van",
    flexibleDailyMode: true,
    awakeHours: { start: 8, end: 22 },
  },
  {
    code: "albert",
    displayName: "Uncle Albert",
    cash: 100,
    ...makeRoutineFromSpans("peckham-flat", [
      { from: 8, to: 11, location: "peckham-flat" },
      { from: 11, to: 14, location: "albert-legion" },
      { from: 14, to: 17, location: "peckham-flat" },
      { from: 19, to: 23, location: "nags" },
      { from: 23, to: 8, location: "peckham-flat" },
    ]),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 8, end: 23 },
  },
  {
    code: "grandad",
    displayName: "Grandad",
    cash: 50,
    ...makeRoutineFromSpans("peckham-flat", [
      { from: 9, to: 23, location: "peckham-flat" },
    ]),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "none",
    awakeHours: { start: 9, end: 22 },
  },

  // ─── Boyce family ────────────────────────────────────────────────────
  {
    code: "marlene",
    displayName: "Marlene Boyce",
    cash: 300,
    ...makeRoutineFromSpans("boycie-house", [
      { from: 8, to: 10, location: "boycie-house" },
      { from: 10, to: 12, location: "peckham-market" },
      { from: 12, to: 14, location: "nags" },
      { from: 14, to: 18, location: "boycie-house" },
      { from: 20, to: 23, location: "nags" },
      { from: 23, to: 8, location: "boycie-house" },
    ]),
    defaultLocation: "boycie-house",
    homeLocation: "boycie-house",
    transportCapacity: "boot",
    awakeHours: { start: 8, end: 23 },
  },

  // ─── pub regulars / sidekicks ───────────────────────────────────────
  {
    code: "mickey-pearce",
    displayName: "Mickey Pearce",
    cash: 150,
    ...makeRoutineFromSpans("mickey-jevon-flat", [
      { from: 10, to: 19, location: "FLEXIBLE" },
      { from: 19, to: 23.5, location: "nags" },
      { from: 23.5, to: 10, location: "mickey-jevon-flat" },
    ]),
    defaultLocation: "mickey-jevon-flat",
    homeLocation: "mickey-jevon-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 10, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "jevon",
    displayName: "Jevon",
    cash: 120,
    ...makeRoutineFromSpans("mickey-jevon-flat", [
      { from: 12, to: 19, location: "FLEXIBLE" },
      { from: 19, to: 23.5, location: "nags" },
      { from: 23.5, to: 12, location: "mickey-jevon-flat" },
    ]),
    defaultLocation: "mickey-jevon-flat",
    homeLocation: "mickey-jevon-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 11, end: 23 },
    flexibleDailyMode: true,
  },
  {
    code: "raquel",
    displayName: "Raquel Turner",
    cash: 250,
    ...makeRoutineFromSpans("raquel-flat", [
      { from: 10, to: 13, location: "raquel-flat" },
      { from: 13, to: 17, location: "FLEXIBLE" },
      { from: 19, to: 23, location: "starlight-rooms" },
      { from: 23, to: 10, location: "raquel-flat" },
    ]),
    defaultLocation: "raquel-flat",
    homeLocation: "raquel-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 9, end: 23 },
  },
  {
    code: "cassandra",
    displayName: "Cassandra Parry",
    cash: 800,
    ...makeRoutineFromSpans("cassandra-flat", [
      { from: 7.5, to: 8.5, location: "FLEXIBLE" },
      { from: 8.5, to: 13, location: "cassandra-bank" },
      { from: 13, to: 14, location: "FLEXIBLE" },
      { from: 14, to: 17.5, location: "cassandra-bank" },
      { from: 18, to: 20, location: "FLEXIBLE" },
      { from: 20, to: 22.5, location: "nags" },
      { from: 22.5, to: 7.5, location: "cassandra-flat" },
    ]),
    // Bank closed weekends — chill at home, evening pub.
    ...weekendSpans("cassandra-flat", [
      { from: 20, to: 22.5, location: "nags" },
    ]),
    defaultLocation: "cassandra-bank",
    homeLocation: "cassandra-flat",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 22 },
    lunchSlot: {
      hours: [13],
      daysOfWeek: DAYS_MON_FRI,
      candidateCodes: ["cassandra-bank", "cassandra-flat", "sids-cafe", "nags"],
    },
  },
  {
    code: "alan-parry",
    displayName: "Alan Parry",
    cash: 4000,
    ...makeRoutineFromSpans("parry-house", [
      { from: 8.5, to: 13, location: "parry-printers" },
      { from: 13, to: 14.5, location: "FLEXIBLE" },
      { from: 14.5, to: 18, location: "parry-printers" },
      { from: 19, to: 22, location: "FLEXIBLE" },
      { from: 22, to: 8.5, location: "parry-house" },
    ]),
    defaultLocation: "parry-printers",
    homeLocation: "parry-house",
    lockupLocation: "parry-printers",
    transportCapacity: "boot",
    awakeHours: { start: 8, end: 22 },
    lunchSlot: {
      hours: [13, 14],
      daysOfWeek: DAYS_MON_FRI,
      candidateCodes: ["parry-printers", "parry-house", "sids-cafe", "nags"],
    },
  },
  {
    code: "sid",
    displayName: "Sid",
    cash: 400,
    ...makeRoutineFromSpans("sids-cafe", [
      { from: 6, to: 17, location: "sids-cafe" },
      { from: 19, to: 23, location: "nags" },
      { from: 23, to: 6, location: "sids-cafe" },
    ]),
    defaultLocation: "sids-cafe",
    homeLocation: "sids-cafe",
    transportCapacity: "pocket",
    awakeHours: { start: 6, end: 23 },
  },

  // ─── shady suppliers ────────────────────────────────────────────────
  {
    code: "alfie-flowers",
    displayName: "Alfie Flowers",
    cash: 600,
    ...makeRoutineFromSpans("off-map", [
      { from: 10, to: 13, location: "auction-house" },
      { from: 13, to: 15, location: "one-eleven-club" },
      { from: 20, to: 24, location: "one-eleven-club" },
    ]),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "pocket",
    awakeHours: { start: 10, end: 23 },
  },
  {
    code: "ronnie-nelson",
    displayName: "Ronnie Nelson",
    cash: 900,
    ...makeRoutineFromSpans("off-map", [
      { from: 10, to: 17, location: "FLEXIBLE" },
      { from: 20, to: 23, location: "one-eleven-club" },
    ]),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "van",
    awakeHours: { start: 9, end: 23 },
  },
  {
    code: "mustapha",
    displayName: "Mustapha",
    cash: 500,
    ...makeRoutineFromSpans("off-map", [
      { from: 9, to: 17, location: "FLEXIBLE" },
    ]),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "van",
    awakeHours: { start: 9, end: 18 },
  },
  {
    code: "arnie",
    displayName: "Arnie Rutter",
    cash: 0,
    ...makeRoutineFromSpans("off-map", [
      { from: 12, to: 14, location: "one-eleven-club" },
      { from: 19, to: 23, location: "FLEXIBLE" },
    ]),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "boot",
    awakeHours: { start: 11, end: 23 },
  },
  {
    code: "towser",
    displayName: "Towser",
    cash: 80,
    ...makeRoutineFromSpans("off-map", [
      { from: 10, to: 16, location: "auction-house" },
      { from: 19, to: 23, location: "nags" },
    ]),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "pocket",
    awakeHours: { start: 10, end: 23 },
  },
  {
    code: "paddy-the-greek",
    displayName: "Paddy the Greek",
    cash: 350,
    ...makeRoutineFromSpans("off-map", [
      { from: 8, to: 14, location: "peckham-market" },
      { from: 14, to: 16, location: "sids-cafe" },
    ]),
    defaultLocation: "peckham-market",
    homeLocation: "off-map",
    lockupLocation: "lockup",
    transportCapacity: "van",
    awakeHours: { start: 7, end: 17 },
  },

  // ─── enemies / wildcards ────────────────────────────────────────────
  {
    code: "slater",
    displayName: "DCI Roy Slater",
    cash: 300,
    // Slater patrols — his routine reads as "station" but the
    // patrol-picker overrides each hour, weighted random across his
    // beat (station, market, Nag's, Sid's). Event-driven alerts
    // (e.g. a tip-off about stolen goods) supersede the patrol pick.
    ...makeRoutineFromSpans("slater-flat", [
      { from: 8, to: 18, location: "police-station" },
      { from: 18, to: 22, location: "FLEXIBLE" },
      { from: 22, to: 8, location: "slater-flat" },
    ]),
    defaultLocation: "police-station",
    homeLocation: "slater-flat",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 22 },
    bribable: true,
  },
  {
    code: "pc-hoskins",
    displayName: "PC Terence Hoskins",
    cash: 200,
    // The straight cop on the beat — counterpart to Slater. Same
    // station hours, same evening flexible window, but not bribable
    // (default). Patrol override kicks in 09-15 across a small
    // 3-venue beat (see `patrolOfficers` at the bottom of this file)
    // — lighter presence than Slater so he's rarely the limiting
    // factor but occasionally adds risk when their beats overlap.
    ...makeRoutineFromSpans("off-map", [
      { from: 8, to: 18, location: "police-station" },
      { from: 18, to: 22, location: "FLEXIBLE" },
    ]),
    defaultLocation: "police-station",
    homeLocation: "off-map",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 22 },
  },
  {
    code: "dirty-barry",
    displayName: "Dirty Barry",
    cash: 250,
    // Dirty Barry has a fixed job: minding his fence shop. No daily
    // mode picker — he's at the shop until he heads to the pub.
    ...makeRoutineFromSpans("dirty-barrys", [
      { from: 11, to: 20, location: "dirty-barrys" },
      { from: 21, to: 23, location: "nags" },
      { from: 23, to: 11, location: "dirty-barrys" },
    ]),
    defaultLocation: "dirty-barrys",
    homeLocation: "dirty-barrys",
    transportCapacity: "pocket",
    awakeHours: { start: 10, end: 23 },
  },
  {
    code: "eugene-mccarthy",
    displayName: "Eugene McCarthy",
    cash: 1500,
    ...makeRoutineFromSpans("starlight-rooms", [
      { from: 20, to: 24, location: "starlight-rooms" },
      { from: 0, to: 2, location: "starlight-rooms" },
    ]),
    defaultLocation: "starlight-rooms",
    homeLocation: "off-map",
    transportCapacity: "boot",
    awakeHours: { start: 14, end: 23 },
  },
  {
    code: "driscoll-brothers",
    displayName: "The Driscoll Brothers",
    cash: 2000,
    // Plural-as-one: two brothers operating as a single in-world
    // presence. Nocturnal villains based out of the Shamrock Club —
    // only visible in-world during pub hours; off-map otherwise,
    // same shape as Eugene McCarthy.
    ...makeRoutineFromSpans("shamrock-club", [
      { from: 20, to: 24, location: "shamrock-club" },
      { from: 0, to: 2, location: "shamrock-club" },
    ]),
    defaultLocation: "shamrock-club",
    homeLocation: "off-map",
    transportCapacity: "van",
    awakeHours: { start: 14, end: 23 },
  },
  // ─── high-street shopkeepers ─────────────────────────────────────────
  // All keep the same 9-17 schedule at their respective shop and
  // overnight off-map. They're buyers in shop-deal autonomy; their
  // category specialisation lives in their bidder profile, not here.
  ...HIGH_STREET_SHOPS.map(({ shopCode, keeperCode }): ActorSpec => ({
    code: keeperCode,
    displayName: SHOPKEEPER_DISPLAY_NAMES[keeperCode] ?? keeperCode,
    cash: 2500,
    ...makeRoutineFromSpans("off-map", [
      { from: 9, to: 17, location: shopCode },
    ]),
    // Shops shut Saturday and Sunday — keeper stays off-map.
    ...weekendSpans("off-map", []),
    defaultLocation: shopCode,
    homeLocation: "off-map",
    transportCapacity: "none",
    awakeHours: { start: 8, end: 18 },
  })),
  // ─── off-map dealers ─────────────────────────────────────────────────
  // The wider trade scene from neighbouring areas. Each travels to
  // Sotheby's during gallery (8-11) + auction (11-16) hours on
  // weekdays, bids on lots in their specialty, then returns off-map
  // overnight. The off-map resale handler liquidates whatever they
  // bought at end-of-day so they're back tomorrow with replenished
  // capital. Weekends they stay off-map (auction's closed anyway).
  ...OFF_MAP_DEALER_CODES.map((code): ActorSpec => ({
    code,
    displayName: OFF_MAP_DEALER_DISPLAY_NAMES[code] ?? code,
    cash: 4000,
    ...makeRoutineFromSpans("off-map", [
      { from: 8, to: 17, location: "auction-house" },
    ]),
    ...weekendSpans("off-map", []),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 19 },
  })),
  // The synthetic external-economy account — pays the off-map dealers
  // for their stock at end-of-day. Stays off-map; no schedule needed
  // (it's purely an accounting actor).
  {
    code: OFF_MAP_MARKET_CODE,
    displayName: "Off-map Market",
    cash: 0,
    ...makeRoutineFromSpans("off-map", []),
    defaultLocation: "off-map",
    homeLocation: "off-map",
    transportCapacity: "none",
    awakeHours: { start: 0, end: 24 },
  },
];

// Which actor codes participate in pub-deal / pool-claim autonomy. The
// wider cast follows routines but stays out of the trading loop —
// civilians don't claim pools, and Mike doesn't run pubdeals from
// behind the bar.
const TRADING_CODES: readonly string[] = [
  "boyce",
  "denzil",
  "monkey-harris",
  "trigger",
];

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
const INFO_TRADER_CODES: readonly string[] = [
  "denzil",
  "mike",
  "sid",
  "albert",
];

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

const VIRTUAL_PRODUCERS: readonly VirtualProducerSpec[] = [
  {
    code: "trader-bob",
    displayName: "Trader Bob",
    categories: ["electrical", "novelty", "tools"],
    brokerCodes: ["denzil", "monkey-harris"],
    provenancePhrases: [
      "off a lorry on the A2",
      "direct from a depot in Croydon",
      "warehouse closure in Sidcup",
      "no questions asked, mate",
    ],
  },
  {
    code: "wholesaler-cyril",
    displayName: "Wholesaler Cyril",
    categories: ["clothing", "luggage"],
    brokerCodes: ["boyce", "mustapha"],
    provenancePhrases: [
      "bankrupt warehouse sale",
      "catalogue returns",
      "end-of-line stock from a chain shop",
      "container straight off the Port of Tilbury",
    ],
  },
  {
    code: "reggies-estate",
    displayName: "Reggie's Estate",
    categories: ["furniture", "decor", "toys"],
    brokerCodes: ["boyce", "monkey-harris"],
    provenancePhrases: [
      "estate clearance in Bromley",
      "probate sale, deceased gentleman",
      "house contents from a divorce in Eltham",
      "garage clearout — owner emigrating",
    ],
  },
  {
    code: "salvage-sid",
    displayName: "Salvage Sid",
    categories: ["vehicles", "safety", "food"],
    brokerCodes: ["denzil", "trigger"],
    provenancePhrases: [
      "site clearance in New Cross",
      "bailiff's auction overflow",
      "excess stock from a contract job",
      "damaged but functional, guv",
    ],
  },
];

const REACHABLE_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  electrical: ["denzil", "monkey-harris", "ronnie-nelson"],
  furniture: ["boyce", "monkey-harris"],
  luggage: ["denzil"],
  decor: ["monkey-harris"],
  toys: ["monkey-harris"],
  food: ["denzil"],
  novelty: ["monkey-harris", "mustapha"],
  tools: ["denzil"],
  clothing: ["boyce", "monkey-harris", "mustapha"],
  safety: ["denzil"],
  vehicles: ["boyce"],
};

const DEFAULT_REACHABLE_CODES: readonly string[] = ["denzil", "monkey-harris", "boyce"];

/**
 * Free-form descriptive tags per character. Used by the webapp filter
 * rail (no engine logic depends on these). Order in each list is just
 * for readability — primary identity first, secondary tags after.
 *
 * Keys must match an actor `code` in ACTORS above. New code → empty
 * roles unless added here.
 */
const ACTOR_ROLES: Readonly<Record<string, readonly string[]>> = {
  player: ["dealer"],
  boyce: ["dealer"],
  denzil: ["dealer"],
  "monkey-harris": ["dealer"],
  trigger: ["dealer"],
  mike: ["pub"],
  "auction-house": ["official"],
  rodney: ["dealer"],
  albert: ["household"],
  grandad: ["household"],
  marlene: ["household"],
  "mickey-pearce": ["dealer"],
  jevon: ["dealer"],
  raquel: ["household"],
  cassandra: ["household"],
  "alan-parry": ["household"],
  sid: ["pub"],
  "alfie-flowers": ["supplier"],
  "ronnie-nelson": ["supplier"],
  mustapha: ["supplier"],
  arnie: ["supplier"],
  towser: ["supplier"],
  "paddy-the-greek": ["supplier"],
  slater: ["police"],
  "pc-hoskins": ["police"],
  "dirty-barry": ["fence"],
  "eugene-mccarthy": ["villain"],
  "driscoll-brothers": ["villain"],
  // High-street shopkeepers — buyers in shop-deal autonomy.
  "cyril-diamond": ["shopkeeper"],
  "margaret-bracelet": ["shopkeeper"],
  "ranjit-patel": ["shopkeeper"],
  "doreen-wicks": ["shopkeeper"],
  "albert-pickering": ["shopkeeper"],
  "linda-beasley": ["shopkeeper"],
  "eric-sparks": ["shopkeeper"],
  "brian-yardley": ["shopkeeper"],
  "doris-whittle": ["shopkeeper"],
  "reg-throne": ["shopkeeper"],
  // Off-map dealers — wider trade scene tag for the filter rail.
  "slough-stan": ["off-map-dealer"],
  "croydon-carl": ["off-map-dealer"],
  "maidstone-maureen": ["off-map-dealer"],
  "wandsworth-wally": ["off-map-dealer"],
  "brighton-bernie": ["off-map-dealer"],
  "watford-wendy": ["off-map-dealer"],
  "romford-reg": ["off-map-dealer"],
  "kingston-kev": ["off-map-dealer"],
  // External-economy account — invisible, used by the resale handler.
  "off-map-market": ["off-map-market"],
};

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
      displayName: spec.displayName,
      cash: spec.cash,
      transportCapacity: spec.transportCapacity,
      homeLocationId: homeId,
      lockupLocationId: lockupId,
      ...(spec.bribable === true ? { bribable: true } : {}),
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

    if (spec.code !== "player") {
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

  const playerId = actorByCode.get("player");
  const auctionHouseId = actorByCode.get("auction-house");
  // Resolve role tags: skin-defined codes → live actor ids.
  const rolesByActorId = new Map<number, readonly string[]>();
  for (const [code, roles] of Object.entries(ACTOR_ROLES)) {
    const id = actorByCode.get(code);
    if (id !== undefined && roles.length > 0) rolesByActorId.set(id, roles);
  }
  if (playerId === undefined || auctionHouseId === undefined) {
    throw new Error("placeholder skin must seed player and auction-house actors");
  }

  // Bidder profiles.
  const bidderProfiles = new Map<number, BidderProfile>();
  for (const [code, spec] of Object.entries(ACTOR_PROFILES)) {
    const id = actorByCode.get(code);
    if (id === undefined) continue;
    const accuracyMap = new Map<string, number>();
    if (spec.perCategory) {
      for (const [cat, acc] of Object.entries(spec.perCategory)) {
        accuracyMap.set(cat, acc);
      }
    }
    const flawMap = new Map<FlawType, number>();
    if (spec.perFlawDetection) {
      for (const [flaw, score] of Object.entries(spec.perFlawDetection)) {
        if (score !== undefined) flawMap.set(flaw as FlawType, score);
      }
    }
    const profileEntry: BidderProfile = spec.customerTypes
      ? {
          appraisalAccuracy: accuracyMap,
          defaultAppraisalAccuracy: spec.defaultAccuracy,
          flawTypeDetection: flawMap,
          defaultFlawTypeDetection: spec.defaultFlawDetection,
          customerTypes: spec.customerTypes,
        }
      : {
          appraisalAccuracy: accuracyMap,
          defaultAppraisalAccuracy: spec.defaultAccuracy,
          flawTypeDetection: flawMap,
          defaultFlawTypeDetection: spec.defaultFlawDetection,
        };
    bidderProfiles.set(id, profileEntry);
  }

  // Persist a five-axis KnowledgeProfile for every actor (todolist:57).
  // The legacy bidderProfiles map is kept in memory for the existing
  // auction / pub-deal / market pipelines; the new schema-backed
  // skill grid is what consultations, the belief aggregator, and the
  // belief-anchored haggle read from.
  seedKnowledgeProfiles(db, bidderProfiles);

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
      displayName: spec.displayName,
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
    patrolOfficers: (() => {
      const officers: PatrolOfficerSpec[] = [];
      const buildBeat = (
        actorCode: string,
        weights: readonly [string, number][],
        activeHours: ReadonlySet<number>,
      ): void => {
        const officerActorId = actorByCode.get(actorCode);
        if (officerActorId === undefined) return;
        const candidates: { locationId: number; weight: number }[] = [];
        for (const [code, weight] of weights) {
          const id = locByCode.get(code);
          if (id !== undefined) candidates.push({ locationId: id, weight });
        }
        if (candidates.length === 0) return;
        officers.push({ officerActorId, candidates, activeHours });
      };
      // Slater — station-heavy beat across his 08-17 shift. The
      // venues where dealing happens (Nag's, Peckham Market, Sid's
      // caff) get smaller weights so he turns up there occasionally.
      buildBeat(
        "slater",
        [
          ["police-station", 40],
          ["peckham-market", 25],
          ["nags", 15],
          ["sids-cafe", 10],
          ["hard-knock-cafe", 10],
        ],
        new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]),
      );
      // Hoskins — lighter presence, 09-15 with a small 3-venue
      // beat. Supporting cast: rarely the limiting factor, but
      // adds occasional risk when he overlaps with Slater on the
      // same venue.
      buildBeat(
        "pc-hoskins",
        [
          ["police-station", 50],
          ["peckham-market", 30],
          ["nags", 20],
        ],
        new Set([9, 10, 11, 12, 13, 14, 15]),
      );
      return officers;
    })(),
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

      seedSupplyLeadForStockLot(db, lot, 1);
    }
  }
}

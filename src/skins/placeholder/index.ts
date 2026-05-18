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
  /**
   * Optional short / nickname per actor. Used by the webapp for chip-
   * sized UI surfaces (selection chips, mini actor rows, owner labels).
   * Falls back to displayName when an actor isn't listed.
   */
  readonly shortNameByActorId: ReadonlyMap<number, string>;
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
const CATEGORY_ANCHORS: ReadonlyMap<string, number> = new Map([
  ["electrical", 50],
  ["furniture", 70],
  ["tools", 30],
  ["decor", 20],
  ["clothing", 40],
  ["toys", 20],
  ["luggage", 45],
  ["food", 10],
  ["safety", 50],
  ["vehicles", 100],
  ["novelty", 25],
]);

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
const CATEGORY_CONDITION_ANCHORS: ReadonlyMap<string, number> = new Map([
  ["electrical", 0.55],
  ["furniture", 0.45],
  ["tools", 0.35],
  ["decor", 0.5],
  ["clothing", 0.5],
  ["toys", 0.4],
  ["luggage", 0.4],
  ["food", 0.3],
  ["safety", 0.6],
  ["vehicles", 0.3],
  ["novelty", 0.4],
]);

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
  // Vehicle-parts garages — proprietors are vehicle/tools specialists.
  // Different shift patterns: Spanner runs a full-trade week (Mon-Sat
  // early-start parts shop); Camshaft trades to a smarter Mon-Fri rhythm.
  { code: "spanner-motors", displayName: "Spanner Motors", type: "business", openHours: { start: 8, end: 16 }, openDaysOfWeek: DAYS_MON_SAT },
  { code: "camshaft-autos", displayName: "Camshaft Autos", type: "business", openHours: { start: 9, end: 17 }, openDaysOfWeek: DAYS_MON_FRI },
];

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
  "spanner-motors": ["vehicles", "tools"],
  "camshaft-autos": ["vehicles", "tools"],
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
  // Mickey Pearce — the confident schemer. Mediocre across the board
  // with a slight knack for "wheeler-dealer" categories (clothing,
  // novelty). His distinctive trait is set via `actor_arm_j` below:
  // a HIGH price-j paired with LOW price-expertise produces the
  // "decisive but wrong" archetype the doc anticipated. He commits
  // tightly to centred-on-the-anchor beliefs, sounding confident
  // while drifting toward generic category numbers regardless of the
  // actual goods. The first actor in the cast to deliberately decouple
  // j from expertise.
  "mickey-pearce": {
    defaultAccuracy: 0.35,
    perCategory: { clothing: 0.5, novelty: 0.55 },
    defaultFlawDetection: 0.3,
    perFlawDetection: { scam_bait: 0.45 },
    customerTypes: ["market-punters", "yuppies"],
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
  "eddie-spanner": {
    defaultAccuracy: 0.3,
    perCategory: { vehicles: 0.95, tools: 0.75 },
    defaultFlawDetection: 0.8,
    perFlawDetection: { dangerous: 0.9, faulty: 0.85 },
    customerTypes: ["tradesmen", "dads"],
  },
  "vince-camshaft": {
    defaultAccuracy: 0.3,
    perCategory: { vehicles: 0.95, tools: 0.75 },
    defaultFlawDetection: 0.8,
    perFlawDetection: { dangerous: 0.9, faulty: 0.85 },
    customerTypes: ["tradesmen", "dads"],
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
  marlene: ["household"],
  corrine: ["household"],
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
  "eddie-spanner": ["shopkeeper"],
  "vince-camshaft": ["shopkeeper"],
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
  // Short / nickname forms — actor ids → short label for chip UI.
  const shortNameByActorId = new Map<number, string>();
  for (const spec of ACTORS) {
    if (spec.shortName === undefined) continue;
    const id = actorByCode.get(spec.code);
    if (id !== undefined) shortNameByActorId.set(id, spec.shortName);
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
    shortNameByActorId,
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

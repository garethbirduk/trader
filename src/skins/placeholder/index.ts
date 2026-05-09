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
import type { FlawType, QualityTier } from "../../engine/stock/types.js";
import type { TransportCapacity } from "../../engine/actors/types.js";
import { EVERYDAY_ITEMS } from "./catalogue-everyday.js";
import { EASTER_EGG_ITEMS } from "./catalogue-easter-eggs.js";

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
  /** Where the daily auction is held; bidders must be physically present. */
  readonly auctionLocationId: number;
  /** First and last hour of the daily auction window. One lot per hour
   *  runs in this inclusive range. */
  readonly auctionStartHour: number;
  readonly auctionEndHour: number;
  /** Where the morning newspaper publishes the day's lot listing. */
  readonly newspaperLocationId: number;
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

export interface ActorRoutineInfo {
  readonly homeLocationId: number | null;
  readonly schedule: ReadonlyMap<number, number>;
  readonly flexibleHours: ReadonlySet<number>;
  readonly awakeHours: { readonly start: number; readonly end: number };
}

interface ActorSpec {
  readonly code: string;
  readonly displayName: string;
  readonly cash: number;
  readonly schedule: ReadonlyMap<number, string>;
  /** Hours where the actor's routine is flexible (defaults to home but
   *  can be repurposed for ad-hoc tasks like delivery trips). Filled in
   *  automatically by makeRoutineFromSpans(). */
  readonly flexibleHours: ReadonlySet<number>;
  readonly defaultLocation: string;
  readonly homeLocation: string;
  /** Where this actor stores stock. Defaults to homeLocation. */
  readonly lockupLocation?: string;
  readonly transportCapacity: TransportCapacity;
  readonly awakeHours: { readonly start: number; readonly end: number };
}

interface LocationSpec {
  readonly code: string;
  readonly displayName: string;
  readonly type: LocationType;
  readonly openHours?: { readonly start: number; readonly end: number };
}

const LOCATIONS: readonly LocationSpec[] = [
  // Original cast's spaces.
  { code: "peckham-flat", displayName: "Del's Flat", type: "home" },
  { code: "lockup", displayName: "The Lock-up", type: "business", openHours: { start: 8, end: 20 } },
  { code: "nags", displayName: "The Nag's Head", type: "pub", openHours: { start: 11, end: 23 } },
  { code: "auction-house", displayName: "Sotheby's", type: "auction", openHours: { start: 8, end: 17 } },
  { code: "boyce-auto-sales", displayName: "Boyce Autos", type: "business", openHours: { start: 9, end: 18 } },
  { code: "transworld-depot", displayName: "Transworld Depot", type: "business", openHours: { start: 6, end: 18 } },
  { code: "lambeth-council-yard", displayName: "Council Yard", type: "civic", openHours: { start: 6, end: 17 } },
  // Added from the wider canon.
  { code: "peckham-market", displayName: "Peckham Market", type: "business", openHours: { start: 8, end: 14 } },
  { code: "sids-cafe", displayName: "Sid's Café", type: "business", openHours: { start: 6, end: 17 } },
  { code: "boycie-house", displayName: "Boycie's", type: "home" },
  { code: "denzil-house", displayName: "Denzil's", type: "home" },
  { code: "one-eleven-club", displayName: "The 111 Club", type: "pub", openHours: { start: 12, end: 24 } },
  { code: "starlight-rooms", displayName: "Starlight Rooms", type: "pub", openHours: { start: 20, end: 26 } },
  { code: "police-station", displayName: "The Nick", type: "civic" },
  { code: "post-office", displayName: "Post Office", type: "civic", openHours: { start: 8, end: 17 } },
  { code: "betting-shop", displayName: "The Bookies", type: "business", openHours: { start: 9, end: 18 } },
  { code: "shamrock-club", displayName: "Shamrock Club", type: "pub", openHours: { start: 19, end: 26 } },
  { code: "dirty-barrys", displayName: "Dirty Barry's", type: "business", openHours: { start: 11, end: 20 } },
  { code: "raquel-flat", displayName: "Raquel's", type: "home" },
  { code: "cassandra-bank", displayName: "The Bank", type: "business", openHours: { start: 9, end: 17 } },
  { code: "parry-printers", displayName: "Parry Print", type: "business", openHours: { start: 8, end: 18 } },
  { code: "trigger-flat", displayName: "Trigger's", type: "home" },
  { code: "albert-legion", displayName: "The Legion", type: "pub", openHours: { start: 11, end: 23 } },
  { code: "mickey-jevon-flat", displayName: "Mickey & Jevon's", type: "home" },
  { code: "cassandra-flat", displayName: "Cassandra's", type: "home" },
  { code: "parry-house", displayName: "Parry's", type: "home" },
  { code: "slater-flat", displayName: "Slater's", type: "home" },
  { code: "off-map", displayName: "Off-map", type: "abstract" },
];

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
  if (options?.attendsAuction) {
    // Auction-attending dealers do the morning paper run at Sid's then
    // spend the auction window at Sotheby's. The window covers reading
    // the docket on arrival, inspecting where useful, and bidding.
    // Their other commitments at these hours get displaced — going to
    // the auction is the day's main commitment.
    schedule.set(PAPER_FROM_HOUR, "sids-cafe");
    fixed.add(PAPER_FROM_HOUR);
    for (let h = AUCTION_START_HOUR; h <= AUCTION_END_HOUR; h += 1) {
      schedule.set(h, "auction-house");
      fixed.add(h);
    }
  }
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
};

const ACTORS: readonly ActorSpec[] = [
  // ─── core trader cast ────────────────────────────────────────────────
  {
    code: "player",
    displayName: "The Trader",
    cash: 2000,
    ...makeRoutineFromSpans(
      "peckham-flat",
      [
        { from: 6, to: 8, location: "peckham-flat" },
        { from: 8, to: 8.5, location: "sids-cafe" },
        { from: 8.5, to: 9, location: "lockup" },
        { from: 9, to: 13, location: "peckham-market" },
        { from: 13, to: 14, location: "nags" },
        { from: 14, to: 17, location: "FLEXIBLE" },
        { from: 17, to: 18.5, location: "peckham-flat" },
        { from: 18.5, to: 23.5, location: "nags" },
        { from: 23.5, to: 6, location: "peckham-flat" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 6, end: 23 },
  },
  {
    code: "boyce",
    displayName: "Boycie",
    cash: 5000,
    ...makeRoutineFromSpans(
      "boycie-house",
      [
        { from: 8, to: 9, location: "boycie-house" },
        { from: 9, to: 13, location: "boyce-auto-sales" },
        { from: 13, to: 14.5, location: "nags" },
        { from: 14.5, to: 17, location: "boyce-auto-sales" },
        { from: 17, to: 19, location: "FLEXIBLE" },
        { from: 19.5, to: 22.5, location: "nags" },
        { from: 22.5, to: 8, location: "boycie-house" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "boyce-auto-sales",
    homeLocation: "boycie-house",
    lockupLocation: "boyce-auto-sales",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 23 },
  },
  {
    code: "denzil",
    displayName: "Denzil",
    cash: 1500,
    ...makeRoutineFromSpans(
      "denzil-house",
      [
        { from: 5, to: 6, location: "denzil-house" },
        { from: 6, to: 14, location: "TRAVELLING" },
        { from: 14, to: 15, location: "transworld-depot" },
        { from: 15, to: 18, location: "FLEXIBLE" },
        { from: 19, to: 22, location: "nags" },
        { from: 22, to: 5, location: "denzil-house" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "transworld-depot",
    homeLocation: "denzil-house",
    lockupLocation: "transworld-depot",
    transportCapacity: "truck",
    awakeHours: { start: 5, end: 23 },
  },
  {
    code: "monkey-harris",
    displayName: "Monkey Harris",
    cash: 800,
    ...makeRoutineFromSpans(
      "lockup",
      [
        { from: 11, to: 17, location: "lockup" },
        { from: 19, to: 23, location: "nags" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "lockup",
    homeLocation: "lockup",
    transportCapacity: "van",
    awakeHours: { start: 9, end: 23 },
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
    ...makeRoutineFromSpans(
      "peckham-flat",
      [
        { from: 8, to: 9, location: "peckham-flat" },
        { from: 9, to: 13, location: "peckham-market" },
        { from: 13, to: 14, location: "nags" },
        { from: 14, to: 17, location: "FLEXIBLE" },
        { from: 19, to: 22, location: "nags" },
        { from: 22, to: 8, location: "peckham-flat" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "van",
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
      { from: 10, to: 13, location: "FLEXIBLE" },
      { from: 13, to: 15, location: "nags" },
      { from: 15, to: 19, location: "FLEXIBLE" },
      { from: 19, to: 23.5, location: "nags" },
      { from: 23.5, to: 10, location: "mickey-jevon-flat" },
    ]),
    defaultLocation: "mickey-jevon-flat",
    homeLocation: "mickey-jevon-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 10, end: 23 },
  },
  {
    code: "jevon",
    displayName: "Jevon",
    cash: 120,
    ...makeRoutineFromSpans("mickey-jevon-flat", [
      { from: 12, to: 14, location: "nags" },
      { from: 14, to: 19, location: "FLEXIBLE" },
      { from: 19, to: 23.5, location: "nags" },
      { from: 23.5, to: 12, location: "mickey-jevon-flat" },
    ]),
    defaultLocation: "mickey-jevon-flat",
    homeLocation: "mickey-jevon-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 11, end: 23 },
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
    defaultLocation: "cassandra-bank",
    homeLocation: "cassandra-flat",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 22 },
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
    ...makeRoutineFromSpans("slater-flat", [
      { from: 8, to: 18, location: "police-station" },
      { from: 18, to: 22, location: "FLEXIBLE" },
      { from: 22, to: 8, location: "slater-flat" },
    ]),
    defaultLocation: "police-station",
    homeLocation: "slater-flat",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 22 },
  },
  {
    code: "dirty-barry",
    displayName: "Dirty Barry",
    cash: 250,
    ...makeRoutineFromSpans(
      "dirty-barrys",
      [
        { from: 11, to: 20, location: "dirty-barrys" },
        { from: 21, to: 23, location: "nags" },
        { from: 23, to: 11, location: "dirty-barrys" },
      ],
      { attendsAuction: true },
    ),
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
  player: ["player", "dealer", "family"],
  boyce: ["dealer", "fence"],
  denzil: ["dealer"],
  "monkey-harris": ["dealer", "fence"],
  trigger: ["civilian", "official"],
  mike: ["pub"],
  "auction-house": ["official"],
  rodney: ["dealer", "family"],
  albert: ["civilian", "family"],
  grandad: ["civilian", "family"],
  marlene: ["civilian", "family"],
  "mickey-pearce": ["dealer"],
  jevon: ["dealer"],
  raquel: ["civilian"],
  cassandra: ["civilian", "family"],
  "alan-parry": ["civilian", "family"],
  sid: ["pub"],
  "alfie-flowers": ["supplier"],
  "ronnie-nelson": ["supplier"],
  mustapha: ["supplier"],
  arnie: ["supplier"],
  towser: ["supplier"],
  "paddy-the-greek": ["supplier", "dealer"],
  slater: ["police"],
  "dirty-barry": ["fence", "villain"],
  "eugene-mccarthy": ["villain"],
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
}

export function seedPlaceholderSkin(
  db: DB,
  rng: SeededRNG,
  opts: SkinSeedOptions = {},
): SkinSeedResult {
  const runLengthDays = opts.runLengthDays ?? 14;

  // Locations.
  const locByCode = new Map<string, number>();
  for (const spec of LOCATIONS) {
    const loc = insertLocation(db, {
      code: spec.code,
      displayName: spec.displayName,
      type: spec.type,
      openHours: spec.openHours ?? null,
    });
    locByCode.set(spec.code, loc.id);
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

    actorRoutines.set(a.id, {
      homeLocationId: homeId,
      schedule: scheduleByHour,
      flexibleHours: spec.flexibleHours,
      awakeHours: spec.awakeHours,
    });

    if (spec.code !== "player") {
      const hourOverride = opts.hourOverrideForActor?.(a.id) ?? null;
      const policyOpts =
        hourOverride !== null
          ? { schedule: scheduleByHour, defaultLocationId: defaultLocId, hourOverride }
          : { schedule: scheduleByHour, defaultLocationId: defaultLocId };
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

  // Starter stock — every dealer/fence opens day 1 with 2-3 lots from
  // the everyday catalogue. Each lot also seeds a first-hand "I have
  // this" supply lead, so gossip starts with something to circulate.
  // Stock lives at the actor's *lockup*, not their day-time location.
  seedStarterStock(db, rng, {
    actorByCode,
    actorLockupLocByCode,
    everydayItemIds,
  });

  const newspaperLocationId = sidsId;
  if (newspaperLocationId === undefined) {
    throw new Error("placeholder skin must seed the sids-cafe location");
  }

  return {
    playerActorId: playerId,
    auctionHouseActorId: auctionHouseId,
    policies,
    bidderProfiles,
    reachableByCategory,
    defaultReachableActorIds,
    pubLocationIds,
    auctionLocationId,
    auctionStartHour: AUCTION_START_HOUR,
    auctionEndHour: AUCTION_END_HOUR,
    newspaperLocationId,
    paperFromHour: PAPER_FROM_HOUR,
    galleryFromHour: GALLERY_FROM_HOUR,
    runLengthDays,
    tradingActorIds,
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
}

function seedStarterStock(
  db: DB,
  rng: SeededRNG,
  args: SeedStarterStockArgs,
): void {
  const { actorByCode, actorLockupLocByCode, everydayItemIds } = args;
  if (everydayItemIds.length === 0) return;

  for (const code of STARTER_STOCK_CODES) {
    const ownerId = actorByCode.get(code);
    if (ownerId === undefined) continue;
    const locId = actorLockupLocByCode.get(code) ?? null;

    const lotCount = rng.int(2, 4); // 2 or 3 lots
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
      const quantity = rng.int(10, 41); // 10..40
      // Acquired at 40-80% of base value — they got it cheap.
      const priceFactor = 0.4 + rng.next() * 0.4;
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

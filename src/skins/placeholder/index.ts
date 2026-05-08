import type { DB } from "../../engine/core/db.js";
import type { SeededRNG } from "../../engine/core/rng.js";
import { insertActor } from "../../engine/actors/actors-repo.js";
import { insertItemKind } from "../../engine/stock/items-repo.js";
import {
  insertLocation,
  setActorLocation,
  setLocationProprietor,
} from "../../engine/locations/locations.js";
import type { LocationType } from "../../engine/locations/locations.js";
import { RuleBasedAIPolicy } from "../../engine/policy/rule-based.js";
import type { ActorPolicy } from "../../engine/policy/types.js";
import type { BidderProfile } from "../../engine/auction/bidder-profile.js";
import type { FlawType } from "../../engine/stock/types.js";
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
  /** Hour of day at which the auction fires. */
  readonly auctionHour: number;
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
}

export interface ActorRoutineInfo {
  readonly homeLocationId: number | null;
  readonly schedule: ReadonlyMap<number, number>;
  readonly awakeHours: { readonly start: number; readonly end: number };
}

interface ActorSpec {
  readonly code: string;
  readonly displayName: string;
  readonly cash: number;
  readonly schedule: ReadonlyMap<number, string>;
  readonly defaultLocation: string;
  readonly homeLocation: string;
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
  { code: "peckham-flat", displayName: "Peckham flat (Nelson Mandela House)", type: "home" },
  { code: "lockup", displayName: "The Lock-up", type: "business", openHours: { start: 8, end: 20 } },
  { code: "nags", displayName: "The Nag's Head", type: "pub", openHours: { start: 11, end: 23 } },
  { code: "auction-house", displayName: "Sotheby's-by-the-Pub", type: "auction", openHours: { start: 9, end: 13 } },
  { code: "boyce-auto-sales", displayName: "Boyce Auto Sales (Lewisham)", type: "business", openHours: { start: 9, end: 18 } },
  { code: "transworld-depot", displayName: "Transworld Express depot", type: "business", openHours: { start: 6, end: 18 } },
  { code: "lambeth-council-yard", displayName: "Lambeth Council yard", type: "civic", openHours: { start: 6, end: 17 } },
  // Added from the wider canon.
  { code: "peckham-market", displayName: "Peckham Market", type: "business", openHours: { start: 8, end: 14 } },
  { code: "sids-cafe", displayName: "Sid's Café", type: "business", openHours: { start: 6, end: 17 } },
  { code: "boycie-house", displayName: "Boycie & Marlene's house", type: "home" },
  { code: "denzil-house", displayName: "Denzil & Corinne's house", type: "home" },
  { code: "council-streets", displayName: "Council sweeping round", type: "street" },
  { code: "one-eleven-club", displayName: "The One-Eleven Club", type: "pub", openHours: { start: 12, end: 24 } },
  { code: "starlight-rooms", displayName: "The Starlight Rooms", type: "pub", openHours: { start: 20, end: 26 } },
  { code: "police-station", displayName: "Peckham Police Station", type: "civic" },
  { code: "post-office", displayName: "Post Office", type: "civic", openHours: { start: 8, end: 17 } },
  { code: "betting-shop", displayName: "The Bookies", type: "business", openHours: { start: 9, end: 18 } },
  { code: "shamrock-club", displayName: "The Shamrock Club, Deptford", type: "pub", openHours: { start: 19, end: 26 } },
  { code: "dirty-barrys", displayName: "Dirty Barry's", type: "business", openHours: { start: 11, end: 20 } },
  { code: "raquel-flat", displayName: "Raquel's flat", type: "home" },
  { code: "cassandra-bank", displayName: "Cassandra's bank", type: "business", openHours: { start: 9, end: 17 } },
  { code: "parry-printers", displayName: "Parry Print", type: "business", openHours: { start: 8, end: 18 } },
  { code: "trigger-flat", displayName: "Trigger's flat", type: "home" },
  { code: "albert-legion", displayName: "Royal British Legion", type: "pub", openHours: { start: 11, end: 23 } },
  { code: "mickey-jevon-flat", displayName: "Mickey & Jevon's flat", type: "home" },
  { code: "cassandra-flat", displayName: "Cassandra's flat", type: "home" },
  { code: "parry-house", displayName: "Alan & Pamela Parry's house", type: "home" },
  { code: "slater-flat", displayName: "Slater's flat", type: "home" },
  { code: "off-map", displayName: "Off-map", type: "abstract" },
];

/** Hour at which the daily auction is held. */
const AUCTION_HOUR = 10;

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

function makeRoutineFromSpans(
  homeCode: string,
  spans: readonly ScheduleSpan[],
  options?: { readonly attendsAuction?: boolean },
): Map<number, string> {
  const m = new Map<number, string>();
  for (let h = 0; h < 24; h += 1) m.set(h, homeCode);
  for (const sp of spans) {
    if (PLACEHOLDER_LOCATIONS.has(sp.location)) continue;
    const f = Math.floor(sp.from);
    const t = Math.ceil(sp.to);
    if (f < t) {
      for (let h = f; h < t && h < 24; h += 1) m.set(h, sp.location);
    } else {
      for (let h = f; h < 24; h += 1) m.set(h, sp.location);
      for (let h = 0; h < t && h < 24; h += 1) m.set(h, sp.location);
    }
  }
  if (options?.attendsAuction) {
    m.set(AUCTION_HOUR, "auction-house");
  }
  return m;
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
    schedule: makeRoutineFromSpans(
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
    schedule: makeRoutineFromSpans(
      "boycie-house",
      [
        { from: 8, to: 9, location: "boycie-house" },
        { from: 9, to: 13, location: "boyce-auto-sales" },
        { from: 13, to: 14.5, location: "nags" },
        { from: 14.5, to: 18, location: "boyce-auto-sales" },
        { from: 18, to: 19, location: "boycie-house" },
        { from: 19.5, to: 22.5, location: "nags" },
        { from: 22.5, to: 8, location: "boycie-house" },
      ],
      { attendsAuction: true },
    ),
    defaultLocation: "boyce-auto-sales",
    homeLocation: "boycie-house",
    transportCapacity: "boot",
    awakeHours: { start: 7, end: 23 },
  },
  {
    code: "denzil",
    displayName: "Denzil",
    cash: 1500,
    schedule: makeRoutineFromSpans(
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
    transportCapacity: "truck",
    awakeHours: { start: 5, end: 23 },
  },
  {
    code: "monkey-harris",
    displayName: "Monkey Harris",
    cash: 800,
    schedule: makeRoutineFromSpans(
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
    schedule: makeRoutineFromSpans("trigger-flat", [
      { from: 6.5, to: 7, location: "lambeth-council-yard" },
      { from: 7, to: 12, location: "council-streets" },
      { from: 12, to: 13, location: "sids-cafe" },
      { from: 13, to: 16, location: "council-streets" },
      { from: 16, to: 16.5, location: "lambeth-council-yard" },
      { from: 17, to: 23, location: "nags" },
      { from: 23, to: 6.5, location: "trigger-flat" },
    ]),
    defaultLocation: "council-streets",
    homeLocation: "trigger-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 6, end: 23 },
  },
  {
    code: "mike",
    displayName: "Mike Fisher",
    cash: 600,
    schedule: makeRoutineFromSpans("nags", [
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
    displayName: "Sotheby's-by-the-Pub",
    cash: 0,
    schedule: makeRoutineFromSpans("auction-house", []),
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
    schedule: makeRoutineFromSpans("peckham-flat", [
      { from: 8, to: 9, location: "peckham-flat" },
      { from: 9, to: 13, location: "peckham-market" },
      { from: 13, to: 14, location: "nags" },
      { from: 14, to: 17, location: "FLEXIBLE" },
      { from: 19, to: 22, location: "nags" },
      { from: 22, to: 8, location: "peckham-flat" },
    ]),
    defaultLocation: "peckham-flat",
    homeLocation: "peckham-flat",
    transportCapacity: "pocket",
    awakeHours: { start: 8, end: 22 },
  },
  {
    code: "albert",
    displayName: "Uncle Albert",
    cash: 100,
    schedule: makeRoutineFromSpans("peckham-flat", [
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
    schedule: makeRoutineFromSpans("peckham-flat", [
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
    schedule: makeRoutineFromSpans("boycie-house", [
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
    schedule: makeRoutineFromSpans("mickey-jevon-flat", [
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
    schedule: makeRoutineFromSpans("mickey-jevon-flat", [
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
    schedule: makeRoutineFromSpans("raquel-flat", [
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
    schedule: makeRoutineFromSpans("cassandra-flat", [
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
    schedule: makeRoutineFromSpans("parry-house", [
      { from: 8.5, to: 13, location: "parry-printers" },
      { from: 13, to: 14.5, location: "FLEXIBLE" },
      { from: 14.5, to: 18, location: "parry-printers" },
      { from: 19, to: 22, location: "FLEXIBLE" },
      { from: 22, to: 8.5, location: "parry-house" },
    ]),
    defaultLocation: "parry-printers",
    homeLocation: "parry-house",
    transportCapacity: "boot",
    awakeHours: { start: 8, end: 22 },
  },
  {
    code: "sid",
    displayName: "Sid",
    cash: 400,
    schedule: makeRoutineFromSpans("sids-cafe", [
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
    schedule: makeRoutineFromSpans("off-map", [
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
    schedule: makeRoutineFromSpans("off-map", [
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
    schedule: makeRoutineFromSpans("off-map", [
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
    schedule: makeRoutineFromSpans("off-map", [
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
    schedule: makeRoutineFromSpans("off-map", [
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
    schedule: makeRoutineFromSpans("off-map", [
      { from: 8, to: 14, location: "peckham-market" },
      { from: 14, to: 16, location: "sids-cafe" },
    ]),
    defaultLocation: "peckham-market",
    homeLocation: "off-map",
    transportCapacity: "van",
    awakeHours: { start: 7, end: 17 },
  },

  // ─── enemies / wildcards ────────────────────────────────────────────
  {
    code: "slater",
    displayName: "DCI Roy Slater",
    cash: 300,
    schedule: makeRoutineFromSpans("slater-flat", [
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
    schedule: makeRoutineFromSpans("dirty-barrys", [
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
    schedule: makeRoutineFromSpans("starlight-rooms", [
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

export interface SkinSeedOptions {
  readonly runLengthDays?: number;
}

export function seedPlaceholderSkin(
  db: DB,
  _rng: SeededRNG,
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

  // Items.
  for (const spec of EVERYDAY_ITEMS) insertItemKind(db, spec);
  for (const spec of EASTER_EGG_ITEMS) insertItemKind(db, spec);

  // Actors.
  const actorByCode = new Map<string, number>();
  const policies = new Map<number, ActorPolicy>();
  const actorRoutines = new Map<number, ActorRoutineInfo>();
  for (const spec of ACTORS) {
    const homeId = locByCode.get(spec.homeLocation);
    if (homeId === undefined) {
      throw new Error(`unknown home location for ${spec.code}: ${spec.homeLocation}`);
    }
    const a = insertActor(db, {
      code: spec.code,
      displayName: spec.displayName,
      cash: spec.cash,
      transportCapacity: spec.transportCapacity,
      homeLocationId: homeId,
    });
    actorByCode.set(spec.code, a.id);

    const defaultLocId = locByCode.get(spec.defaultLocation);
    if (defaultLocId === undefined) {
      throw new Error(`unknown default location for ${spec.code}: ${spec.defaultLocation}`);
    }
    setActorLocation(db, a.id, defaultLocId);

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
      awakeHours: spec.awakeHours,
    });

    if (spec.code !== "player") {
      policies.set(
        a.id,
        new RuleBasedAIPolicy(`policy-${spec.code}`, {
          schedule: scheduleByHour,
          defaultLocationId: defaultLocId,
        }),
      );
    }
  }

  const playerId = actorByCode.get("player");
  const auctionHouseId = actorByCode.get("auction-house");
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

  return {
    playerActorId: playerId,
    auctionHouseActorId: auctionHouseId,
    policies,
    bidderProfiles,
    reachableByCategory,
    defaultReachableActorIds,
    pubLocationIds,
    auctionLocationId,
    auctionHour: AUCTION_HOUR,
    runLengthDays,
    tradingActorIds,
    actorRoutines,
  };
}

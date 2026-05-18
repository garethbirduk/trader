/**
 * Cast data for the placeholder skin — the actor specs, the routine-
 * building helpers they use, and the small constants that describe
 * groups of actors (high-street shopkeepers, off-map dealers,
 * synthetic accounting actors).
 *
 * Extracted from `index.ts` so the cast lives in one self-contained
 * file. The seed loop in `index.ts` imports `ACTORS` (and the few
 * group constants the seed function also touches) and inserts each
 * spec into the DB.
 *
 * Anything specific to ONE actor goes in the matching ACTORS entry
 * (cash, schedule, transport, awake hours, social score, lunch slot,
 * shortName, etc.). Anything that describes a *role* tag or pricing
 * profile lives in `index.ts` next to `ACTOR_ROLES` / `ACTOR_PROFILES`
 * because those are cross-referenced with engine subsystems beyond
 * the cast itself.
 */

import type { TransportCapacity } from "../../engine/actors/types.js";

// ────────────────────────────────────────────────────────────────────
// Calendar helpers
// ────────────────────────────────────────────────────────────────────

export const DAYS_MON_FRI: readonly number[] = [1, 2, 3, 4, 5];
export const DAYS_MON_SAT: readonly number[] = [1, 2, 3, 4, 5, 6];

// ────────────────────────────────────────────────────────────────────
// ActorSpec — the shape every cast entry has to match
// ────────────────────────────────────────────────────────────────────

export interface ActorSpec {
  readonly code: string;
  readonly displayName: string;
  /** Optional short / nickname form used in chip-sized UI surfaces
   *  (selection chips, mini actor rows, owner labels). Falls back to
   *  displayName when unset. Use this for characters whose displayName
   *  is "First Last" but who go by just "First" in conversation. */
  readonly shortName?: string;
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
  /** Character-arm scalar in [0, 1]. Defaults to 0.5 (neutral).
   *  Drives the (buyer_social − seller_social) delta at pub-deal
   *  entry which modifies the buyer's effective flaw-detection
   *  (docs/judgement.md). */
  readonly socialScore?: number;
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

// ────────────────────────────────────────────────────────────────────
// Routine span DSL — small builders the ACTORS array uses to write
// schedules as readable {from, to, location} spans rather than 24
// hour entries.
//
// Hours not covered fall back to `homeCode`. Spans whose location is
// the placeholder `FLEXIBLE` / `TRAVELLING` / `OFF_SCREEN` / `ROAMING`
// leave the underlying default in place — they're not real locations.
// ────────────────────────────────────────────────────────────────────

export interface ScheduleSpan {
  readonly from: number;
  readonly to: number;
  readonly location: string;
}

export const PLACEHOLDER_LOCATIONS = new Set([
  "FLEXIBLE",
  "TRAVELLING",
  "OFF_SCREEN",
  "ROAMING",
]);

export interface BuiltRoutine {
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
export function weekendSpans(
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

export function makeRoutineFromSpans(
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

// ────────────────────────────────────────────────────────────────────
// High-street shopkeepers — each shop has one keeper. The cast loop
// at the bottom expands these into full ActorSpec entries. Cross-
// referenced with the matching LOCATIONS shop entries in `index.ts`.
// ────────────────────────────────────────────────────────────────────

/**
 * High-street shop codes paired with their resident shopkeeper code.
 * Both are seeded together — one shopkeeper per shop, working 9-17,
 * living off-map. The pub-deal autonomy uses the location list to
 * decide where shop-sale attempts can fire, and the actor list to
 * constrain who can be the *buyer* (dealer-sells-to-shopkeeper only).
 */
export interface HighStreetShopSpec {
  readonly shopCode: string;
  readonly keeperCode: string;
  /** Override the default 9-17 keeper shift. */
  readonly hours?: { readonly from: number; readonly to: number };
  /** When true, the keeper keeps their full schedule on Sat/Sun (matches
   *  Sid's caff pattern). Defaults to false → weekday-only keeper, off-map
   *  Sat/Sun. The location's `openDaysOfWeek` is the canonical
   *  customer-facing schedule; this just covers the keeper's diary. */
  readonly worksWeekends?: boolean;
}

export const HIGH_STREET_SHOPS: readonly HighStreetShopSpec[] = [
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
  { shopCode: "spanner-motors", keeperCode: "eddie-spanner", hours: { from: 8, to: 16 }, worksWeekends: true },
  { shopCode: "camshaft-autos", keeperCode: "vince-camshaft" },
];

export const SHOPKEEPER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
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
  "eddie-spanner": "Eddie Spanner",
  "vince-camshaft": "Vince Camshaft",
};

// ────────────────────────────────────────────────────────────────────
// Off-map dealers + synthetic external-economy account
// ────────────────────────────────────────────────────────────────────

export const OFF_MAP_DEALER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "slough-stan": "Slough Stan",
  "croydon-carl": "Croydon Carl",
  "maidstone-maureen": "Maidstone Maureen",
  "wandsworth-wally": "Wandsworth Wally",
  "brighton-bernie": "Brighton Bernie",
  "watford-wendy": "Watford Wendy",
  "romford-reg": "Romford Reg",
  "kingston-kev": "Kingston Kev",
};

export const OFF_MAP_DEALER_CODES: readonly string[] = [
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
export const OFF_MAP_MARKET_CODE = "off-map-market";

// ────────────────────────────────────────────────────────────────────
// ACTORS — the cast itself
// ────────────────────────────────────────────────────────────────────

export const ACTORS: readonly ActorSpec[] = [
  // ─── core trader cast ────────────────────────────────────────────────
  {
    code: "player",
    displayName: "Del Boy",
    cash: 2000,
    socialScore: 0.75,
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
    socialScore: 0.7,
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
    socialScore: 0.55,
    displayName: "Denzil Tulser",
    shortName: "Denzil",
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
    socialScore: 0.2,
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
    socialScore: 0.85,
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
    socialScore: 0.45,
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
    socialScore: 0.65,
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

  // ─── Denzil's household ──────────────────────────────────────────────
  {
    code: "corrine",
    displayName: "Corrine Tulser",
    shortName: "Corrine",
    cash: 250,
    ...makeRoutineFromSpans("denzil-house", [
      { from: 8, to: 10, location: "denzil-house" },
      { from: 10, to: 12, location: "peckham-market" },
      { from: 12, to: 14, location: "nags" },
      { from: 14, to: 18, location: "denzil-house" },
      { from: 20, to: 23, location: "nags" },
      { from: 23, to: 8, location: "denzil-house" },
    ]),
    defaultLocation: "denzil-house",
    homeLocation: "denzil-house",
    transportCapacity: "boot",
    awakeHours: { start: 8, end: 23 },
  },

  // ─── pub regulars / sidekicks ───────────────────────────────────────
  {
    code: "mickey-pearce",
    socialScore: 0.55,
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
    socialScore: 0.75,
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
    socialScore: 0.85,
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
    socialScore: 0.9,
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
  ...HIGH_STREET_SHOPS.map(({ shopCode, keeperCode, hours, worksWeekends }): ActorSpec => {
    const fromH = hours?.from ?? 9;
    const toH = hours?.to ?? 17;
    const base = {
      code: keeperCode,
      displayName: SHOPKEEPER_DISPLAY_NAMES[keeperCode] ?? keeperCode,
      cash: 2500,
      ...makeRoutineFromSpans("off-map", [
        { from: fromH, to: toH, location: shopCode },
      ]),
      defaultLocation: shopCode,
      homeLocation: "off-map",
      transportCapacity: "none" as TransportCapacity,
      awakeHours: { start: Math.max(0, fromH - 1), end: Math.min(24, toH + 1) },
    };
    // Mon-Fri keepers stay off-map at weekends; Mon-Sat keepers keep their
    // weekday rhythm Sat/Sun (engine policy has no Sat/Sun split — the
    // location's openDaysOfWeek is the customer-facing truth).
    return worksWeekends ? base : { ...base, ...weekendSpans("off-map", []) };
  }),
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

/**
 * Cast types & helpers for the placeholder skin.
 *
 * Seed data lives in JSON: see ./data/actors.json, ./data/locations.json,
 * ./data/items.json. The arrays exported here (ACTORS, HIGH_STREET_SHOPS,
 * OFF_MAP_DEALER_CODES) are loaded from those files at module-load
 * time. See temp/seed-archive/ for the legacy hard-coded cast.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** Given name. Required. */
  readonly firstName: string;
  /** Family name. Optional — omit for institutions (e.g. "Sotheby's")
   *  and one-name characters. */
  readonly lastName?: string;
  /** Chip-friendly display form (nickname or short label). Required.
   *  Used in chips and any compact surface; lists and the POV dropdown
   *  use the composed full name (`firstName` + ` ` + `lastName`). */
  readonly shortName: string;
  readonly cash: number;
  readonly schedule: ReadonlyMap<number, string>;
  readonly flexibleHours: ReadonlySet<number>;
  readonly weekendSchedule?: ReadonlyMap<number, string>;
  readonly weekendFlexibleHours?: ReadonlySet<number>;
  readonly defaultLocation: string;
  readonly homeLocation: string;
  readonly lockupLocation?: string;
  readonly transportCapacity: TransportCapacity;
  readonly awakeHours: { readonly start: number; readonly end: number };
  readonly flexibleDailyMode?: boolean;
  readonly bribable?: boolean;
  readonly socialScore?: number;
  readonly lunchSlot?: {
    readonly hours: readonly number[];
    readonly daysOfWeek: readonly number[];
    readonly candidateCodes: readonly string[];
  };
}

/**
 * Compose an actor's full display name (`firstName` + ` ` + `lastName`),
 * falling back to just `firstName` when no `lastName` is set (institutions,
 * one-name characters). Use this for surfaces showing the full name —
 * the Actors list, the POV dropdown, profile headers. Chip surfaces use
 * `shortName` instead (see `docs/ui-rules.md`).
 */
export function fullName(spec: { firstName: string; lastName?: string }): string {
  return spec.lastName ? `${spec.firstName} ${spec.lastName}` : spec.firstName;
}

// ────────────────────────────────────────────────────────────────────
// Routine span DSL — small builders used by the JSON loader (TBD) to
// turn ./data/actors.json schedule arrays into hour→location maps.
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
  readonly flexibleHours: ReadonlySet<number>;
}

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
  const flexibleHours = new Set<number>();
  for (let h = 0; h < 24; h += 1) {
    if (!fixed.has(h)) flexibleHours.add(h);
  }
  return { schedule, flexibleHours };
}

// ────────────────────────────────────────────────────────────────────
// High-street shopkeepers — data has moved to JSON. Empty stub.
// ────────────────────────────────────────────────────────────────────

export interface HighStreetShopSpec {
  readonly shopCode: string;
  readonly keeperCode: string;
  readonly hours?: { readonly from: number; readonly to: number };
  readonly worksWeekends?: boolean;
}

export const HIGH_STREET_SHOPS: readonly HighStreetShopSpec[] = [];

// ────────────────────────────────────────────────────────────────────
// Off-map dealers + synthetic external-economy account — empty stubs.
// ────────────────────────────────────────────────────────────────────

export const OFF_MAP_DEALER_CODES: readonly string[] = [];

export const OFF_MAP_MARKET_CODE = "off-map-market";

// ────────────────────────────────────────────────────────────────────
// ACTORS — loaded from ./data/actors.json at module-load time.
// ────────────────────────────────────────────────────────────────────

interface ActorJson {
  readonly code: string;
  readonly firstName: string;
  readonly lastName?: string;
  readonly shortName: string;
  readonly cash: number;
  readonly socialScore?: number;
  readonly homeLocation: string;
  readonly defaultLocation: string;
  readonly lockupLocation?: string;
  readonly transportCapacity: TransportCapacity;
  readonly awakeHours: { readonly start: number; readonly end: number };
  readonly flexibleDailyMode?: boolean;
  readonly bribable?: boolean;
  readonly schedule: readonly ScheduleSpan[];
  readonly weekendSchedule?: readonly ScheduleSpan[];
  readonly lunchSlot?: {
    readonly hours: readonly number[];
    readonly daysOfWeek: readonly number[];
    readonly candidateCodes: readonly string[];
  };
}

function loadJson<T>(relativePath: string): T {
  const dir = dirname(fileURLToPath(import.meta.url));
  const path = join(dir, relativePath);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function actorJsonToSpec(j: ActorJson): ActorSpec {
  const routine = makeRoutineFromSpans(j.homeLocation, j.schedule);
  const weekend = j.weekendSchedule
    ? weekendSpans(j.homeLocation, j.weekendSchedule)
    : null;
  return {
    code: j.code,
    firstName: j.firstName,
    ...(j.lastName !== undefined ? { lastName: j.lastName } : {}),
    shortName: j.shortName,
    cash: j.cash,
    schedule: routine.schedule,
    flexibleHours: routine.flexibleHours,
    ...(weekend !== null
      ? {
          weekendSchedule: weekend.weekendSchedule,
          weekendFlexibleHours: weekend.weekendFlexibleHours,
        }
      : {}),
    defaultLocation: j.defaultLocation,
    homeLocation: j.homeLocation,
    ...(j.lockupLocation !== undefined ? { lockupLocation: j.lockupLocation } : {}),
    transportCapacity: j.transportCapacity,
    awakeHours: j.awakeHours,
    ...(j.socialScore !== undefined ? { socialScore: j.socialScore } : {}),
    ...(j.flexibleDailyMode === true ? { flexibleDailyMode: true } : {}),
    ...(j.bribable === true ? { bribable: true } : {}),
    ...(j.lunchSlot !== undefined ? { lunchSlot: j.lunchSlot } : {}),
  };
}

export const ACTORS: readonly ActorSpec[] = loadJson<readonly ActorJson[]>(
  "data/actors.json",
).map(actorJsonToSpec);

/** Load helper exposed so other skin modules (locations, items) can
 *  read their own JSON files from the same data directory. */
export function loadSkinJson<T>(relativePath: string): T {
  return loadJson<T>(relativePath);
}

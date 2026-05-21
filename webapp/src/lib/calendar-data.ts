import type { DaySnapshot, RunActorRoutine, RunDump } from "../types.js";
import type { SelectionItem } from "./selection-set.js";
import { isWeekend } from "./calendar.js";
import { isLocationOpenAt } from "./location-open.js";

/** One hour row in the agenda. Empty rows (no actors, no facts) are
 *  still emitted so the 24-hour stripe always renders. */
export interface CalendarHourSlot {
  readonly hour: number;
  readonly locationGroups: readonly LocationGroup[];
  readonly facts: readonly CalendarFact[];
}

export interface LocationGroup {
  readonly locationId: number;
  readonly arrivals: readonly ActorArrival[];
  readonly departures: readonly ActorDeparture[];
}

export interface ActorArrival {
  readonly actorId: number;
  /** First hour the actor is no longer at this location (exclusive).
   *  24 means they stay through end-of-day. */
  readonly untilHour: number;
}

export interface ActorDeparture {
  readonly actorId: number;
}

export type CalendarFact =
  | {
      readonly kind: "auction-lot";
      readonly lotId: number;
      readonly knowerActorIds: readonly number[];
    }
  | {
      readonly kind: "deal-deadline";
      readonly dealId: number;
      readonly knowerActorIds: readonly number[];
    }
  | {
      readonly kind: "location-open";
      readonly locationId: number;
    }
  | {
      readonly kind: "location-close";
      readonly locationId: number;
    };

export interface CalendarDay {
  readonly day: number;
  readonly hourSlots: readonly CalendarHourSlot[];
}

export interface BuildCalendarOpts {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  /** POV actor id (admin = null). Used to suppress the POV's own
   *  avatar in arrival/departure rows. */
  readonly povActorId: number | null;
  /** Knowledge filter: when present, only actors in this set have
   *  their arrivals / departures rendered. Admin POV passes `null`
   *  to disable the filter. */
  readonly knownActorIds: ReadonlySet<number> | null;
  readonly selectionSet: readonly SelectionItem[];
}

/** Look up an actor's routine, applying weekend/weekday choice. Returns
 *  a 24-entry hour→locationId array, falling back to homeLocationId. */
function expandRoutine(
  routine: RunActorRoutine | undefined,
  day: number,
): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: 24 }, () =>
    routine?.homeLocationId ?? null,
  );
  if (routine === undefined) return out;
  const useWeekend =
    isWeekend(day) && routine.weekendSchedule !== undefined;
  const src = useWeekend ? routine.weekendSchedule! : routine.schedule;
  for (const e of src) {
    if (e.hour >= 0 && e.hour < 24) out[e.hour] = e.locationId;
  }
  return out;
}

/** Walk 0..23 once, emit one entry each time the hour-by-hour
 *  location changes. Hour 0 emits an arrival only (no prior location to
 *  depart from). A transition at hour H emits a departure from the old
 *  location at H and an arrival at the new location at H. */
function transitionsFromRoutine(
  byHour: (number | null)[],
): {
  arrivals: { hour: number; locationId: number; untilHour: number }[];
  departures: { hour: number; locationId: number }[];
} {
  const arrivals: { hour: number; locationId: number; untilHour: number }[] = [];
  const departures: { hour: number; locationId: number }[] = [];
  for (let h = 0; h < 24; h += 1) {
    const cur = byHour[h] ?? null;
    const prev = h > 0 ? byHour[h - 1] ?? null : null;
    const changed = h === 0 ? cur !== null : cur !== prev;
    if (!changed) continue;
    if (h > 0 && prev !== null) {
      departures.push({ hour: h, locationId: prev });
    }
    if (cur !== null) {
      let until = 24;
      for (let k = h + 1; k < 24; k += 1) {
        if ((byHour[k] ?? null) !== cur) {
          until = k;
          break;
        }
      }
      arrivals.push({ hour: h, locationId: cur, untilHour: until });
    }
  }
  return { arrivals, departures };
}

function pickSelected(
  selectionSet: readonly SelectionItem[],
): {
  actors: Set<number>;
  locations: Set<number>;
  lots: Set<number>;
  deals: Set<number>;
} {
  const actors = new Set<number>();
  const locations = new Set<number>();
  const lots = new Set<number>();
  const deals = new Set<number>();
  for (const s of selectionSet) {
    if (s.kind === "actor") actors.add(s.id);
    else if (s.kind === "location") locations.add(s.id);
    else if (s.kind === "lot") lots.add(s.id);
    else if (s.kind === "deal") deals.add(s.id);
  }
  return { actors, locations, lots, deals };
}

export function buildCalendarDay(opts: BuildCalendarOpts): CalendarDay {
  const { dump, day, snapshot, selectionSet, knownActorIds } = opts;
  const sel = pickSelected(selectionSet);

  // 1) Actor routines for selected actors, with POV knowledge filter.
  const arrivalsByHour: Map<number, Map<number, ActorArrival[]>> = new Map();
  const departuresByHour: Map<number, Map<number, ActorDeparture[]>> = new Map();
  for (let h = 0; h < 24; h += 1) {
    arrivalsByHour.set(h, new Map());
    departuresByHour.set(h, new Map());
  }
  const allRoutines = dump.actorRoutines ?? [];
  for (const r of allRoutines) {
    if (!sel.actors.has(r.actorId)) continue;
    if (knownActorIds !== null && !knownActorIds.has(r.actorId)) continue;
    const byHour = expandRoutine(r, day);
    const { arrivals, departures } = transitionsFromRoutine(byHour);
    for (const a of arrivals) {
      const hourMap = arrivalsByHour.get(a.hour)!;
      const list = hourMap.get(a.locationId) ?? [];
      list.push({ actorId: r.actorId, untilHour: a.untilHour });
      hourMap.set(a.locationId, list);
    }
    for (const d of departures) {
      const hourMap = departuresByHour.get(d.hour)!;
      const list = hourMap.get(d.locationId) ?? [];
      list.push({ actorId: r.actorId });
      hourMap.set(d.locationId, list);
    }
  }

  // 2) Facts.
  const factsByHour: Map<number, CalendarFact[]> = new Map();
  for (let h = 0; h < 24; h += 1) factsByHour.set(h, []);

  // 2a) Auction lots: selected lots that are on today's docket.
  if (snapshot !== null && sel.lots.size > 0) {
    for (const lot of snapshot.auctionLots) {
      if (!sel.lots.has(lot.id)) continue;
      if (lot.scheduledHour === null || lot.scheduledHour === undefined) continue;
      const onDocketToday =
        lot.listedDay <= day &&
        (lot.clearedDay === null || lot.clearedDay >= day);
      if (!onDocketToday) continue;
      const knowers: number[] = [];
      for (const a of snapshot.actors) {
        const kk = a.knownAuctionLotIds ?? [];
        if (kk.includes(lot.id)) knowers.push(a.id);
      }
      factsByHour.get(lot.scheduledHour)?.push({
        kind: "auction-lot",
        lotId: lot.id,
        knowerActorIds: knowers,
      });
    }
  }

  // 2b) Deal deadlines: selected deals whose deadline hits today.
  if (snapshot !== null && sel.deals.size > 0) {
    for (const deal of snapshot.deals) {
      if (!sel.deals.has(deal.id)) continue;
      if (deal.deadlineDay !== day) continue;
      factsByHour.get(0)?.push({
        kind: "deal-deadline",
        dealId: deal.id,
        knowerActorIds: [deal.buyerActorId, deal.sellerActorId],
      });
    }
  }

  // 2c) Location open/close transitions for selected locations.
  for (const locId of sel.locations) {
    const loc = dump.locations.find((l) => l.id === locId);
    if (loc === undefined) continue;
    let prevOpen = isLocationOpenAt(loc, day, 0);
    if (prevOpen) {
      const yesterdayLast = day > 1 ? isLocationOpenAt(loc, day - 1, 23) : false;
      if (!yesterdayLast) {
        factsByHour.get(0)?.push({ kind: "location-open", locationId: locId });
      }
    }
    for (let h = 1; h < 24; h += 1) {
      const open = isLocationOpenAt(loc, day, h);
      if (open && !prevOpen) {
        factsByHour.get(h)?.push({ kind: "location-open", locationId: locId });
      } else if (!open && prevOpen) {
        factsByHour.get(h)?.push({ kind: "location-close", locationId: locId });
      }
      prevOpen = open;
    }
  }

  // 3) Assemble hour slots. Union arrival + departure location ids
  //    so a location with only departures (last hour an actor was
  //    there) still gets a row.
  const hourSlots: CalendarHourSlot[] = [];
  for (let h = 0; h < 24; h += 1) {
    const arrMap = arrivalsByHour.get(h)!;
    const depMap = departuresByHour.get(h)!;
    const locIds = new Set<number>([...arrMap.keys(), ...depMap.keys()]);
    const groups: LocationGroup[] = [];
    for (const locationId of locIds) {
      groups.push({
        locationId,
        arrivals: arrMap.get(locationId) ?? [],
        departures: depMap.get(locationId) ?? [],
      });
    }
    groups.sort((a, b) => {
      const an =
        dump.locations.find((l) => l.id === a.locationId)?.displayName ?? "";
      const bn =
        dump.locations.find((l) => l.id === b.locationId)?.displayName ?? "";
      return an.localeCompare(bn);
    });
    hourSlots.push({
      hour: h,
      locationGroups: groups,
      facts: factsByHour.get(h) ?? [],
    });
  }

  return { day, hourSlots };
}

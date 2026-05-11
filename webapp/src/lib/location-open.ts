import { isWeekend } from "./calendar.js";

/**
 * Location types that close at weekends in v1, matching the engine's
 * planner weekendModifier weights (auction and business both negative;
 * pub and home positive). Civic and street stay open. This is the
 * fallback heuristic only — when a location ships explicit
 * `openSessions` data, those win.
 */
const WEEKEND_CLOSED_TYPES = new Set(["auction", "business"]);

export interface OpenHours {
  readonly start: number;
  readonly end: number;
}

export interface OpenSession {
  readonly daysOfWeek: readonly number[];
  readonly start: number;
  readonly end: number;
}

export interface LocationOpenInfo {
  readonly openHours?: OpenHours | null;
  readonly openSessions?: readonly OpenSession[];
  readonly type?: string | undefined;
}

/** 1=Mon..7=Sun, from the run's day number (day 1 = Monday). */
function dayOfWeek(day: number): number {
  return ((day - 1) % 7) + 1;
}

function prevDayOfWeek(dow: number): number {
  return dow === 1 ? 7 : dow - 1;
}

/**
 * Is this session open at the given (day, hour)? A session covers
 * a set of weekdays and a half-open hour window [start, end). When
 * `end > 24` the window wraps past midnight into the next day; the
 * small-hours portion is attributed to the previous day's session
 * (so a Fri 19→02 club is open Sat 01:00 because Fri is in the
 * session's daysOfWeek, not Sat).
 */
function isSessionOpen(session: OpenSession, day: number, hour: number): boolean {
  const dow = dayOfWeek(day);
  const daySet = session.daysOfWeek;
  // Today's portion: hour within [start, min(end, 24)).
  if (daySet.includes(dow)) {
    const todayEnd = Math.min(session.end, 24);
    if (hour >= session.start && hour < todayEnd) return true;
  }
  // Wrap-over from yesterday's session: only if the session
  // extends past midnight.
  if (session.end > 24) {
    const yesterdayDow = prevDayOfWeek(dow);
    if (daySet.includes(yesterdayDow)) {
      if (hour < session.end - 24) return true;
    }
  }
  return false;
}

/**
 * Is a location open at the given day + hour? When `openSessions` is
 * present, it's the source of truth (the location is open if any
 * session matches). Otherwise falls back to the simple
 * `openHours` + type-based weekend heuristic — keeps behaviour
 * sensible for locations that haven't opted in to per-day scheduling.
 */
export function isLocationOpenAt(
  loc: LocationOpenInfo,
  day: number,
  hour: number,
): boolean {
  if (loc.openSessions !== undefined && loc.openSessions.length > 0) {
    for (const s of loc.openSessions) {
      if (isSessionOpen(s, day, hour)) return true;
    }
    return false;
  }
  // Fallback: type-based weekend heuristic + simple hour window.
  if (
    loc.type !== undefined &&
    WEEKEND_CLOSED_TYPES.has(loc.type) &&
    isWeekend(day)
  ) {
    return false;
  }
  const openHours = loc.openHours;
  if (openHours === null || openHours === undefined) return true;
  const { start, end } = openHours;
  if (end > 24) {
    // Wraps past midnight without day-of-week info: treat as the
    // union of [start, 24) and [0, end - 24).
    return hour >= start || hour < end - 24;
  }
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

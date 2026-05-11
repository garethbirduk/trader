import { isWeekend } from "./calendar.js";

/**
 * Location types that close at weekends in v1, matching the engine's
 * planner weekendModifier weights (auction and business both negative;
 * pub and home positive). Civic and street stay open.
 *
 * This is a viewer-side heuristic — the data model doesn't currently
 * carry per-location weekend hours, so we infer from `type`. If a
 * specific venue ever needs to override (e.g. a 24-hour corner shop),
 * add a `closedWeekends` field to the location dump and consult it
 * here in preference.
 */
const WEEKEND_CLOSED_TYPES = new Set(["auction", "business"]);

export interface OpenHours {
  readonly start: number;
  readonly end: number;
}

export interface LocationOpenInfo {
  readonly openHours?: OpenHours | null;
  readonly type?: string | undefined;
}

/**
 * Is a location open at the given day + hour? Considers both:
 *   • hour-of-day window (`openHours`), and
 *   • day-of-week (weekend closure inferred from `type`).
 *
 * Locations with no `openHours` are treated as 24-hour. The window is
 * half-open: [start, end). Windows that wrap past midnight (start >
 * end, e.g. a club open 22:00–02:00) are matched as the union of
 * [start, 24) and [0, end).
 */
export function isLocationOpenAt(
  loc: LocationOpenInfo,
  day: number,
  hour: number,
): boolean {
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
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

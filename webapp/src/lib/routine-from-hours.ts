/**
 * Derive an actor's routine spans from a venue's opening hours so the
 * editor can keep `actor.worksAt` and the venue's `openSessions` in
 * sync. Used by both the cast editor (when worksAt changes on an
 * actor) and the business-hours editor (when a venue's hours change
 * and we need to ripple to every actor that works there).
 *
 * The actor schedule schema is coarser than per-day openSessions —
 * it only supports weekday-versus-weekend split, not per-day variance.
 * So the derivation collapses sessions: the most common weekday
 * window becomes `schedule`; the most common weekend window becomes
 * `weekendSchedule`. Per-day differences within either half-week
 * are lost (e.g. a Mon-Thu venue with different Fri hours collapses
 * to the most common across Mon-Fri).
 */

export interface ScheduleSpan {
  readonly from: number;
  readonly to: number;
  readonly location: string;
}

export interface OpenSession {
  readonly daysOfWeek: readonly number[];
  readonly start: number;
  readonly end: number;
}

export interface VenueLike {
  readonly openSessions?: readonly OpenSession[];
  readonly openHours?: { readonly start: number; readonly end: number } | null;
  readonly openDaysOfWeek?: readonly number[];
}

export interface DerivedRoutine {
  /** Weekday spans (1=Mon..5=Fri). One entry pinning the actor to the
   *  venue for its open window — empty when the venue isn't open any
   *  weekday or has no hours defined. */
  readonly schedule: ScheduleSpan[];
  /** Weekend spans (Sat+Sun). Empty when the venue is weekday-only —
   *  meaning the actor is closed weekends and falls back to home. */
  readonly weekendSchedule: ScheduleSpan[];
}

function expandFromOpenHours(v: VenueLike): OpenSession[] {
  if (v.openHours === null || v.openHours === undefined) return [];
  const days = v.openDaysOfWeek ?? [1, 2, 3, 4, 5, 6, 7];
  return [{ daysOfWeek: days, start: v.openHours.start, end: v.openHours.end }];
}

interface Window {
  readonly start: number;
  readonly end: number;
}

function mostCommon(windows: readonly Window[]): Window | null {
  if (windows.length === 0) return null;
  const counts = new Map<string, { w: Window; n: number }>();
  for (const w of windows) {
    const k = `${w.start}|${w.end}`;
    const existing = counts.get(k);
    if (existing === undefined) counts.set(k, { w, n: 1 });
    else existing.n += 1;
  }
  let best: { w: Window; n: number } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.n > best.n) best = entry;
  }
  return best === null ? null : best.w;
}

export function deriveRoutineFromVenue(
  venueCode: string,
  venue: VenueLike,
): DerivedRoutine {
  const sessions: readonly OpenSession[] =
    venue.openSessions !== undefined && venue.openSessions.length > 0
      ? venue.openSessions
      : expandFromOpenHours(venue);

  const weekday: Window[] = [];
  const weekend: Window[] = [];
  for (const s of sessions) {
    let hasWeekday = false;
    let hasWeekend = false;
    for (const d of s.daysOfWeek) {
      if (d >= 1 && d <= 5) hasWeekday = true;
      if (d >= 6 && d <= 7) hasWeekend = true;
    }
    if (hasWeekday) weekday.push({ start: s.start, end: s.end });
    if (hasWeekend) weekend.push({ start: s.start, end: s.end });
  }

  const wd = mostCommon(weekday);
  const we = mostCommon(weekend);

  const schedule: ScheduleSpan[] = wd === null
    ? []
    : [{ from: wd.start, to: wd.end, location: venueCode }];
  const weekendSchedule: ScheduleSpan[] = we === null
    ? []
    : [{ from: we.start, to: we.end, location: venueCode }];

  return { schedule, weekendSchedule };
}

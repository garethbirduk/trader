/**
 * Day-of-week helpers for the UI. Kept in lockstep with the engine's
 * `src/engine/core/calendar.ts` (Day 1 = Monday, weeks repeat mod 7).
 */

const DAYS_LONG = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

export function dayOfWeekShort(day: number): string {
  return DAYS_LONG[(day - 1) % 7]!;
}

export function isWeekend(day: number): boolean {
  const d = (day - 1) % 7;
  return d === 5 || d === 6;
}

/** "D03 Wed" — compact label used by the time stepper, map overlay, diary headers. */
export function dayLabel(day: number): string {
  return `D${String(day).padStart(2, "0")} ${dayOfWeekShort(day)}`;
}

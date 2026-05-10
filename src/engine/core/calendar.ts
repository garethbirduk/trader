/**
 * Day-of-week helpers. Day 1 = Monday by convention; weeks repeat
 * mod 7 thereafter so a sim run never "runs out of week."
 *
 * Used by the actor planner (weekend modifiers) and skin schedules
 * (optional weekend overrides for fixed-job actors like Trigger and
 * Cassandra). The engine itself doesn't care about days of week
 * beyond what callers ask via these helpers.
 */

export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

const DAYS: readonly DayOfWeek[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

export function dayOfWeek(day: number): DayOfWeek {
  if (day < 1) throw new Error(`day must be >= 1; got ${day}`);
  return DAYS[(day - 1) % 7]!;
}

export function isWeekend(day: number): boolean {
  const d = dayOfWeek(day);
  return d === "sat" || d === "sun";
}

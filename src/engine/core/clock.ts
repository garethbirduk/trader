/**
 * In-game time. Days are 1-indexed; hours are 0..23. The engine clock runs
 * a full 24-hour day — what's "open" at any given hour is decided by
 * locations and NPC schedules, not the clock itself.
 */
export interface Clock {
  readonly day: number;
  readonly hour: number;
}

export interface MutableClock {
  day: number;
  hour: number;
}

export const HOURS_PER_DAY = 24;

export function makeClock(day: number, hour: number): Clock {
  if (!Number.isInteger(day) || day < 1) {
    throw new Error(`day must be a positive integer; got ${day}`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) {
    throw new Error(`hour must be in [0, ${HOURS_PER_DAY}); got ${hour}`);
  }
  return Object.freeze({ day, hour });
}

export function cloneClock(c: Clock): MutableClock {
  return { day: c.day, hour: c.hour };
}

export function freezeClock(c: MutableClock): Clock {
  return Object.freeze({ day: c.day, hour: c.hour });
}

/** Total hours elapsed since the start of day 1 hour 0. Useful for ordering. */
export function absoluteHour(c: Clock): number {
  return (c.day - 1) * HOURS_PER_DAY + c.hour;
}

/**
 * Mutate `c` forward by one hour. Returns whether the day rolled over.
 * Day rollover occurs when going from hour 23 to hour 0 of the next day.
 */
export function advanceOneHour(c: MutableClock): { rolledOverFromDay: number | null } {
  if (c.hour < HOURS_PER_DAY - 1) {
    c.hour += 1;
    return { rolledOverFromDay: null };
  }
  const previousDay = c.day;
  c.hour = 0;
  c.day += 1;
  return { rolledOverFromDay: previousDay };
}

/** "D03 09:00" — compact, sortable, debug-friendly. */
export function formatClock(c: Clock): string {
  const day = String(c.day).padStart(2, "0");
  const hour = String(c.hour).padStart(2, "0");
  return `D${day} ${hour}:00`;
}

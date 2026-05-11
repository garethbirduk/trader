/**
 * Is a location open at the given hour? Locations with no openHours
 * field are treated as 24-hour (always open) — e.g. homes, streets.
 * The window is half-open: [start, end). Locations whose hours
 * wrap past midnight (start > end, e.g. a club open 22:00–02:00)
 * are matched as the union of [start, 24) and [0, end).
 */
export function isLocationOpenAt(
  openHours: { start: number; end: number } | null | undefined,
  hour: number,
): boolean {
  if (openHours === null || openHours === undefined) return true;
  const { start, end } = openHours;
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

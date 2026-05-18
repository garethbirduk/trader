import { useMemo } from "react";
import type { RunDump } from "../types.js";

/**
 * Hour-precise actor positions. Replays the move event stream
 * (`actor.departed` / `actor.travelled`) up to (day, hour) over the
 * actors' initial positions and returns `Map<actorId, locationId>`.
 *
 * The snapshot's `currentLocationId` is daily — not hour-precise — so
 * any surface that wants to ask "who is at venue X at hour H?" must
 * use this hook instead of reading the snapshot directly.
 *
 * Performance: O(events). For a 1962-event 4-day run this is sub-ms;
 * memoised on (dump, day, hour) so it only re-runs when one of those
 * changes.
 */
export function useActorPositionsAt(
  dump: RunDump,
  day: number,
  hour: number,
): ReadonlyMap<number, number> {
  return useMemo(() => {
    const positions = new Map<number, number>();
    // Seed with initial positions from the actor records — `dump.actors`
    // captures where each actor stands at sim start (day 1 hour 0).
    for (const a of dump.actors) {
      if (a.currentLocationId !== null && a.currentLocationId !== undefined) {
        positions.set(a.id, a.currentLocationId);
      }
    }
    // Replay all moves up to (day, hour). We don't assume events are
    // strictly sorted — just filter by the at-stamp.
    for (const e of dump.events) {
      if (e.at.day > day) continue;
      if (e.at.day === day && e.at.hour > hour) continue;
      if (e.type !== "actor.departed" && e.type !== "actor.travelled") continue;
      const aid = e.actorId as number | undefined;
      const to = e.toLocationId as number | undefined;
      if (typeof aid !== "number" || typeof to !== "number") continue;
      positions.set(aid, to);
    }
    return positions;
  }, [dump, day, hour]);
}

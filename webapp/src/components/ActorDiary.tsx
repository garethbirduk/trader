import { useMemo } from "react";
import type { RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { LocationLink } from "./Links.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly onChangeDay: (d: number) => void;
  readonly onSelect: (s: Selection) => void;
}

interface DiaryHourEntry {
  readonly hour: number;
  readonly plannedLocationId: number | null;
  readonly arrivedLocationId: number | null;
  readonly events: readonly RunEvent[];
}

export function ActorDiary({
  dump,
  day,
  hour,
  actorId,
  onChangeDay,
  onSelect,
}: Props) {
  const actor = dump.actors.find((a) => a.id === actorId);
  if (actor === undefined) return null;

  const routine = dump.actorRoutines?.find((r) => r.actorId === actorId);
  const awake = routine?.awakeHours ?? { start: 6, end: 23 };
  const scheduleByHour = useMemo(() => {
    const m = new Map<number, number>();
    if (routine !== undefined)
      for (const e of routine.schedule) m.set(e.hour, e.locationId);
    return m;
  }, [routine]);

  // Diary is a turn-by-turn replay — only events at-or-before the
  // cursor hour have "happened" yet.
  const dayEvents = useMemo(
    () =>
      dump.events.filter((e) => e.at.day === day && e.at.hour <= hour),
    [dump, day, hour],
  );

  const entries = useMemo<DiaryHourEntry[]>(() => {
    const rows: DiaryHourEntry[] = [];
    for (let h = awake.start; h <= awake.end; h += 1) {
      const planned = scheduleByHour.get(h) ?? null;
      const eventsThisHour = dayEvents.filter(
        (e) => e.at.hour === h && eventInvolvesActor(e, actorId),
      );
      const travel = eventsThisHour.find(
        (e) => e.type === "actor.travelled" && (e.actorId as number) === actorId,
      );
      const arrived = travel
        ? (travel.toLocationId as number) ?? null
        : null;
      rows.push({
        hour: h,
        plannedLocationId: planned,
        arrivedLocationId: arrived,
        events: eventsThisHour,
      });
    }
    return rows;
  }, [awake.start, awake.end, scheduleByHour, dayEvents, actorId]);

  return (
    <section className="diary">
      <header className="diary-nav">
        <button onClick={() => onChangeDay(day - 1)} disabled={day <= 1} title="prev day">‹</button>
        <span className="diary-day">Day {day} · {actor.displayName}</span>
        <button
          onClick={() => onChangeDay(day + 1)}
          disabled={day >= dump.runLengthDays}
          title="next day"
        >›</button>
      </header>
      <div className="diary-hours">
        {entries.map((row) => {
          const isCurrent = row.hour === hour;
          const showArrival =
            row.arrivedLocationId !== null &&
            row.arrivedLocationId !== row.plannedLocationId;
          return (
            <div
              key={row.hour}
              className={`diary-row ${isCurrent ? "diary-row-now" : ""}`}
            >
              <span className="diary-hour">
                {String(row.hour).padStart(2, "0")}:00
              </span>
              <span className="diary-loc">
                {showArrival ? <span className="muted">→ </span> : null}
                {(showArrival ? row.arrivedLocationId : row.plannedLocationId) !== null ? (
                  <LocationLink
                    dump={dump}
                    locationId={(showArrival ? row.arrivedLocationId : row.plannedLocationId)!}
                    onSelect={onSelect}
                  />
                ) : (
                  <span className="muted">—</span>
                )}
              </span>
              {row.events.length > 0 ? (
                <div className="diary-events">
                  {row.events.map((e, i) => (
                    <div key={i} className={`diary-event diary-event-${e.type.replace(/\./g, "-")}`}>
                      <span className="muted">{e.type}</span>{" "}
                      <span>{summarizeEvent(e, dump, actorId)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function eventInvolvesActor(e: RunEvent, actorId: number): boolean {
  const idFields = [
    "actorId",
    "buyerActorId",
    "sellerActorId",
    "winnerActorId",
    "visitorActorId",
    "proprietorActorId",
  ] as const;
  for (const f of idFields) {
    if ((e as Record<string, unknown>)[f] === actorId) return true;
  }
  return false;
}

function summarizeEvent(
  e: RunEvent,
  dump: RunDump,
  actorId: number,
): string {
  const actorName = (id: unknown) =>
    typeof id === "number"
      ? dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`
      : "?";
  const locName = (id: unknown) =>
    typeof id === "number"
      ? dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`
      : "?";
  const itemName = (id: unknown) =>
    typeof id === "number"
      ? dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`
      : "?";

  switch (e.type) {
    case "actor.travelled":
      return `→ ${locName(e.toLocationId)}`;
    case "pool.claimed":
      return `claimed ${e.quantity} units @ £${e.unitPrice} from pool ${e.poolId}`;
    case "auction.cleared":
      return e.winnerActorId === actorId
        ? `won lot ${e.auctionLotId} for £${e.totalPrice}`
        : `lot ${e.auctionLotId} sold`;
    case "deal.settled":
      return e.sellerActorId === actorId
        ? `sold to ${actorName(e.buyerActorId)} for £${e.totalPrice}`
        : `bought from ${actorName(e.sellerActorId)} for £${e.totalPrice}`;
    case "deal.defaulted":
      return `defaulted with ${actorName(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)} — ${e.reason}`;
    case "delivery.fee":
      return `paid £${e.fee} delivery for deal ${e.dealId}`;
    case "settlement.lead-claim":
      return `sourced ${e.quantity} @ £${e.unitPrice} from pool ${e.poolId}`;
    case "pubdeal.attempted":
      return `pubdeal vs ${actorName(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)}${typeof e.itemKindId === "number" ? ` — ${itemName(e.itemKindId)} ×${e.quantity}` : ` ×${e.quantity}`}`;
    case "pubdeal.agreed":
      return `agreed deal ${e.dealId} ×${e.quantity} @ £${e.unitPrice}`;
    case "pubdeal.walked":
      return `walked away — ${e.reason}`;
    case "pubdeal.skipped-low-trust":
      return `wouldn't deal (trust ${e.trustScore})`;
    case "gossip.exchanged":
      return `gossip with ${actorName(e.proprietorActorId === actorId ? e.visitorActorId : e.proprietorActorId)} at ${locName(e.atLocationId)}`;
    case "heat.raised":
      return `+${e.delta} heat → ${e.score} (${e.reason})`;
    case "authority.raid":
      return `🚨 raid — £${e.fine} fine, ${e.unitsSeized} units seized`;
    default:
      return "";
  }
}

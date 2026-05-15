import { useMemo } from "react";
import type { RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { LocationLink } from "./Links.js";
import { ActorRef, DealRef, ItemRef, LocationRef, LotRef, PoolRef } from "./Refs.js";
import { dayLabel, isWeekend } from "../lib/calendar.js";

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
  // Pick the schedule that matches the displayed day-of-week. Weekend
  // schedules are optional — when an actor doesn't ship one, the
  // weekday schedule applies all week (legacy behaviour).
  const scheduleByHour = useMemo(() => {
    const m = new Map<number, number>();
    if (routine !== undefined) {
      const useWeekend =
        isWeekend(day) && routine.weekendSchedule !== undefined;
      const src = useWeekend ? routine.weekendSchedule! : routine.schedule;
      for (const e of src) m.set(e.hour, e.locationId);
    }
    return m;
  }, [routine, day]);

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
        <span className="diary-day">{dayLabel(day)} · {actor.displayName}</span>
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
                      <span>{summarizeEvent(e, dump, actorId, onSelect)}</span>
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
    "holderActorId",
    "subjectTargetActorId",
    "brokerActorId",
    "producerActorId",
    "blockerActorId",
    "ownerActorId",
  ] as const;
  for (const f of idFields) {
    if ((e as Record<string, unknown>)[f] === actorId) return true;
  }
  // gossip.exchanged carries its participants as an array. A gossip
  // event involves the focal actor if their id is listed.
  const participants = (e as { participantActorIds?: readonly number[] })
    .participantActorIds;
  if (participants !== undefined && participants.includes(actorId)) return true;
  return false;
}

function summarizeEvent(
  e: RunEvent,
  dump: RunDump,
  actorId: number,
  onSelect: (s: Selection) => void,
): JSX.Element {
  const A = (id: unknown) =>
    typeof id === "number" ? (
      <ActorRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
    ) : (
      <span className="muted">?</span>
    );
  const L = (id: unknown) =>
    typeof id === "number" ? (
      <LocationRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
    ) : (
      <span className="muted">?</span>
    );
  const I = (id: unknown) =>
    typeof id === "number" ? (
      <ItemRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">?</span>
    );
  const Lot = (id: unknown) =>
    typeof id === "number" ? (
      <LotRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">lot ?</span>
    );
  const Deal = (id: unknown) =>
    typeof id === "number" ? (
      <DealRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">deal ?</span>
    );
  const Pool = (id: unknown) =>
    typeof id === "number" ? (
      <PoolRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">pool ?</span>
    );

  switch (e.type) {
    case "actor.travelled":
      return <>→ {L(e.toLocationId)}</>;
    case "pool.claimed":
      return (
        <>
          claimed {String(e.quantity)} units @ £{String(e.unitPrice)} from {Pool(e.poolId)}
        </>
      );
    case "auction.cleared":
      return e.winnerActorId === actorId ? (
        <>
          won {Lot(e.auctionLotId)} for £{String(e.totalPrice)}
        </>
      ) : (
        <>{Lot(e.auctionLotId)} sold</>
      );
    case "deal.settled":
      return e.sellerActorId === actorId ? (
        <>
          sold to {A(e.buyerActorId)} for £{String(e.totalPrice)}
        </>
      ) : (
        <>
          bought from {A(e.sellerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "deal.defaulted":
      return (
        <>
          defaulted with {A(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)} — {String(e.reason)}
        </>
      );
    case "delivery.fee":
      return (
        <>
          paid £{String(e.fee)} delivery for {Deal(e.dealId)}
        </>
      );
    case "settlement.lead-claim":
      return (
        <>
          sourced {String(e.quantity)} @ £{String(e.unitPrice)} from {Pool(e.poolId)}
        </>
      );
    case "pubdeal.attempted":
      return (
        <>
          pubdeal vs {A(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)}
          {typeof e.itemKindId === "number" ? (
            <>
              {" — "}
              {I(e.itemKindId)} ×{String(e.quantity)}
            </>
          ) : (
            <> ×{String(e.quantity)}</>
          )}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          agreed {Deal(e.dealId)} ×{String(e.quantity)} @ £{String(e.unitPrice)}
        </>
      );
    case "pubdeal.walked":
      return <>walked away — {String(e.reason)}</>;
    case "pubdeal.skipped-low-trust":
      return <>wouldn't deal (trust {String(e.trustScore)})</>;
    case "pubdeal.skipped-rep":
      return (
        <>
          wouldn't deal with {A(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)}{" "}
          <span className="muted">
            (rep — hop {String(e.hopCount)}, £{String(e.damageOnLead)})
          </span>
        </>
      );
    case "pubdeal.skipped-too-small":
      return (
        <>
          didn't bother haggling with{" "}
          {A(e.sellerActorId === actorId ? e.buyerActorId : e.sellerActorId)}{" "}
          <span className="muted">— too small (floor £{String(e.floor)})</span>
        </>
      );
    case "rep.spawned":
      return e.holderActorId === actorId ? (
        <>
          got burned by {A(e.subjectTargetActorId)} for £{String(e.damage)}
        </>
      ) : e.subjectTargetActorId === actorId ? (
        <>
          burned {A(e.holderActorId)} for £{String(e.damage)}
        </>
      ) : (
        <></>
      );
    case "broker.materialised":
      return e.brokerActorId === actorId ? (
        <>
          brought {A(e.producerActorId)} in to {L(e.locationId)}{" "}
          <span className="muted">(fee £{String(e.fee)})</span>
        </>
      ) : e.producerActorId === actorId ? (
        <>
          walked into {L(e.locationId)} on {A(e.brokerActorId)}'s arrangement
        </>
      ) : (
        <>
          {A(e.brokerActorId)} brought {A(e.producerActorId)} in
        </>
      );
    case "broker.materialisation-aborted":
      return e.brokerActorId === actorId ? (
        <>
          {A(e.producerActorId)} clocked {A(e.blockerActorId)} and walked
        </>
      ) : e.producerActorId === actorId ? (
        <>
          spotted {A(e.blockerActorId)} at {L(e.locationId)} and left
        </>
      ) : e.blockerActorId === actorId ? (
        <>
          {A(e.producerActorId)} clocked you and turned around
        </>
      ) : (
        <></>
      );
    case "payout.released":
      return (
        <>
          received £{String(e.amount)}{" "}
          <span className="muted">
            ({String(e.source)} from D{String(e.originatedDay)})
          </span>
        </>
      );
    case "stock.written-off":
      return e.ownerActorId === actorId ? (
        <>
          skipped {String(e.quantity)}× {I(e.itemKindId)}{" "}
          <span className="muted">
            ({String(e.qualityTier)} · fee £{String(e.feePaid)})
          </span>
        </>
      ) : (
        <></>
      );
    case "gossip.exchanged": {
      const others = (e.participantActorIds as readonly number[]).filter(
        (id) => id !== actorId,
      );
      const otherId = others[0];
      const kind = e.kind as "proprietor" | "chat" | "deal" | "clarification";
      const verb =
        kind === "chat"
          ? "chatted"
          : kind === "deal"
            ? "haggle gossip"
            : kind === "clarification"
              ? "asked about"
              : "gossip";
      return (
        <>
          {verb} with {otherId !== undefined ? A(otherId) : <span className="muted">?</span>} at {L(e.atLocationId)}
        </>
      );
    }
    case "heat.raised":
      return (
        <>
          +{String(e.delta)} heat → {String(e.score)} ({String(e.reason)})
        </>
      );
    case "authority.raid":
      return (
        <>
          🚨 raid — £{String(e.fine)} fine, {String(e.unitsSeized)} units seized
        </>
      );
    case "auction.knowledge-acquired":
      return (
        <>
          learned about {Lot(e.auctionLotId)}{" "}
          <span className="muted">via {String(e.via)}</span>
          {typeof e.fromActorId === "number" ? (
            <>
              {" "}
              <span className="muted">from</span> {A(e.fromActorId)}
            </>
          ) : null}
        </>
      );
    case "auction.lot-inspected":
      return <>inspected {Lot(e.auctionLotId)}</>;
    case "market.hour-summary":
      return (
        <>
          sold {String(e.unitsSold)}× {I(e.itemKindId)} @ £{String(e.pricePerUnit)}/u
          {" "}<span className="muted">(rev £{String(e.revenue)})</span>
        </>
      );
    case "actor.planned":
      return (
        <>
          plans {String(e.kind)} for{" "}
          {String(e.targetHour).padStart(2, "0")}:00
        </>
      );
    case "actor.notebook-row-added":
    case "actor.notebook-row-updated": {
      const verb = e.type === "actor.notebook-row-added" ? "noted" : "updated note";
      const side = e.side === "sell" ? "wants" : "has";
      const score =
        typeof e.score === "number" ? (
          <>
            {" · "}
            <strong className={(e.score as number) > 0 ? "" : "warn"}>
              gross £{String(e.score)}
            </strong>
          </>
        ) : null;
      const exploit = e.counterpartyExploitable ? (
        <span title="Counterparty has a category blind spot">{" ⚠"}</span>
      ) : null;
      const locked = e.unlocked === false ? (
        <span className="muted"> · headline only</span>
      ) : null;
      return (
        <>
          {verb}: {A(e.counterpartyActorId)} {side} {I(e.itemKindId)}
          {score}
          {exploit}
          {locked}
        </>
      );
    }
    case "actor.notebook-row-removed":
      return (
        <span className="muted">
          dropped note: {A(e.counterpartyActorId)}{" "}
          {e.side === "sell" ? "wants" : "has"} {I(e.itemKindId)}
        </span>
      );
    default:
      return <></>;
  }
}

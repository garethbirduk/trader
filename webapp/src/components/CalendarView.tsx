import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { usePov } from "../lib/pov.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { dayLabel } from "../lib/calendar.js";
import {
  buildCalendarDay,
  type CalendarFact,
  type LocationGroup,
} from "../lib/calendar-data.js";
import { ActorRef, LocationRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly onChangeDay: (d: number) => void;
  readonly onSelect: (s: Selection) => void;
}

export function CalendarView({
  dump,
  day,
  hour,
  snapshot,
  onChangeDay,
  onSelect,
}: Props) {
  const { pov } = usePov();
  const povActorId = pov.kind === "actor" ? pov.actorId : null;
  const set = useSelectionSet();

  const agenda = useMemo(
    () =>
      buildCalendarDay({
        dump,
        day,
        snapshot,
        povActorId,
        selectionSet: set.items,
      }),
    [dump, day, snapshot, povActorId, set.items],
  );

  const prevDisabled = day <= 1;
  const nextDisabled = day >= dump.runLengthDays;
  const isEmpty = set.items.length === 0;

  return (
    <section className="calendar">
      <header className="calendar-nav">
        <button
          type="button"
          onClick={() => onChangeDay(day - 1)}
          disabled={prevDisabled}
          title="prev day"
        >
          ‹
        </button>
        <span className="calendar-day-label">{dayLabel(day)}</span>
        <button
          type="button"
          onClick={() => onChangeDay(day + 1)}
          disabled={nextDisabled}
          title="next day"
        >
          ›
        </button>
      </header>
      {isEmpty ? (
        <div className="calendar-empty muted">
          Nothing selected. Click chips in the LHS (Actors · Locations · Stock)
          to populate the calendar.
        </div>
      ) : null}
      <ol className="calendar-hours">
        {agenda.hourSlots.map((slot) => {
          const empty =
            slot.locationGroups.length === 0 && slot.facts.length === 0;
          const current = slot.hour === hour;
          return (
            <li
              key={slot.hour}
              className={`cal-hour ${empty ? "cal-hour-empty" : ""} ${current ? "cal-hour-current" : ""}`}
            >
              <span className="cal-hour-label">
                {String(slot.hour).padStart(2, "0")}:00
              </span>
              <div className="cal-hour-body">
                {slot.facts.map((fact, i) => (
                  <FactRow
                    key={`f-${i}`}
                    fact={fact}
                    dump={dump}
                    povActorId={povActorId}
                    onSelect={onSelect}
                  />
                ))}
                {slot.locationGroups.map((g) => (
                  <LocationGroupRow
                    key={`g-${g.locationId}`}
                    group={g}
                    dump={dump}
                    povActorId={povActorId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LocationGroupRow({
  group,
  dump,
  povActorId,
  onSelect,
}: {
  group: LocationGroup;
  dump: RunDump;
  povActorId: number | null;
  onSelect: (s: Selection) => void;
}) {
  return (
    <div className="cal-loc-group">
      <LocationRef
        dump={dump}
        id={group.locationId}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
      <div className="cal-arrivals">
        {group.arrivals.map((a) => {
          // In POV mode the POV's own chip is implicit. Admin shows all.
          if (povActorId !== null && a.actorId === povActorId) return null;
          return (
            <span key={a.actorId} className="cal-arrival" title={`until ${String(a.untilHour).padStart(2, "0")}:00`}>
              <ActorRef
                dump={dump}
                id={a.actorId}
                onSelect={onSelect}
                variant="avatar"
                size={14}
              />
              <span className="cal-arrival-until muted">→{String(a.untilHour).padStart(2, "0")}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function FactRow({
  fact,
  dump,
  povActorId,
  onSelect,
}: {
  fact: CalendarFact;
  dump: RunDump;
  povActorId: number | null;
  onSelect: (s: Selection) => void;
}) {
  if (fact.kind === "location-open" || fact.kind === "location-close") {
    return (
      <div className={`cal-fact cal-fact-${fact.kind}`}>
        <span className="cal-fact-label">
          {fact.kind === "location-open" ? "opens" : "closes"}
        </span>
        <LocationRef
          dump={dump}
          id={fact.locationId}
          onSelect={onSelect}
          variant="chip"
          size={14}
        />
      </div>
    );
  }
  const knowers = fact.knowerActorIds.filter((id) => id !== povActorId);
  if (fact.kind === "auction-lot") {
    const lot = dump.snapshots
      ?.flatMap((s) => s.auctionLots)
      .find((l) => l.id === fact.lotId);
    const item = lot ? dump.items.find((i) => i.id === lot.itemKindId) : null;
    return (
      <div className="cal-fact cal-fact-auction">
        <span className="cal-fact-label">auction lot</span>
        <span className="cal-fact-name">
          {item?.displayName ?? `lot #${fact.lotId}`}
          {lot ? ` × ${lot.quantity}` : ""}
        </span>
        <KnowerChips
          actorIds={knowers}
          dump={dump}
          onSelect={onSelect}
        />
      </div>
    );
  }
  // deal-deadline
  return (
    <div className="cal-fact cal-fact-deal">
      <span className="cal-fact-label">deal deadline</span>
      <span className="cal-fact-name">#{fact.dealId}</span>
      <KnowerChips actorIds={knowers} dump={dump} onSelect={onSelect} />
    </div>
  );
}

function KnowerChips({
  actorIds,
  dump,
  onSelect,
}: {
  actorIds: readonly number[];
  dump: RunDump;
  onSelect: (s: Selection) => void;
}) {
  if (actorIds.length === 0) return null;
  return (
    <span className="cal-knowers">
      {actorIds.map((id) => (
        <ActorRef
          key={id}
          dump={dump}
          id={id}
          onSelect={onSelect}
          variant="avatar"
          size={12}
        />
      ))}
    </span>
  );
}

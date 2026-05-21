import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { usePov } from "../lib/pov.js";
import { useKnownIds } from "../lib/pov-knowledge.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { dayLabel } from "../lib/calendar.js";
import {
  buildCalendarDay,
  type CalendarFact,
  type LocationGroup,
} from "../lib/calendar-data.js";
import { LocationRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { BeliefChip } from "./BeliefChip.js";

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

  // POV-knowledge filter: actor POV only sees movements of actors they
  // know about (household, dealer fraternity, gossip partners, …).
  // Admin POV bypasses the filter. The hook needs an id unconditionally,
  // so use a 0 sentinel in admin mode and discard the result.
  const known = useKnownIds(dump, povActorId ?? 0, day, hour);
  const knownActorIds = povActorId === null ? null : known.actors;

  const agenda = useMemo(
    () =>
      buildCalendarDay({
        dump,
        day,
        snapshot,
        povActorId,
        knownActorIds,
        selectionSet: set.items,
      }),
    [dump, day, snapshot, povActorId, knownActorIds, set.items],
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
  // In POV mode the POV's own chip is implicit (they always know where
  // they are). Admin shows all.
  const arrivals = group.arrivals.filter(
    (a) => povActorId === null || a.actorId !== povActorId,
  );
  const departures = group.departures.filter(
    (d) => povActorId === null || d.actorId !== povActorId,
  );
  if (arrivals.length === 0 && departures.length === 0) return null;
  return (
    <div className="cal-loc-group">
      <LocationRef
        dump={dump}
        id={group.locationId}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
      <div className="cal-movements">
        {arrivals.length > 0 ? (
          <div className="cal-arrivals" title="arrivals">
            <span className="cal-move-arrow" aria-label="arriving">→</span>
            {arrivals.map((a) => (
              <ActorChipById
                key={a.actorId}
                dump={dump}
                actorId={a.actorId}
                onSelect={onSelect}
                size={14}
                title={`until ${String(a.untilHour).padStart(2, "0")}:00`}
              />
            ))}
          </div>
        ) : null}
        {departures.length > 0 ? (
          <div className="cal-departures" title="departures">
            <span className="cal-move-arrow" aria-label="leaving">←</span>
            {departures.map((d) => (
              <ActorChipById
                key={d.actorId}
                dump={dump}
                actorId={d.actorId}
                onSelect={onSelect}
                size={14}
              />
            ))}
          </div>
        ) : null}
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
    return (
      <div className="cal-fact cal-fact-auction">
        <span className="cal-fact-label">auction lot</span>
        {lot !== undefined ? (
          <BeliefChip
            dump={dump}
            itemKindId={lot.itemKindId}
            qualityTier={lot.qualityTier}
            quantity={lot.quantity}
            observerActorId={povActorId}
            onSelect={onSelect}
          />
        ) : (
          <span className="muted">lot #{fact.lotId}</span>
        )}
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
        <ActorChipById
          key={id}
          dump={dump}
          actorId={id}
          onSelect={onSelect}
          size={12}
        />
      ))}
    </span>
  );
}

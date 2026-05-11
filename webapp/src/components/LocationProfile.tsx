import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly locationId: number;
  readonly onSelect: (s: Selection) => void;
}

export function LocationProfile({ dump, day, snapshot, locationId, onSelect }: Props) {
  const loc = dump.locations.find((l) => l.id === locationId);
  if (loc === undefined) return null;

  const hereIds = useMemo<readonly number[]>(() => {
    if (snapshot === null) return [];
    return snapshot.actors
      .filter((a) => a.currentLocationId === locationId)
      .map((sa) => sa.id);
  }, [snapshot, locationId]);

  // Residents = actors whose home is this location.
  const residents = useMemo(
    () =>
      dump.actors.filter((a) => a.homeLocationId === locationId),
    [dump, locationId],
  );

  // Stock in this location (snapshot only).
  const stockSummary = useMemo(() => {
    if (snapshot === null) return null;
    const lots = snapshot.stockLots.filter((l) => l.locationId === locationId);
    const units = lots.reduce((s, l) => s + l.quantity, 0);
    const value = lots.reduce(
      (s, l) => s + l.quantity * l.acquiredUnitPrice,
      0,
    );
    return { lotCount: lots.length, units, value };
  }, [snapshot, locationId]);

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">📍</div>
        <div className="profile-title">
          <div className="profile-name">{loc.displayName}</div>
          <div className="profile-code muted">{loc.code}</div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Now (D{day})</dt>
        <dd>{hereIds.length === 0 ? <span className="muted">empty</span> : `${hereIds.length} here`}</dd>
        {stockSummary !== null ? (
          <>
            <dt>Stock</dt>
            <dd>
              {stockSummary.units === 0 ? (
                <span className="muted">—</span>
              ) : (
                <>
                  {stockSummary.units} units{" "}
                  <span className="muted">({stockSummary.lotCount} lot{stockSummary.lotCount === 1 ? "" : "s"} · £{stockSummary.value})</span>
                </>
              )}
            </dd>
          </>
        ) : null}
        <dt>Residents</dt>
        <dd>{residents.length === 0 ? <span className="muted">—</span> : residents.length}</dd>
      </dl>
      {residents.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Lives here</div>
          {residents.map((r) => (
            <div key={r.id} className="loc-person-row">
              <ActorRef
                dump={dump}
                id={r.id}
                onSelect={onSelect}
                variant="chip"
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
      {hereIds.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Here right now</div>
          {hereIds.map((id) => (
            <div key={id} className="loc-person-row">
              <ActorRef
                dump={dump}
                id={id}
                onSelect={onSelect}
                variant="chip"
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

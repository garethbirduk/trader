import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, ItemRef, LocationRef, PoolRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly lotId: number;
  readonly onSelect: (s: Selection) => void;
}

export function LotProfile({ dump, day, snapshot, lotId, onSelect }: Props) {
  void day;
  const lot = useMemo(() => {
    if (snapshot !== null) {
      const here = snapshot.auctionLots.find((l) => l.id === lotId);
      if (here !== undefined) return here;
    }
    for (let i = (dump.snapshots?.length ?? 0) - 1; i >= 0; i -= 1) {
      const s = dump.snapshots![i]!;
      const found = s.auctionLots.find((l) => l.id === lotId);
      if (found !== undefined) return found;
    }
    return null;
  }, [snapshot, dump.snapshots, lotId]);

  if (lot === null) {
    return <div className="empty-state">lot {lotId} not found</div>;
  }

  const auctionLocId = dump.auctionLocationId;
  const cleared = lot.clearedDay !== null;

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">🔨</div>
        <div className="profile-title">
          <div className="profile-name">lot {lot.id}</div>
          <div className="profile-code muted">
            {cleared ? `cleared D${lot.clearedDay}` : "open"}
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Item</dt>
        <dd>
          <ItemRef
            dump={dump}
            id={lot.itemKindId}
            onSelect={onSelect}
            variant="chip"
            qualityTier={lot.qualityTier}
          />
          <span className="muted"> ×{lot.quantity}</span>
        </dd>
        <dt>Floor</dt>
        <dd>£{lot.floorPrice}</dd>
        <dt>Listed</dt>
        <dd>D{lot.listedDay}</dd>
        {lot.scheduledHour !== undefined && lot.scheduledHour !== null ? (
          <>
            <dt>On the block</dt>
            <dd>{String(lot.scheduledHour).padStart(2, "0")}:00</dd>
          </>
        ) : null}
        {auctionLocId !== undefined ? (
          <>
            <dt>Where</dt>
            <dd>
              <LocationRef
                dump={dump}
                id={auctionLocId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : null}
        {lot.sourcePoolId !== null ? (
          <>
            <dt>Source</dt>
            <dd>
              <PoolRef
                dump={dump}
                id={lot.sourcePoolId}
                onSelect={onSelect}
                variant="chip"
              />
            </dd>
          </>
        ) : (lot.provenance ?? null) !== null ? (
          <>
            <dt>Source</dt>
            <dd>
              <span className="badge badge-virtual">regional clearance</span>
            </dd>
          </>
        ) : null}
        {lot.provenance ? (
          <>
            <dt>Provenance</dt>
            <dd className="muted">"{lot.provenance}"</dd>
          </>
        ) : null}
        {cleared && lot.clearedPrice !== null ? (
          <>
            <dt>Cleared</dt>
            <dd>£{lot.clearedPrice}</dd>
          </>
        ) : null}
        {lot.clearedToActorId !== null ? (
          <>
            <dt>Winner</dt>
            <dd>
              <ActorRef
                dump={dump}
                id={lot.clearedToActorId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : cleared ? (
          <>
            <dt>Outcome</dt>
            <dd className="muted">unsold</dd>
          </>
        ) : null}
      </dl>
      {snapshot !== null ? (
        <KnowledgeSummary
          dump={dump}
          snapshot={snapshot}
          lotId={lot.id}
          onSelect={onSelect}
        />
      ) : null}
    </section>
  );
}

function KnowledgeSummary({
  dump,
  snapshot,
  lotId,
  onSelect,
}: {
  dump: RunDump;
  snapshot: DaySnapshot;
  lotId: number;
  onSelect: (s: Selection) => void;
}) {
  const knowers: number[] = [];
  const inspectors: number[] = [];
  for (const a of snapshot.actors) {
    if ((a.knownAuctionLotIds ?? []).includes(lotId)) knowers.push(a.id);
    if ((a.inspectedAuctionLotIds ?? []).includes(lotId)) inspectors.push(a.id);
  }
  if (knowers.length === 0 && inspectors.length === 0) return null;
  return (
    <>
      {knowers.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">
            Knows about ({knowers.length})
          </div>
          {knowers.map((aid) => (
            <div key={aid} className="loc-person-row">
              <ActorRef
                dump={dump}
                id={aid}
                onSelect={onSelect}
                variant="chip"
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
      {inspectors.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">
            Inspected ({inspectors.length})
          </div>
          {inspectors.map((aid) => (
            <div key={aid} className="loc-person-row">
              <ActorRef
                dump={dump}
                id={aid}
                onSelect={onSelect}
                variant="chip"
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

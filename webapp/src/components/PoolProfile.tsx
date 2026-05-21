import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ItemRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly poolId: number;
  readonly onSelect: (s: Selection) => void;
}

export function PoolProfile({ dump, day, snapshot, poolId, onSelect }: Props) {
  const pool = useMemo(() => {
    if (snapshot !== null) {
      const here = snapshot.pools.find((p) => p.id === poolId);
      if (here !== undefined) return here;
    }
    for (let i = (dump.snapshots?.length ?? 0) - 1; i >= 0; i -= 1) {
      const s = dump.snapshots![i]!;
      const found = s.pools.find((p) => p.id === poolId);
      if (found !== undefined) return found;
    }
    return null;
  }, [snapshot, dump.snapshots, poolId]);

  if (pool === null) {
    return <div className="empty-state">pool {poolId} not found</div>;
  }

  const isFlushed = pool.flushedDay !== null;
  const isExpired = !isFlushed && pool.expiryDay < day;
  const lifeSpan = pool.expiryDay - pool.createdDay;
  const dayInLife = Math.max(0, Math.min(lifeSpan, day - pool.createdDay));
  const t = lifeSpan === 0 ? 1 : dayInLife / lifeSpan;
  const currentUnitPrice = Math.round(
    pool.openingUnitPrice + (pool.closingUnitPrice - pool.openingUnitPrice) * t,
  );

  const status = isFlushed
    ? `flushed D${pool.flushedDay} → ${pool.dumpDestination}`
    : isExpired
      ? "expired"
      : "live";

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">≋</div>
        <div className="profile-title">
          <div className="profile-name">pool {pool.id}</div>
          <div className="profile-code muted">{status}</div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Item</dt>
        <dd>
          <ItemRef
            dump={dump}
            id={pool.itemKindId}
            onSelect={onSelect}
            variant="chip"
            qualityTier={pool.qualityTier}
          />
        </dd>
        <dt>Remaining</dt>
        <dd>{pool.quantityRemaining}</dd>
        <dt>Created</dt>
        <dd>D{pool.createdDay} @ £{pool.openingUnitPrice}</dd>
        <dt>Expires</dt>
        <dd>D{pool.expiryDay} @ £{pool.closingUnitPrice}</dd>
        {!isFlushed && !isExpired ? (
          <>
            <dt>Today</dt>
            <dd>≈ £{currentUnitPrice}/u</dd>
          </>
        ) : null}
        {pool.ownerActorId !== null && pool.ownerActorId !== undefined ? (
          <>
            <dt>Source</dt>
            <dd>
              <ActorChipById
                dump={dump}
                actorId={pool.ownerActorId}
                onSelect={onSelect}
                size={16}
              />
            </dd>
          </>
        ) : null}
        {pool.provenance ? (
          <>
            <dt>Provenance</dt>
            <dd className="muted">"{pool.provenance}"</dd>
          </>
        ) : null}
      </dl>
      {pool.reachableBy.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">
            {pool.ownerActorId !== null && pool.ownerActorId !== undefined
              ? "Brokered by"
              : "Reachable by"}
          </div>
          {pool.reachableBy.map((aid) => (
            <div key={aid} className="loc-person-row">
              <ActorChipById
                dump={dump}
                actorId={aid}
                onSelect={onSelect}
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

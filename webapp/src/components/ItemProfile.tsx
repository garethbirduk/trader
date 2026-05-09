import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly itemId: number;
  readonly onSelect: (s: Selection) => void;
}

export function ItemProfile({ dump, day, snapshot, itemId, onSelect }: Props) {
  const item = dump.items.find((i) => i.id === itemId);

  const stockSummary = useMemo(() => {
    if (snapshot === null || item === undefined) return null;
    const lots = snapshot.stockLots.filter((l) => l.itemKindId === itemId);
    const units = lots.reduce((s, l) => s + l.quantity, 0);
    const owners = new Set(lots.map((l) => l.ownerActorId));
    const byTier = new Map<string, number>();
    for (const l of lots) {
      byTier.set(l.qualityTier, (byTier.get(l.qualityTier) ?? 0) + l.quantity);
    }
    return { units, owners: [...owners], byTier };
  }, [snapshot, itemId, item]);

  const livePools = useMemo(() => {
    if (snapshot === null || item === undefined) return [];
    return snapshot.pools.filter(
      (p) =>
        p.itemKindId === itemId &&
        p.flushedDay === null &&
        p.expiryDay >= day &&
        p.createdDay <= day,
    );
  }, [snapshot, itemId, item, day]);

  if (item === undefined) {
    return <div className="empty-state">item {itemId} not found</div>;
  }

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">◆</div>
        <div className="profile-title">
          <div className="profile-name">{item.displayName}</div>
          <div className="profile-code muted">
            {item.code} · {item.category}
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Base value</dt>
        <dd>£{item.baseValue}</dd>
        <dt>Risk</dt>
        <dd className={item.risk > 0 ? "warn" : "muted"}>
          {item.risk > 0 ? `🔥 ${item.risk}` : "—"}
        </dd>
        {item.flawType !== null ? (
          <>
            <dt>Flaw</dt>
            <dd>{item.flawType}</dd>
          </>
        ) : null}
        {item.isEasterEgg ? (
          <>
            <dt>Tag</dt>
            <dd className="muted">easter egg</dd>
          </>
        ) : null}
        {stockSummary !== null ? (
          <>
            <dt>In stock</dt>
            <dd>
              {stockSummary.units === 0 ? (
                <span className="muted">—</span>
              ) : (
                <>
                  {stockSummary.units} units{" "}
                  <span className="muted">
                    ({stockSummary.owners.length} owner
                    {stockSummary.owners.length === 1 ? "" : "s"})
                  </span>
                </>
              )}
            </dd>
          </>
        ) : null}
        <dt>Live pools</dt>
        <dd>{livePools.length === 0 ? <span className="muted">—</span> : livePools.length}</dd>
      </dl>
      {stockSummary !== null && stockSummary.byTier.size > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">By quality</div>
          {[...stockSummary.byTier.entries()].map(([tier, qty]) => (
            <div key={tier} className="loc-person-row">
              <span className={`tier tier-${tier}`}>{tier}</span>
              <span className="muted">×{qty}</span>
            </div>
          ))}
        </div>
      ) : null}
      {stockSummary !== null && stockSummary.owners.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Owned by</div>
          {stockSummary.owners.map((ownerId) => (
            <div key={ownerId} className="loc-person-row">
              <ActorRef
                dump={dump}
                id={ownerId}
                onSelect={onSelect}
                variant="chip"
                size={20}
              />
            </div>
          ))}
        </div>
      ) : null}
      {item.flavourText !== null && item.flavourText.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Flavour</div>
          <p className="muted" style={{ margin: 0, fontSize: 11, fontStyle: "italic" }}>
            {item.flavourText}
          </p>
        </div>
      ) : null}
    </section>
  );
}

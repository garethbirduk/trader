import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef } from "./Refs.js";
import { estimateUnitRetail, formatRetailEstimate } from "../lib/retail-estimate.js";

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
      <RetailEstimateTable item={item} dump={dump} onSelect={onSelect} />
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

const TIERS_FOR_TABLE: readonly string[] = ["good", "fair", "shoddy"];

function RetailEstimateTable({
  item,
  dump,
  onSelect,
}: {
  item: RunDump["items"][number];
  dump: RunDump;
  onSelect: (s: Selection) => void;
}) {
  // Show estimates only for actors who have a bidder profile and one
  // of the dealer-ish roles — civilians' "estimates" aren't meaningful.
  const traders = dump.actors.filter(
    (a) =>
      a.bidderProfile !== undefined &&
      (a.roles ?? []).some((r) =>
        ["dealer", "fence", "player"].includes(r),
      ),
  );
  if (traders.length === 0) return null;
  return (
    <div className="loc-people">
      <div className="profile-section-label">Retail estimates per unit</div>
      <table className="estimate-table">
        <thead>
          <tr>
            <th>Trader</th>
            {TIERS_FOR_TABLE.map((t) => (
              <th key={t} className={`tier tier-${t}`}>
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {traders.map((a) => (
            <tr key={a.id}>
              <td>
                <ActorRef
                  dump={dump}
                  id={a.id}
                  onSelect={onSelect}
                  variant="inline"
                />
              </td>
              {TIERS_FOR_TABLE.map((t) => {
                const est = estimateUnitRetail(a.bidderProfile!, item, t);
                return (
                  <td key={t} className="num muted">
                    {formatRetailEstimate(est)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

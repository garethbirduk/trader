import { useMemo } from "react";
import type { DaySnapshot, RunDump, SnapshotStockLot } from "../types.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
}

export function InventoryView({ dump, day, snapshot }: Props) {
  const grouped = useMemo(() => {
    if (snapshot === null) return null;
    const byOwner = new Map<number, SnapshotStockLot[]>();
    for (const lot of snapshot.stockLots) {
      const list = byOwner.get(lot.ownerActorId) ?? [];
      list.push(lot);
      byOwner.set(lot.ownerActorId, list);
    }
    return byOwner;
  }, [snapshot]);

  if (snapshot === null || grouped === null) {
    return (
      <div className="empty-state">
        no snapshot for day {day} (re-run the sim with --out to capture
        per-day state)
      </div>
    );
  }

  if (grouped.size === 0) {
    return <div className="empty-state">no stock anywhere on day {day}</div>;
  }

  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
  const locName = (id: number | null) =>
    id === null
      ? "— (no location)"
      : dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`;
  const actorName = (id: number) =>
    dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`;

  const sortedOwners = [...grouped.entries()].sort((a, b) => {
    if (a[0] === dump.playerActorId) return -1;
    if (b[0] === dump.playerActorId) return 1;
    return actorName(a[0]).localeCompare(actorName(b[0]));
  });

  return (
    <div className="inventory">
      {sortedOwners.map(([ownerId, lots]) => {
        const totalUnits = lots.reduce((s, l) => s + l.quantity, 0);
        const totalCost = lots.reduce(
          (s, l) => s + l.quantity * l.acquiredUnitPrice,
          0,
        );
        return (
          <section key={ownerId} className="inventory-actor">
            <header className="inventory-actor-header">
              <span>{actorName(ownerId)}</span>
              <span className="muted">
                {totalUnits} units · cost £{totalCost}
              </span>
            </header>
            <table className="inv-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Tier</th>
                  <th>Qty</th>
                  <th>£/u</th>
                  <th>Acquired</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {lots
                  .slice()
                  .sort((a, b) => itemName(a.itemKindId).localeCompare(itemName(b.itemKindId)))
                  .map((lot) => (
                    <tr key={lot.id}>
                      <td>{itemName(lot.itemKindId)}</td>
                      <td className={`tier tier-${lot.qualityTier}`}>{lot.qualityTier}</td>
                      <td className="num">{lot.quantity}</td>
                      <td className="num">£{lot.acquiredUnitPrice}</td>
                      <td className="num muted">D{lot.acquiredDay}</td>
                      <td className="muted">{locName(lot.locationId)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

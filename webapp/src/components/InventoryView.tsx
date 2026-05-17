import { useMemo } from "react";
import type { DaySnapshot, RunDump, SnapshotStockLot } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, LocationRef } from "./Refs.js";
import { StockLine } from "./StockLine.js";
import { BeliefChip } from "./BeliefChip.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

export function InventoryView({ dump, day, snapshot, onSelect }: Props) {
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
        const sortedLots = lots
          .slice()
          .sort((a, b) =>
            itemName(a.itemKindId).localeCompare(itemName(b.itemKindId)),
          );
        return (
          <section key={ownerId} className="inventory-actor">
            <header className="inventory-actor-header">
              <ActorRef
                dump={dump}
                id={ownerId}
                onSelect={onSelect}
                variant="chip"
                size={18}
              />
              <span className="muted">
                {totalUnits} units · cost £{totalCost}
              </span>
            </header>
            <ul className="inv-lots">
              {sortedLots.map((lot) => (
                <StockLine
                  key={lot.id}
                  fact={
                    <>
                      <span className="muted">has</span>{" "}
                      <BeliefChip
                        dump={dump}
                        itemKindId={lot.itemKindId}
                        qualityTier={lot.qualityTier}
                        quantity={lot.quantity}
                        observerActorId={null}
                        onSelect={onSelect}
                      />
                    </>
                  }
                  meta={
                    <>
                      <span>cost £{lot.acquiredUnitPrice}/u</span>
                      <span>·</span>
                      <span>acquired D{lot.acquiredDay}</span>
                      {lot.locationId !== null ? (
                        <>
                          <span>·</span>
                          <LocationRef
                            dump={dump}
                            id={lot.locationId}
                            onSelect={onSelect}
                            variant="chip"
                            size={12}
                          />
                        </>
                      ) : null}
                    </>
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

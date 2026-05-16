import { useMemo } from "react";
import type { DaySnapshot, RunDump, SnapshotStockLot } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, ItemRef, LocationRef } from "./Refs.js";
import { StockLine, StockValue } from "./StockLine.js";
import { anchorFor, priceBandFor, tierTruth } from "../lib/perception.js";

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
        const owner = dump.actors.find((a) => a.id === ownerId);
        const profile = owner?.bidderProfile;
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
              {sortedLots.map((lot) => {
                const item = dump.items.find((i) => i.id === lot.itemKindId);
                const truth =
                  item !== undefined ? tierTruth(item, lot.qualityTier, dump.economics) : null;
                const retailBand =
                  profile !== undefined && item !== undefined && truth !== null
                    ? priceBandFor(
                        profile,
                        item.category,
                        truth,
                        anchorFor(dump, item.category),
                      )
                    : null;
                return (
                  <StockLine
                    key={lot.id}
                    fact={
                      <>
                        <span className="muted">has</span>{" "}
                        <StockValue>{lot.quantity}</StockValue>{" "}
                        <ItemRef
                          dump={dump}
                          id={lot.itemKindId}
                          onSelect={onSelect}
                          variant="chip"
                          qualityTier={lot.qualityTier}
                        />{" "}
                        <span className="muted">@</span>{" "}
                        <StockValue>£{lot.acquiredUnitPrice}</StockValue>
                        <span className="muted">/u</span>
                      </>
                    }
                    meta={
                      <>
                        {retailBand !== null ? (
                          <span
                            title={`${owner?.displayName ?? "owner"}'s belief about resale value — judgement engine centre + band (docs/judgement.md)`}
                          >
                            ~{formatBand(retailBand.centre, retailBand.low, retailBand.high)} retail
                          </span>
                        ) : null}
                        {retailBand !== null ? <span>·</span> : null}
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
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function formatBand(centre: number, low: number, high: number): string {
  const mid = Math.max(0, Math.round(centre));
  const lo = Math.max(0, Math.round(low));
  const hi = Math.max(0, Math.round(high));
  if (lo === hi) return `£${mid}`;
  return `£${mid} (£${lo}–£${hi})`;
}

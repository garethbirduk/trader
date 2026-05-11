import { useMemo } from "react";
import type { DaySnapshot, RunDump, SnapshotDeal, SnapshotStockLot } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";
import { ItemRef, LocationRef } from "./Refs.js";
import { StockLine, StockValue } from "./StockLine.js";
import {
  estimateUnitRetail,
  formatRetailEstimate,
} from "../lib/retail-estimate.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
}

export function ActorInventory({ dump, day, snapshot, actorId, onSelect }: Props) {
  const actor = dump.actors.find((a) => a.id === actorId);
  const profile = actor?.bidderProfile;

  const lots = useMemo<readonly SnapshotStockLot[]>(() => {
    if (snapshot === null) return [];
    return snapshot.stockLots.filter((l) => l.ownerActorId === actorId);
  }, [snapshot, actorId]);

  const sells = useMemo<readonly SnapshotDeal[]>(() => {
    if (snapshot === null) return [];
    return snapshot.deals.filter(
      (d) => d.sellerActorId === actorId && d.state === "agreed",
    );
  }, [snapshot, actorId]);

  const buys = useMemo<readonly SnapshotDeal[]>(() => {
    if (snapshot === null) return [];
    return snapshot.deals.filter(
      (d) => d.buyerActorId === actorId && d.state === "agreed",
    );
  }, [snapshot, actorId]);

  if (snapshot === null) {
    return (
      <div className="side-lower-empty muted">
        No snapshot for day {day}.
      </div>
    );
  }

  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;

  const totalUnits = lots.reduce((s, l) => s + l.quantity, 0);
  const totalCost = lots.reduce((s, l) => s + l.quantity * l.acquiredUnitPrice, 0);

  return (
    <section className="actor-inv">
      <header className="actor-inv-header muted">
        End of D{day} · {lots.length} lot{lots.length === 1 ? "" : "s"} ·{" "}
        {totalUnits} units · cost £{totalCost}
      </header>

      <h4 className="actor-inv-section">Stock on hand</h4>
      {lots.length === 0 ? (
        <div className="muted">No stock.</div>
      ) : (
        <ul className="inv-lots">
          {lots
            .slice()
            .sort((a, b) => itemName(a.itemKindId).localeCompare(itemName(b.itemKindId)))
            .map((lot) => {
              const item = dump.items.find((i) => i.id === lot.itemKindId);
              const retail =
                profile !== undefined && item !== undefined
                  ? estimateUnitRetail(
                      profile,
                      item,
                      lot.qualityTier,
                      dump.economics,
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
                      {retail !== null ? (
                        <span
                          title={`${actor?.displayName ?? "owner"}'s retail estimate based on category accuracy`}
                        >
                          ~£{formatRetailEstimate(retail)} retail
                        </span>
                      ) : null}
                      {retail !== null ? <span>·</span> : null}
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
      )}

      <h4 className="actor-inv-section">Promised to deliver</h4>
      {sells.length === 0 ? (
        <div className="muted">Nothing on order.</div>
      ) : (
        <ul className="actor-inv-deals">
          {sells.map((d) => (
            <DealRow
              key={d.id}
              dump={dump}
              deal={d}
              counterpartyKind="buyer"
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}

      <h4 className="actor-inv-section">Promised to receive</h4>
      {buys.length === 0 ? (
        <div className="muted">Nothing on order.</div>
      ) : (
        <ul className="actor-inv-deals">
          {buys.map((d) => (
            <DealRow
              key={d.id}
              dump={dump}
              deal={d}
              counterpartyKind="seller"
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DealRow({
  dump,
  deal,
  counterpartyKind,
  onSelect,
}: {
  readonly dump: RunDump;
  readonly deal: SnapshotDeal;
  readonly counterpartyKind: "buyer" | "seller";
  readonly onSelect: (s: Selection) => void;
}) {
  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
  const cpId = counterpartyKind === "buyer" ? deal.buyerActorId : deal.sellerActorId;
  const arrow = counterpartyKind === "buyer" ? "→" : "←";
  return (
    <li className="actor-inv-deal">
      <div className="actor-inv-deal-head">
        <span className="muted">D{deal.agreedDay}</span>
        <span>
          {arrow} <ActorChip dump={dump} actorId={cpId} onSelect={onSelect} size={14} />
        </span>
        <span className="muted">deadline D{deal.deadlineDay}</span>
        {deal.deliveryLocationId !== null ? (
          <span className="muted">
            · <LocationLink dump={dump} locationId={deal.deliveryLocationId} onSelect={onSelect} />
          </span>
        ) : null}
        <span className="muted">· £{deal.totalPrice}</span>
      </div>
      <ul className="actor-inv-deal-lines">
        {deal.lines.map((line, i) => (
          <li key={i} className="muted">
            {line.quantity} {itemName(line.itemKindId)} ({line.qualityTier}) @ £{line.unitPrice}
          </li>
        ))}
      </ul>
    </li>
  );
}

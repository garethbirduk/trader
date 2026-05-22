import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { DealRef, LocationRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { StockChip } from "./StockChip.js";
import { priceBandFor, tierTruth, tieredAnchorFor } from "../lib/perception.js";

/** Wholesale-to-shop resale benchmark — what a buyer can typically
 *  flip stock for to another dealer at 70% of perceived RRP. */
const RESALE_WHOLESALE_FRACTION = 0.7;
/** Market-stall resale ceiling — direct-to-public top end at ~90%
 *  of perceived RRP. */
const RESALE_MARKET_FRACTION = 0.9;

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

const STATE_FILTERS = ["all", "agreed", "settled", "defaulted", "cancelled"] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

export function DealBook({ dump, day, snapshot, onSelect }: Props) {
  const [filter, setFilter] = useState<StateFilter>("all");

  const filtered = useMemo(() => {
    if (snapshot === null) return [];
    const all = [...snapshot.deals];
    const filt = filter === "all" ? all : all.filter((d) => d.state === filter);
    filt.sort((a, b) => {
      const sortKey = (d: SnapshotDeal) =>
        d.state === "agreed" ? 0 : d.state === "settled" ? 1 : 2;
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return b.id - a.id;
    });
    return filt;
  }, [snapshot, filter]);

  if (snapshot === null) {
    return (
      <div className="empty-state">
        no snapshot for day {day} (re-run the sim with --out to capture
        per-day state)
      </div>
    );
  }

  return (
    <div className="dealbook">
      <div className="toggle">
        {STATE_FILTERS.map((s) => (
          <label key={s}>
            <input
              type="radio"
              checked={filter === s}
              onChange={() => setFilter(s)}
            />
            {s}
          </label>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">no deals match</div>
      ) : (
        <div className="deals">
          {filtered.map((d) => (
            <article key={d.id} className={`deal deal-${d.state}`}>
              <header className="deal-head">
                <span className="deal-id">
                  <DealRef
                    dump={dump}
                    id={d.id}
                    onSelect={onSelect}
                    variant="chip"
                  />
                </span>
                <span className={`deal-state state-${d.state}`}>{d.state}</span>
                <span className="deal-parties">
                  <ActorChipById
                    dump={dump}
                    actorId={d.sellerActorId}
                    onSelect={onSelect}
                    size={14}
                  />
                  <span className="ref-arrow">→</span>
                  <ActorChipById
                    dump={dump}
                    actorId={d.buyerActorId}
                    onSelect={onSelect}
                    size={14}
                  />
                </span>
                <span className="muted">
                  agreed D{d.agreedDay} · deadline D{d.deadlineDay}
                  {d.deliveryLocationId !== null ? (
                    <>
                      {" · drop @ "}
                      <LocationRef
                        dump={dump}
                        id={d.deliveryLocationId}
                        onSelect={onSelect}
                        variant="chip"
                        size={14}
                      />
                    </>
                  ) : null}
                </span>
                <span className="deal-total">£{d.totalPrice}</span>
              </header>
              <ul className="deal-lines">
                {d.lines.map((l, i) => {
                  const verb = d.state === "settled"
                    ? "SOLD"
                    : d.state === "defaulted"
                      ? "DEFAULTED"
                      : "AGREED";
                  // Buyer's POV value drives the resale-margin row.
                  // Skip the row if the buyer has no bidder profile
                  // (civilians / virtual actors).
                  const item = dump.items.find((it) => it.id === l.itemKindId);
                  const buyer = dump.actors.find((a) => a.id === d.buyerActorId);
                  const buyerProfile = buyer?.knowledgeProfile;
                  const truth = item !== undefined
                    ? tierTruth(item, l.qualityTier, dump.economics)
                    : null;
                  let buyerBeliefUnit: number | null = null;
                  if (buyerProfile !== undefined && item !== undefined && truth !== null) {
                    const anchor = tieredAnchorFor(dump, item.category, l.qualityTier);
                    const band = priceBandFor(
                      buyerProfile,
                      item.category,
                      truth,
                      anchor,
                      buyer?.armJ?.price,
                    );
                    buyerBeliefUnit = Math.max(0, Math.round(band.centre));
                  }
                  const resaleWholesaleUnit = buyerBeliefUnit !== null
                    ? Math.max(0, Math.round(buyerBeliefUnit * RESALE_WHOLESALE_FRACTION))
                    : null;
                  const resaleMarketUnit = buyerBeliefUnit !== null
                    ? Math.max(0, Math.round(buyerBeliefUnit * RESALE_MARKET_FRACTION))
                    : null;
                  const wholesaleMargin = resaleWholesaleUnit !== null
                    ? resaleWholesaleUnit * l.quantity - l.unitPrice * l.quantity
                    : null;
                  const marketMargin = resaleMarketUnit !== null
                    ? resaleMarketUnit * l.quantity - l.unitPrice * l.quantity
                    : null;
                  return (
                    <li key={i} className="deal-line">
                      <div className="deal-line-row">
                        <span className="deal-line-label muted">RRP</span>
                        <StockChip
                          dump={dump}
                          itemKindId={l.itemKindId}
                          qualityTier={l.qualityTier}
                          quantity={l.quantity}
                          observerActorId={null}
                          onSelect={onSelect}
                        />
                      </div>
                      <div className="deal-line-row">
                        <ActorChipById
                          dump={dump}
                          actorId={d.sellerActorId}
                          onSelect={onSelect}
                          size={14}
                        />
                        <span className="muted">POV:</span>
                        <StockChip
                          dump={dump}
                          itemKindId={l.itemKindId}
                          qualityTier={l.qualityTier}
                          quantity={l.quantity}
                          observerActorId={d.sellerActorId}
                          onSelect={onSelect}
                        />
                      </div>
                      <div className="deal-line-row">
                        <ActorChipById
                          dump={dump}
                          actorId={d.sellerActorId}
                          onSelect={onSelect}
                          size={14}
                        />
                        <span className="muted">→</span>
                        <ActorChipById
                          dump={dump}
                          actorId={d.buyerActorId}
                          onSelect={onSelect}
                          size={14}
                        />
                        <span className="muted">{verb}</span>
                        <StockChip
                          dump={dump}
                          itemKindId={l.itemKindId}
                          qualityTier={l.qualityTier}
                          quantity={l.quantity}
                          observerActorId={d.sellerActorId}
                          unitPriceOverride={l.unitPrice}
                          onSelect={onSelect}
                        />
                      </div>
                      <div className="deal-line-row">
                        <ActorChipById
                          dump={dump}
                          actorId={d.buyerActorId}
                          onSelect={onSelect}
                          size={14}
                        />
                        <span className="muted">POV:</span>
                        <StockChip
                          dump={dump}
                          itemKindId={l.itemKindId}
                          qualityTier={l.qualityTier}
                          quantity={l.quantity}
                          observerActorId={d.buyerActorId}
                          onSelect={onSelect}
                        />
                      </div>
                      {resaleWholesaleUnit !== null && resaleMarketUnit !== null ? (
                        <div className="deal-line-row">
                          <ActorChipById
                            dump={dump}
                            actorId={d.buyerActorId}
                            onSelect={onSelect}
                            size={14}
                          />
                          <span className="muted">resale margin:</span>
                          <span className="muted">70% RRP</span>
                          <StockChip
                            dump={dump}
                            itemKindId={l.itemKindId}
                            qualityTier={l.qualityTier}
                            quantity={l.quantity}
                            observerActorId={d.buyerActorId}
                            unitPriceOverride={resaleWholesaleUnit}
                            onSelect={onSelect}
                          />
                          {wholesaleMargin !== null ? (
                            <strong className={wholesaleMargin >= 0 ? "" : "warn"}>
                              {wholesaleMargin >= 0 ? "+" : "−"}£{Math.abs(wholesaleMargin)}
                            </strong>
                          ) : null}
                          <span className="muted">→ 90% RRP</span>
                          <StockChip
                            dump={dump}
                            itemKindId={l.itemKindId}
                            qualityTier={l.qualityTier}
                            quantity={l.quantity}
                            observerActorId={d.buyerActorId}
                            unitPriceOverride={resaleMarketUnit}
                            onSelect={onSelect}
                          />
                          {marketMargin !== null ? (
                            <strong className={marketMargin >= 0 ? "" : "warn"}>
                              {marketMargin >= 0 ? "+" : "−"}£{Math.abs(marketMargin)}
                            </strong>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {d.state === "settled" && d.settledDay !== null ? (
                <footer className="muted">settled D{d.settledDay}</footer>
              ) : null}
              {d.state === "defaulted" && d.defaultedDay !== null ? (
                <footer className="warn">
                  defaulted D{d.defaultedDay}
                  {d.defaultReason !== null ? ` — ${d.defaultReason}` : ""}
                </footer>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

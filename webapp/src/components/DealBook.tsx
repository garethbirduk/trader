import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, DealRef, ItemRef, LocationRef } from "./Refs.js";

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
                    variant="inline"
                  />
                </span>
                <span className={`deal-state state-${d.state}`}>{d.state}</span>
                <span className="deal-parties">
                  <ActorRef
                    dump={dump}
                    id={d.sellerActorId}
                    onSelect={onSelect}
                    variant="inline"
                  />
                  {" → "}
                  <ActorRef
                    dump={dump}
                    id={d.buyerActorId}
                    onSelect={onSelect}
                    variant="inline"
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
                        variant="inline"
                      />
                    </>
                  ) : null}
                </span>
                <span className="deal-total">£{d.totalPrice}</span>
              </header>
              <table className="deal-lines">
                <tbody>
                  {d.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <ItemRef
                          dump={dump}
                          id={l.itemKindId}
                          onSelect={onSelect}
                          variant="inline"
                        />
                      </td>
                      <td className={`tier tier-${l.qualityTier}`}>{l.qualityTier}</td>
                      <td className="num">×{l.quantity}</td>
                      <td className="num">@ £{l.unitPrice}</td>
                      <td className="num muted">= £{l.quantity * l.unitPrice}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, ItemRef, LocationRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly dealId: number;
  readonly onSelect: (s: Selection) => void;
}

export function DealProfile({ dump, day, snapshot, dealId, onSelect }: Props) {
  // Fall back to scanning every snapshot if today's doesn't carry the
  // deal yet — useful for browsing settled/defaulted deals on later days.
  const deal = useMemo(() => {
    if (snapshot !== null) {
      const here = snapshot.deals.find((d) => d.id === dealId);
      if (here !== undefined) return here;
    }
    for (let i = (dump.snapshots?.length ?? 0) - 1; i >= 0; i -= 1) {
      const s = dump.snapshots![i]!;
      const found = s.deals.find((d) => d.id === dealId);
      if (found !== undefined) return found;
    }
    return null;
  }, [snapshot, dump.snapshots, dealId]);

  if (deal === null) {
    return <div className="empty-state">deal {dealId} not found</div>;
  }

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">⇄</div>
        <div className="profile-title">
          <div className="profile-name">deal {deal.id}</div>
          <div className="profile-code muted">
            <span className={`deal-state state-${deal.state}`}>{deal.state}</span>
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Seller</dt>
        <dd>
          <ActorRef
            dump={dump}
            id={deal.sellerActorId}
            onSelect={onSelect}
            variant="chip"
            size={16}
          />
        </dd>
        <dt>Buyer</dt>
        <dd>
          <ActorRef
            dump={dump}
            id={deal.buyerActorId}
            onSelect={onSelect}
            variant="chip"
            size={16}
          />
        </dd>
        <dt>Total</dt>
        <dd>£{deal.totalPrice}</dd>
        <dt>Agreed</dt>
        <dd>D{deal.agreedDay}</dd>
        <dt>Deadline</dt>
        <dd className={day > deal.deadlineDay && deal.state === "agreed" ? "warn" : ""}>
          D{deal.deadlineDay}
        </dd>
        {deal.deliveryLocationId !== null ? (
          <>
            <dt>Drop</dt>
            <dd>
              <LocationRef
                dump={dump}
                id={deal.deliveryLocationId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : null}
        {deal.settledDay !== null ? (
          <>
            <dt>Settled</dt>
            <dd>D{deal.settledDay}</dd>
          </>
        ) : null}
        {deal.defaultedDay !== null ? (
          <>
            <dt>Defaulted</dt>
            <dd className="warn">
              D{deal.defaultedDay}
              {deal.defaultReason !== null ? (
                <>
                  {" — "}
                  <span className="muted">{deal.defaultReason}</span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {deal.lines.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Lines</div>
          {deal.lines.map((l, i) => (
            <div key={i} className="loc-person-row">
              <ItemRef
                dump={dump}
                id={l.itemKindId}
                onSelect={onSelect}
                variant="chip"
                qualityTier={l.qualityTier}
              />
              <span className="muted">×{l.quantity}</span>
              <span className="muted">@ £{l.unitPrice}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

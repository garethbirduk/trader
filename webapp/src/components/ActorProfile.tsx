import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import { Avatar } from "./Avatar.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly actorId: number;
}

export function ActorProfile({ dump, day, snapshot, actorId }: Props) {
  const actor = dump.actors.find((a) => a.id === actorId);
  if (actor === undefined) return null;
  const isPlayer = actor.id === dump.playerActorId;

  const sa = snapshot?.actors.find((a) => a.id === actorId) ?? null;
  const cash = sa?.cash ?? actor.cash;
  const heat = sa?.heat ?? 0;
  const locId = sa?.currentLocationId ?? actor.currentLocationId;

  const locName = (id: number | null) =>
    id === null
      ? "—"
      : dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`;

  const stockSummary = useMemo(() => {
    if (snapshot === null) return null;
    const lots = snapshot.stockLots.filter((l) => l.ownerActorId === actorId);
    const units = lots.reduce((s, l) => s + l.quantity, 0);
    const cost = lots.reduce((s, l) => s + l.quantity * l.acquiredUnitPrice, 0);
    return { lotCount: lots.length, units, cost };
  }, [snapshot, actorId]);

  const dealCounts = useMemo(() => {
    if (snapshot === null) return null;
    let openBuy = 0;
    let openSell = 0;
    let settled = 0;
    let defaulted = 0;
    for (const d of snapshot.deals) {
      const involved =
        d.buyerActorId === actorId || d.sellerActorId === actorId;
      if (!involved) continue;
      if (d.state === "agreed" && d.buyerActorId === actorId) openBuy += 1;
      else if (d.state === "agreed" && d.sellerActorId === actorId) openSell += 1;
      else if (d.state === "settled") settled += 1;
      else if (d.state === "defaulted") defaulted += 1;
    }
    return { openBuy, openSell, settled, defaulted };
  }, [snapshot, actorId]);

  const reachablePools = useMemo(() => {
    if (snapshot === null) return 0;
    return snapshot.pools.filter(
      (p) =>
        p.flushedDay === null &&
        p.expiryDay >= day &&
        p.createdDay <= day &&
        p.reachableBy.includes(actorId),
    ).length;
  }, [snapshot, day, actorId]);

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <Avatar
          name={actor.displayName}
          code={actor.code}
          isPlayer={isPlayer}
          size={42}
        />
        <div className="profile-title">
          <div className="profile-name">
            {isPlayer ? "▶ " : ""}
            {actor.displayName}
          </div>
          <div className="profile-code muted">
            {actor.code} · {actor.transportCapacity}
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Cash</dt>
        <dd>£{cash}</dd>
        <dt>Home</dt>
        <dd>{locName(actor.homeLocationId)}</dd>
        <dt>Now at</dt>
        <dd>{locName(locId)}</dd>
        <dt>Heat</dt>
        <dd className={heat > 0 ? "warn" : "muted"}>{heat > 0 ? `🔥 ${heat}` : "—"}</dd>
        {stockSummary !== null ? (
          <>
            <dt>Stock</dt>
            <dd>
              {stockSummary.units} units{" "}
              <span className="muted">
                ({stockSummary.lotCount} lot{stockSummary.lotCount === 1 ? "" : "s"} · £{stockSummary.cost} cost)
              </span>
            </dd>
          </>
        ) : null}
        {dealCounts !== null ? (
          <>
            <dt>Open deals</dt>
            <dd>
              {dealCounts.openBuy + dealCounts.openSell === 0 ? (
                <span className="muted">—</span>
              ) : (
                <>
                  {dealCounts.openBuy > 0 ? <>buying {dealCounts.openBuy}</> : null}
                  {dealCounts.openBuy > 0 && dealCounts.openSell > 0 ? " · " : ""}
                  {dealCounts.openSell > 0 ? <>selling {dealCounts.openSell}</> : null}
                </>
              )}
            </dd>
            <dt>Closed</dt>
            <dd>
              <span className="muted">{dealCounts.settled} settled</span>
              {dealCounts.defaulted > 0 ? (
                <>
                  {" · "}
                  <span className="warn">{dealCounts.defaulted} defaulted</span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Reachable pools</dt>
        <dd>{reachablePools}</dd>
      </dl>
    </section>
  );
}

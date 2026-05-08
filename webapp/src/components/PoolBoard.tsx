import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump, SnapshotPool } from "../types.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
}

export function PoolBoard({ dump, day, snapshot }: Props) {
  const [includeFlushed, setIncludeFlushed] = useState(false);

  const pools = useMemo(() => {
    if (snapshot === null) return [];
    return snapshot.pools.filter((p) => {
      if (p.flushedDay !== null && !includeFlushed) return false;
      if (p.createdDay > day) return false;
      return true;
    });
  }, [snapshot, day, includeFlushed]);

  if (snapshot === null) {
    return (
      <div className="empty-state">
        no snapshot for day {day} (re-run the sim with --out to capture
        per-day state)
      </div>
    );
  }

  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
  const actorName = (id: number) =>
    dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`;

  if (pools.length === 0) {
    return <div className="empty-state">no pools to show</div>;
  }

  // Sort: live first, then by expiry.
  const sorted = [...pools].sort((a, b) => {
    const aDead = a.flushedDay !== null || a.expiryDay < day;
    const bDead = b.flushedDay !== null || b.expiryDay < day;
    if (aDead !== bDead) return aDead ? 1 : -1;
    return a.expiryDay - b.expiryDay;
  });

  return (
    <div className="poolboard">
      <div className="toggle">
        <label>
          <input
            type="checkbox"
            checked={includeFlushed}
            onChange={(e) => setIncludeFlushed(e.target.checked)}
          />
          show flushed pools
        </label>
      </div>
      <div className="pools">
        {sorted.map((p) => (
          <PoolCard
            key={p.id}
            pool={p}
            day={day}
            itemName={itemName(p.itemKindId)}
            reachableNames={p.reachableBy.map(actorName)}
          />
        ))}
      </div>
    </div>
  );
}

function PoolCard({
  pool,
  day,
  itemName,
  reachableNames,
}: {
  pool: SnapshotPool;
  day: number;
  itemName: string;
  reachableNames: readonly string[];
}) {
  const isFlushed = pool.flushedDay !== null;
  const isExpired = !isFlushed && pool.expiryDay < day;
  const lifeSpan = pool.expiryDay - pool.createdDay;
  const dayInLife = Math.max(0, Math.min(lifeSpan, day - pool.createdDay));
  // Linear price decay opening → closing.
  const t = lifeSpan === 0 ? 1 : dayInLife / lifeSpan;
  const currentUnitPrice = Math.round(
    pool.openingUnitPrice + (pool.closingUnitPrice - pool.openingUnitPrice) * t,
  );

  const status = isFlushed
    ? `flushed D${pool.flushedDay} → ${pool.dumpDestination}`
    : isExpired
      ? "expired"
      : "live";

  return (
    <article className={`pool pool-${isFlushed ? "flushed" : isExpired ? "expired" : "live"}`}>
      <header className="pool-head">
        <span className="pool-id">pool {pool.id}</span>
        <span className="pool-status">{status}</span>
        <span className="pool-item">
          {itemName} <span className={`tier tier-${pool.qualityTier}`}>{pool.qualityTier}</span>
        </span>
        <span className="pool-qty">qty {pool.quantityRemaining}</span>
      </header>
      <DecayMiniGraph
        openingPrice={pool.openingUnitPrice}
        closingPrice={pool.closingUnitPrice}
        createdDay={pool.createdDay}
        expiryDay={pool.expiryDay}
        currentDay={day}
      />
      <div className="pool-prices muted">
        D{pool.createdDay} £{pool.openingUnitPrice} → D{pool.expiryDay} £{pool.closingUnitPrice}
        {!isFlushed && !isExpired ? ` · today ≈ £${currentUnitPrice}/u` : ""}
      </div>
      <div className="pool-reach muted">
        reachable: {reachableNames.length === 0 ? "—" : reachableNames.join(", ")}
      </div>
    </article>
  );
}

function DecayMiniGraph({
  openingPrice,
  closingPrice,
  createdDay,
  expiryDay,
  currentDay,
}: {
  openingPrice: number;
  closingPrice: number;
  createdDay: number;
  expiryDay: number;
  currentDay: number;
}) {
  const W = 200;
  const H = 24;
  const P = 2;
  const lo = Math.min(openingPrice, closingPrice);
  const hi = Math.max(openingPrice, closingPrice);
  const range = Math.max(1, hi - lo);
  const x = (d: number) =>
    P + ((d - createdDay) / Math.max(1, expiryDay - createdDay)) * (W - 2 * P);
  const y = (price: number) =>
    P + (1 - (price - lo) / range) * (H - 2 * P);
  const x1 = x(createdDay);
  const x2 = x(expiryDay);
  const y1 = y(openingPrice);
  const y2 = y(closingPrice);
  const dayClamped = Math.max(createdDay, Math.min(expiryDay, currentDay));
  const xc = x(dayClamped);

  return (
    <svg width={W} height={H} className="decay-graph">
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent-2)" strokeWidth={1.5} />
      <circle cx={xc} cy={P + (H - 2 * P) / 2} r={2.5} fill="var(--accent)" />
      <line x1={xc} y1={P} x2={xc} y2={H - P} stroke="var(--accent)" strokeOpacity={0.4} strokeWidth={1} />
    </svg>
  );
}

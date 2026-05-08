import { useMemo } from "react";
import type { RunDump } from "../types.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
}

/**
 * Shows running counters of significant events up to and including
 * `day`. Computed from the event stream at render time — small enough
 * that it doesn't need memoising past the dependency on day.
 */
export function Summary({ dump, day }: Props) {
  const counts = useMemo(() => {
    const c = {
      poolSpawned: 0,
      poolClaimed: 0,
      poolFlushed: 0,
      auctionsCleared: 0,
      auctionsUnsold: 0,
      auctionsWrittenOff: 0,
      dealsSettled: 0,
      dealsDefaulted: 0,
      pubdealsAttempted: 0,
      pubdealsAgreed: 0,
      pubdealsWalked: 0,
      pubdealsTrustBlocked: 0,
      gossipExchanges: 0,
      heatRaisedEvents: 0,
      authorityRaids: 0,
      easterEggsSpawned: 0,
    };
    for (const e of dump.events) {
      if (e.at.day > day) break;
      switch (e.type) {
        case "pool.spawned":
          c.poolSpawned += 1;
          if (e.isEasterEgg === true) c.easterEggsSpawned += 1;
          break;
        case "pool.claimed": c.poolClaimed += 1; break;
        case "pool.flushed": c.poolFlushed += 1; break;
        case "auction.cleared": c.auctionsCleared += 1; break;
        case "auction.unsold": c.auctionsUnsold += 1; break;
        case "auction.written_off": c.auctionsWrittenOff += 1; break;
        case "deal.settled": c.dealsSettled += 1; break;
        case "deal.defaulted": c.dealsDefaulted += 1; break;
        case "pubdeal.attempted": c.pubdealsAttempted += 1; break;
        case "pubdeal.agreed": c.pubdealsAgreed += 1; break;
        case "pubdeal.walked": c.pubdealsWalked += 1; break;
        case "pubdeal.skipped-low-trust": c.pubdealsTrustBlocked += 1; break;
        case "gossip.exchanged": c.gossipExchanges += 1; break;
        case "heat.raised": c.heatRaisedEvents += 1; break;
        case "authority.raid": c.authorityRaids += 1; break;
      }
    }
    return c;
  }, [dump, day]);

  return (
    <aside className="panel">
      <h2>Cumulative through day {day}</h2>
      <dl className="summary">
        <dt>Pool spawns</dt>
        <dd>{counts.poolSpawned} {counts.easterEggsSpawned > 0 ? `(${counts.easterEggsSpawned} ✨)` : ""}</dd>
        <dt>Pool claims</dt>
        <dd>{counts.poolClaimed}</dd>
        <dt>Pool flushes</dt>
        <dd>{counts.poolFlushed}</dd>
        <dt>Auctions cleared</dt>
        <dd>{counts.auctionsCleared}</dd>
        <dt>Auctions unsold</dt>
        <dd>{counts.auctionsUnsold}</dd>
        <dt>Auctions written off</dt>
        <dd>{counts.auctionsWrittenOff}</dd>
        <dt>Deals settled</dt>
        <dd>{counts.dealsSettled}</dd>
        <dt>Deals defaulted</dt>
        <dd style={{ color: counts.dealsDefaulted > 0 ? "var(--warn)" : undefined }}>
          {counts.dealsDefaulted}
        </dd>
        <dt>Pubdeals attempted</dt>
        <dd>{counts.pubdealsAttempted}</dd>
        <dt>· agreed</dt>
        <dd>{counts.pubdealsAgreed}</dd>
        <dt>· walked</dt>
        <dd>{counts.pubdealsWalked}</dd>
        <dt>· trust-blocked</dt>
        <dd>{counts.pubdealsTrustBlocked}</dd>
        <dt>Gossip exchanges</dt>
        <dd>{counts.gossipExchanges}</dd>
        <dt>Heat raises</dt>
        <dd>{counts.heatRaisedEvents}</dd>
        <dt>🚨 raids</dt>
        <dd style={{ color: counts.authorityRaids > 0 ? "var(--warn)" : undefined }}>
          {counts.authorityRaids}
        </dd>
      </dl>
      <h2 style={{ marginTop: 20 }}>Final tally</h2>
      <dl className="summary">
        <dt>Run length</dt>
        <dd>{dump.runLengthDays} days</dd>
        <dt>Total events</dt>
        <dd>{dump.events.length}</dd>
      </dl>
    </aside>
  );
}

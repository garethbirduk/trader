import { useMemo } from "react";
import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";
import { ActorRef, LotRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
}

interface ExchangedLead {
  readonly side: "supply" | "demand";
  readonly subjectItemKindId: number;
  readonly subjectQualityTier: string | null;
  readonly counterpartyActorId: number | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly confidence: "warm" | "cold";
  readonly hopCount: number;
  readonly sourceActorId: number | null;
}

interface Exchange {
  readonly fromActorId: number;
  readonly toActorId: number;
  readonly lead: ExchangedLead;
}

interface LearnedRow {
  readonly day: number;
  readonly hour: number;
  readonly fromActorId: number;
  readonly atLocationId: number;
  readonly lead: ExchangedLead;
}

interface LotKnowledgeRow {
  readonly day: number;
  readonly hour: number;
  readonly lotId: number;
  readonly via: string;
  readonly fromActorId: number | null;
  readonly inspected: boolean;
}

/** Identity of a piece of news, for dedup. Two leads with the same
 *  side + item + quality + counterparty are "the same fact" — refined
 *  qty/price estimates don't count as new news. */
function dedupKey(l: ExchangedLead): string {
  return [
    l.side,
    l.subjectItemKindId,
    l.subjectQualityTier ?? "_",
    l.counterpartyActorId ?? "_",
  ].join("|");
}

export function ActorKnows({ dump, day, hour, actorId, onSelect }: Props) {
  // Auction lot knowledge from `auction.knowledge-acquired` and
  // `auction.lot-inspected` events. Newest first, deduped per lot —
  // the inspection (if any) merges into the same row.
  const lotRows = useMemo<readonly LotKnowledgeRow[]>(() => {
    const byLot = new Map<number, LotKnowledgeRow>();
    const events = [...dump.events]
      .filter(
        (e) =>
          (e.type === "auction.knowledge-acquired" ||
            e.type === "auction.lot-inspected") &&
          e.actorId === actorId,
      )
      .filter((e) => e.at.day < day || (e.at.day === day && e.at.hour <= hour))
      .sort((a, b) =>
        a.at.day !== b.at.day ? a.at.day - b.at.day : a.at.hour - b.at.hour,
      );
    for (const e of events) {
      const lotId = e.auctionLotId as number;
      const existing = byLot.get(lotId);
      if (e.type === "auction.knowledge-acquired") {
        if (existing === undefined) {
          byLot.set(lotId, {
            day: e.at.day,
            hour: e.at.hour,
            lotId,
            via: String(e.via),
            fromActorId:
              typeof e.fromActorId === "number" ? e.fromActorId : null,
            inspected: false,
          });
        }
      } else {
        // lot-inspected — flag inspection on the existing row, or
        // create one if knowledge was already there from a snapshot
        // not represented here.
        if (existing === undefined) {
          byLot.set(lotId, {
            day: e.at.day,
            hour: e.at.hour,
            lotId,
            via: "inspected",
            fromActorId: null,
            inspected: true,
          });
        } else {
          byLot.set(lotId, { ...existing, inspected: true });
        }
      }
    }
    return [...byLot.values()].sort((a, b) =>
      a.day !== b.day ? b.day - a.day : b.hour - a.hour,
    );
  }, [dump.events, actorId, day, hour]);

  const rows = useMemo<readonly LearnedRow[]>(() => {
    // Walk events chronologically and keep the *first time* the actor
    // heard each distinct fact. Anything they already knew is dropped.
    const seen = new Set<string>();
    const learned: LearnedRow[] = [];
    const events = [...dump.events]
      .filter((e) => e.type === "gossip.exchanged")
      .filter((e) =>
        e.at.day < day || (e.at.day === day && e.at.hour <= hour),
      )
      .sort((a, b) =>
        a.at.day !== b.at.day ? a.at.day - b.at.day : a.at.hour - b.at.hour,
      );
    for (const e of events) {
      const exchanges = (e.exchanges as readonly Exchange[] | undefined) ?? [];
      for (const x of exchanges) {
        if (x.toActorId !== actorId) continue;
        const key = dedupKey(x.lead);
        if (seen.has(key)) continue;
        seen.add(key);
        learned.push({
          day: e.at.day,
          hour: e.at.hour,
          fromActorId: x.fromActorId,
          atLocationId: e.atLocationId as number,
          lead: x.lead,
        });
      }
    }
    learned.reverse(); // newest first for display
    return learned;
  }, [dump.events, actorId, day, hour]);

  if (rows.length === 0 && lotRows.length === 0) {
    return (
      <div className="side-lower-empty muted">
        Nothing yet — nothing new learned by this point.
      </div>
    );
  }

  return (
    <section className="knows-list">
      <header className="knows-header muted">
        {rows.length + lotRows.length} thing
        {rows.length + lotRows.length === 1 ? "" : "s"} learned · as of D{day}{" "}
        {pad(hour)}:00
      </header>
      {lotRows.length > 0 ? (
        <>
          <div className="profile-section-label">Auction lots</div>
          <ul>
            {lotRows.map((r) => (
              <li key={r.lotId} className="knows-row">
                <div className="knows-stamp-line">
                  <span className="knows-stamp">
                    D{pad(r.day)} {pad(r.hour)}:00
                  </span>
                  <span className="knows-body">
                    <LotRef
                      dump={dump}
                      id={r.lotId}
                      onSelect={onSelect}
                      variant="inline"
                    />{" "}
                    <span className="muted">
                      via {r.via}
                      {r.inspected ? " · inspected" : ""}
                    </span>
                    {r.fromActorId !== null ? (
                      <>
                        {" "}
                        <span className="muted">from</span>{" "}
                        <ActorRef
                          dump={dump}
                          id={r.fromActorId}
                          onSelect={onSelect}
                          variant="inline"
                        />
                      </>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rows.length > 0 ? (
        <>
          {lotRows.length > 0 ? (
            <div className="profile-section-label">Gossip leads</div>
          ) : null}
          <ul>
            {rows.map((r, i) => (
              <li key={i} className="knows-row">
                <div className="knows-stamp-line">
                  <span className="knows-stamp">
                    D{pad(r.day)} {pad(r.hour)}:00
                  </span>
                  <span className="knows-body">
                    from{" "}
                    <ActorChip
                      dump={dump}
                      actorId={r.fromActorId}
                      onSelect={onSelect}
                      size={14}
                    />{" "}
                    at{" "}
                    <LocationLink
                      dump={dump}
                      locationId={r.atLocationId}
                      onSelect={onSelect}
                    />
                  </span>
                </div>
                <div className="knows-fact">
                  {formatLead(r.lead, dump, onSelect)}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function formatLead(
  l: ExchangedLead,
  dump: RunDump,
  onSelect: (s: Selection) => void,
): JSX.Element {
  const item = dump.items.find((i) => i.id === l.subjectItemKindId);
  const itemLabel = item?.displayName ?? `kind ${l.subjectItemKindId}`;
  const tier = l.subjectQualityTier ?? null;
  const cp = l.counterpartyActorId;
  const verb = l.side === "supply" ? "has" : "wants";
  return (
    <>
      {cp !== null ? (
        <ActorChip dump={dump} actorId={cp} onSelect={onSelect} size={14} />
      ) : (
        <span className="muted">someone</span>
      )}{" "}
      {verb} {l.estimatedQuantity} {itemLabel}
      {tier !== null ? <span className="muted"> ({tier})</span> : null} @ £
      {l.estimatedUnitPrice}
      <span className="muted">
        {" · "}
        {l.confidence}
        {l.hopCount > 0 ? ` · hop ${l.hopCount}` : ""}
      </span>
    </>
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

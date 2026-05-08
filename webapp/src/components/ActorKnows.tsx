import { useMemo } from "react";
import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";

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

  if (rows.length === 0) {
    return (
      <div className="side-lower-empty muted">
        Nothing yet — nothing new learned by this point.
      </div>
    );
  }

  return (
    <section className="knows-list">
      <header className="knows-header muted">
        {rows.length} thing{rows.length === 1 ? "" : "s"} learned · as of D{day} {pad(hour)}:00
      </header>
      <ul>
        {rows.map((r, i) => (
          <li key={i} className="knows-row">
            <div className="knows-stamp-line">
              <span className="knows-stamp">
                D{pad(r.day)} {pad(r.hour)}:00
              </span>
              <span className="knows-body">
                from <ActorChip dump={dump} actorId={r.fromActorId} onSelect={onSelect} size={14} /> at{" "}
                <LocationLink dump={dump} locationId={r.atLocationId} onSelect={onSelect} />
              </span>
            </div>
            <div className="knows-fact">{formatLead(r.lead, dump, onSelect)}</div>
          </li>
        ))}
      </ul>
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

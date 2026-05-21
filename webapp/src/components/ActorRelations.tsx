import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { DealRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
}

interface RelationRow {
  readonly counterpartyActorId: number;
  /** How the focal actor rates the counterparty (focal = holder). */
  readonly outgoingScore: number;
  /** How the counterparty rates the focal actor (focal = target). */
  readonly incomingScore: number;
  /** Latest day either side moved. Used to sort recents first. */
  readonly lastDay: number;
}

interface TrustChangeEntry {
  readonly day: number;
  readonly hour: number;
  readonly direction: "outgoing" | "incoming";
  readonly delta: number;
  readonly newScore: number;
  readonly reason: string;
  readonly dealId: number;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The Relations tab: a per-counterparty view of trust scores plus a
 * collapsible timeline of every adjustment that landed during the run.
 *
 * Trust is per-pair and directional: A's view of B may differ from B's
 * view of A (especially when one side defaulted on the other). The
 * outgoing/incoming columns make that explicit.
 *
 * The timeline draws from `trust.adjusted` events emitted by
 * `trust-reactions.ts`. Each row carries the delta, the new score on
 * the holder's side, the deal that triggered the change, and the
 * reason ('settled' vs 'defaulted') — enough to read "she walked out
 * on him last Thursday."
 */
export function ActorRelations({
  dump,
  day,
  hour,
  snapshot,
  actorId,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  // Current scores from the snapshot, grouped by counterparty.
  const relations = useMemo<readonly RelationRow[]>(() => {
    if (snapshot === null) return [];
    const trustPairs = snapshot.trustPairs ?? [];
    const byCounterparty = new Map<
      number,
      { outgoing: number; incoming: number; lastDay: number }
    >();
    for (const p of trustPairs) {
      const lastDay = p.lastEventDay ?? 0;
      if (p.holderActorId === actorId) {
        const entry = byCounterparty.get(p.targetActorId) ?? {
          outgoing: 0,
          incoming: 0,
          lastDay: 0,
        };
        byCounterparty.set(p.targetActorId, {
          ...entry,
          outgoing: p.score,
          lastDay: Math.max(entry.lastDay, lastDay),
        });
      } else if (p.targetActorId === actorId) {
        const entry = byCounterparty.get(p.holderActorId) ?? {
          outgoing: 0,
          incoming: 0,
          lastDay: 0,
        };
        byCounterparty.set(p.holderActorId, {
          ...entry,
          incoming: p.score,
          lastDay: Math.max(entry.lastDay, lastDay),
        });
      }
    }
    const rows: RelationRow[] = [];
    for (const [cpId, scores] of byCounterparty) {
      rows.push({
        counterpartyActorId: cpId,
        outgoingScore: scores.outgoing,
        incomingScore: scores.incoming,
        lastDay: scores.lastDay,
      });
    }
    // Most recent activity first; ties broken by lowest score (the
    // dramatic ones float up).
    rows.sort((a, b) => {
      if (a.lastDay !== b.lastDay) return b.lastDay - a.lastDay;
      const aMin = Math.min(a.outgoingScore, a.incomingScore);
      const bMin = Math.min(b.outgoingScore, b.incomingScore);
      return aMin - bMin;
    });
    return rows;
  }, [snapshot, actorId]);

  // Per-counterparty trust-event timeline — derived from the event
  // stream, sliced to the current cursor.
  const changesByCounterparty = useMemo(() => {
    const m = new Map<number, TrustChangeEntry[]>();
    for (const e of dump.events as readonly RunEvent[]) {
      if (e.type !== "trust.adjusted") continue;
      if (e.at.day > day || (e.at.day === day && e.at.hour > hour)) continue;
      const holderId = e.holderActorId as number;
      const targetId = e.targetActorId as number;
      let cpId: number;
      let direction: "outgoing" | "incoming";
      if (holderId === actorId) {
        cpId = targetId;
        direction = "outgoing";
      } else if (targetId === actorId) {
        cpId = holderId;
        direction = "incoming";
      } else {
        continue;
      }
      const list = m.get(cpId) ?? [];
      list.push({
        day: e.at.day,
        hour: e.at.hour,
        direction,
        delta: e.delta as number,
        newScore: e.newScore as number,
        reason: String(e.reason),
        dealId: e.dealId as number,
      });
      m.set(cpId, list);
    }
    // Sort each timeline newest-first inside its counterparty.
    for (const arr of m.values()) {
      arr.sort((a, b) =>
        a.day !== b.day ? b.day - a.day : b.hour - a.hour,
      );
    }
    return m;
  }, [dump.events, day, hour, actorId]);

  if (relations.length === 0) {
    return (
      <div className="side-lower-empty muted">
        No trust history yet — this actor hasn't agreed or defaulted on
        any deal as of D{day} {pad(hour)}:00.
      </div>
    );
  }

  const toggle = (cpId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cpId)) next.delete(cpId);
      else next.add(cpId);
      return next;
    });
  };

  return (
    <section className="relations-list">
      <header className="relations-header muted">
        Trust as of D{day} {pad(hour)}:00 · {relations.length} counterpart
        {relations.length === 1 ? "y" : "ies"}
      </header>
      <ul className="relations-rows">
        {relations.map((r) => {
          const isOpen = expanded.has(r.counterpartyActorId);
          const changes = changesByCounterparty.get(r.counterpartyActorId) ?? [];
          return (
            <li key={r.counterpartyActorId} className="relations-row">
              <button
                type="button"
                className="relations-row-head"
                onClick={() => toggle(r.counterpartyActorId)}
                aria-expanded={isOpen}
              >
                <span className="relations-arrow muted">
                  {isOpen ? "▾" : "▸"}
                </span>
                <ActorChipById
                  dump={dump}
                  actorId={r.counterpartyActorId}
                  onSelect={onSelect}
                  size={18}
                />
                <span className="relations-scores">
                  <ScoreBadge label="me → them" score={r.outgoingScore} />
                  <ScoreBadge label="them → me" score={r.incomingScore} />
                </span>
              </button>
              {isOpen ? (
                <div className="relations-history">
                  {changes.length === 0 ? (
                    <div className="muted">No recorded trust changes.</div>
                  ) : (
                    <ul className="relations-history-list">
                      {changes.map((c, i) => (
                        <li key={i} className="relations-history-row">
                          <span className="muted">
                            D{pad(c.day)} {pad(c.hour)}:00
                          </span>
                          <span
                            className={
                              c.delta >= 0
                                ? "relations-delta-pos"
                                : "relations-delta-neg"
                            }
                          >
                            {c.delta >= 0 ? "+" : ""}
                            {c.delta}
                          </span>
                          <span className="muted">
                            → {c.newScore} ({c.direction})
                          </span>
                          <span className="muted">·</span>
                          <span>{c.reason}</span>
                          <span className="muted">·</span>
                          <DealRef
                            dump={dump}
                            id={c.dealId}
                            onSelect={onSelect}
                            variant="chip"
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ScoreBadge({
  label,
  score,
}: {
  readonly label: string;
  readonly score: number;
}) {
  const sign =
    score > 0 ? "relations-score-pos" : score < 0 ? "relations-score-neg" : "";
  return (
    <span className={`relations-score ${sign}`} title={label}>
      <span className="muted">{label}:</span> {score >= 0 ? "+" : ""}
      {score}
    </span>
  );
}

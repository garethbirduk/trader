import { useMemo, useState } from "react";
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

interface ItemGroup {
  readonly itemId: number;
  readonly tier: string | null;
  readonly supply: LearnedRow[];
  readonly demand: LearnedRow[];
}

interface PersonGroup {
  readonly counterpartyActorId: number | null;
  readonly rows: LearnedRow[];
}

type ViewMode = "timeline" | "item" | "person";

const VIEW_KEY = "trader-knows-view";

function readView(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw === "item" || raw === "person" || raw === "timeline") return raw;
  } catch {
    /* ignore */
  }
  return "timeline";
}

function writeView(v: ViewMode): void {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* quota / disabled */
  }
}

/** Subject identity for grouping: side + item + tier + counterparty.
 *  Two leads with the same key are "about the same fact" — qty/price
 *  estimates may differ, and that disagreement is what we want to
 *  surface as a conflict. */
function subjectKey(l: ExchangedLead): string {
  return [
    l.side,
    l.subjectItemKindId,
    l.subjectQualityTier ?? "_",
    l.counterpartyActorId ?? "_",
  ].join("|");
}

/** Compare rows: warm before cold, low hop before high, newest first. */
function cmpRows(a: LearnedRow, b: LearnedRow): number {
  const cA = a.lead.confidence === "warm" ? 0 : 1;
  const cB = b.lead.confidence === "warm" ? 0 : 1;
  if (cA !== cB) return cA - cB;
  if (a.lead.hopCount !== b.lead.hopCount)
    return a.lead.hopCount - b.lead.hopCount;
  if (a.day !== b.day) return b.day - a.day;
  return b.hour - a.hour;
}

export function ActorKnows({ dump, day, hour, actorId, onSelect }: Props) {
  const [view, setView] = useState<ViewMode>(() => readView());

  function pickView(v: ViewMode): void {
    setView(v);
    writeView(v);
  }

  // Auction-lot knowledge from `auction.knowledge-acquired` and
  // `auction.lot-inspected` events. Same shape as before.
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

  // All gossip leads received by this actor — no dedup. The same fact
  // arriving from two sources keeps both rows so conflicts are visible.
  const allRows = useMemo<readonly LearnedRow[]>(() => {
    const out: LearnedRow[] = [];
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
        out.push({
          day: e.at.day,
          hour: e.at.hour,
          fromActorId: x.fromActorId,
          atLocationId: e.atLocationId as number,
          lead: x.lead,
        });
      }
    }
    return out;
  }, [dump.events, actorId, day, hour]);

  // Timeline: first-time-learned for each distinct subject, newest first.
  // Matches the previous behaviour — useful for "what's new lately?"
  const timelineRows = useMemo<readonly LearnedRow[]>(() => {
    const seen = new Set<string>();
    const out: LearnedRow[] = [];
    for (const r of allRows) {
      const k = subjectKey(r.lead);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    out.reverse();
    return out;
  }, [allRows]);

  // By item: group by (item, tier), split into supply vs demand within.
  const itemGroups = useMemo<readonly ItemGroup[]>(() => {
    const byKey = new Map<string, ItemGroup>();
    for (const r of allRows) {
      const k = `${r.lead.subjectItemKindId}|${r.lead.subjectQualityTier ?? "_"}`;
      let g = byKey.get(k);
      if (g === undefined) {
        g = {
          itemId: r.lead.subjectItemKindId,
          tier: r.lead.subjectQualityTier,
          supply: [],
          demand: [],
        };
        byKey.set(k, g);
      }
      if (r.lead.side === "supply") g.supply.push(r);
      else g.demand.push(r);
    }
    const groups = [...byKey.values()];
    for (const g of groups) {
      g.supply.sort(cmpRows);
      g.demand.sort(cmpRows);
    }
    groups.sort((a, b) => {
      const an =
        dump.items.find((i) => i.id === a.itemId)?.displayName ??
        `kind ${a.itemId}`;
      const bn =
        dump.items.find((i) => i.id === b.itemId)?.displayName ??
        `kind ${b.itemId}`;
      return an.localeCompare(bn);
    });
    return groups;
  }, [allRows, dump.items]);

  // By person (subject = the counterparty the leads are *about*).
  const personGroups = useMemo<readonly PersonGroup[]>(() => {
    const byKey = new Map<string, PersonGroup>();
    for (const r of allRows) {
      const k = r.lead.counterpartyActorId === null
        ? "_null"
        : String(r.lead.counterpartyActorId);
      let g = byKey.get(k);
      if (g === undefined) {
        g = { counterpartyActorId: r.lead.counterpartyActorId, rows: [] };
        byKey.set(k, g);
      }
      g.rows.push(r);
    }
    const groups = [...byKey.values()];
    for (const g of groups) g.rows.sort(cmpRows);
    groups.sort((a, b) => {
      if (a.counterpartyActorId === null) return 1;
      if (b.counterpartyActorId === null) return -1;
      const an =
        dump.actors.find((x) => x.id === a.counterpartyActorId)?.displayName ??
        `actor ${a.counterpartyActorId}`;
      const bn =
        dump.actors.find((x) => x.id === b.counterpartyActorId)?.displayName ??
        `actor ${b.counterpartyActorId}`;
      return an.localeCompare(bn);
    });
    return groups;
  }, [allRows, dump.actors]);

  const totalDistinctFacts = timelineRows.length;

  if (totalDistinctFacts === 0 && lotRows.length === 0) {
    return (
      <div className="side-lower-empty muted">
        Nothing yet — nothing new learned by this point.
      </div>
    );
  }

  return (
    <section className="knows-list">
      <header className="knows-header">
        <span className="muted">
          {totalDistinctFacts} fact{totalDistinctFacts === 1 ? "" : "s"} · as of D
          {day} {pad(hour)}:00 ({allRows.length} lead
          {allRows.length === 1 ? "" : "s"} received)
        </span>
        {totalDistinctFacts > 0 ? (
          <nav className="knows-views" aria-label="Group gossip leads by">
            <button
              type="button"
              className={`knows-view-btn${view === "timeline" ? " active" : ""}`}
              onClick={() => pickView("timeline")}
            >
              Timeline
            </button>
            <button
              type="button"
              className={`knows-view-btn${view === "item" ? " active" : ""}`}
              onClick={() => pickView("item")}
            >
              By item
            </button>
            <button
              type="button"
              className={`knows-view-btn${view === "person" ? " active" : ""}`}
              onClick={() => pickView("person")}
            >
              By person
            </button>
          </nav>
        ) : null}
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
                      variant="chip"
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
                          variant="chip"
                          size={14}
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

      {totalDistinctFacts > 0 ? (
        <>
          {lotRows.length > 0 ? (
            <div className="profile-section-label">Gossip leads</div>
          ) : null}
          {view === "timeline" ? (
            <TimelineView rows={timelineRows} dump={dump} onSelect={onSelect} />
          ) : null}
          {view === "item" ? (
            <ByItemView groups={itemGroups} dump={dump} onSelect={onSelect} />
          ) : null}
          {view === "person" ? (
            <ByPersonView
              groups={personGroups}
              dump={dump}
              onSelect={onSelect}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function TimelineView({
  rows,
  dump,
  onSelect,
}: {
  readonly rows: readonly LearnedRow[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
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
          <div className="knows-fact">{formatLead(r.lead, dump, onSelect)}</div>
        </li>
      ))}
    </ul>
  );
}

function ByItemView({
  groups,
  dump,
  onSelect,
}: {
  readonly groups: readonly ItemGroup[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
    <ul className="knows-groups">
      {groups.map((g) => {
        const item = dump.items.find((i) => i.id === g.itemId);
        const itemName = item?.displayName ?? `kind ${g.itemId}`;
        const totalLeads = g.supply.length + g.demand.length;
        return (
          <li
            key={`${g.itemId}|${g.tier ?? "_"}`}
            className="knows-group"
          >
            <div className="knows-group-header">
              <button
                type="button"
                className="ref ref-inline ref-item knows-group-title"
                onClick={() => onSelect({ kind: "item", id: g.itemId })}
                title={itemName}
              >
                {itemName}
              </button>
              {g.tier !== null ? (
                <span className={`tier tier-${g.tier}`}>{g.tier}</span>
              ) : null}
              <span className="knows-group-count muted">
                {totalLeads} lead{totalLeads === 1 ? "" : "s"}
              </span>
            </div>
            {g.supply.length > 0 ? (
              <SubgroupRows
                label="Supply"
                rows={g.supply}
                showItem={false}
                showCounterparty={true}
                dump={dump}
                onSelect={onSelect}
              />
            ) : null}
            {g.demand.length > 0 ? (
              <SubgroupRows
                label="Demand"
                rows={g.demand}
                showItem={false}
                showCounterparty={true}
                dump={dump}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ByPersonView({
  groups,
  dump,
  onSelect,
}: {
  readonly groups: readonly PersonGroup[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
    <ul className="knows-groups">
      {groups.map((g) => {
        const supply = g.rows.filter((r) => r.lead.side === "supply");
        const demand = g.rows.filter((r) => r.lead.side === "demand");
        return (
          <li
            key={g.counterpartyActorId === null ? "_null" : g.counterpartyActorId}
            className="knows-group"
          >
            <div className="knows-group-header">
              {g.counterpartyActorId !== null ? (
                <ActorChip
                  dump={dump}
                  actorId={g.counterpartyActorId}
                  onSelect={onSelect}
                  size={16}
                />
              ) : (
                <span className="muted">unspecified counterparty</span>
              )}
              <span className="knows-group-count muted">
                {g.rows.length} lead{g.rows.length === 1 ? "" : "s"}
              </span>
            </div>
            {supply.length > 0 ? (
              <SubgroupRows
                label="Supplies"
                rows={supply}
                showItem={true}
                showCounterparty={false}
                dump={dump}
                onSelect={onSelect}
              />
            ) : null}
            {demand.length > 0 ? (
              <SubgroupRows
                label="Wants"
                rows={demand}
                showItem={true}
                showCounterparty={false}
                dump={dump}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function SubgroupRows({
  label,
  rows,
  showItem,
  showCounterparty,
  dump,
  onSelect,
}: {
  readonly label: string;
  readonly rows: readonly LearnedRow[];
  readonly showItem: boolean;
  readonly showCounterparty: boolean;
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  // Detect conflict by subject: rows about the same subject with
  // diverging qty or price are in disagreement. In By-Item view all
  // rows share item+tier, so subject equivalence is by counterparty.
  // In By-Person view all rows share counterparty, so subject
  // equivalence is by item+tier.
  const conflictMap = new Map<string, { priceVaries: boolean; qtyVaries: boolean }>();
  {
    const subjectGroups = new Map<string, LearnedRow[]>();
    for (const r of rows) {
      const k = subjectKey(r.lead);
      const arr = subjectGroups.get(k) ?? [];
      arr.push(r);
      subjectGroups.set(k, arr);
    }
    for (const [k, arr] of subjectGroups) {
      if (arr.length < 2) continue;
      const prices = new Set(arr.map((r) => r.lead.estimatedUnitPrice));
      const qtys = new Set(arr.map((r) => r.lead.estimatedQuantity));
      if (prices.size > 1 || qtys.size > 1) {
        conflictMap.set(k, {
          priceVaries: prices.size > 1,
          qtyVaries: qtys.size > 1,
        });
      }
    }
  }
  const groupHasConflict = conflictMap.size > 0;
  return (
    <>
      <div className="knows-subgroup-label">
        {label}
        {groupHasConflict ? (
          <span className="knows-conflict-badge" title="Sources disagree">
            {" ⚠"}
          </span>
        ) : null}
      </div>
      <ul className="knows-subgroup-rows">
        {rows.map((r, i) => {
          const k = subjectKey(r.lead);
          const conflict = conflictMap.get(k);
          const item = dump.items.find(
            (it) => it.id === r.lead.subjectItemKindId,
          );
          const itemName = item?.displayName ?? `kind ${r.lead.subjectItemKindId}`;
          return (
            <li key={i} className="knows-grouped-row">
              <div className="knows-grouped-fact">
                {showItem ? (
                  <>
                    <button
                      type="button"
                      className="ref ref-inline ref-item"
                      onClick={() =>
                        onSelect({ kind: "item", id: r.lead.subjectItemKindId })
                      }
                    >
                      {itemName}
                    </button>
                    {r.lead.subjectQualityTier !== null ? (
                      <span
                        className={`tier tier-${r.lead.subjectQualityTier}`}
                      >
                        {r.lead.subjectQualityTier}
                      </span>
                    ) : null}{" "}
                  </>
                ) : null}
                {showCounterparty ? (
                  r.lead.counterpartyActorId !== null ? (
                    <>
                      <ActorChip
                        dump={dump}
                        actorId={r.lead.counterpartyActorId}
                        onSelect={onSelect}
                        size={12}
                      />{" "}
                    </>
                  ) : (
                    <span className="muted">someone </span>
                  )
                ) : null}
                <span
                  className={
                    conflict?.qtyVaries
                      ? "knows-value knows-value-divergent"
                      : "knows-value"
                  }
                >
                  {r.lead.estimatedQuantity}
                </span>
                <span className="muted"> @ </span>
                <span
                  className={
                    conflict?.priceVaries
                      ? "knows-value knows-value-divergent"
                      : "knows-value"
                  }
                >
                  £{r.lead.estimatedUnitPrice}
                </span>
              </div>
              <div className="knows-source-line muted">
                from{" "}
                <ActorChip
                  dump={dump}
                  actorId={r.fromActorId}
                  onSelect={onSelect}
                  size={12}
                />{" "}
                · {r.lead.confidence}
                {r.lead.hopCount > 0 ? ` · hop ${r.lead.hopCount}` : ""} · D
                {pad(r.day)} {pad(r.hour)}:00
              </div>
            </li>
          );
        })}
      </ul>
    </>
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

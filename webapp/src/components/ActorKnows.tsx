import { useMemo, useState } from "react";
import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";
import { ActorRef, ItemRef, LotRef } from "./Refs.js";
import { StockLine, StockValue } from "./StockLine.js";
import {
  estimateUnitRetail,
  formatRetailEstimate,
} from "../lib/retail-estimate.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
}

interface ExchangedLead {
  /** Lead id in the receiver's bag — added by the engine so the UI
   *  can correlate received gossip with later detail-unlock events.
   *  Optional for back-compat with older dumps that didn't carry it. */
  readonly id?: number;
  readonly kind: "commodity" | "rep";
  readonly side: "supply" | "demand";
  /** Null for rep leads. */
  readonly subjectItemKindId: number | null;
  readonly subjectQualityTier: string | null;
  /** Rep-only: the actor the lead is about. */
  readonly subjectTargetActorId: number | null;
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

  // Two-tier gossip — track which received leads have been unlocked
  // (their detail tier is visible to the holder). Default is locked;
  // each `gossip.detail-unlocked` event for this actor flips one or
  // more lead ids to unlocked. Locked rows render headline-only.
  const unlockedLeadIds = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>();
    for (const e of dump.events) {
      if (e.type !== "gossip.detail-unlocked") continue;
      if (e.askerActorId !== actorId) continue;
      if (e.at.day > day || (e.at.day === day && e.at.hour > hour)) continue;
      const leads = (e.unlockedLeads ?? []) as readonly { leadId: number; unlocked: boolean }[];
      for (const u of leads) {
        if (u.unlocked) out.add(u.leadId);
      }
    }
    return out;
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

  // Commodity-only stream feeds the existing timeline/item/person views.
  // Rep leads use a separate surface (see `repRows` below).
  const commodityRows = useMemo<readonly LearnedRow[]>(
    () => allRows.filter((r) => r.lead.kind !== "rep"),
    [allRows],
  );

  // Rep leads — both first-hand (the actor got burned themselves; spawned
  // via `rep.spawned`) and gossip-received (via `gossip.exchanged`).
  // Freshest first. Conflicts (two versions of "Boyce burned Trigger" /
  // "Trigger burned Boyce") appear as two rows because we don't dedup —
  // exactly what the design wants.
  const repRows = useMemo<readonly LearnedRow[]>(() => {
    const fromGossip = allRows.filter((r) => r.lead.kind === "rep");
    const fromFirstHand: LearnedRow[] = [];
    for (const e of dump.events) {
      if (e.type !== "rep.spawned") continue;
      if ((e.holderActorId as number) !== actorId) continue;
      if (e.at.day > day || (e.at.day === day && e.at.hour > hour)) continue;
      fromFirstHand.push({
        day: e.at.day,
        hour: e.at.hour,
        fromActorId: actorId, // first-hand grievance, the holder is the source
        atLocationId: 0,
        lead: {
          kind: "rep",
          side: "supply",
          subjectItemKindId: null,
          subjectQualityTier: null,
          subjectTargetActorId: e.subjectTargetActorId as number,
          counterpartyActorId: e.counterpartyActorId as number,
          estimatedQuantity: 1,
          estimatedUnitPrice: e.damage as number,
          confidence: "warm",
          hopCount: 0,
          sourceActorId: null,
        },
      });
    }
    return [...fromGossip, ...fromFirstHand].sort(cmpRows);
  }, [allRows, dump.events, actorId, day, hour]);

  // Timeline: first-time-learned for each distinct subject, newest first.
  // Matches the previous behaviour — useful for "what's new lately?"
  const timelineRows = useMemo<readonly LearnedRow[]>(() => {
    const seen = new Set<string>();
    const out: LearnedRow[] = [];
    for (const r of commodityRows) {
      const k = subjectKey(r.lead);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    out.reverse();
    return out;
  }, [commodityRows]);

  // By item: group by (item, tier), split into supply vs demand within.
  const itemGroups = useMemo<readonly ItemGroup[]>(() => {
    const byKey = new Map<string, ItemGroup>();
    for (const r of commodityRows) {
      if (r.lead.subjectItemKindId === null) continue;
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
  }, [commodityRows, dump.items]);

  // By person (subject = the counterparty the leads are *about*).
  const personGroups = useMemo<readonly PersonGroup[]>(() => {
    const byKey = new Map<string, PersonGroup>();
    for (const r of commodityRows) {
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
  }, [commodityRows, dump.actors]);

  const totalDistinctFacts = timelineRows.length;

  if (totalDistinctFacts === 0 && lotRows.length === 0 && repRows.length === 0) {
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

      {repRows.length > 0 ? (
        <>
          <div className="profile-section-label">Reputation</div>
          <ul>
            {repRows.map((r, i) => {
              const targetId = r.lead.subjectTargetActorId;
              const victimId = r.lead.counterpartyActorId;
              return (
                <li key={`rep-${i}`} className="knows-row">
                  <div className="knows-stamp-line">
                    <span className="knows-stamp">
                      D{pad(r.day)} {pad(r.hour)}:00
                    </span>
                    <span className="knows-body">
                      {targetId !== null ? (
                        <ActorRef
                          dump={dump}
                          id={targetId}
                          onSelect={onSelect}
                          variant="chip"
                          size={14}
                        />
                      ) : (
                        <span className="muted">?</span>
                      )}{" "}
                      burned{" "}
                      {victimId !== null ? (
                        <ActorRef
                          dump={dump}
                          id={victimId}
                          onSelect={onSelect}
                          variant="chip"
                          size={14}
                        />
                      ) : (
                        <span className="muted">someone</span>
                      )}{" "}
                      <span className="muted">
                        for £{r.lead.estimatedUnitPrice} · {r.lead.confidence} ·
                        hop {r.lead.hopCount}
                      </span>
                      {r.fromActorId !== actorId ? (
                        <>
                          {" "}
                          <span className="muted">from</span>{" "}
                          <ActorChip
                            dump={dump}
                            actorId={r.fromActorId}
                            onSelect={onSelect}
                            size={14}
                          />
                        </>
                      ) : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

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
            <TimelineView
              rows={timelineRows}
              dump={dump}
              unlockedLeadIds={unlockedLeadIds}
              onSelect={onSelect}
            />
          ) : null}
          {view === "item" ? (
            <ByItemView
              groups={itemGroups}
              dump={dump}
              actorId={actorId}
              unlockedLeadIds={unlockedLeadIds}
              onSelect={onSelect}
            />
          ) : null}
          {view === "person" ? (
            <ByPersonView
              groups={personGroups}
              dump={dump}
              actorId={actorId}
              unlockedLeadIds={unlockedLeadIds}
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
  unlockedLeadIds,
  onSelect,
}: {
  readonly rows: readonly LearnedRow[];
  readonly dump: RunDump;
  readonly unlockedLeadIds: ReadonlySet<number>;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
    <ul>
      {rows.map((r, i) => {
        const unlocked = isLeadUnlocked(r.lead, unlockedLeadIds);
        return (
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
                {!unlocked ? (
                  <span className="muted" title="Headline only — pay to unlock detail.">
                    {" "}· headline
                  </span>
                ) : null}
              </span>
            </div>
            <div className="knows-fact">
              {unlocked
                ? formatLead(r.lead, dump, onSelect)
                : formatHeadline(r.lead, dump, onSelect)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A lead is unlocked if it's first-hand (rep, no id from gossip) or
 *  its id appears in the unlock set. Defensive — old dumps that don't
 *  carry lead ids fall back to "unlocked" so legacy rendering doesn't
 *  regress to all-locked. */
function isLeadUnlocked(
  lead: ExchangedLead,
  unlocked: ReadonlySet<number>,
): boolean {
  if (lead.kind === "rep") return true;
  if (lead.id === undefined) return true;
  return unlocked.has(lead.id);
}

function ByItemView({
  groups,
  dump,
  actorId,
  unlockedLeadIds,
  onSelect,
}: {
  readonly groups: readonly ItemGroup[];
  readonly dump: RunDump;
  readonly actorId: number;
  readonly unlockedLeadIds: ReadonlySet<number>;
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
                receiverActorId={actorId}
                unlockedLeadIds={unlockedLeadIds}
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
                receiverActorId={actorId}
                unlockedLeadIds={unlockedLeadIds}
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
  actorId,
  unlockedLeadIds,
  onSelect,
}: {
  readonly groups: readonly PersonGroup[];
  readonly dump: RunDump;
  readonly actorId: number;
  readonly unlockedLeadIds: ReadonlySet<number>;
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
                receiverActorId={actorId}
                unlockedLeadIds={unlockedLeadIds}
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
                receiverActorId={actorId}
                unlockedLeadIds={unlockedLeadIds}
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
  receiverActorId,
  unlockedLeadIds,
  onSelect,
}: {
  readonly label: string;
  readonly rows: readonly LearnedRow[];
  readonly showItem: boolean;
  readonly showCounterparty: boolean;
  readonly dump: RunDump;
  /** The actor whose knowledge this is — drives the retail-estimate
   *  calculation (the receiver's own guess at value, given the
   *  claimed tier from the gossip; their estimate is no better than
   *  their bidder profile says, and uninspected hearsay carries its
   *  speaker's possibly-wrong tier verbatim). */
  readonly receiverActorId: number;
  readonly unlockedLeadIds: ReadonlySet<number>;
  readonly onSelect: (s: Selection) => void;
}) {
  const receiver = dump.actors.find((a) => a.id === receiverActorId);
  const receiverProfile = receiver?.bidderProfile;
  // Detect conflict by subject: rows about the same subject with
  // diverging qty or price are in disagreement. In By-Item view all
  // rows share item+tier, so subject equivalence is by counterparty.
  // In By-Person view all rows share counterparty, so subject
  // equivalence is by item+tier.
  const conflictMap = new Map<string, { priceVaries: boolean; qtyVaries: boolean }>();
  {
    // Only unlocked rows participate in conflict detection — the locked
    // rows hide their numeric values, so disagreement on hidden data
    // would be a badge with no visible cause.
    const subjectGroups = new Map<string, LearnedRow[]>();
    for (const r of rows) {
      if (!isLeadUnlocked(r.lead, unlockedLeadIds)) continue;
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
          const unlocked = isLeadUnlocked(r.lead, unlockedLeadIds);
          const k = subjectKey(r.lead);
          const conflict = conflictMap.get(k);
          // Retail estimate from the receiver's perspective — same
          // shape as inventory's retail column. The claimed tier
          // drives it: until the receiver inspects (auction-lot
          // mechanic only, not modelled here), they trust the
          // speaker's tier verbatim. Civilians with no bidder
          // profile get no estimate. Locked rows skip this — there's
          // no claimed tier to value yet.
          const item = dump.items.find(
            (it) => it.id === r.lead.subjectItemKindId,
          );
          const retailEstimate =
            unlocked && receiverProfile !== undefined && item !== undefined
              ? estimateUnitRetail(
                  receiverProfile,
                  item,
                  r.lead.subjectQualityTier ?? "fair",
                  dump.economics,
                )
              : null;
          const counterpartyChip = r.lead.counterpartyActorId !== null ? (
            <ActorChip
              dump={dump}
              actorId={r.lead.counterpartyActorId}
              onSelect={onSelect}
              size={12}
            />
          ) : (
            <span className="muted">someone</span>
          );
          return (
            <StockLine
              key={i}
              fact={
                unlocked ? (
                  <>
                    {showCounterparty ? (
                      r.lead.counterpartyActorId !== null ? (
                        <>
                          {counterpartyChip}{" "}
                          <span className="muted">has</span>{" "}
                        </>
                      ) : (
                        <span className="muted">someone has</span>
                      )
                    ) : (
                      <span className="muted">has</span>
                    )}{" "}
                    <StockValue divergent={conflict?.qtyVaries}>
                      {r.lead.estimatedQuantity}
                    </StockValue>{" "}
                    {showItem && r.lead.subjectItemKindId !== null ? (
                      <ItemRef
                        dump={dump}
                        id={r.lead.subjectItemKindId}
                        onSelect={onSelect}
                        variant="chip"
                        qualityTier={r.lead.subjectQualityTier ?? undefined}
                      />
                    ) : r.lead.subjectQualityTier !== null ? (
                      <span className={`tier tier-${r.lead.subjectQualityTier}`}>
                        {r.lead.subjectQualityTier}
                      </span>
                    ) : null}{" "}
                    <span className="muted">@</span>{" "}
                    <StockValue divergent={conflict?.priceVaries}>
                      £{r.lead.estimatedUnitPrice}
                    </StockValue>
                    <span className="muted">/u</span>
                  </>
                ) : (
                  <>
                    {showCounterparty ? (
                      r.lead.counterpartyActorId !== null ? (
                        <>{counterpartyChip}{" "}</>
                      ) : (
                        <span className="muted">someone </span>
                      )
                    ) : null}
                    <span className="muted">
                      {r.lead.side === "supply" ? "has" : "wants"}
                    </span>{" "}
                    {showItem && r.lead.subjectItemKindId !== null ? (
                      <ItemRef
                        dump={dump}
                        id={r.lead.subjectItemKindId}
                        onSelect={onSelect}
                        variant="chip"
                      />
                    ) : (
                      <span className="muted">(item)</span>
                    )}{" "}
                    <span className="muted" title="Headline only — pay to unlock detail.">
                      · headline
                    </span>
                  </>
                )
              }
              meta={
                <>
                  {retailEstimate !== null ? (
                    <>
                      <span
                        title={`Your retail estimate at the claimed tier (${r.lead.subjectQualityTier ?? "fair"}), based on your category accuracy. Inspect the lot to tighten the range.`}
                      >
                        ~£{formatRetailEstimate(retailEstimate)} retail
                      </span>
                      <span>·</span>
                    </>
                  ) : null}
                  from{" "}
                  <ActorChip
                    dump={dump}
                    actorId={r.fromActorId}
                    onSelect={onSelect}
                    size={12}
                  />{" "}
                  {unlocked ? (
                    <>
                      · {r.lead.confidence}
                      {r.lead.hopCount > 0 ? ` · hop ${r.lead.hopCount}` : ""} ·{" "}
                    </>
                  ) : (
                    <>· </>
                  )}
                  D{pad(r.day)} {pad(r.hour)}:00
                </>
              }
            />
          );
        })}
      </ul>
    </>
  );
}

function formatHeadline(
  l: ExchangedLead,
  dump: RunDump,
  onSelect: (s: Selection) => void,
): JSX.Element {
  const item = dump.items.find((i) => i.id === l.subjectItemKindId);
  const itemLabel = item?.displayName ?? `kind ${l.subjectItemKindId}`;
  const cp = l.counterpartyActorId;
  const verb = l.side === "supply" ? "has" : "wants";
  return (
    <>
      {cp !== null ? (
        <ActorChip dump={dump} actorId={cp} onSelect={onSelect} size={14} />
      ) : (
        <span className="muted">someone</span>
      )}{" "}
      {verb} {itemLabel}
      <span className="muted"> · headline — buy a drink to learn more</span>
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

import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip } from "./Links.js";
import { colourFor, resolvePerceiverJ } from "../lib/palette.js";
import { BeliefChip } from "./BeliefChip.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
}

/** Bag-of-leads row reconstructed from the gossip.exchanged event stream
 *  (mirrors ActorKnows). Notebook only uses commodity leads. */
interface BagLead {
  readonly id?: number;
  readonly side: "supply" | "demand";
  readonly itemKindId: number;
  readonly itemTier: string | null;
  readonly counterpartyActorId: number;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly confidence: "warm" | "cold";
  readonly hopCount: number;
}

interface NotebookRow {
  readonly side: "sell" | "buy";
  readonly itemKindId: number;
  readonly itemTier: string | null;
  readonly counterpartyActorId: number;
  readonly myQty: number | null;
  readonly myUnitCost: number | null;
  readonly theirQty: number | null;
  readonly theirUnitPrice: number | null;
  readonly score: number | null;
  readonly unlocked: boolean;
  /** Counterparty's appraisal accuracy on this row's category, or null
   *  when they have no bidder profile. Rendered as a palette-coloured
   *  dot through the player's perceiver-j (docs/judgement.md). */
  readonly counterpartyAccuracy: number | null;
  /** Category label for the dot's tooltip ("Furniture · accuracy 0.45"). */
  readonly counterpartyCategory: string | null;
  /** Buy-side only: who the best onward buyer is, when known. */
  readonly onwardBuyerActorId: number | null;
  /** Buy-side only: best onward unit price among unlocked demand leads. */
  readonly onwardUnitPrice: number | null;
}

/** Lower hop wins, warm beats cold, newer id wins ties. */
function preferLead(a: BagLead, b: BagLead): BagLead {
  if (a.hopCount !== b.hopCount) return a.hopCount < b.hopCount ? a : b;
  const ac = a.confidence === "warm" ? 0 : 1;
  const bc = b.confidence === "warm" ? 0 : 1;
  if (ac !== bc) return ac < bc ? a : b;
  if (a.id !== undefined && b.id !== undefined) return a.id > b.id ? a : b;
  return a;
}

export function ActorNotebook({ dump, day, hour, snapshot, actorId, onSelect }: Props) {
  const perceiverJ = useMemo(() => resolvePerceiverJ(dump), [dump]);

  // Locked-lead set — same replay ActorKnows uses.
  const unlockedLeadIds = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>();
    for (const e of dump.events) {
      if (e.type !== "gossip.detail-unlocked") continue;
      if (e.askerActorId !== actorId) continue;
      if (e.at.day > day || (e.at.day === day && e.at.hour > hour)) continue;
      const leads = (e.unlockedLeads ?? []) as readonly { leadId: number; unlocked: boolean }[];
      for (const u of leads) if (u.unlocked) out.add(u.leadId);
    }
    return out;
  }, [dump.events, actorId, day, hour]);

  // Reconstruct the actor's commodity-lead bag from gossip.exchanged
  // up to (day, hour). Dedup by (side, item, counterparty) — keep the
  // best lead per group, same heuristic as the engine compute uses.
  const { bestDemand, bestSupply } = useMemo(() => {
    const demand = new Map<string, BagLead>();
    const supply = new Map<string, BagLead>();
    for (const e of dump.events) {
      if (e.type !== "gossip.exchanged") continue;
      if (e.at.day > day || (e.at.day === day && e.at.hour > hour)) continue;
      const exchanges = (e.exchanges as readonly {
        readonly toActorId: number;
        readonly lead: {
          readonly id?: number;
          readonly kind: "commodity" | "rep";
          readonly side: "supply" | "demand";
          readonly subjectItemKindId: number | null;
          readonly subjectQualityTier: string | null;
          readonly counterpartyActorId: number | null;
          readonly estimatedQuantity: number;
          readonly estimatedUnitPrice: number;
          readonly confidence: "warm" | "cold";
          readonly hopCount: number;
        };
      }[] | undefined) ?? [];
      for (const x of exchanges) {
        if (x.toActorId !== actorId) continue;
        const l = x.lead;
        if (l.kind !== "commodity") continue;
        if (l.subjectItemKindId === null) continue;
        if (l.counterpartyActorId === null) continue;
        const row: BagLead = {
          ...(l.id !== undefined ? { id: l.id } : {}),
          side: l.side,
          itemKindId: l.subjectItemKindId,
          itemTier: l.subjectQualityTier,
          counterpartyActorId: l.counterpartyActorId,
          estimatedQuantity: l.estimatedQuantity,
          estimatedUnitPrice: l.estimatedUnitPrice,
          confidence: l.confidence,
          hopCount: l.hopCount,
        };
        const k = `${row.itemKindId}|${row.counterpartyActorId}`;
        const target = row.side === "demand" ? demand : supply;
        const existing = target.get(k);
        target.set(k, existing === undefined ? row : preferLead(row, existing));
      }
    }
    return { bestDemand: demand, bestSupply: supply };
  }, [dump.events, actorId, day, hour]);

  // Item-category lookup, memoised.
  const categoryByItem = useMemo<ReadonlyMap<number, string>>(() => {
    const out = new Map<number, string>();
    for (const it of dump.items) out.set(it.id, it.category);
    return out;
  }, [dump.items]);

  // Bidder profile lookup.
  const profileByActor = useMemo(() => {
    const out = new Map<number, NonNullable<RunDump["actors"][number]["knowledgeProfile"]>>();
    for (const a of dump.actors) {
      if (a.knowledgeProfile !== undefined) out.set(a.id, a.knowledgeProfile);
    }
    return out;
  }, [dump.actors]);

  /** Counterparty's per-category appraisal accuracy on the row's
   *  category — fed to the palette dot. Null when the counterparty
   *  has no bidder profile (civilians, virtual producers). */
  function counterpartyAccuracyOn(cpId: number, itemKindId: number): number | null {
    const p = profileByActor.get(cpId);
    if (p === undefined) return null;
    const category = categoryByItem.get(itemKindId) ?? "_";
    return p.priceAccuracy[category] ?? p.defaultPriceAccuracy;
  }

  // Stock aggregated by item kind.
  const stockByItem = useMemo<ReadonlyMap<number, { qty: number; cost: number }>>(() => {
    const out = new Map<number, { qty: number; cost: number }>();
    if (snapshot === null) return out;
    for (const lot of snapshot.stockLots) {
      if (lot.ownerActorId !== actorId) continue;
      const agg = out.get(lot.itemKindId) ?? { qty: 0, cost: 0 };
      agg.qty += lot.quantity;
      agg.cost += lot.quantity * lot.acquiredUnitPrice;
      out.set(lot.itemKindId, agg);
    }
    return out;
  }, [snapshot, actorId]);

  // Best onward unit price per item, derived from this actor's
  // unlocked demand leads. Drives buy-side scoring.
  const bestOnward = useMemo<ReadonlyMap<number, { actorId: number; price: number }>>(() => {
    const out = new Map<number, { actorId: number; price: number }>();
    for (const l of bestDemand.values()) {
      const unlocked = l.id === undefined ? true : unlockedLeadIds.has(l.id);
      if (!unlocked) continue;
      const prev = out.get(l.itemKindId);
      if (prev === undefined || l.estimatedUnitPrice > prev.price) {
        out.set(l.itemKindId, {
          actorId: l.counterpartyActorId,
          price: l.estimatedUnitPrice,
        });
      }
    }
    return out;
  }, [bestDemand, unlockedLeadIds]);

  const rows = useMemo<NotebookRow[]>(() => {
    const out: NotebookRow[] = [];

    // Sell-side.
    for (const lead of bestDemand.values()) {
      const stock = stockByItem.get(lead.itemKindId);
      if (stock === undefined || stock.qty === 0) continue;
      const unlocked = lead.id === undefined ? true : unlockedLeadIds.has(lead.id);
      const myUnitCost = Math.round(stock.cost / stock.qty);
      const theirQty = unlocked ? lead.estimatedQuantity : null;
      const theirUnitPrice = unlocked ? lead.estimatedUnitPrice : null;
      const score =
        unlocked && theirQty !== null && theirUnitPrice !== null
          ? (theirUnitPrice - myUnitCost) * Math.min(stock.qty, theirQty)
          : null;
      out.push({
        side: "sell",
        itemKindId: lead.itemKindId,
        itemTier: lead.itemTier,
        counterpartyActorId: lead.counterpartyActorId,
        myQty: stock.qty,
        myUnitCost,
        theirQty,
        theirUnitPrice,
        score,
        unlocked,
        counterpartyAccuracy: counterpartyAccuracyOn(lead.counterpartyActorId, lead.itemKindId),
        counterpartyCategory: categoryByItem.get(lead.itemKindId) ?? null,
        onwardBuyerActorId: null,
        onwardUnitPrice: null,
      });
    }

    // Buy-side: only items the holder has a demand lead for.
    const itemsIWant = new Set<number>();
    for (const l of bestDemand.values()) itemsIWant.add(l.itemKindId);
    for (const lead of bestSupply.values()) {
      if (!itemsIWant.has(lead.itemKindId)) continue;
      const unlocked = lead.id === undefined ? true : unlockedLeadIds.has(lead.id);
      const theirQty = unlocked ? lead.estimatedQuantity : null;
      const theirUnitPrice = unlocked ? lead.estimatedUnitPrice : null;
      const onward = bestOnward.get(lead.itemKindId);
      // Drop self-pair rows: when the only onward buyer the holder knows
      // about is the same actor as the supplier, the "trade" is just
      // their bid/ask spread — not an opportunity. The supply knowledge
      // is still surfaced in ActorKnows; the notebook is the
      // buy-to-flip lane and reserves space for cross-actor flips.
      if (onward !== undefined && onward.actorId === lead.counterpartyActorId) continue;
      const score =
        unlocked && theirQty !== null && theirUnitPrice !== null && onward !== undefined
          ? (onward.price - theirUnitPrice) * theirQty
          : null;
      out.push({
        side: "buy",
        itemKindId: lead.itemKindId,
        itemTier: lead.itemTier,
        counterpartyActorId: lead.counterpartyActorId,
        myQty: null,
        myUnitCost: null,
        theirQty,
        theirUnitPrice,
        score,
        unlocked,
        counterpartyAccuracy: counterpartyAccuracyOn(lead.counterpartyActorId, lead.itemKindId),
        counterpartyCategory: categoryByItem.get(lead.itemKindId) ?? null,
        onwardBuyerActorId: onward?.actorId ?? null,
        onwardUnitPrice: onward?.price ?? null,
      });
    }
    return out;
  }, [bestDemand, bestSupply, stockByItem, bestOnward, unlockedLeadIds, profileByActor, categoryByItem]);

  const sellRows = useMemo(
    () => rows.filter((r) => r.side === "sell").sort(byScoreDesc),
    [rows],
  );
  const buyRows = useMemo(
    () => rows.filter((r) => r.side === "buy").sort(byScoreDesc),
    [rows],
  );

  if (rows.length === 0) {
    return (
      <div className="side-lower-empty muted">
        Nothing actionable yet — no notebook rows by this point.
      </div>
    );
  }

  return (
    <section className="notebook-list">
      <header className="knows-header">
        <span className="muted">
          {rows.length} row{rows.length === 1 ? "" : "s"} · as of D{day} {pad(hour)}:00
        </span>
      </header>

      {sellRows.length > 0 ? (
        <>
          <div className="profile-section-label">Stock I have → who wants it</div>
          <ul className="knows-subgroup-rows">
            {sellRows.map((r) => (
              <SellRow key={`s-${r.itemKindId}-${r.counterpartyActorId}`} row={r} dump={dump} perceiverJ={perceiverJ} onSelect={onSelect} />
            ))}
          </ul>
        </>
      ) : null}

      {buyRows.length > 0 ? (
        <>
          <div className="profile-section-label">Stock I want → who has it</div>
          <ul className="knows-subgroup-rows">
            {buyRows.map((r) => (
              <BuyRow key={`b-${r.itemKindId}-${r.counterpartyActorId}`} row={r} dump={dump} perceiverJ={perceiverJ} onSelect={onSelect} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function byScoreDesc(a: NotebookRow, b: NotebookRow): number {
  // Locked rows last; among scored rows, highest score first.
  const aHasScore = a.score !== null;
  const bHasScore = b.score !== null;
  if (aHasScore !== bHasScore) return aHasScore ? -1 : 1;
  if (aHasScore && bHasScore) return (b.score ?? 0) - (a.score ?? 0);
  return 0;
}

function SellRow({
  row,
  dump,
  perceiverJ,
  onSelect,
}: {
  readonly row: NotebookRow;
  readonly dump: RunDump;
  readonly perceiverJ: number;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
    <li className="chip-stack">
      <div className="chip-stack-row">
        <ActorChip dump={dump} actorId={row.counterpartyActorId} onSelect={onSelect} size={14} />
        <CounterpartyDot row={row} perceiverJ={perceiverJ} />
        <span className="muted">wants</span>
        {row.score !== null ? (
          <strong className={row.score > 0 ? "" : "warn"}>· gross £{row.score}</strong>
        ) : null}
      </div>
      <div className="chip-stack-row">
        <span className="chip-stack-label muted">RRP</span>
        <BeliefChip
          dump={dump}
          itemKindId={row.itemKindId}
          qualityTier={row.itemTier}
          quantity={row.theirQty}
          observerActorId={null}
          onSelect={onSelect}
        />
      </div>
      {row.unlocked && row.theirQty !== null ? (
        <div className="chip-stack-row">
          <ActorChip dump={dump} actorId={row.counterpartyActorId} onSelect={onSelect} size={14} />
          <span className="muted">POV:</span>
          <BeliefChip
            dump={dump}
            itemKindId={row.itemKindId}
            qualityTier={row.itemTier}
            quantity={row.theirQty}
            observerActorId={row.counterpartyActorId}
            perceiverJ={perceiverJ}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="chip-stack-row">
          <span className="muted" title="Headline only — pay to unlock detail.">
            · unlock to evaluate
          </span>
        </div>
      )}
      {row.myQty !== null && row.myUnitCost !== null ? (
        <div className="chip-stack-row">
          <span className="muted">I have</span>
          <BeliefChip
            dump={dump}
            itemKindId={row.itemKindId}
            qualityTier={row.itemTier}
            quantity={row.myQty}
            observerActorId={null}
            unitPriceOverride={row.myUnitCost}
            onSelect={onSelect}
          />
        </div>
      ) : null}
    </li>
  );
}

function BuyRow({
  row,
  dump,
  perceiverJ,
  onSelect,
}: {
  readonly row: NotebookRow;
  readonly dump: RunDump;
  readonly perceiverJ: number;
  readonly onSelect: (s: Selection) => void;
}) {
  return (
    <li className="chip-stack">
      <div className="chip-stack-row">
        <ActorChip dump={dump} actorId={row.counterpartyActorId} onSelect={onSelect} size={14} />
        <CounterpartyDot row={row} perceiverJ={perceiverJ} />
        <span className="muted">has</span>
        {row.score !== null ? (
          <strong className={row.score > 0 ? "" : "warn"}>· gross £{row.score}</strong>
        ) : null}
      </div>
      <div className="chip-stack-row">
        <span className="chip-stack-label muted">RRP</span>
        <BeliefChip
          dump={dump}
          itemKindId={row.itemKindId}
          qualityTier={row.itemTier}
          quantity={row.theirQty}
          observerActorId={null}
          onSelect={onSelect}
        />
      </div>
      {row.unlocked && row.theirQty !== null ? (
        <div className="chip-stack-row">
          <ActorChip dump={dump} actorId={row.counterpartyActorId} onSelect={onSelect} size={14} />
          <span className="muted">POV:</span>
          <BeliefChip
            dump={dump}
            itemKindId={row.itemKindId}
            qualityTier={row.itemTier}
            quantity={row.theirQty}
            observerActorId={row.counterpartyActorId}
            perceiverJ={perceiverJ}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="chip-stack-row">
          <span className="muted" title="Headline only — pay to unlock detail.">
            · unlock to evaluate
          </span>
        </div>
      )}
      {row.onwardBuyerActorId !== null && row.onwardUnitPrice !== null && row.theirQty !== null ? (
        <div className="chip-stack-row">
          <span className="muted">onward to</span>
          <ActorChip dump={dump} actorId={row.onwardBuyerActorId} onSelect={onSelect} size={12} />
          <BeliefChip
            dump={dump}
            itemKindId={row.itemKindId}
            qualityTier={row.itemTier}
            quantity={row.theirQty}
            observerActorId={row.onwardBuyerActorId}
            unitPriceOverride={row.onwardUnitPrice}
            onSelect={onSelect}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Palette-coloured dot showing the counterparty's appraisal accuracy
 * on the row's category. Colour is gated by the player-actor's j —
 * playing Trigger (j ≈ 0.3) grains the dots down to ~3 distinguishable
 * stops, so "wholly exploitable" and "competent generalist" blur
 * together. That's the perceiver-j model doing its job: replacing the
 * old binary ⚠ tell with a continuous read the character can mis-see.
 */
function CounterpartyDot({
  row,
  perceiverJ,
}: {
  readonly row: NotebookRow;
  readonly perceiverJ: number;
}) {
  if (row.counterpartyAccuracy === null) return null;
  const stop = colourFor(row.counterpartyAccuracy, perceiverJ);
  const cat = row.counterpartyCategory ?? "";
  const title = cat === ""
    ? `accuracy ${row.counterpartyAccuracy.toFixed(2)}`
    : `${cat} · accuracy ${row.counterpartyAccuracy.toFixed(2)}`;
  return (
    <span
      className={`notebook-counterparty-dot palette-stop-${stop}`}
      title={title}
    />
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

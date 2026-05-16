/**
 * Per-actor notebook — a derived view that joins an actor's stock, lead
 * bag, and counterparties' bidder profiles into actionable rows ("I
 * have Radios; Boyce wants Radios; expected gross £60"). Computed each
 * hour, diffed against the previous tick's row set, with row-level
 * lifecycle events emitted for the diary / event log.
 *
 * Two buckets per actor:
 *   • sell-side — my on-hand stock × demand-side leads in my bag.
 *     Counterparty = "who wants it". Row is actionable as a sale.
 *   • buy-side  — supply-side leads in my bag for items I have demand
 *     leads for. Counterparty = "who has it". Row is actionable as a
 *     buy-to-flip.
 *
 * Locked headlines (gossiped leads where `detail_unlocked = 0`) still
 * produce rows; their numeric fields are nulled out and the row is
 * tagged `unlocked: false`. That way the player sees the £3 upgrade
 * decision in the same surface that scores their other leads.
 */

import type { DB } from "../core/db.js";
import type { World, Unsubscribe } from "../core/world.js";
import { getLeadsByHolder } from "../leads/leads-repo.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import type { Lead } from "../leads/types.js";

export type NotebookSide = "sell" | "buy";

export interface NotebookRow {
  readonly side: NotebookSide;
  readonly itemKindId: number;
  readonly counterpartyActorId: number;
  /** Sell-side: total on-hand units of this item. Buy-side: null. */
  readonly myQty: number | null;
  /** Sell-side: weighted-average per-unit acquisition cost. Buy-side: null. */
  readonly myUnitCost: number | null;
  /** Counterparty's gossiped quantity. Null on locked headlines. */
  readonly theirQty: number | null;
  /** Counterparty's gossiped per-unit price. Null on locked headlines. */
  readonly theirUnitPrice: number | null;
  /** Expected gross profit on this row. Null when inputs are unknown
   *  (locked headline) or when one side is missing. */
  readonly score: number | null;
  /** True when the underlying lead's detail tier is visible. */
  readonly unlocked: boolean;
}

/** Field-by-field equality for diff detection. */
function rowsEqual(a: NotebookRow, b: NotebookRow): boolean {
  return (
    a.myQty === b.myQty &&
    a.myUnitCost === b.myUnitCost &&
    a.theirQty === b.theirQty &&
    a.theirUnitPrice === b.theirUnitPrice &&
    a.score === b.score &&
    a.unlocked === b.unlocked
  );
}

function rowKey(row: Pick<NotebookRow, "side" | "itemKindId" | "counterpartyActorId">): string {
  return `${row.side}|${row.itemKindId}|${row.counterpartyActorId}`;
}

/** Lower hop and warm-before-cold wins. Ties broken by higher id (newer). */
function preferLead(a: Lead, b: Lead): Lead {
  if (a.hopCount !== b.hopCount) return a.hopCount < b.hopCount ? a : b;
  const ac = a.confidence === "warm" ? 0 : 1;
  const bc = b.confidence === "warm" ? 0 : 1;
  if (ac !== bc) return ac < bc ? a : b;
  return a.id > b.id ? a : b;
}

/**
 * Compute the full notebook row set for `actorId`. Pure function over
 * the current DB state — no side effects. Used by the diff hook here
 * and by tests directly.
 *
 * Counterparty-character reads (was: a binary `counterpartyExploitable`
 * flag thresholded on per-category appraisal accuracy) were removed
 * when the judgement engine took over UI valuation — the webapp dot
 * routes through `colourFor(accuracy, perceiverJ)` directly off the
 * counterparty's bidder profile, so the engine row no longer needs to
 * pre-thresh anything (docs/judgement.md). The diary log similarly
 * dropped its `⚠exploit` suffix.
 */
export function computeNotebookRows(
  db: DB,
  actorId: number,
): NotebookRow[] {
  const leads = getLeadsByHolder(db, actorId).filter(
    (l) => l.kind === "commodity" && l.subjectItemKindId !== null && l.counterpartyActorId !== null,
  );
  const lots = getStockLotsByOwner(db, actorId);

  // Aggregate stock by item kind.
  const stockByItem = new Map<number, { qty: number; cost: number }>();
  for (const lot of lots) {
    const agg = stockByItem.get(lot.itemKindId) ?? { qty: 0, cost: 0 };
    agg.qty += lot.quantity;
    agg.cost += lot.quantity * lot.acquiredUnitPrice;
    stockByItem.set(lot.itemKindId, agg);
  }

  // Best demand & supply lead per (item, counterparty).
  const bestDemand = new Map<string, Lead>();
  const bestSupply = new Map<string, Lead>();
  for (const l of leads) {
    const k = `${l.subjectItemKindId!}|${l.counterpartyActorId!}`;
    const target = l.side === "demand" ? bestDemand : bestSupply;
    const existing = target.get(k);
    target.set(k, existing === undefined ? l : preferLead(l, existing));
  }

  // Items the holder has at least one demand lead for — that's the
  // signal for "I want to source this." Drives buy-side row inclusion.
  const itemsIWant = new Set<number>();
  for (const l of bestDemand.values()) itemsIWant.add(l.subjectItemKindId!);

  const rows: NotebookRow[] = [];

  // ── Sell-side: my stock × demand leads ───────────────────────────
  for (const lead of bestDemand.values()) {
    const itemKindId = lead.subjectItemKindId!;
    const cp = lead.counterpartyActorId!;
    const stock = stockByItem.get(itemKindId);
    if (stock === undefined || stock.qty === 0) continue;
    const myUnitCost = Math.round(stock.cost / stock.qty);
    const unlocked = lead.detailUnlocked;
    const theirQty = unlocked ? lead.estimatedQuantity : null;
    const theirUnitPrice = unlocked ? lead.estimatedUnitPrice : null;
    const score =
      unlocked && theirQty !== null && theirUnitPrice !== null
        ? (theirUnitPrice - myUnitCost) * Math.min(stock.qty, theirQty)
        : null;
    rows.push({
      side: "sell",
      itemKindId,
      counterpartyActorId: cp,
      myQty: stock.qty,
      myUnitCost,
      theirQty,
      theirUnitPrice,
      score,
      unlocked,
    });
  }

  // ── Buy-side: items I want × supply leads ────────────────────────
  // For score: pair each supply lead with the holder's best onward
  // demand lead on the same item (highest gossiped price among the
  // unlocked demand leads). When that onward price is unknown the
  // score collapses to null.
  const bestOnwardPriceByItem = new Map<number, number>();
  for (const l of bestDemand.values()) {
    if (!l.detailUnlocked) continue;
    const prev = bestOnwardPriceByItem.get(l.subjectItemKindId!) ?? 0;
    if (l.estimatedUnitPrice > prev) {
      bestOnwardPriceByItem.set(l.subjectItemKindId!, l.estimatedUnitPrice);
    }
  }

  for (const lead of bestSupply.values()) {
    const itemKindId = lead.subjectItemKindId!;
    if (!itemsIWant.has(itemKindId)) continue;
    const cp = lead.counterpartyActorId!;
    const unlocked = lead.detailUnlocked;
    const theirQty = unlocked ? lead.estimatedQuantity : null;
    const theirUnitPrice = unlocked ? lead.estimatedUnitPrice : null;
    const onward = bestOnwardPriceByItem.get(itemKindId);
    const score =
      unlocked && theirQty !== null && theirUnitPrice !== null && onward !== undefined
        ? (onward - theirUnitPrice) * theirQty
        : null;
    rows.push({
      side: "buy",
      itemKindId,
      counterpartyActorId: cp,
      myQty: null,
      myUnitCost: null,
      theirQty,
      theirUnitPrice,
      score,
      unlocked,
    });
  }

  return rows;
}

export interface NotebookDiffConfig {
  /** Which actors get notebooks computed. Typically the actors with
   *  bidder profiles (i.e. trading characters); civilians and virtual
   *  producers are excluded. */
  readonly actorIds: readonly number[];
}

/**
 * Register the per-hour notebook recompute + diff. After every other
 * hour-tick mechanic has run, recompute each tracked actor's notebook,
 * diff against the cached previous row-set, and emit
 * `actor.notebook-row-added` / `-updated` / `-removed` for the delta.
 *
 * Cache lives in-memory for the lifetime of the World — the event
 * stream IS the persistence layer.
 */
export function registerNotebookDiff(
  world: World,
  config: NotebookDiffConfig,
): Unsubscribe {
  const cache = new Map<number, Map<string, NotebookRow>>();
  for (const id of config.actorIds) cache.set(id, new Map());

  return world.onHour((clock) => {
    for (const actorId of config.actorIds) {
      const prev = cache.get(actorId) ?? new Map<string, NotebookRow>();
      const next = new Map<string, NotebookRow>();
      const rows = computeNotebookRows(world.db, actorId);
      for (const r of rows) next.set(rowKey(r), r);

      // Removed: in prev but not in next.
      for (const [k, oldRow] of prev) {
        if (next.has(k)) continue;
        world.events.emit({
          type: "actor.notebook-row-removed",
          at: clock,
          actorId,
          side: oldRow.side,
          itemKindId: oldRow.itemKindId,
          counterpartyActorId: oldRow.counterpartyActorId,
        });
      }

      // Added / updated.
      for (const [k, row] of next) {
        const old = prev.get(k);
        if (old === undefined) {
          world.events.emit({
            type: "actor.notebook-row-added",
            at: clock,
            actorId,
            side: row.side,
            itemKindId: row.itemKindId,
            counterpartyActorId: row.counterpartyActorId,
            myQty: row.myQty,
            myUnitCost: row.myUnitCost,
            theirQty: row.theirQty,
            theirUnitPrice: row.theirUnitPrice,
            score: row.score,
            unlocked: row.unlocked,
          });
        } else if (!rowsEqual(old, row)) {
          world.events.emit({
            type: "actor.notebook-row-updated",
            at: clock,
            actorId,
            side: row.side,
            itemKindId: row.itemKindId,
            counterpartyActorId: row.counterpartyActorId,
            myQty: row.myQty,
            myUnitCost: row.myUnitCost,
            theirQty: row.theirQty,
            theirUnitPrice: row.theirUnitPrice,
            score: row.score,
            unlocked: row.unlocked,
          });
        }
      }

      cache.set(actorId, next);
    }
  });
}

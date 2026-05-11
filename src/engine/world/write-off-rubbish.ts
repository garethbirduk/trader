import type { World, Unsubscribe } from "../core/world.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import { deleteStockLot, getStockLotById } from "../stock/lots-repo.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface WriteOffRubbishOptions {
  /** Where the per-unit fee lands (typically the off-map ledger). */
  readonly feeProceedsActorId?: number | null;
  readonly economics?: EconomicsConfig;
}

interface WriteOffCandidateRow {
  id: number;
  owner_actor_id: number;
  item_kind_id: number;
  quality_tier: string;
  quantity: number;
  acquired_day: number;
}

/**
 * Stage 8 — auto write-off of unsellable rubbish.
 *
 * Without an exit valve, broken / shoddy stock that no auction
 * bidder wants and no shopkeeper will buy just sits in the dealer's
 * bag forever, dragging on planner decisions and clouding the
 * inventory view. This handler runs at the start of each day and
 * sweeps lots that meet all of:
 *
 *   • tier in `eligibleTiers` (default broken + shoddy)
 *   • acquired_day ≤ today − `minDaysHeld` (default 7)
 *
 * The owner pays `feePerUnit × quantity` to the fee-proceeds account
 * (auction house / off-map ledger) and the lot is deleted. Owners
 * below `skipFeeBelowCash` get the fee waived — we don't push the
 * skint into debt over already-worthless stock.
 *
 * Emits `stock.written-off` per lot for the trace + viewer.
 */
export function registerWriteOffRubbish(
  world: World,
  opts: WriteOffRubbishOptions = {},
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.writeOff;
  const feeProceedsActorId = opts.feeProceedsActorId ?? null;

  return world.onDayStart((day) => {
    if (!cfg.enabled) return;
    const tiers = new Set(cfg.eligibleTiers);
    if (tiers.size === 0) return;

    // Pull candidates straight from SQL so we don't iterate per-actor.
    const placeholders = [...tiers].map((_, i) => `@t${i}`).join(",");
    const params: Record<string, number | string> = {
      cutoff: day - cfg.minDaysHeld,
    };
    [...tiers].forEach((t, i) => {
      params[`t${i}`] = t;
    });
    const rows = world.db
      .prepare<WriteOffCandidateRow>(
        `SELECT id, owner_actor_id, item_kind_id, quality_tier, quantity,
                acquired_day
         FROM stock_lots
         WHERE quantity > 0
           AND quality_tier IN (${placeholders})
           AND acquired_day <= @cutoff
         ORDER BY id ASC`,
      )
      .all(params);

    for (const r of rows) {
      // Re-fetch via the repo to get the rich typed object (and to
      // catch races where a settlement run in the same tick already
      // touched the lot).
      const lot = getStockLotById(world.db, r.id);
      if (!lot || lot.quantity <= 0) continue;

      const grossFee = cfg.feePerUnit * lot.quantity;
      const owner = getActorById(world.db, lot.ownerActorId);
      if (!owner) continue;
      const skipFee = owner.cash < cfg.skipFeeBelowCash;
      const feeApplied = skipFee ? 0 : grossFee;

      if (feeApplied > 0) {
        adjustActorCash(world.db, lot.ownerActorId, -feeApplied);
        if (feeProceedsActorId !== null) {
          adjustActorCash(world.db, feeProceedsActorId, feeApplied);
        }
      }
      const quantity = lot.quantity;
      deleteStockLot(world.db, lot.id);
      world.events.emit({
        type: "stock.written-off",
        at: world.clock,
        ownerActorId: lot.ownerActorId,
        stockLotId: lot.id,
        itemKindId: lot.itemKindId,
        qualityTier: lot.qualityTier,
        quantity,
        feePaid: feeApplied,
        reason: skipFee
          ? "auto-rubbish (fee waived, owner skint)"
          : "auto-rubbish",
      });
    }
  });
}

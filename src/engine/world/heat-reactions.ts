import type { World, Unsubscribe } from "../core/world.js";
import { getDealLinesByDealId } from "../deals/deals-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { raiseHeat } from "../heat/heat-repo.js";

export interface HeatReactionConfig {
  /** Per-unit-of-risk × quantity coefficient when buying or selling. */
  readonly perUnitRiskFactor: number;
  /**
   * Multiplier on the base heat raise for the seller. Default 1.0.
   * Makes selling stolen goods at least as risky as buying them.
   */
  readonly sellerMultiplier: number;
  /** Multiplier on the base heat raise for the buyer. Default 0.5. */
  readonly buyerMultiplier: number;
}

const DEFAULTS: HeatReactionConfig = {
  perUnitRiskFactor: 0.5,
  sellerMultiplier: 1.0,
  buyerMultiplier: 0.5,
};

/**
 * Listens for `deal.settled` events. When the deal involved items with
 * a flaw type the authorities care about (stolen, dangerous), both
 * parties' heat rises in proportion to (line risk × line quantity).
 *
 * Heat is symmetric in spirit but not equal: sellers carry more
 * (they've been visibly distributing) than buyers (who can claim
 * ignorance). Calibration is per-skin via `HeatReactionConfig`.
 */
export function registerHeatReactions(
  world: World,
  config: Partial<HeatReactionConfig> = {},
): Unsubscribe {
  const cfg: HeatReactionConfig = { ...DEFAULTS, ...config };

  return world.events.subscribe((e) => {
    if (e.type !== "deal.settled") return;

    const lines = getDealLinesByDealId(world.db, e.dealId);
    let totalSellerRaise = 0;
    let totalBuyerRaise = 0;
    for (const line of lines) {
      const item = getItemKindById(world.db, line.itemKindId);
      if (!item) continue;
      if (item.flawType !== "stolen" && item.flawType !== "dangerous") continue;
      const base = cfg.perUnitRiskFactor * item.risk * line.quantity;
      totalSellerRaise += Math.round(base * cfg.sellerMultiplier);
      totalBuyerRaise += Math.round(base * cfg.buyerMultiplier);
    }

    if (totalSellerRaise > 0) {
      const after = raiseHeat(world.db, e.sellerActorId, totalSellerRaise, e.at.day);
      world.events.emit({
        type: "heat.raised",
        at: e.at,
        actorId: e.sellerActorId,
        delta: totalSellerRaise,
        score: after.score,
        reason: "sold-risky",
      });
    }
    if (totalBuyerRaise > 0) {
      const after = raiseHeat(world.db, e.buyerActorId, totalBuyerRaise, e.at.day);
      world.events.emit({
        type: "heat.raised",
        at: e.at,
        actorId: e.buyerActorId,
        delta: totalBuyerRaise,
        score: after.score,
        reason: "bought-risky",
      });
    }
  });
}

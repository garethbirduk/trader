import type { World, Unsubscribe } from "../core/world.js";
import { adjustTrust } from "../trust/trust-repo.js";

export interface TrustReactionConfig {
  /** Trust gained by buyer in seller (and vice versa) on a clean settlement. */
  readonly settleDelta: number;
  /** Trust lost by buyer in seller when seller defaults on delivery. */
  readonly defaultDelta: number;
}

const DEFAULTS: TrustReactionConfig = {
  settleDelta: 2,
  defaultDelta: -10,
};

/**
 * Listen for deal lifecycle events and update trust accordingly. Trust is
 * symmetric on settlement (both parties gained from a clean transaction),
 * one-sided on default (the wronged party — the buyer who didn't receive
 * — drops trust in the seller; the seller doesn't lose faith in the buyer
 * just because they failed to deliver).
 */
export function registerTrustReactions(
  world: World,
  config: Partial<TrustReactionConfig> = {},
): Unsubscribe {
  const cfg: TrustReactionConfig = { ...DEFAULTS, ...config };

  const apply = (
    holderId: number,
    targetId: number,
    delta: number,
    reason: "settled" | "defaulted",
    dealId: number,
    at: import("../core/clock.js").Clock,
  ): void => {
    const updated = adjustTrust(world.db, holderId, targetId, delta, at.day);
    world.events.emit({
      type: "trust.adjusted",
      at,
      holderActorId: holderId,
      targetActorId: targetId,
      delta,
      newScore: updated.score,
      reason,
      dealId,
    });
  };

  return world.events.subscribe((e) => {
    if (e.type === "deal.settled") {
      apply(e.buyerActorId, e.sellerActorId, cfg.settleDelta, "settled", e.dealId, e.at);
      apply(e.sellerActorId, e.buyerActorId, cfg.settleDelta, "settled", e.dealId, e.at);
    } else if (e.type === "deal.defaulted") {
      apply(e.buyerActorId, e.sellerActorId, cfg.defaultDelta, "defaulted", e.dealId, e.at);
    }
  });
}

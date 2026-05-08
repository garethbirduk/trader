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

  return world.events.subscribe((e) => {
    if (e.type === "deal.settled") {
      adjustTrust(world.db, e.buyerActorId, e.sellerActorId, cfg.settleDelta, e.at.day);
      adjustTrust(world.db, e.sellerActorId, e.buyerActorId, cfg.settleDelta, e.at.day);
    } else if (e.type === "deal.defaulted") {
      adjustTrust(world.db, e.buyerActorId, e.sellerActorId, cfg.defaultDelta, e.at.day);
    }
  });
}

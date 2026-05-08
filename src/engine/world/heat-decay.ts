import type { World, Unsubscribe } from "../core/world.js";
import { decayAllHeat } from "../heat/heat-repo.js";

export interface HeatDecayConfig {
  /** Heat units shed per actor per day. Default 5. */
  readonly perDay: number;
}

const DEFAULTS: HeatDecayConfig = { perDay: 5 };

/**
 * Each morning, every actor's heat drops by a fixed amount (clamped
 * at 0). Models "no news, no problems" — keep your nose clean for a
 * few days and the law forgets you.
 */
export function registerHeatDecay(
  world: World,
  config: Partial<HeatDecayConfig> = {},
): Unsubscribe {
  const cfg: HeatDecayConfig = { ...DEFAULTS, ...config };
  return world.onDayStart(() => {
    decayAllHeat(world.db, cfg.perDay);
  });
}

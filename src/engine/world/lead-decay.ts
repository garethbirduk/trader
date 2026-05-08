import { decayLeads } from "../leads/leads-repo.js";
import type { World, Unsubscribe } from "../core/world.js";

export interface LeadDecayConfig {
  /** Days after acquisition at which a warm lead goes cold. */
  readonly warmThresholdDays: number;
  /** Days after acquisition at which a lead is removed entirely. */
  readonly deleteThresholdDays: number;
}

const DEFAULTS: LeadDecayConfig = {
  warmThresholdDays: 3,
  deleteThresholdDays: 7,
};

/** Run lead decay every morning. */
export function registerLeadDecay(
  world: World,
  config: Partial<LeadDecayConfig> = {},
): Unsubscribe {
  const cfg: LeadDecayConfig = { ...DEFAULTS, ...config };
  return world.onDayStart((day) => {
    decayLeads(world.db, day, cfg.warmThresholdDays, cfg.deleteThresholdDays);
  });
}

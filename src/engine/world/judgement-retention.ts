import { pruneJudgementsOlderThan } from "../perception/judgement-log-repo.js";
import type { World, Unsubscribe } from "../core/world.js";

export interface JudgementRetentionConfig {
  /** Rows on days strictly older than `currentDay - keepDays` are
   *  dropped. 14 keeps two weeks of audit history — long enough for
   *  the UI to render math behind any in-view scene + diary scrubback,
   *  short enough that a year-long sim doesn't carry every appraisal
   *  forever. */
  readonly keepDays: number;
}

const DEFAULTS: JudgementRetentionConfig = {
  keepDays: 14,
};

/** Daily housekeeper for the judgement audit log. Mirrors
 *  `registerLeadDecay` — hooks `onDayStart` and prunes rows older
 *  than the retention window. Safe on day 0 (helper short-circuits
 *  when cutoff < 0). */
export function registerJudgementRetention(
  world: World,
  config: Partial<JudgementRetentionConfig> = {},
): Unsubscribe {
  const cfg: JudgementRetentionConfig = { ...DEFAULTS, ...config };
  return world.onDayStart((day) => {
    pruneJudgementsOlderThan(world.db, day, cfg.keepDays);
  });
}

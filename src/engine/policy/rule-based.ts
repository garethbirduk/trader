import type { ActorPolicy, Action, ActorView } from "./types.js";

export interface RuleBasedAIPolicyOptions {
  /**
   * Hourly schedule mapping in-game hour (0..23) to a desired location id.
   * Hours not present fall back to `defaultLocationId`. Missing entries are
   * fine — `idle` is the safe default.
   */
  readonly schedule?: ReadonlyMap<number, number>;
  /** Where to be when the schedule doesn't say. May be null. */
  readonly defaultLocationId?: number | null;
}

/**
 * The default NPC policy for v1. The actor moves toward the location
 * dictated by the hour in `schedule`, falling back to `defaultLocationId`,
 * and otherwise idles. Settlement is handled at the world level (daily
 * tick), not by individual policies — that keeps actors out of the
 * settlement decision and lets the engine enforce default consistently.
 *
 * Later milestones layer on lead-acquisition, deal-proposal, and trust-
 * sensitive socialising. The policy is intentionally minimal here so it
 * can be extended additively.
 */
export class RuleBasedAIPolicy implements ActorPolicy {
  readonly id: string;
  private readonly schedule: ReadonlyMap<number, number> | null;
  private readonly defaultLocationId: number | null;

  constructor(id: string, opts: RuleBasedAIPolicyOptions = {}) {
    this.id = id;
    this.schedule = opts.schedule ?? null;
    this.defaultLocationId = opts.defaultLocationId ?? null;
  }

  decide(view: ActorView): Action {
    const targetLocationId =
      this.schedule?.get(view.clock.hour) ?? this.defaultLocationId;

    if (targetLocationId == null) return { type: "idle" };

    const currentId = view.currentLocation?.id ?? null;
    if (currentId !== targetLocationId) {
      return { type: "travel", toLocationId: targetLocationId };
    }
    return { type: "idle" };
  }
}

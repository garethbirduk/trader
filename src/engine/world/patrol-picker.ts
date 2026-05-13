import type { Clock } from "../core/clock.js";
import type { SeededRNG } from "../core/rng.js";

/**
 * A simple weighted-random hour-by-hour patrol picker. Used for
 * police officers (Slater, Hoskins, …): each has a nominal day of
 * "wander between the station, the market, the Nag's, Sid's" with
 * weights biasing where they're most often found. The picker only
 * fires during an officer's awake/active window; outside that it
 * returns null and the policy falls through to schedule / home.
 *
 * The picker is hour-stateless — each hour is an independent
 * weighted pick. That's deliberately bouncy: it means an officer
 * can show up at the Nag's at 14:00 having been at the station at
 * 13:00, which is what "patrol" wants to feel like. Wiring a
 * "stay one extra hour" momentum knob is straightforward later.
 *
 * Multiple officers can be registered; each has their own
 * candidate beat and active-hours window. Beats may overlap (two
 * officers can both pick the market in the same hour).
 */

export interface PatrolCandidate {
  readonly locationId: number;
  /** Relative weight; higher = more likely. */
  readonly weight: number;
}

export interface PatrolConfig {
  readonly actorId: number;
  readonly candidates: readonly PatrolCandidate[];
  /** Hours during which patrol-picking applies. Outside this window
   *  the picker returns null. */
  readonly activeHours: ReadonlySet<number>;
}

export class PatrolPicker {
  private configs: Map<number, PatrolConfig> = new Map();

  /**
   * Register a patrol config for an officer. Calling `register`
   * again with the same `actorId` replaces the previous config.
   */
  register(config: PatrolConfig): void {
    this.configs.set(config.actorId, config);
  }

  /**
   * Pick a location for `actorId` at `clock`, or null when the
   * picker doesn't apply (actor not registered, outside active
   * hours, or no candidates).
   */
  pickFor(actorId: number, clock: Clock, rng: SeededRNG): number | null {
    const config = this.configs.get(actorId);
    if (config === undefined) return null;
    if (!config.activeHours.has(clock.hour)) return null;
    if (config.candidates.length === 0) return null;
    return rng.weighted(
      config.candidates.map((c) => ({
        value: c.locationId,
        weight: c.weight,
      })),
    );
  }
}

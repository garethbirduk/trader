import type { Clock } from "../core/clock.js";
import type { SeededRNG } from "../core/rng.js";

/**
 * A simple weighted-random hour-by-hour patrol picker. Used for
 * Slater: his nominal day is "wander between the station, the
 * market, the Nag's, Sid's" with weights biasing where he's most
 * often found. The picker only fires during the actor's awake
 * window; outside that it returns null and the policy falls
 * through to schedule / home.
 *
 * The picker is hour-stateless — each hour is an independent
 * weighted pick. That's deliberately bouncy: it means Slater can
 * show up at the Nag's at 14:00 having been at the station at
 * 13:00, which is what "patrol" wants to feel like. Wiring a
 * "stay one extra hour" momentum knob is straightforward later.
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
  private config: PatrolConfig | null = null;

  configure(config: PatrolConfig): void {
    this.config = config;
  }

  /**
   * Pick a location for `actorId` at `clock`, or null when the
   * picker doesn't apply (different actor, outside active hours,
   * or never configured).
   */
  pickFor(actorId: number, clock: Clock, rng: SeededRNG): number | null {
    if (this.config === null) return null;
    if (actorId !== this.config.actorId) return null;
    if (!this.config.activeHours.has(clock.hour)) return null;
    if (this.config.candidates.length === 0) return null;
    return rng.weighted(
      this.config.candidates.map((c) => ({
        value: c.locationId,
        weight: c.weight,
      })),
    );
  }
}

import type { World, Unsubscribe } from "../core/world.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import { listOpenAuctionLots } from "../auction/auction-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type DealerDayModeKey,
  type EconomicsConfig,
} from "../economics/config.js";

/**
 * Per-actor, per-day record of the chosen mode plus the resolved
 * hour→locationId override map. The daily-mode picker fills this at
 * day-start; the actor's policy override callback consults it during
 * the day. Cleared and rebuilt each day.
 */
export class DayModeRegistry {
  // Map: actorId → { day → { hour → locationId } }
  private readonly overrides = new Map<number, Map<number, Map<number, number>>>();
  // Map: actorId → { day → mode } — useful for diary surfaces / events.
  private readonly modes = new Map<number, Map<number, DealerDayModeKey>>();

  setForDay(
    actorId: number,
    day: number,
    mode: DealerDayModeKey,
    hourMap: Map<number, number>,
  ): void {
    let perActor = this.overrides.get(actorId);
    if (perActor === undefined) {
      perActor = new Map();
      this.overrides.set(actorId, perActor);
    }
    perActor.set(day, hourMap);

    let modeMap = this.modes.get(actorId);
    if (modeMap === undefined) {
      modeMap = new Map();
      this.modes.set(actorId, modeMap);
    }
    modeMap.set(day, mode);
  }

  getOverride(actorId: number, day: number, hour: number): number | null {
    return this.overrides.get(actorId)?.get(day)?.get(hour) ?? null;
  }

  getMode(actorId: number, day: number): DealerDayModeKey | null {
    return this.modes.get(actorId)?.get(day) ?? null;
  }
}

export interface DealerDayModeOptions {
  /** Actor ids whose routines should be replaced each day by a randomly
   *  chosen mode. Fixed-job actors (Mike, Sid, Slater, …) are excluded. */
  readonly flexibleActorIds: ReadonlySet<number>;
  /** Per-actor bidder profiles — used to compute auction interest. */
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
  /** Maps location codes (in the mode schedules) to engine ids. */
  readonly locationByCode: ReadonlyMap<string, number>;
  /** The shared registry the policy callbacks read from. */
  readonly registry: DayModeRegistry;
  /** Economic tuning bundle. Pulls weights and mode schedules from
   *  `economics.dealerDayMode`. */
  readonly economics?: EconomicsConfig;
}

/**
 * Day-start dealer mode picker. For each flexible actor:
 *
 *   1. Inspect today's auction docket (lots scheduled with non-null
 *      scheduledHour, listed before today, still open).
 *   2. Compute auction-interest: does any docket lot's category fall
 *      in the actor's profile with appraisalAccuracy >= threshold?
 *      If yes, add `auctionInterestBoost` to the auction weight.
 *   3. Roll the mode (weighted random).
 *   4. Resolve the mode's hour-schedule (codes → ids) and fill the
 *      registry. The policy override callback consults this during
 *      the day; hours not in the map fall through to the regular
 *      schedule (or an even-higher-priority delivery override).
 *
 * Emits `dealer.day-mode` per chosen mode so the diary captures it.
 *
 * Registers as `onDayStart`. Must run AFTER the auction docket is
 * published (registerDailyAuction also runs onDayStart) — registration
 * order in run-sim.ts handles this.
 */
export function registerDealerDayMode(
  world: World,
  opts: DealerDayModeOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.dealerDayMode;

  return world.onDayStart((day) => {
    // Pull today's docket: lots scheduled for an hour, listed before
    // today, not yet cleared.
    const docket = listOpenAuctionLots(world.db).filter(
      (l) => l.scheduledHour !== null && l.listedDay < day,
    );
    const docketCategories = new Set<string>();
    for (const lot of docket) {
      const item = getItemKindById(world.db, lot.itemKindId);
      if (item !== null) docketCategories.add(item.category);
    }

    for (const actorId of opts.flexibleActorIds) {
      const profile = opts.bidderProfiles.get(actorId);
      const interested =
        profile !== undefined &&
        [...docketCategories].some(
          (cat) =>
            (profile.appraisalAccuracy.get(cat) ??
              profile.defaultAppraisalAccuracy) >= cfg.interestThreshold,
        );

      const weights: { value: DealerDayModeKey; weight: number }[] = [
        {
          value: "auction",
          weight:
            cfg.baseWeights.auction +
            (interested ? cfg.auctionInterestBoost : 0),
        },
        { value: "market", weight: cfg.baseWeights.market },
        { value: "pub", weight: cfg.baseWeights.pub },
        { value: "home", weight: cfg.baseWeights.home },
      ];
      const mode = world.rng.weighted(weights);

      // Resolve the mode's hour schedule into an hour → locationId map.
      const hourMap = new Map<number, number>();
      const schedule = cfg.modeSchedules[mode] ?? {};
      for (const [hourStr, code] of Object.entries(schedule)) {
        const hour = Number.parseInt(hourStr, 10);
        if (!Number.isFinite(hour)) continue;
        const locId = opts.locationByCode.get(code);
        if (locId !== undefined) hourMap.set(hour, locId);
      }

      opts.registry.setForDay(actorId, day, mode, hourMap);

      world.events.emit({
        type: "dealer.day-mode",
        at: world.clock,
        actorId,
        mode,
        auctionInterested: interested,
      });
    }
  });
}

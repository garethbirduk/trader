import type { World, Unsubscribe } from "../core/world.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import {
  getStockLotsByOwner,
  decrementLotQuantity,
} from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import {
  listActorsAboveHeat,
  raiseHeat,
} from "../heat/heat-repo.js";

export interface AuthoritySweepConfig {
  /** Heat threshold above which a raid becomes possible. Default 60. */
  readonly raidThreshold: number;
  /**
   * Per-day raid probability scaler. Final chance ≈ score / scaler. So
   * with default 200, score 100 ⇒ 50% chance, score 200 ⇒ 100%.
   */
  readonly raidChanceScaler: number;
  /** Fine charged per unit of contraband seized. Default £20. */
  readonly finePerUnit: number;
  /** Heat reduction applied after a raid. Default 50. */
  readonly heatReductionAfterRaid: number;
  /**
   * Where the raid fines flow. If null, cash is burned (fine for tests).
   * Skins should set this — typically to a "police" actor or fold it
   * into the auction-house sink.
   */
  readonly fineProceedsActorId?: number | null;
}

const DEFAULTS: AuthoritySweepConfig = {
  raidThreshold: 60,
  raidChanceScaler: 200,
  finePerUnit: 20,
  heatReductionAfterRaid: 50,
};

/**
 * Daily authority sweep. For each actor whose heat is above the
 * threshold, rolls a raid chance proportional to their heat. On a
 * raid: confiscates ALL their stock of items flagged stolen or
 * dangerous (heat-attracting items), levies a per-unit fine
 * deducted from the actor's cash, reduces heat. Cash flow goes to
 * `fineProceedsActorId` if configured.
 *
 * v1 doesn't model arrest / lock-up time; the engine just makes the
 * actor cheaper to be near for a few days afterwards. Future phases
 * could add downtime, location-based raids (only at the lock-up),
 * and tip-off mechanics.
 */
export function registerAuthoritySweep(
  world: World,
  config: Partial<AuthoritySweepConfig> = {},
): Unsubscribe {
  const cfg: AuthoritySweepConfig = { ...DEFAULTS, ...config };

  return world.onDayStart((day) => {
    const targets = listActorsAboveHeat(world.db, cfg.raidThreshold);
    for (const target of targets) {
      const chance = target.score / cfg.raidChanceScaler;
      if (!world.rng.chance(chance)) continue;

      const actor = getActorById(world.db, target.actorId);
      if (!actor) continue;

      // Find all the actor's contraband — items flagged stolen or
      // dangerous in the catalogue.
      const lots = getStockLotsByOwner(world.db, target.actorId);
      let unitsSeized = 0;
      const seizedKinds: string[] = [];
      for (const lot of lots) {
        const item = getItemKindById(world.db, lot.itemKindId);
        if (!item) continue;
        if (item.flawType !== "stolen" && item.flawType !== "dangerous") continue;
        unitsSeized += lot.quantity;
        seizedKinds.push(item.code);
        // Confiscate the whole lot.
        decrementLotQuantity(world.db, lot.id, lot.quantity);
      }

      const fine = unitsSeized * cfg.finePerUnit;
      if (fine > 0) {
        const debit = Math.min(actor.cash, fine);
        if (debit > 0) {
          adjustActorCash(world.db, target.actorId, -debit);
          if (
            cfg.fineProceedsActorId !== null &&
            cfg.fineProceedsActorId !== undefined
          ) {
            adjustActorCash(world.db, cfg.fineProceedsActorId, debit);
          }
        }
      }

      raiseHeat(world.db, target.actorId, -cfg.heatReductionAfterRaid, day);

      world.events.emit({
        type: "authority.raid",
        at: world.clock,
        actorId: target.actorId,
        unitsSeized,
        seizedItemCodes: seizedKinds,
        fine,
        heatBefore: target.score,
      });
    }
  });
}

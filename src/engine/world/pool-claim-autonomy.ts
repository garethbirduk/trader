import type { World, Unsubscribe } from "../core/world.js";
import {
  PoolEmptyError,
  PoolNotYetAvailableError,
  PoolUnreachableError,
  claimFromPool,
  listReachableActiveByActor,
} from "../pools/pools-repo.js";
import {
  adjustActorCash,
  getActorById,
} from "../actors/actors-repo.js";
import { poolUnitPriceOnDay } from "../pools/types.js";

export interface PoolClaimAutonomyOptions {
  /** Actor ids that should attempt to claim from their reachable pools. */
  readonly claimingActorIds: readonly number[];
  /** Per-claim probability each morning. 0..1. */
  readonly attemptChance?: number;
  /** Quantity per claim. v1 uses a single fixed quantity. */
  readonly claimQuantity?: number;
  /** Where the claim's cash goes. If null, cash is burned (no conservation). */
  readonly proceedsActorId?: number | null;
}

/**
 * Daily NPC autonomy: each named actor probabilistically claims from one of
 * their reachable pools, paying the pool's interpolated unit price into a
 * proceeds account (typically the auction house or a "supplier" sink). The
 * claim is gated on cash — actors won't go into debt to buy from a pool.
 *
 * Intentionally minimal in v1 — drives some simulation activity so the
 * world has goods flowing without overcommitting to a full NPC AI.
 */
export function registerPoolClaimAutonomy(
  world: World,
  opts: PoolClaimAutonomyOptions,
): Unsubscribe {
  const attemptChance = opts.attemptChance ?? 0.6;
  const claimQuantity = opts.claimQuantity ?? 10;
  const proceedsActorId = opts.proceedsActorId ?? null;

  return world.onDayStart((day) => {
    for (const actorId of opts.claimingActorIds) {
      if (!world.rng.chance(attemptChance)) continue;
      const reachable = listReachableActiveByActor(world.db, actorId, day);
      if (reachable.length === 0) continue;
      const pool = world.rng.pick(reachable);
      const desiredQty = Math.min(claimQuantity, pool.quantityRemaining);
      if (desiredQty === 0) continue;
      const actor = getActorById(world.db, actorId);
      if (!actor) continue;
      const unitPrice = poolUnitPriceOnDay(pool, day);
      const affordableQty =
        unitPrice === 0
          ? desiredQty
          : Math.min(desiredQty, Math.floor(actor.cash / unitPrice));
      if (affordableQty <= 0) continue;
      try {
        const result = claimFromPool(world.db, {
          poolId: pool.id,
          actorId,
          quantity: affordableQty,
          atDay: day,
        });
        const cost = result.unitPriceCharged * affordableQty;
        adjustActorCash(world.db, actorId, -cost);
        if (proceedsActorId !== null) {
          adjustActorCash(world.db, proceedsActorId, cost);
        }
        world.events.emit({
          type: "pool.claimed",
          at: world.clock,
          poolId: pool.id,
          actorId,
          quantity: affordableQty,
          unitPrice: result.unitPriceCharged,
        });
      } catch (e) {
        if (
          e instanceof PoolEmptyError ||
          e instanceof PoolUnreachableError ||
          e instanceof PoolNotYetAvailableError
        ) {
          continue;
        }
        throw e;
      }
    }
  });
}

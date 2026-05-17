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
import { poolUnitPriceOnDay, type WorldPool } from "../pools/types.js";
import { getItemKindById } from "../stock/items-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { deriveKnowledgeProfile } from "../knowledge/skin-seed.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface PoolClaimAutonomyOptions {
  /** Actor ids that should attempt to claim from their reachable pools. */
  readonly claimingActorIds: readonly number[];
  /** Per-claim probability each morning. 0..1. */
  readonly attemptChance?: number;
  /** Quantity per claim. v1 uses a single fixed quantity. */
  readonly claimQuantity?: number;
  /** Where the claim's cash goes. If null, cash is burned (no conservation). */
  readonly proceedsActorId?: number | null;
  /** Per-actor bidder profiles. When provided, the claim decision
   *  filters reachable pools through the judgement engine's price
   *  arm: a pool is a candidate only if the actor's perceived per-
   *  unit value (centre via `estimatePriceBand`, against the pool's
   *  known tier) >= the pool's published unit price × ratio. A
   *  clueless actor's centre lerps toward the category anchor and
   *  rejects overpriced pools (or claims junk at zero cost); an
   *  expert's centre lerps toward truth and picks up underpriced
   *  pools. Omit to preserve the legacy "take any reachable pool"
   *  behaviour. */
  readonly bidderProfiles?: ReadonlyMap<number, BidderProfile>;
  /** Min ratio of perceived per-unit value (price-arm centre, RNG-
   *  free) to the pool's published unit price for the pool to be a
   *  claim candidate. Default 1.0 — the actor thinks the pool is
   *  worth at least what it costs. Set >1.0 to require margin;
   *  <1.0 for desperate claiming. Ignored when `bidderProfiles` is
   *  not supplied. Pools with `unitPrice == 0` (free) bypass the
   *  filter — there's no cost basis to compare against. */
  readonly claimValueToCostRatio?: number;
  /** Economics bundle — supplies the tier multipliers used to
   *  reconstruct the pool's truth-price for the price arm. Defaults
   *  to `DEFAULT_ECONOMICS_CONFIG`. Ignored when `bidderProfiles`
   *  is not supplied. */
  readonly economics?: EconomicsConfig;
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
  const bidderProfiles = opts.bidderProfiles ?? null;
  const claimValueToCostRatio = opts.claimValueToCostRatio ?? 1.0;
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;

  return world.onDayStart((day) => {
    for (const actorId of opts.claimingActorIds) {
      if (!world.rng.chance(attemptChance)) continue;
      const reachable = listReachableActiveByActor(world.db, actorId, day);
      if (reachable.length === 0) continue;

      // Judgement engine — filter to pools the actor judges a deal.
      // Tier is known (the pool's content is published with reach),
      // so this is Price-only (per docs/judgement.md). RNG-free —
      // the morning claim loop shouldn't shimmer on RNG advancement.
      let candidates: WorldPool[] = reachable;
      const profile = bidderProfiles?.get(actorId);
      if (profile !== undefined) {
        const knowledgeProfile = deriveKnowledgeProfile(profile);
        candidates = reachable.filter((p) => {
          const unitPrice = poolUnitPriceOnDay(p, day);
          if (unitPrice <= 0) return true; // free pool — always a deal
          const item = getItemKindById(world.db, p.itemKindId);
          if (item === null) return false;
          const mult = economics.tierMultipliers[p.qualityTier];
          const band = estimatePriceBand({
            db: world.db,
            actorId,
            category: item.category,
            truth: item.baseValue * mult,
            tierMultiplier: mult,
            profileOverride: knowledgeProfile,
          });
          return band.centre >= unitPrice * claimValueToCostRatio;
        });
        if (candidates.length === 0) continue;
      }

      const pool = world.rng.pick(candidates);
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

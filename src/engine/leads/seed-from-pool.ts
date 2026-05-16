import type { DB } from "../core/db.js";
import { getPoolById } from "../pools/pools-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { perceivedTierCentre } from "../perception/arms.js";
import { insertLead } from "./leads-repo.js";
import type { Lead } from "./types.js";
import type { QualityTier } from "../stock/types.js";
import type { EconomicsConfig } from "../economics/config.js";

/**
 * Generate first-hand supply leads for every actor with reach to the
 * given pool. Each lead points back to the pool via `subject_pool_id`,
 * so when leads are gossiped onward (`shareLead`) the pool reference
 * propagates with them. Two retold leads from different counterparties
 * carrying the same pool id is the over-counted-stock setup.
 *
 * For Stage-6 owned pools, the lead's `counterparty_actor_id` is set
 * to the pool's owner (the virtual producer — "I'm in touch with
 * Trader Bob about 200 vacuums"). For ambient pools, the counterparty
 * is the reachable actor themselves — "I am the one with access" — so
 * gossiping the lead onward retains the access-holder's identity.
 *
 * Both `estimatedUnitPrice` and `subjectQualityTier` route through the
 * judgement engine so the seeder's character shapes downstream gossip:
 *
 *   • Price — `estimatePriceBand` centre lerps from the category anchor
 *     toward the pool's opening unit price by the seeder's price
 *     expertise.
 *   • Tier — `perceivedTierCentre` lerps from the condition anchor
 *     ("fair") toward the pool's truth tier by their condition
 *     expertise.
 *
 * Clueless seeders propagate generic numbers and a wrong tier; experts
 * propagate truth. Replaces the prior truth-as-belief seed
 * (docs/judgement.md).
 */
export function seedSupplyLeadsForPool(
  db: DB,
  poolId: number,
  atDay: number,
  economics: EconomicsConfig,
): Lead[] {
  const pool = getPoolById(db, poolId);
  if (!pool) return [];
  const item = getItemKindById(db, pool.itemKindId);
  const category = item?.category ?? "_unknown";
  const tierMult = economics.tierMultipliers[pool.qualityTier as QualityTier];
  const reach = db
    .prepare<{ actor_id: number }>(
      `SELECT actor_id FROM pool_reachability WHERE pool_id = @pool ORDER BY actor_id ASC`,
    )
    .all({ pool: poolId })
    .map((r) => r.actor_id);
  const leads: Lead[] = [];
  for (const actorId of reach) {
    const band = estimatePriceBand({
      db,
      actorId,
      category,
      truth: pool.openingUnitPrice,
      tierMultiplier: tierMult,
    });
    const perceivedTier = perceivedTierCentre({
      db,
      actorId,
      truthTier: pool.qualityTier,
      category,
    });
    leads.push(
      insertLead(db, {
        holderActorId: actorId,
        side: "supply",
        subjectItemKindId: pool.itemKindId,
        subjectQualityTier: perceivedTier,
        counterpartyActorId: pool.ownerActorId ?? actorId,
        estimatedQuantity: pool.quantityRemaining,
        estimatedUnitPrice: Math.max(1, Math.round(band.centre)),
        confidence: "warm",
        sourceActorId: null,
        acquiredDay: atDay,
        hopCount: 0,
        derivedFromLeadId: null,
        subjectPoolId: poolId,
      }),
    );
  }
  return leads;
}

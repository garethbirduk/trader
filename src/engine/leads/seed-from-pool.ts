import type { DB } from "../core/db.js";
import { getPoolById } from "../pools/pools-repo.js";
import { insertLead } from "./leads-repo.js";
import type { Lead } from "./types.js";

/**
 * Generate first-hand supply leads for every actor with reach to the
 * given pool. Each lead points back to the pool via `subject_pool_id`,
 * so when leads are gossiped onward (`shareLead`) the pool reference
 * propagates with them. Two retold leads from different counterparties
 * carrying the same pool id is the over-counted-stock setup.
 *
 * The lead's `counterparty_actor_id` is set to the reachable actor
 * themselves — semantically "I am the one with access." When this lead
 * is gossiped onward, the recipient's lead reads "<actor> has N units"
 * with counterparty = the original reachable actor.
 */
export function seedSupplyLeadsForPool(
  db: DB,
  poolId: number,
  atDay: number,
): Lead[] {
  const pool = getPoolById(db, poolId);
  if (!pool) return [];
  const reach = db
    .prepare<{ actor_id: number }>(
      `SELECT actor_id FROM pool_reachability WHERE pool_id = @pool ORDER BY actor_id ASC`,
    )
    .all({ pool: poolId })
    .map((r) => r.actor_id);
  const leads: Lead[] = [];
  for (const actorId of reach) {
    leads.push(
      insertLead(db, {
        holderActorId: actorId,
        side: "supply",
        subjectItemKindId: pool.itemKindId,
        subjectQualityTier: pool.qualityTier,
        counterpartyActorId: actorId,
        estimatedQuantity: pool.quantityRemaining,
        estimatedUnitPrice: pool.openingUnitPrice,
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

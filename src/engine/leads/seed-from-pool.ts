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
 * For Stage-6 owned pools, the lead's `counterparty_actor_id` is set
 * to the pool's owner (the virtual producer — "I'm in touch with
 * Trader Bob about 200 vacuums"). For ambient pools, the counterparty
 * is the reachable actor themselves — "I am the one with access" — so
 * gossiping the lead onward retains the access-holder's identity.
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
        counterpartyActorId: pool.ownerActorId ?? actorId,
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

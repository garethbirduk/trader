import type { DB } from "../core/db.js";
import { getPoolById } from "../pools/pools-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { perceivedTierCentre } from "../perception/arms.js";
import {
  buildPriceArmPayload,
  insertJudgement,
} from "../perception/judgement-log-repo.js";
import { getCategoryAnchor } from "../perception/anchors-repo.js";
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
  /** Hour the seeding happened — written into the audit row. Default
   *  0 for callers that don't have a world clock (skin seed pass,
   *  tests). Production hooks pass `world.clock.hour`. */
  atHour: number = 0,
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
    const lead = insertLead(db, {
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
    });
    leads.push(lead);

    // Audit trail (docs/judgement.md). One row per (reachable actor,
    // pool) — captures why a clueless seeder propagated a wrong
    // price even though the underlying pool was the same.
    if (item !== null) {
      insertJudgement(db, {
        day: atDay,
        hour: atHour,
        actorId,
        arm: "price",
        contextKind: "lead-seed",
        contextRefId: lead.id,
        payload: buildPriceArmPayload({
          itemKindId: pool.itemKindId,
          category: item.category,
          truthTier: pool.qualityTier,
          truthUnit: pool.openingUnitPrice,
          anchor: getCategoryAnchor(db, item.category) * tierMult,
          tierMultiplier: tierMult,
          band,
          quantity: pool.quantityRemaining,
        }),
      });
    }
  }
  return leads;
}

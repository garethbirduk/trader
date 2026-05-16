import type { DB } from "../core/db.js";
import { getItemKindById } from "../stock/items-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { insertLead } from "./leads-repo.js";
import type { Lead } from "./types.js";
import type { StockLot } from "../stock/types.js";

/**
 * Generate a first-hand "I have this stock" supply lead for the owner of
 * a stock lot. The lead's counterparty is the owner themselves —
 * semantically "I am the one with the stock." When this lead is gossiped
 * onward, the recipient learns "<owner> has N units" with the owner as
 * counterparty.
 *
 * Unlike pool-derived leads, stock leads carry no `subjectPoolId` — there
 * is no shared upstream source to dedup against.
 *
 * `estimatedUnitPrice` is the owner's *belief* about resale value,
 * sampled from the judgement engine's price band with their sunk cost
 * (`acquiredUnitPrice`) as the truth anchor: a category-expert owner's
 * belief stays near cost; a clueless owner's belief drifts toward the
 * category anchor. That number is what propagates onward in gossip
 * (docs/judgement.md), so the seeder's expertise shapes downstream
 * notebooks and haggle anchors.
 */
export function seedSupplyLeadForStockLot(
  db: DB,
  lot: StockLot,
  atDay: number,
): Lead {
  const item = getItemKindById(db, lot.itemKindId);
  const category = item?.category ?? "_unknown";
  const band = estimatePriceBand({
    db,
    actorId: lot.ownerActorId,
    category,
    truth: lot.acquiredUnitPrice,
  });
  return insertLead(db, {
    holderActorId: lot.ownerActorId,
    side: "supply",
    subjectItemKindId: lot.itemKindId,
    subjectQualityTier: lot.qualityTier,
    counterpartyActorId: lot.ownerActorId,
    estimatedQuantity: lot.quantity,
    estimatedUnitPrice: Math.max(1, Math.round(band.centre)),
    confidence: "warm",
    sourceActorId: null,
    acquiredDay: atDay,
    hopCount: 0,
    derivedFromLeadId: null,
    subjectPoolId: null,
  });
}

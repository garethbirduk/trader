import type { DB } from "../core/db.js";
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
 */
export function seedSupplyLeadForStockLot(
  db: DB,
  lot: StockLot,
  atDay: number,
): Lead {
  return insertLead(db, {
    holderActorId: lot.ownerActorId,
    side: "supply",
    subjectItemKindId: lot.itemKindId,
    subjectQualityTier: lot.qualityTier,
    counterpartyActorId: lot.ownerActorId,
    estimatedQuantity: lot.quantity,
    estimatedUnitPrice: lot.acquiredUnitPrice,
    confidence: "warm",
    sourceActorId: null,
    acquiredDay: atDay,
    hopCount: 0,
    derivedFromLeadId: null,
    subjectPoolId: null,
  });
}

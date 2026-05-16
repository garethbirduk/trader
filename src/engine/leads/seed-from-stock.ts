import type { DB } from "../core/db.js";
import { getItemKindById } from "../stock/items-repo.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { perceivedTierCentre } from "../perception/arms.js";
import { insertLead } from "./leads-repo.js";
import type { Lead } from "./types.js";
import type { StockLot, QualityTier } from "../stock/types.js";
import type { EconomicsConfig } from "../economics/config.js";

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
 * Both `estimatedUnitPrice` and `subjectQualityTier` route through the
 * judgement engine so the seeder's character shapes downstream gossip:
 *
 *   • Price — `estimatePriceBand` centre lerps from the category anchor
 *     toward the lot's sunk-cost truth by the owner's price expertise.
 *   • Tier — `perceivedTierCentre` lerps from the condition anchor
 *     ("fair") toward the lot's truth tier by their condition expertise.
 *
 * A clueless owner gossips a wrong tier alongside a generic price; an
 * expert owner propagates truth. The notebook's tier glyph and the
 * downstream `priceBandFor` retail calls all read these seeded values,
 * so a low-expertise seeder's character is visible end-to-end.
 */
export function seedSupplyLeadForStockLot(
  db: DB,
  lot: StockLot,
  atDay: number,
  economics: EconomicsConfig,
): Lead {
  const item = getItemKindById(db, lot.itemKindId);
  const category = item?.category ?? "_unknown";
  const tierMult = economics.tierMultipliers[lot.qualityTier as QualityTier];
  const band = estimatePriceBand({
    db,
    actorId: lot.ownerActorId,
    category,
    truth: lot.acquiredUnitPrice,
    tierMultiplier: tierMult,
  });
  const perceivedTier = perceivedTierCentre({
    db,
    actorId: lot.ownerActorId,
    truthTier: lot.qualityTier,
    category,
  });
  return insertLead(db, {
    holderActorId: lot.ownerActorId,
    side: "supply",
    subjectItemKindId: lot.itemKindId,
    subjectQualityTier: perceivedTier,
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

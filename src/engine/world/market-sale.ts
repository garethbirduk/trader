import type { World, Unsubscribe } from "../core/world.js";
import { adjustActorCash, listActors } from "../actors/actors-repo.js";
import { getStockLotsByOwner, decrementLotQuantity } from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import {
  FALLBACK_BIDDER_PROFILE,
  type BidderProfile,
} from "../auction/bidder-profile.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { deriveKnowledgeProfile } from "../knowledge/skin-seed.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import {
  resolveOneSale,
  rollCustomerHistogram,
} from "../market/customer-flow.js";
import type { QualityTier } from "../stock/types.js";

export interface MarketSaleOptions {
  /** Where market sales happen (Peckham Market). */
  readonly marketLocationId: number;
  /** Actor ids eligible to sell at the market — usually the dealer/fence
   *  cast. Civilians passing through don't run a stall. */
  readonly sellerActorIds: ReadonlySet<number>;
  /** Bidder profiles per actor — used to compute the seller's pricing
   *  model (their estimate-mid × market fraction). */
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
  /** Economic tuning. Reads `marketSale` knobs and tier multipliers. */
  readonly economics?: EconomicsConfig;
}

/**
 * Per-hour market-stall autonomy. For each eligible seller present at
 * the market location, picks one stock lot to display, computes their
 * asking price from their own retail estimate × market fraction, and
 * walks the hour's customer histogram against the lot until either
 * customers run out or the lot's stock is exhausted.
 *
 * Sales aggregate into a single `market.hour-summary` event per
 * (seller, hour). Phase 2 will switch to player-driven pricing and
 * a price range; v1 is fully autonomous.
 */
export function registerMarketSale(
  world: World,
  opts: MarketSaleOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.marketSale;

  return world.onHour((clock) => {
    const baseFootfall = cfg.hourlyFootfall[clock.hour];
    if (baseFootfall === undefined || baseFootfall <= 0) return;

    const histogram = rollCustomerHistogram(clock.hour, cfg, world.rng);
    if (histogram.totalCount === 0) return;

    for (const seller of listActors(world.db)) {
      if (!opts.sellerActorIds.has(seller.id)) continue;
      if (seller.currentLocationId !== opts.marketLocationId) continue;
      const lots = getStockLotsByOwner(world.db, seller.id).filter(
        (l) => l.quantity > 0,
      );
      if (lots.length === 0) continue;

      // Pick the displayed lot — for v1, the lot with the most units.
      // Ties broken by id ascending. Phase 2 will let the player choose.
      const displayed = [...lots].sort(
        (a, b) => b.quantity - a.quantity || a.id - b.id,
      )[0]!;
      const item = getItemKindById(world.db, displayed.itemKindId);
      if (!item) continue;

      // Sellers without a bespoke profile use the fallback — they're
      // passable generalists with default category accuracy.
      const profile = opts.bidderProfiles.get(seller.id) ?? FALLBACK_BIDDER_PROFILE;

      // Seller's belief band — what the seller thinks the lot is worth.
      // Kept on the event for the deal/profile UI to render the
      // "what the seller thought" range; not used to gate the sale.
      const sellerEstimate = estimatePriceBand({
        db: world.db,
        actorId: seller.id,
        category: item.category,
        truth:
          item.baseValue *
          economics.tierMultipliers[displayed.qualityTier as QualityTier],
        profileOverride: deriveKnowledgeProfile(profile),
      });

      // True retail per unit — what the engine knows the lot is worth.
      // Unknown to the seller. Drives the customer's willingness window.
      const truePricePerUnit =
        item.baseValue * economics.tierMultipliers[displayed.qualityTier as QualityTier];

      let unitsSold = 0;
      let revenue = 0;
      let priceLow = Number.POSITIVE_INFINITY;
      let priceHigh = 0;
      const soldByPersona: Record<string, number> = {};
      const remainingByPersona: Record<string, number> = { ...histogram.counts };
      let stockLeft = displayed.quantity;

      // Iterate personas in stable order, using up customer counts as
      // they buy. We round-robin would over-engineer it; one persona
      // at a time matches the "the dad-shaped queue arrives, then a
      // wave of mums" feel of a market hour.
      const personaIds = Object.keys(remainingByPersona);
      for (const personaId of personaIds) {
        if (stockLeft <= 0) break;
        const persona = cfg.customerTypes[personaId];
        if (persona === undefined) continue;
        let n = remainingByPersona[personaId] ?? 0;
        while (n > 0 && stockLeft > 0) {
          const sale = resolveOneSale({
            persona,
            itemCategory: item.category,
            truePricePerUnit,
            rng: world.rng,
          });
          n -= 1;
          if (sale !== null) {
            unitsSold += 1;
            revenue += sale.soldAt;
            if (sale.soldAt < priceLow) priceLow = sale.soldAt;
            if (sale.soldAt > priceHigh) priceHigh = sale.soldAt;
            stockLeft -= 1;
            soldByPersona[personaId] = (soldByPersona[personaId] ?? 0) + 1;
          }
        }
        remainingByPersona[personaId] = n;
      }

      if (unitsSold === 0) continue;
      decrementLotQuantity(world.db, displayed.id, unitsSold);
      adjustActorCash(world.db, seller.id, revenue);

      // `pricePerUnit` becomes the AVERAGE realised price — varying
      // per customer in the [0.9, 1.1] × RRP window. `priceRange`
      // exposes the actual low/high realised across the hour.
      const averagePricePerUnit = Math.round(revenue / unitsSold);

      // Only emit when something actually sold. Zero-sale hours would
      // be no-ops — they'd clutter diaries and the event list with
      // rows that read "stall was open, nothing happened". The
      // *absence* of a market event speaks for itself.
      world.events.emit({
        type: "market.hour-summary",
        at: clock,
        sellerActorId: seller.id,
        atLocationId: opts.marketLocationId,
        stockLotId: displayed.id,
        itemKindId: item.id,
        qualityTier: displayed.qualityTier,
        pricePerUnit: averagePricePerUnit,
        priceRange: { low: priceLow, high: priceHigh },
        sellerBelief: { low: sellerEstimate.low, high: sellerEstimate.high },
        truePricePerUnit,
        unitsOffered: displayed.quantity,
        unitsSold,
        revenue,
        footfall: histogram.totalCount,
        customerMix: histogram.counts,
        soldByPersona,
      });
    }
  });
}

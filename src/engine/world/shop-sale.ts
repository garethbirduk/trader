import type { World, Unsubscribe } from "../core/world.js";
import { adjustActorCash, getActorById } from "../actors/actors-repo.js";
import {
  decrementLotQuantity,
  getStockLotsByOwner,
} from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import {
  FALLBACK_BIDDER_PROFILE,
  type BidderProfile,
} from "../auction/bidder-profile.js";
import { estimateUnitRetail } from "../auction/estimate.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";
import {
  resolveOneSale,
  rollCustomerHistogram,
} from "../market/customer-flow.js";
import type { QualityTier } from "../stock/types.js";

export interface ShopSpec {
  readonly locationId: number;
  readonly keeperActorId: number;
  /** Item categories this shop trades in. Used as a soft filter on
   *  the displayed lot — keepers prefer matching stock. */
  readonly specialties: readonly string[];
}

export interface ShopSaleOptions {
  readonly shops: readonly ShopSpec[];
  /** Bidder profiles per actor — used to compute the keeper's pricing
   *  model (their retail estimate × shopSale.pricePerUnitFraction). */
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
  readonly economics?: EconomicsConfig;
}

/**
 * Stage 8 — shop turnover.
 *
 * Before this, shopkeepers were silent sinks: dealers ran shop-deals
 * with them (via pub-deal-autonomy at shop locations), the keeper's
 * bag grew, but nothing ever moved out. Now each shop runs a small
 * household-customer histogram each open hour, mirroring the market
 * stall logic. The keeper picks one lot to display — preferring a lot
 * in their shop's specialty categories — prices it from their own
 * retail estimate, and walks the hour's customers through it.
 *
 * Reuses `rollCustomerHistogram` + `resolveOneSale` from
 * `market/customer-flow.ts`, so additions to the market persona mix
 * (new customer types in the skin) automatically apply to shop
 * footfall too. The hourly footfall comes from
 * `EconomicsConfig.shopSale.hourlyFootfall` and is shared across all
 * shops; the per-shop specialty bias emerges through
 * `categoryInterest` weights on each persona.
 *
 * Emits `market.hour-summary` events with `atLocationId` set to the
 * shop, distinguishing them from market-stall events for callers
 * that care. The viewer treats both kinds the same.
 */
export function registerShopSale(
  world: World,
  opts: ShopSaleOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const marketCfg = economics.marketSale;
  const shopCfg = economics.shopSale;

  // Hijack the market customer-types and customer-flow logic but with
  // the shop's own footfall curve. The underlying customer-flow API
  // expects a MarketSaleConfig-shaped object, so we synthesise one.
  const shopFlowConfig = {
    ...marketCfg,
    hourlyFootfall: shopCfg.hourlyFootfall,
    pricePerUnitFraction: shopCfg.pricePerUnitFraction,
  };

  return world.onHour((clock) => {
    if (!shopCfg.enabled) return;
    const footfall = shopCfg.hourlyFootfall[clock.hour];
    if (footfall === undefined || footfall <= 0) return;

    for (const shop of opts.shops) {
      const keeper = getActorById(world.db, shop.keeperActorId);
      if (!keeper) continue;
      if (keeper.currentLocationId !== shop.locationId) continue;

      const allLots = getStockLotsByOwner(world.db, shop.keeperActorId).filter(
        (l) => l.quantity > 0,
      );
      if (allLots.length === 0) continue;

      // Specialty filter — prefer lots whose item category matches.
      // If none match, fall back to whatever the keeper has (rather
      // than skipping the hour entirely; the customer-interest weights
      // still gate engagement).
      const specialtySet = new Set(shop.specialties);
      const matchingLots: typeof allLots = [];
      for (const l of allLots) {
        const item = getItemKindById(world.db, l.itemKindId);
        if (item && specialtySet.has(item.category)) matchingLots.push(l);
      }
      const eligibleLots = matchingLots.length > 0 ? matchingLots : allLots;

      // Display the lot with the most units (ties broken by id), same
      // as the market stall.
      const displayed = [...eligibleLots].sort(
        (a, b) => b.quantity - a.quantity || a.id - b.id,
      )[0]!;
      const item = getItemKindById(world.db, displayed.itemKindId);
      if (!item) continue;

      const profile =
        opts.bidderProfiles.get(shop.keeperActorId) ?? FALLBACK_BIDDER_PROFILE;
      // Keeper's belief band — surfaced on the event for the UI, not
      // used to gate sales (customer drives the realised price).
      const sellerEstimate = estimateUnitRetail(
        profile,
        item,
        displayed.qualityTier as QualityTier,
        economics,
      );

      const histogram = rollCustomerHistogram(clock.hour, shopFlowConfig, world.rng);
      if (histogram.totalCount === 0) continue;

      const truePricePerUnit =
        item.baseValue *
        economics.tierMultipliers[displayed.qualityTier as QualityTier];

      let unitsSold = 0;
      let revenue = 0;
      let priceLow = Number.POSITIVE_INFINITY;
      let priceHigh = 0;
      const soldByPersona: Record<string, number> = {};
      const remainingByPersona: Record<string, number> = { ...histogram.counts };
      let stockLeft = displayed.quantity;
      const personaIds = Object.keys(remainingByPersona);
      for (const personaId of personaIds) {
        if (stockLeft <= 0) break;
        const persona = marketCfg.customerTypes[personaId];
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
      adjustActorCash(world.db, shop.keeperActorId, revenue);

      const averagePricePerUnit = Math.round(revenue / unitsSold);

      world.events.emit({
        type: "market.hour-summary",
        at: clock,
        sellerActorId: shop.keeperActorId,
        atLocationId: shop.locationId,
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

import type { Migration } from "../migrations.js";
import { m001Smoke } from "./001-smoke.js";
import { m002ActorsItemsStock } from "./002-actors-items-stock.js";
import { m003Deals } from "./003-deals.js";
import { m004Locations } from "./004-locations.js";
import { m005LeadsTrust } from "./005-leads-trust.js";
import { m006PoolsAuction } from "./006-pools-auction.js";
import { m007AuctionTotals } from "./007-auction-totals.js";
import { m008ItemKindExtras } from "./008-item-kind-extras.js";
import { m009KnownFlaws } from "./009-known-flaws.js";
import { m010LeadsAndLocations } from "./010-leads-and-locations.js";
import { m011Transport } from "./011-transport.js";
import { m012StockAndDeliveryLocation } from "./012-stock-and-delivery-location.js";
import { m013Heat } from "./013-heat.js";
import { m014ActorHome } from "./014-actor-home.js";
import { m015LocationType } from "./015-location-type.js";
import { m016ItemSize } from "./016-item-size.js";
import { m017ActorLockup } from "./017-actor-lockup.js";
import { m018AuctionDocket } from "./018-auction-docket.js";
import { m019RepLeads } from "./019-rep-leads.js";
import { m020VirtualActors } from "./020-virtual-actors.js";
import { m021PendingPayouts } from "./021-pending-payouts.js";
import { m022AuctionLotProvenance } from "./022-auction-lot-provenance.js";

/**
 * Ordered list of all migrations the engine will apply. Append, never
 * reorder or rewrite past entries — once a migration has shipped, it is
 * effectively part of the on-disk schema contract.
 */
export const ALL_MIGRATIONS: readonly Migration[] = [
  m001Smoke,
  m002ActorsItemsStock,
  m003Deals,
  m004Locations,
  m005LeadsTrust,
  m006PoolsAuction,
  m007AuctionTotals,
  m008ItemKindExtras,
  m009KnownFlaws,
  m010LeadsAndLocations,
  m011Transport,
  m012StockAndDeliveryLocation,
  m013Heat,
  m014ActorHome,
  m015LocationType,
  m016ItemSize,
  m017ActorLockup,
  m018AuctionDocket,
  m019RepLeads,
  m020VirtualActors,
  m021PendingPayouts,
  m022AuctionLotProvenance,
];

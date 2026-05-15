/**
 * Shared world setup used by both the headless Node sim (`run-sim.ts`)
 * and the in-browser live mode. Owns: skin seeding, World construction,
 * and registration of every engine subsystem (planner, deliveries,
 * auctions, gossip, heat, etc.).
 *
 * Migrations are NOT applied here — the caller does that against its
 * concrete DB driver (better-sqlite3 in Node, sql.js in the browser)
 * before calling `setupWorld`. Event subscribers (console output,
 * tally, snapshot capture) are also the caller's responsibility — this
 * module just hands back a configured `World` that's ready to run.
 */

import type { DB } from "./core/db.js";
import { applyMigrations } from "./core/migrations.js";
import { ALL_MIGRATIONS } from "./core/migrations/index.js";
import { World } from "./core/world.js";
import { createRNG } from "./core/rng.js";
import { PolicyRegistry } from "./policy/runner.js";
import { seedPlaceholderSkin } from "../skins/placeholder/index.js";
import type { SkinSeedResult } from "../skins/placeholder/index.js";
import {
  DeliveryRegistry,
  registerDailyDelivery,
} from "./world/delivery-scheduler.js";
import { registerPoolExpiry } from "./world/pool-expiry.js";
import { registerDailyAuction } from "./world/daily-auction.js";
import { registerAuctionListingKnowledge } from "./world/auction-listing-knowledge.js";
import { registerAuctionInspection } from "./world/auction-inspection.js";
import { registerOffMapResale } from "./world/off-map-resale.js";
import { registerLeadDecay } from "./world/lead-decay.js";
import { registerPendingPayouts } from "./world/pending-payouts.js";
import { registerRegionalClearance } from "./world/regional-clearance.js";
import { registerClearanceAutonomy } from "./world/clearance-autonomy.js";
import { registerMarketStallAutonomy } from "./world/market-stall-autonomy.js";
import { DiaryAlertRegistry } from "./world/diary-alerts.js";
import { PatrolPicker } from "./world/patrol-picker.js";
import { registerSlaterAlerts } from "./world/slater-alerts.js";
import { registerWriteOffRubbish } from "./world/write-off-rubbish.js";
import { registerMarketSale } from "./world/market-sale.js";
import { registerShopSale, type ShopSpec } from "./world/shop-sale.js";
import {
  PlannerRegistry,
  registerActorPlanner,
  type CandidateLocation,
} from "./world/actor-planner.js";
import {
  resolveEconomicsConfig,
  type EconomicsConfig,
} from "./economics/config.js";
import { registerTrustReactions } from "./world/trust-reactions.js";
import { registerReputationReactions } from "./world/reputation-reactions.js";
import { registerPolicyHourTick } from "./world/policy-tick.js";
import { registerPoolClaimAutonomy } from "./world/pool-claim-autonomy.js";
import { listLocations } from "./locations/locations.js";
import { makeDefaultBidders } from "./auction/default-bidders.js";
import { registerPoolSpawner } from "../skins/placeholder/pool-spawner.js";
import { registerPubDealAutonomy } from "./world/pub-deal-autonomy.js";
import { registerLocationGossip } from "./world/location-gossip.js";
import { registerVisitorChat } from "./world/visitor-chat.js";
import { registerPubDealGossip } from "./world/pub-deal-gossip.js";
import { registerDetailUnlock } from "./world/detail-unlock.js";
import { registerBrokerMaterialisation } from "./world/broker-materialisation.js";
import { registerHeatReactions } from "./world/heat-reactions.js";
import { registerHeatDecay } from "./world/heat-decay.js";
import { registerAuthoritySweep } from "./world/authority-sweep.js";
import { registerNotebookDiff } from "./world/notebook.js";

export interface SetupOptions {
  readonly seed: string;
  /** Override the skin's default run length. */
  readonly runLengthDays?: number;
  /** Override individual economics knobs; unset fields fall back to skin defaults. */
  readonly economics?: Partial<EconomicsConfig>;
  /** Apply migrations as part of setup. Defaults to true. Set to false
   *  if the caller has already migrated (e.g. when reopening an
   *  existing sql.js DB from IndexedDB). */
  readonly applyMigrations?: boolean;
}

export interface SetupResult {
  readonly world: World;
  readonly skin: SkinSeedResult;
}

/**
 * Wire up a fully-configured world against `db`. After this returns,
 * the caller can subscribe to `world.events`, then call
 * `world.runToCompletion()` (or drive `tickOnce()` manually).
 */
export function setupWorld(db: DB, opts: SetupOptions): SetupResult {
  if (opts.applyMigrations !== false) {
    applyMigrations(db, ALL_MIGRATIONS);
  }

  const rng = createRNG(opts.seed);

  // Registries are created up-front so the skin's policies can consult
  // them for trip overrides at construction time. Priority order:
  // delivery > lunch > planner > base schedule.
  const deliveryRegistry = new DeliveryRegistry();
  const plannerRegistry = new PlannerRegistry();
  // Lightweight map of (actorId, day, hour) → locId for lunch-slot
  // randomness. Inline class to avoid a tiny standalone file.
  const lunchOverrides = new Map<number, Map<number, Map<number, number>>>();
  const lunchGet = (
    actorId: number,
    day: number,
    hour: number,
  ): number | null =>
    lunchOverrides.get(actorId)?.get(day)?.get(hour) ?? null;
  const lunchSet = (
    actorId: number,
    day: number,
    hour: number,
    locId: number,
  ): void => {
    let perActor = lunchOverrides.get(actorId);
    if (perActor === undefined) {
      perActor = new Map();
      lunchOverrides.set(actorId, perActor);
    }
    let perDay = perActor.get(day);
    if (perDay === undefined) {
      perDay = new Map();
      perActor.set(day, perDay);
    }
    perDay.set(hour, locId);
  };

  const diaryAlerts = new DiaryAlertRegistry();
  const patrolPicker = new PatrolPicker();

  const skin = seedPlaceholderSkin(db, rng, {
    ...(opts.runLengthDays !== undefined
      ? { runLengthDays: opts.runLengthDays }
      : {}),
    hourOverrideForActor: (actorId) => (clock) => {
      const fromDelivery = deliveryRegistry.getOverride(actorId, clock.hour);
      if (fromDelivery !== null) return fromDelivery;
      // Event-driven alerts beat schedule + patrol — a tip-off
      // about stolen goods pulls Slater off his beat.
      const fromAlert = diaryAlerts.getAlertAt(actorId, clock);
      if (fromAlert !== null) return fromAlert.destinationLocationId;
      // Patrol picker (Slater only — others return null).
      const fromPatrol = patrolPicker.pickFor(actorId, clock, rng);
      if (fromPatrol !== null) return fromPatrol;
      const fromLunch = lunchGet(actorId, clock.day, clock.hour);
      if (fromLunch !== null) return fromLunch;
      return plannerRegistry.getOverride(actorId, clock.day, clock.hour);
    },
    economics: resolveEconomicsConfig({
      // Wholesale prices at ~25% of retail mid — enough headroom for
      // a two-link middleman chain to clear at 50% margins.
      poolOpeningFraction: 0.25,
      // Stale stock falls to ~half opening price near expiry.
      poolClosingFraction: 0.5,
      // Pub buyers can't see actual condition — they assume 'fair'.
      // Sellers who know they have shoddy stock can take advantage.
      pubBuyerTierMode: "assumed",
      ...(opts.economics ?? {}),
    }),
  });

  // Lunch-slot rolls: one pick per (actor, day) shared across all
  // the actor's lunch hours that day, so e.g. Alan Parry doesn't
  // jump between Sid's and the Nag's between 13:00 and 14:00. Done
  // after the skin returns so we know the run length.
  for (const [actorId, spec] of skin.lunchSpecsByActorId) {
    for (let day = 1; day <= skin.runLengthDays; day += 1) {
      const dow = ((day - 1) % 7) + 1;
      if (!spec.daysOfWeek.includes(dow)) continue;
      const locId = rng.pick(spec.candidateLocIds);
      for (const hour of spec.hours) {
        lunchSet(actorId, day, hour, locId);
      }
    }
  }

  const world = new World({
    db,
    rng,
    seed: opts.seed,
    maxDays: skin.runLengthDays,
  });

  // ── Engine subsystems ────────────────────────────────────────────
  //
  // Hour-tick lifecycle:
  //   1. LEAVE   — actors whose schedule says "be elsewhere this
  //                hour" depart; `actor.departed` fires for each.
  //   2. ARRIVE  — those actors land at their destination;
  //                `actor.travelled` fires for each.
  //   3. INTERACT — gossip with proprietors, the daily auction (at
  //                AUCTION_HOUR), pool claims, pub deals. By this
  //                point everyone's at the location they're meant
  //                to be at this hour.
  //   4. TICK    — the world clock advances one hour.
  //
  // (1) and (2) are both done by `policy-tick`, which is therefore
  // registered first — every interaction handler that follows
  // observes post-arrival state.

  registerPoolExpiry(world);

  // 1 + 2 — leave & arrive.
  const policyRegistry = new PolicyRegistry();
  for (const [actorId, policy] of skin.policies) {
    policyRegistry.register(actorId, policy);
  }
  registerPolicyHourTick(world, policyRegistry);

  // Delivery scheduler. Registered AFTER policy-tick so settlement
  // runs after the seller has actually arrived at the dropoff
  // location.
  registerDailyDelivery(world, {
    registry: deliveryRegistry,
    procurementProceedsActorId: skin.auctionHouseActorId,
    getSchedulingInfo: (actorId) => {
      const r = skin.actorRoutines.get(actorId);
      if (!r) return null;
      return {
        flexibleHours: r.flexibleHours,
        schedule: r.schedule,
        awakeHours: r.awakeHours,
      };
    },
  });

  // 3 — interactions, all observe post-arrival positions.
  registerLocationGossip(world, { economics: skin.economics });

  // Visitor↔visitor chat at social venues. Pubs are the cinematic core
  // (an evening at the Nag's), but the high-street caff (Sid's) and
  // the market hall also linger long enough for real conversation, so
  // those venues participate too. The auction gallery is excluded —
  // people stop there for the listing, not to talk.
  const chatLocationIds: number[] = [
    ...skin.allPubLocationIds,
    skin.marketLocationId,
    ...skin.newspaperLocationIds, // Sid's + high-street newsagents.
  ];
  registerVisitorChat(world, {
    chatLocationIds,
    infoTraderActorIds: new Set(skin.infoTraderActorIds),
    economics: skin.economics,
  });

  // Deal-adjacent gossip. Every pubdeal — agreed or walked — leaks a
  // piece of news between the two would-be counterparties.
  registerPubDealGossip(world, { economics: skin.economics });

  // Two-tier gossip — paid detail unlock. After a successful chat or
  // proprietor gossip exchange, an eligible asker may "buy the partner
  // a drink" for £3 and unlock the detail tier on their top-N locked
  // headlines. Player-driven for the human-controlled actor; autonomous
  // roll for NPCs. Excludes the player from the autonomy roll so their
  // unlock is always intentional.
  const detailUnlockAutonomy = new Set<number>(
    [...skin.tradingActorIds].filter((id) => id !== skin.playerActorId),
  );
  registerDetailUnlock(world, {
    bidderProfiles: skin.bidderProfiles,
    infoTraderActorIds: new Set(skin.infoTraderActorIds),
    autonomyEligibleActorIds: detailUnlockAutonomy,
    economics: skin.economics,
  });

  // Broker materialisation — at the pubs, brokers occasionally bring
  // their virtual producer in for an hour. Invert the per-producer
  // broker list into a per-broker producer list so the handler can do
  // a quick lookup.
  const producersByBroker = new Map<number, number[]>();
  for (const p of skin.virtualProducers) {
    for (const brokerId of p.brokerActorIds) {
      const list = producersByBroker.get(brokerId) ?? [];
      list.push(p.actorId);
      producersByBroker.set(brokerId, list);
    }
  }
  if (skin.allPubLocationIds.length > 0 && producersByBroker.size > 0) {
    registerBrokerMaterialisation(world, {
      venueLocationIds: skin.allPubLocationIds,
      producersByBroker,
      feeProceedsActorId: skin.auctionHouseActorId,
    });
  }
  registerAuctionListingKnowledge(world, {
    newspaperLocationIds: skin.newspaperLocationIds,
    paperFromHour: skin.paperFromHour,
    galleryLocationId: skin.auctionLocationId,
    galleryFromHour: skin.galleryFromHour,
    auctionStartHour: skin.auctionStartHour,
    auctionEndHour: skin.auctionEndHour,
  });
  registerAuctionInspection(world, {
    galleryLocationId: skin.auctionLocationId,
    auctionStartHour: skin.auctionStartHour,
    auctionEndHour: skin.auctionEndHour,
  });
  registerDailyAuction(world, {
    proceedsActorId: skin.auctionHouseActorId,
    auctionStartHour: skin.auctionStartHour,
    auctionEndHour: skin.auctionEndHour,
    auctionLocationId: skin.auctionLocationId,
    findBiddersForLot: makeDefaultBidders({
      profiles: skin.bidderProfiles,
      requireActorAtLocationId: skin.auctionLocationId,
      requireKnowledge: true,
      economics: skin.economics,
      offMapDealerActorIds: new Set(skin.offMapDealerActorIds),
    }),
  });

  // Per-hour actor planner — picks where each flexible actor should be
  // *next* hour by scoring auction / market / each shop / each pub /
  // newspaper / home against inventory, cash, known docket lots, and
  // travel cost.
  const candidates: CandidateLocation[] = [];
  const locByCode = skin.locationByCode;
  const allLocations = listLocations(db);
  const openHoursByCode = new Map<string, { start: number; end: number } | null>();
  const codeById = new Map<number, string>();
  for (const l of allLocations) {
    openHoursByCode.set(l.code, l.openHours);
    codeById.set(l.id, l.code);
  }

  const auctionId = locByCode.get("auction-house");
  if (auctionId !== undefined) {
    candidates.push({
      locId: auctionId,
      code: "auction-house",
      kind: "auction",
      position: null,
      openHours: openHoursByCode.get("auction-house") ?? null,
    });
  }
  const marketId = locByCode.get("peckham-market");
  if (marketId !== undefined) {
    candidates.push({
      locId: marketId,
      code: "peckham-market",
      kind: "market",
      position: null,
      openHours: openHoursByCode.get("peckham-market") ?? null,
    });
  }
  for (const id of skin.allPubLocationIds) {
    const code = codeById.get(id) ?? `loc-${id}`;
    candidates.push({
      locId: id,
      code,
      kind: "pub",
      position: null,
      openHours: openHoursByCode.get(code) ?? null,
    });
  }
  for (const id of skin.shopLocationIds) {
    const code = codeById.get(id) ?? `loc-${id}`;
    const specs = skin.shopSpecialtiesByLocation.get(id) ?? [];
    candidates.push({
      locId: id,
      code,
      kind: "shop",
      position: null,
      openHours: openHoursByCode.get(code) ?? null,
      specialties: new Set(specs),
    });
  }
  for (const id of skin.newspaperLocationIds) {
    const code = codeById.get(id) ?? `loc-${id}`;
    candidates.push({
      locId: id,
      code,
      kind: "newspaper",
      position: null,
      openHours: openHoursByCode.get(code) ?? null,
    });
  }

  const flexibleActorIds = new Set(skin.flexibleDailyModeActorIds);
  const awakeHoursByActor = new Map<number, { start: number; end: number }>();
  const flexibleHoursByActor = new Map<number, ReadonlySet<number>>();
  const homeLocationByActor = new Map<number, number>();
  for (const [actorId, info] of skin.actorRoutines) {
    if (info.awakeHours) awakeHoursByActor.set(actorId, info.awakeHours);
    if (info.flexibleHours) flexibleHoursByActor.set(actorId, info.flexibleHours);
    if (info.homeLocationId !== null)
      homeLocationByActor.set(actorId, info.homeLocationId);
  }

  registerActorPlanner(world, {
    flexibleActorIds,
    bidderProfiles: skin.bidderProfiles,
    awakeHoursByActor,
    flexibleHoursByActor,
    homeLocationByActor,
    candidates,
    registry: plannerRegistry,
    economics: skin.economics,
  });

  const tradingIds = skin.tradingActorIds;
  registerPoolClaimAutonomy(world, {
    claimingActorIds: tradingIds,
    proceedsActorId: skin.auctionHouseActorId,
    attemptChance: 0.5,
    claimQuantity: 8,
  });
  registerPubDealAutonomy(world, {
    pubLocationIds: skin.pubLocationIds,
    npcActorIds: tradingIds,
    bidderProfiles: skin.bidderProfiles,
    economics: skin.economics,
  });

  // High-street shop sales — same negotiation mechanism, higher buyer
  // ceiling (75% of retail) since shops sell direct to customers.
  if (skin.shopLocationIds.length > 0 && skin.shopkeeperActorIds.length > 0) {
    const shopEconomics = {
      ...skin.economics,
      pubBuyerCeilingFraction: 0.75,
    };
    const shopkeeperSet = new Set(skin.shopkeeperActorIds);
    const dealerSet = new Set(tradingIds);
    registerPubDealAutonomy(world, {
      pubLocationIds: skin.shopLocationIds,
      npcActorIds: [...tradingIds, ...skin.shopkeeperActorIds],
      bidderProfiles: skin.bidderProfiles,
      economics: shopEconomics,
      requireSellerFrom: dealerSet,
      requireBuyerFrom: shopkeeperSet,
      startHour: 9,
      endHour: 17,
    });
  }
  registerMarketSale(world, {
    marketLocationId: skin.marketLocationId,
    sellerActorIds: new Set(skin.marketSellerActorIds),
    bidderProfiles: skin.bidderProfiles,
    economics: skin.economics,
  });

  // Stage 8 — shop turnover. Each high-street shop runs its own small
  // household-customer histogram each open hour. Pair every shop
  // location with its keeper actor; the skin's shop-specialty map
  // becomes the per-shop category bias.
  if (skin.shopLocationIds.length > 0 && skin.shopkeeperActorIds.length > 0) {
    const codeToKeeperId = new Map<string, number>();
    // Trust the skin: keepers and shop locations zip by order in the
    // HIGH_STREET_SHOPS list. The keeper actor's `currentLocationId`
    // becomes the shop during their open hours, and that's the field
    // shop-sale checks.
    const shops: ShopSpec[] = [];
    for (const shopId of skin.shopLocationIds) {
      // The skin doesn't expose a direct shop→keeper map. Find a
      // shopkeeper whose schedule places them at this shop. (The
      // placeholder skin's keepers each have their shop as their
      // default location.)
      for (const keeperId of skin.shopkeeperActorIds) {
        const routine = skin.actorRoutines.get(keeperId);
        if (!routine) continue;
        // Any hour in the keeper's schedule that points at this shop
        // is enough to associate them.
        let matches = false;
        for (const locId of routine.schedule.values()) {
          if (locId === shopId) {
            matches = true;
            break;
          }
        }
        if (matches) {
          codeToKeeperId.set(`shop-${shopId}`, keeperId);
          break;
        }
      }
    }
    for (const shopId of skin.shopLocationIds) {
      const keeperId = codeToKeeperId.get(`shop-${shopId}`);
      if (keeperId === undefined) continue;
      const specialties = skin.shopSpecialtiesByLocation.get(shopId) ?? [];
      const footfall = skin.shopFootfallByLocation.get(shopId);
      const personaMults = skin.shopPersonaMultipliersByLocation.get(shopId);
      shops.push({
        locationId: shopId,
        keeperActorId: keeperId,
        specialties: [...specialties],
        ...(footfall !== undefined ? { hourlyFootfall: footfall } : {}),
        ...(personaMults !== undefined
          ? { personaWeightMultipliers: personaMults }
          : {}),
      });
    }
    if (shops.length > 0) {
      registerShopSale(world, {
        shops,
        bidderProfiles: skin.bidderProfiles,
        economics: skin.economics,
      });
    }
  }

  // Off-map resale: at day-end, off-map dealers liquidate today's
  // purchases against the synthetic external-economy account.
  if (skin.offMapDealerActorIds.length > 0) {
    registerOffMapResale(world, {
      offMapDealerActorIds: new Set(skin.offMapDealerActorIds),
      offMapMarketActorId: skin.offMapMarketActorId,
      economics: skin.economics,
    });
  }

  // Trust/heat reactions are event-driven.
  registerTrustReactions(world);
  registerHeatReactions(world);
  registerReputationReactions(world);

  // Day-scoped bookkeeping. Pending-payouts drains first so any cash
  // arriving today is in actors' hands before they decide where to
  // be (planner) or what to bid (auction). Regional-clearance lists
  // its lots before the daily auction picks the docket. Write-off
  // runs early so the cleared rubbish doesn't clutter today's planner.
  registerPendingPayouts(world);
  registerWriteOffRubbish(world, {
    economics: skin.economics,
    feeProceedsActorId: skin.auctionHouseActorId,
  });
  registerRegionalClearance(world, { economics: skin.economics });
  // House clearances (todolist #9). Full lifecycle:
  //   • morning spawn (default 1 listing per Mon-Sat day)
  //   • newspaper knowledge propagation at Sid's / newsagents
  //   • NPC booking autonomy at pubs (where the phone is)
  //   • hourly resolver delivers hauls to winning bookers
  //   • end-of-day expiry for unbooked listings
  registerClearanceAutonomy(world, {
    newspaperLocationIds: skin.newspaperLocationIds,
    paperFromHour: skin.paperFromHour,
    phoneCapableLocationIds: skin.allPubLocationIds,
    bookerActorIds: new Set(skin.tradingActorIds),
  });
  // Market stall mode + Slater patrol (todolist #3 + #4). Sellers
  // register their stall each day (legit £20 fee or free-but-risky
  // adhoc); during open hours Slater may turn up and bust adhoc
  // stalls. Bribery primitive composes with witness leads — every
  // bribe at the market is seen by present bystanders.
  if (skin.patrolOfficerActorId !== undefined) {
    const marketOpenHours = Object.keys(
      skin.economics.marketSale.hourlyFootfall,
    )
      .map((h) => Number(h))
      .filter((h) => Number.isFinite(h));
    registerMarketStallAutonomy(world, {
      marketLocationId: skin.marketLocationId,
      marketOpenHours,
      sellerActorIds: new Set(skin.marketSellerActorIds),
      patrolOfficerActorId: skin.patrolOfficerActorId,
      fineProceedsActorId: skin.auctionHouseActorId,
    });
    // Event-driven alerts that override the patrol pick.
    registerSlaterAlerts(world, {
      slaterActorId: skin.patrolOfficerActorId,
      registry: diaryAlerts,
    });
  }
  // Register each officer's patrol beat. The hourOverrideForActor
  // callback already wired into the skin consults this picker each
  // tick. Officers' beats may overlap. Independent of bust-officer
  // wiring above — presence and bust mechanics are separate.
  for (const officer of skin.patrolOfficers) {
    patrolPicker.register({
      actorId: officer.officerActorId,
      candidates: officer.candidates,
      activeHours: officer.activeHours,
    });
  }
  registerLeadDecay(world);
  registerHeatDecay(world);
  registerAuthoritySweep(world, {
    fineProceedsActorId: skin.auctionHouseActorId,
  });
  registerPoolSpawner(world, {
    reachableByCategory: skin.reachableByCategory,
    defaultReachableActorIds: skin.defaultReachableActorIds,
    economics: skin.economics,
    virtualProducersByCategory: skin.virtualProducersByCategory,
  });

  // Notebook diff — last in the hour-tick chain so it observes all
  // state mutations the other mechanics produced this hour. Covers
  // every actor with a bidder profile (the trading cast); civilians
  // and virtual producers have no notebook.
  registerNotebookDiff(world, {
    actorIds: [...skin.bidderProfiles.keys()],
    bidderProfiles: skin.bidderProfiles,
  });

  return { world, skin };
}

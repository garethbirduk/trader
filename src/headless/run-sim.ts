import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBetterSqlite3DB } from "../engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../engine/core/migrations/index.js";
import { World } from "../engine/core/world.js";
import { consoleHandler, type WorldEvent } from "../engine/core/events.js";
import { createRNG } from "../engine/core/rng.js";
import {
  getActorByCode,
  getActorById,
} from "../engine/actors/actors-repo.js";
import { PolicyRegistry } from "../engine/policy/runner.js";
import { seedPlaceholderSkin } from "../skins/placeholder/index.js";
import { DeliveryRegistry, registerDailyDelivery } from "../engine/world/delivery-scheduler.js";
import { registerPoolExpiry } from "../engine/world/pool-expiry.js";
import { registerDailyAuction } from "../engine/world/daily-auction.js";
import { registerAuctionListingKnowledge } from "../engine/world/auction-listing-knowledge.js";
import { registerAuctionInspection } from "../engine/world/auction-inspection.js";
import { registerLeadDecay } from "../engine/world/lead-decay.js";
import { registerMarketSale } from "../engine/world/market-sale.js";
import {
  DayModeRegistry,
  registerDealerDayMode,
} from "../engine/world/dealer-day-mode.js";
import { resolveEconomicsConfig } from "../engine/economics/config.js";
import { registerTrustReactions } from "../engine/world/trust-reactions.js";
import { registerPolicyHourTick } from "../engine/world/policy-tick.js";
import { registerPoolClaimAutonomy } from "../engine/world/pool-claim-autonomy.js";
import { getDealsByState } from "../engine/deals/deals-repo.js";
import { listActors } from "../engine/actors/actors-repo.js";
import { listItemKinds } from "../engine/stock/items-repo.js";
import { listLocations } from "../engine/locations/locations.js";
import { makeDefaultBidders } from "../engine/auction/default-bidders.js";
import { registerPoolSpawner } from "../skins/placeholder/pool-spawner.js";
import { registerPubDealAutonomy } from "../engine/world/pub-deal-autonomy.js";
import { registerLocationGossip } from "../engine/world/location-gossip.js";
import { registerHeatReactions } from "../engine/world/heat-reactions.js";
import { registerHeatDecay } from "../engine/world/heat-decay.js";
import { registerAuthoritySweep } from "../engine/world/authority-sweep.js";

interface CliOptions {
  days: number | null;
  seed: string;
  dbPath: string;
  quiet: boolean;
  out: string | null;
}

function parseCli(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      days: { type: "string" },
      seed: { type: "string", default: "default" },
      db: { type: "string", default: ":memory:" },
      quiet: { type: "boolean", default: false },
      out: { type: "string" },
    },
    strict: true,
  });
  const daysStr = values.days as string | undefined;
  const days = daysStr === undefined ? null : Number.parseInt(daysStr, 10);
  if (days !== null && (!Number.isInteger(days) || days < 1)) {
    throw new Error(`--days must be a positive integer; got ${daysStr}`);
  }
  return {
    days,
    seed: values.seed as string,
    dbPath: values.db as string,
    quiet: values.quiet as boolean,
    out: (values.out as string | undefined) ?? null,
  };
}

function main(): void {
  const opts = parseCli(process.argv.slice(2));
  const db = openBetterSqlite3DB({ filename: opts.dbPath });
  try {
    applyMigrations(db, ALL_MIGRATIONS);
    const rng = createRNG(opts.seed);

    // The delivery registry is created up-front so the skin's policies
    // can consult it for trip overrides at construction time. The
    // day-mode registry is filled at day-start by the dealer mode
    // picker; both are consulted in priority order by the override
    // callback (delivery > daymode > base schedule).
    const deliveryRegistry = new DeliveryRegistry();
    const dayModeRegistry = new DayModeRegistry();
    const skin = seedPlaceholderSkin(db, rng, {
      ...(opts.days !== null ? { runLengthDays: opts.days } : {}),
      hourOverrideForActor: (actorId) => (clock) => {
        // Delivery commitments win — physical pickup/dropoff trips
        // override anything else.
        const fromDelivery = deliveryRegistry.getOverride(actorId, clock.hour);
        if (fromDelivery !== null) return fromDelivery;
        // Then today's chosen mode (auction / market / pub / home).
        return dayModeRegistry.getOverride(actorId, clock.day, clock.hour);
      },
      // Tunable economy knobs. Edit these to retune the price chain.
      economics: resolveEconomicsConfig({
        // Wholesale prices at ~25% of retail mid — enough headroom for
        // a two-link middleman chain to clear at 50% margins.
        poolOpeningFraction: 0.25,
        // Stale stock falls to ~half opening price near expiry.
        poolClosingFraction: 0.5,
        // Pub buyers can't see actual condition — they assume 'fair'.
        // Sellers who know they have shoddy stock can take advantage.
        pubBuyerTierMode: "assumed",
      }),
    });

    const world = new World({
      db,
      rng,
      seed: opts.seed,
      maxDays: skin.runLengthDays,
    });

    if (!opts.quiet) {
      world.events.subscribe(consoleHandler());
    }

    // Tally for the end-of-run report.
    const tally = newTally();
    world.events.subscribe((e) => updateTally(tally, e));

    // If --out is set, capture every event into a buffer plus an
    // end-of-day snapshot of the world's tabular state so the webapp can
    // render any historical day directly. We also push a "day 0"
    // snapshot taken right after seeding so the webapp can show
    // pre-day-1 actor positions correctly (otherwise it falls back to
    // the actor's end-of-run location).
    const eventLog: WorldEvent[] = [];
    const snapshots: DaySnapshot[] = [];
    if (opts.out !== null) {
      snapshots.push(captureSnapshot(db, 0));
      world.events.subscribe((e) => {
        eventLog.push(e);
        if (e.type === "day.ended") {
          snapshots.push(captureSnapshot(db, e.day));
        }
      });
    }

    // ── Engine subsystems ────────────────────────────────────────────
    //
    // The hour-tick lifecycle is:
    //
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
    // observes post-arrival state. Day-scoped handlers (settlement,
    // pool expiry, lead decay, heat decay, authority sweep, pool
    // spawner) hook `onDayStart` / `onDayEnd` and their registration
    // order doesn't affect the hour pipeline.

    registerPoolExpiry(world);

    // 1 + 2 — leave & arrive.
    const registry = new PolicyRegistry();
    for (const [actorId, policy] of skin.policies) {
      registry.register(actorId, policy);
    }
    registerPolicyHourTick(world, registry);

    // Delivery scheduler: at day-start of each deadline day, plans
    // pickup/dropoff trips into sellers' flexible hours; settles deals
    // when the dropoff hour arrives. Registered AFTER policy-tick so
    // settlement runs after the seller has actually arrived at the
    // dropoff location. Registry is created up-front above so the
    // skin's policies can consult it via hourOverrideForActor.
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
    registerLocationGossip(world);
    // Auction listing knowledge gates who can bid: actors learn today's
    // docket by reading the paper at Sid's, visiting Sotheby's gallery,
    // attending the auction itself, or via gossip. Without knowledge,
    // bidders can't appear. Registered BEFORE inspection so actors who
    // arrive at the gallery this hour learn the docket in time to act
    // on it within the same hour.
    registerAuctionListingKnowledge(world, {
      newspaperLocationId: skin.newspaperLocationId,
      paperFromHour: skin.paperFromHour,
      galleryLocationId: skin.auctionLocationId,
      galleryFromHour: skin.galleryFromHour,
      auctionStartHour: skin.auctionStartHour,
      auctionEndHour: skin.auctionEndHour,
    });
    // Inspection: actors at Sotheby's can spend a non-bidding hour
    // reviewing a future lot to reveal its quality tier. Registered
    // BEFORE the auction handler so the auction sees this hour's
    // inspection records when filtering out occupied bidders.
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
        // Production runs use docket + listing-knowledge: bidders must
        // have learned about the lot to participate.
        requireKnowledge: true,
        economics: skin.economics,
      }),
    });
    // Dealer day-mode picker — runs at day-start AFTER the auction's
    // docket-publish handler (registration order). Reads the docket
    // and rolls today's mode for each flexible dealer.
    registerDealerDayMode(world, {
      flexibleActorIds: new Set(skin.flexibleDailyModeActorIds),
      bidderProfiles: skin.bidderProfiles,
      locationByCode: skin.locationByCode,
      registry: dayModeRegistry,
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
    // High-street shop sales — same negotiation mechanism, but the
    // buyer must be a shopkeeper, the seller must be a dealer, and
    // shopkeepers pay a higher fraction of retail (75%) since they
    // sell direct to customers rather than re-trading.
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
        // Shops are open 9-17, so haggling only makes sense in that window.
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

    // Trust/heat reactions are event-driven (subscribe to other
    // events) — registration order doesn't pin them to a phase.
    registerTrustReactions(world);
    registerHeatReactions(world);

    // Day-scoped bookkeeping.
    registerLeadDecay(world);
    registerHeatDecay(world);
    registerAuthoritySweep(world, {
      fineProceedsActorId: skin.auctionHouseActorId,
    });
    registerPoolSpawner(world, {
      reachableByCategory: skin.reachableByCategory,
      defaultReachableActorIds: skin.defaultReachableActorIds,
      economics: skin.economics,
    });

    world.runToCompletion();

    printReport(db, skin, tally);

    if (opts.out !== null) {
      const routineEntries = [...skin.actorRoutines.entries()].map(
        ([actorId, info]) => ({
          actorId,
          homeLocationId: info.homeLocationId,
          schedule: [...info.schedule.entries()].map(([hour, locationId]) => ({
            hour,
            locationId,
          })),
          awakeHours: { start: info.awakeHours.start, end: info.awakeHours.end },
        }),
      );
      writeRunDump(opts.out, {
        seed: opts.seed,
        runLengthDays: skin.runLengthDays,
        tally,
        events: eventLog,
        actors: listActors(db).map((a) => {
          const profile = skin.bidderProfiles.get(a.id);
          return {
            id: a.id,
            code: a.code,
            displayName: a.displayName,
            cash: a.cash,
            currentLocationId: a.currentLocationId,
            homeLocationId: a.homeLocationId,
            transportCapacity: a.transportCapacity,
            roles: skin.rolesByActorId.get(a.id) ?? [],
            ...(profile !== undefined
              ? {
                  bidderProfile: {
                    appraisalAccuracy: Object.fromEntries(profile.appraisalAccuracy),
                    defaultAppraisalAccuracy: profile.defaultAppraisalAccuracy,
                    flawTypeDetection: Object.fromEntries(profile.flawTypeDetection),
                    defaultFlawTypeDetection: profile.defaultFlawTypeDetection,
                    customerTypes: profile.customerTypes ?? [],
                  },
                }
              : {}),
          };
        }),
        actorRoutines: routineEntries,
        items: listItemKinds(db).map((it) => ({
          id: it.id,
          code: it.code,
          displayName: it.displayName,
          category: it.category,
          baseValue: it.baseValue,
          flawType: it.flawType,
          risk: it.risk,
          isEasterEgg: it.isEasterEgg,
          flavourText: it.flavourText,
        })),
        locations: listLocations(db).map((l) => ({
          id: l.id,
          code: l.code,
          displayName: l.displayName,
          type: l.type,
          openHours: l.openHours,
        })),
        snapshots,
        playerActorId: skin.playerActorId,
        auctionHouseActorId: skin.auctionHouseActorId,
        auctionLocationId: skin.auctionLocationId,
        auctionStartHour: skin.auctionStartHour,
        auctionEndHour: skin.auctionEndHour,
        newspaperLocationId: skin.newspaperLocationId,
        economics: {
          tierMultipliers: skin.economics.tierMultipliers,
          estimateSpreadAtZeroAccuracy:
            skin.economics.estimateSpreadAtZeroAccuracy,
          estimateSpreadAtFullAccuracy:
            skin.economics.estimateSpreadAtFullAccuracy,
          pubBuyerCeilingFraction: skin.economics.pubBuyerCeilingFraction,
        },
      });
      console.log(`\nrun dumped to ${opts.out}`);
    }
  } finally {
    db.close();
  }
}

interface RunDump {
  readonly seed: string;
  readonly runLengthDays: number;
  readonly tally: RunTally;
  readonly events: readonly WorldEvent[];
  readonly actors: readonly {
    id: number;
    code: string;
    displayName: string;
    cash: number;
    currentLocationId: number | null;
    homeLocationId: number | null;
    transportCapacity: string;
    roles: readonly string[];
    /** Bidder profile snapshot — used by the webapp to compute per-trader
     *  retail estimates client-side. Optional for actors without one. */
    bidderProfile?: {
      appraisalAccuracy: Record<string, number>;
      defaultAppraisalAccuracy: number;
      flawTypeDetection: Record<string, number>;
      defaultFlawTypeDetection: number;
      customerTypes: readonly string[];
    };
  }[];
  readonly actorRoutines: readonly {
    actorId: number;
    homeLocationId: number | null;
    schedule: readonly { hour: number; locationId: number }[];
    awakeHours: { start: number; end: number };
  }[];
  readonly items: readonly {
    id: number;
    code: string;
    displayName: string;
    category: string;
    baseValue: number;
    flawType: string | null;
    risk: number;
    isEasterEgg: boolean;
    flavourText: string | null;
  }[];
  readonly locations: readonly {
    id: number;
    code: string;
    displayName: string;
    type: string;
    openHours: { start: number; end: number } | null;
  }[];
  readonly snapshots: readonly DaySnapshot[];
  readonly playerActorId: number;
  readonly auctionHouseActorId: number;
  readonly auctionLocationId: number;
  readonly auctionStartHour: number;
  readonly auctionEndHour: number;
  readonly newspaperLocationId: number;
  /** Subset of the economics config that the webapp needs to reproduce
   *  retail estimates client-side. */
  readonly economics: {
    tierMultipliers: Record<string, number>;
    estimateSpreadAtZeroAccuracy: number;
    estimateSpreadAtFullAccuracy: number;
    pubBuyerCeilingFraction: number;
  };
}

interface DaySnapshot {
  readonly day: number;
  readonly actors: readonly {
    id: number;
    cash: number;
    currentLocationId: number | null;
    heat: number;
    /** Lot ids the actor knows about, learned via paper / gallery /
     *  attended / gossip. Snapshot of cumulative knowledge as of the
     *  end of `day`. */
    knownAuctionLotIds: readonly number[];
    /** Lot ids the actor has personally inspected, revealing quality. */
    inspectedAuctionLotIds: readonly number[];
  }[];
  readonly stockLots: readonly {
    id: number;
    ownerActorId: number;
    itemKindId: number;
    qualityTier: string;
    quantity: number;
    acquiredUnitPrice: number;
    acquiredDay: number;
    locationId: number | null;
  }[];
  readonly deals: readonly {
    id: number;
    buyerActorId: number;
    sellerActorId: number;
    state: string;
    agreedDay: number;
    deadlineDay: number;
    deliveryLocationId: number | null;
    settledDay: number | null;
    defaultedDay: number | null;
    defaultReason: string | null;
    totalPrice: number;
    lines: readonly {
      itemKindId: number;
      qualityTier: string;
      quantity: number;
      unitPrice: number;
    }[];
  }[];
  readonly pools: readonly {
    id: number;
    itemKindId: number;
    qualityTier: string;
    quantityRemaining: number;
    createdDay: number;
    expiryDay: number;
    openingUnitPrice: number;
    closingUnitPrice: number;
    dumpDestination: string;
    flushedDay: number | null;
    reachableBy: readonly number[];
  }[];
  // floorPrice and clearedPrice are TOTALS (already multiplied by qty)
  // per migration 007.
  readonly auctionLots: readonly {
    id: number;
    sourcePoolId: number | null;
    itemKindId: number;
    qualityTier: string;
    quantity: number;
    floorPrice: number;
    listedDay: number;
    scheduledHour: number | null;
    clearedDay: number | null;
    clearedPrice: number | null;
    clearedToActorId: number | null;
  }[];
}

function captureSnapshot(
  db: ReturnType<typeof openBetterSqlite3DB>,
  day: number,
): DaySnapshot {
  const actorRows = db
    .prepare(
      `SELECT a.id AS id, a.cash AS cash, a.current_location_id AS current_location_id, h.score AS score
       FROM actors a
       LEFT JOIN actor_heat h ON h.actor_id = a.id`,
    )
    .all() as ReadonlyArray<{
      id: number;
      cash: number;
      current_location_id: number | null;
      score: number | null;
    }>;
  const knownLotRows = db
    .prepare(`SELECT actor_id, lot_id FROM actor_known_lots`)
    .all() as ReadonlyArray<{ actor_id: number; lot_id: number }>;
  const knownByActor = new Map<number, number[]>();
  for (const r of knownLotRows) {
    const list = knownByActor.get(r.actor_id) ?? [];
    list.push(r.lot_id);
    knownByActor.set(r.actor_id, list);
  }
  const inspectedLotRows = db
    .prepare(`SELECT actor_id, lot_id FROM actor_inspected_lots`)
    .all() as ReadonlyArray<{ actor_id: number; lot_id: number }>;
  const inspectedByActor = new Map<number, number[]>();
  for (const r of inspectedLotRows) {
    const list = inspectedByActor.get(r.actor_id) ?? [];
    list.push(r.lot_id);
    inspectedByActor.set(r.actor_id, list);
  }
  const actors = actorRows.map((r) => ({
    id: r.id,
    cash: r.cash,
    currentLocationId: r.current_location_id,
    heat: r.score ?? 0,
    knownAuctionLotIds: knownByActor.get(r.id) ?? [],
    inspectedAuctionLotIds: inspectedByActor.get(r.id) ?? [],
  }));

  const lotRows = db
    .prepare(
      `SELECT id, owner_actor_id, item_kind_id, quality_tier, quantity,
              acquired_unit_price, acquired_day, location_id
       FROM stock_lots WHERE quantity > 0`,
    )
    .all() as ReadonlyArray<{
      id: number;
      owner_actor_id: number;
      item_kind_id: number;
      quality_tier: string;
      quantity: number;
      acquired_unit_price: number;
      acquired_day: number;
      location_id: number | null;
    }>;
  const stockLots = lotRows.map((r) => ({
    id: r.id,
    ownerActorId: r.owner_actor_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
    acquiredUnitPrice: r.acquired_unit_price,
    acquiredDay: r.acquired_day,
    locationId: r.location_id,
  }));

  const dealRows = db
    .prepare(
      `SELECT id, buyer_actor_id, seller_actor_id, state, agreed_day,
              deadline_day, delivery_location_id, settled_day,
              defaulted_day, default_reason
       FROM deals`,
    )
    .all() as ReadonlyArray<{
      id: number;
      buyer_actor_id: number;
      seller_actor_id: number;
      state: string;
      agreed_day: number;
      deadline_day: number;
      delivery_location_id: number | null;
      settled_day: number | null;
      defaulted_day: number | null;
      default_reason: string | null;
    }>;
  const lineRows = db
    .prepare(
      `SELECT deal_id, item_kind_id, quality_tier, quantity, unit_price
       FROM deal_lines ORDER BY id ASC`,
    )
    .all() as ReadonlyArray<{
      deal_id: number;
      item_kind_id: number;
      quality_tier: string;
      quantity: number;
      unit_price: number;
    }>;
  const linesByDeal = new Map<
    number,
    { itemKindId: number; qualityTier: string; quantity: number; unitPrice: number }[]
  >();
  for (const ln of lineRows) {
    const list = linesByDeal.get(ln.deal_id) ?? [];
    list.push({
      itemKindId: ln.item_kind_id,
      qualityTier: ln.quality_tier,
      quantity: ln.quantity,
      unitPrice: ln.unit_price,
    });
    linesByDeal.set(ln.deal_id, list);
  }
  const deals = dealRows.map((d) => {
    const lines = linesByDeal.get(d.id) ?? [];
    const totalPrice = lines.reduce(
      (sum, l) => sum + l.quantity * l.unitPrice,
      0,
    );
    return {
      id: d.id,
      buyerActorId: d.buyer_actor_id,
      sellerActorId: d.seller_actor_id,
      state: d.state,
      agreedDay: d.agreed_day,
      deadlineDay: d.deadline_day,
      deliveryLocationId: d.delivery_location_id,
      settledDay: d.settled_day,
      defaultedDay: d.defaulted_day,
      defaultReason: d.default_reason,
      totalPrice,
      lines,
    };
  });

  const poolRows = db
    .prepare(
      `SELECT id, item_kind_id, quality_tier, quantity_remaining, created_day,
              expiry_day, opening_unit_price, closing_unit_price,
              dump_destination, flushed_day
       FROM world_pools`,
    )
    .all() as ReadonlyArray<{
      id: number;
      item_kind_id: number;
      quality_tier: string;
      quantity_remaining: number;
      created_day: number;
      expiry_day: number;
      opening_unit_price: number;
      closing_unit_price: number;
      dump_destination: string;
      flushed_day: number | null;
    }>;
  const reachRows = db
    .prepare(`SELECT pool_id, actor_id FROM pool_reachability`)
    .all() as ReadonlyArray<{ pool_id: number; actor_id: number }>;
  const reachByPool = new Map<number, number[]>();
  for (const r of reachRows) {
    const list = reachByPool.get(r.pool_id) ?? [];
    list.push(r.actor_id);
    reachByPool.set(r.pool_id, list);
  }
  const pools = poolRows.map((p) => ({
    id: p.id,
    itemKindId: p.item_kind_id,
    qualityTier: p.quality_tier,
    quantityRemaining: p.quantity_remaining,
    createdDay: p.created_day,
    expiryDay: p.expiry_day,
    openingUnitPrice: p.opening_unit_price,
    closingUnitPrice: p.closing_unit_price,
    dumpDestination: p.dump_destination,
    flushedDay: p.flushed_day,
    reachableBy: reachByPool.get(p.id) ?? [],
  }));

  const lotAuctionRows = db
    .prepare(
      `SELECT id, source_pool_id, item_kind_id, quality_tier, quantity,
              floor_price, listed_day, scheduled_hour, cleared_day,
              cleared_price, cleared_to_actor_id
       FROM auction_lots`,
    )
    .all() as ReadonlyArray<{
      id: number;
      source_pool_id: number | null;
      item_kind_id: number;
      quality_tier: string;
      quantity: number;
      floor_price: number;
      listed_day: number;
      scheduled_hour: number | null;
      cleared_day: number | null;
      cleared_price: number | null;
      cleared_to_actor_id: number | null;
    }>;
  const auctionLots = lotAuctionRows.map((r) => ({
    id: r.id,
    sourcePoolId: r.source_pool_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
    floorPrice: r.floor_price,
    listedDay: r.listed_day,
    scheduledHour: r.scheduled_hour,
    clearedDay: r.cleared_day,
    clearedPrice: r.cleared_price,
    clearedToActorId: r.cleared_to_actor_id,
  }));

  return { day, actors, stockLots, deals, pools, auctionLots };
}

function writeRunDump(path: string, dump: RunDump): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(dump, null, 2));
}

interface RunTally {
  poolFlushed: number;
  poolClaimed: number;
  auctionCleared: number;
  auctionUnsold: number;
  dealsSettled: number;
  dealsDefaulted: number;
  pubdealsAttempted: number;
  pubdealsAgreed: number;
  pubdealsWalked: number;
}

function newTally(): RunTally {
  return {
    poolFlushed: 0,
    poolClaimed: 0,
    auctionCleared: 0,
    auctionUnsold: 0,
    dealsSettled: 0,
    dealsDefaulted: 0,
    pubdealsAttempted: 0,
    pubdealsAgreed: 0,
    pubdealsWalked: 0,
  };
}

function updateTally(t: RunTally, e: WorldEvent): void {
  switch (e.type) {
    case "pool.flushed": t.poolFlushed += 1; break;
    case "pool.claimed": t.poolClaimed += 1; break;
    case "auction.cleared": t.auctionCleared += 1; break;
    case "auction.unsold": t.auctionUnsold += 1; break;
    case "deal.settled": t.dealsSettled += 1; break;
    case "deal.defaulted": t.dealsDefaulted += 1; break;
    case "pubdeal.attempted": t.pubdealsAttempted += 1; break;
    case "pubdeal.agreed": t.pubdealsAgreed += 1; break;
    case "pubdeal.walked": t.pubdealsWalked += 1; break;
    default: break;
  }
}

function printReport(
  db: ReturnType<typeof openBetterSqlite3DB>,
  skin: ReturnType<typeof seedPlaceholderSkin>,
  tally: RunTally,
): void {
  console.log("");
  console.log("=== run report ===");
  const player = getActorById(db, skin.playerActorId);
  console.log(`player cash:            £${player?.cash ?? "?"}`);
  const house = getActorByCode(db, "auction-house");
  console.log(`auction house revenue:  £${house?.cash ?? "?"}`);
  console.log(`pool flushes:           ${tally.poolFlushed}`);
  console.log(`pool claims:            ${tally.poolClaimed}`);
  console.log(`auctions cleared:       ${tally.auctionCleared}`);
  console.log(`auctions unsold:        ${tally.auctionUnsold}`);
  console.log(`deals settled:          ${tally.dealsSettled}`);
  console.log(`deals defaulted:        ${tally.dealsDefaulted}`);
  console.log(`pubdeals attempted:     ${tally.pubdealsAttempted}`);
  console.log(`pubdeals agreed:        ${tally.pubdealsAgreed}`);
  console.log(`pubdeals walked:        ${tally.pubdealsWalked}`);

  const orphanAgreed = getDealsByState(db, "agreed");
  if (orphanAgreed.length > 0) {
    console.log(`orphan agreed deals:    ${orphanAgreed.length} (deadline > runLength)`);
  }
}

main();

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
import { registerDailySettlement } from "../engine/world/daily-settlement.js";
import { registerPoolExpiry } from "../engine/world/pool-expiry.js";
import { registerDailyAuction } from "../engine/world/daily-auction.js";
import { registerLeadDecay } from "../engine/world/lead-decay.js";
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
    const skin = seedPlaceholderSkin(
      db,
      rng,
      opts.days !== null ? { runLengthDays: opts.days } : {},
    );

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
    // render any historical day directly.
    const eventLog: WorldEvent[] = [];
    const snapshots: DaySnapshot[] = [];
    if (opts.out !== null) {
      world.events.subscribe((e) => {
        eventLog.push(e);
        if (e.type === "day.ended") {
          snapshots.push(captureSnapshot(db, e.day));
        }
      });
    }

    // Wire up the engine subsystems.
    registerPoolExpiry(world);
    registerDailySettlement(world, {
      procurementProceedsActorId: skin.auctionHouseActorId,
    });
    registerLocationGossip(world);

    // Policy tick fires BEFORE daily-auction at the same hour, so NPCs
    // travel into the auction room before the auctioneer opens. Hour
    // handlers run in registration order.
    const registry = new PolicyRegistry();
    for (const [actorId, policy] of skin.policies) {
      registry.register(actorId, policy);
    }
    registerPolicyHourTick(world, registry);

    registerDailyAuction(world, {
      proceedsActorId: skin.auctionHouseActorId,
      auctionHour: skin.auctionHour,
      findBiddersForLot: makeDefaultBidders({
        profiles: skin.bidderProfiles,
        requireActorAtLocationId: skin.auctionLocationId,
      }),
    });
    registerLeadDecay(world);
    registerTrustReactions(world);
    registerHeatReactions(world);
    registerHeatDecay(world);
    registerAuthoritySweep(world, {
      fineProceedsActorId: skin.auctionHouseActorId,
    });

    registerPoolSpawner(world, {
      reachableByCategory: skin.reachableByCategory,
      defaultReachableActorIds: skin.defaultReachableActorIds,
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
        actors: listActors(db).map((a) => ({
          id: a.id,
          code: a.code,
          displayName: a.displayName,
          cash: a.cash,
          currentLocationId: a.currentLocationId,
          homeLocationId: a.homeLocationId,
          transportCapacity: a.transportCapacity,
        })),
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
        auctionHour: skin.auctionHour,
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
  readonly auctionHour: number;
}

interface DaySnapshot {
  readonly day: number;
  readonly actors: readonly {
    id: number;
    cash: number;
    currentLocationId: number | null;
    heat: number;
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
  const actors = actorRows.map((r) => ({
    id: r.id,
    cash: r.cash,
    currentLocationId: r.current_location_id,
    heat: r.score ?? 0,
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
              floor_price, listed_day, cleared_day, cleared_price,
              cleared_to_actor_id
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

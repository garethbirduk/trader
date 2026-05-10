/**
 * Snapshot + run-dump builder. Used by both the headless Node sim and
 * the in-browser live mode to produce a `RunDump` — the JSON shape
 * the webapp consumes (whether loaded from `events.json` or built live
 * after running the engine in the tab).
 *
 * `captureSnapshot(db, day)` reads the current world state into a
 * `DaySnapshot`. Callers typically subscribe to `day.ended` and push
 * one snapshot per day, plus a "day 0" snapshot taken right after
 * seeding so the webapp can show pre-day-1 actor positions.
 *
 * `buildRunDump(...)` assembles the full bundle: seed, tally, events,
 * snapshots, plus end-of-run derived data (actors, items, locations,
 * routines, economics).
 */

import type { DB } from "./core/db.js";
import type { WorldEvent } from "./core/events.js";
import { listActors } from "./actors/actors-repo.js";
import { listItemKinds } from "./stock/items-repo.js";
import { listLocations } from "./locations/locations.js";
import type { SkinSeedResult } from "../skins/placeholder/index.js";

export interface DealLineDump {
  readonly itemKindId: number;
  readonly qualityTier: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface DaySnapshot {
  readonly day: number;
  readonly actors: readonly {
    id: number;
    cash: number;
    currentLocationId: number | null;
    heat: number;
    knownAuctionLotIds: readonly number[];
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
    lines: readonly DealLineDump[];
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

export interface RunTally {
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

export function newTally(): RunTally {
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

export function updateTally(t: RunTally, e: WorldEvent): void {
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

export interface RunDump {
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
    weekendSchedule?: readonly { hour: number; locationId: number }[];
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
  readonly economics: {
    tierMultipliers: Record<string, number>;
    estimateSpreadAtZeroAccuracy: number;
    estimateSpreadAtFullAccuracy: number;
    pubBuyerCeilingFraction: number;
  };
}

export function captureSnapshot(db: DB, day: number): DaySnapshot {
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
  const linesByDeal = new Map<number, DealLineDump[]>();
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

export interface BuildRunDumpInput {
  readonly db: DB;
  readonly skin: SkinSeedResult;
  readonly seed: string;
  readonly tally: RunTally;
  readonly events: readonly WorldEvent[];
  readonly snapshots: readonly DaySnapshot[];
}

export function buildRunDump(input: BuildRunDumpInput): RunDump {
  const { db, skin, seed, tally, events, snapshots } = input;
  const routineEntries = [...skin.actorRoutines.entries()].map(
    ([actorId, info]) => ({
      actorId,
      homeLocationId: info.homeLocationId,
      schedule: [...info.schedule.entries()].map(([hour, locationId]) => ({
        hour,
        locationId,
      })),
      ...(info.weekendSchedule !== undefined
        ? {
            weekendSchedule: [...info.weekendSchedule.entries()].map(
              ([hour, locationId]) => ({ hour, locationId }),
            ),
          }
        : {}),
      awakeHours: { start: info.awakeHours.start, end: info.awakeHours.end },
    }),
  );

  return {
    seed,
    runLengthDays: skin.runLengthDays,
    tally,
    events,
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
      estimateSpreadAtZeroAccuracy: skin.economics.estimateSpreadAtZeroAccuracy,
      estimateSpreadAtFullAccuracy: skin.economics.estimateSpreadAtFullAccuracy,
      pubBuyerCeilingFraction: skin.economics.pubBuyerCeilingFraction,
    },
  };
}

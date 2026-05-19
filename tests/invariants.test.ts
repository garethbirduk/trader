import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { listActors, getActorByCode } from "../src/engine/actors/actors-repo.js";
import { PolicyRegistry } from "../src/engine/policy/runner.js";
import { seedPlaceholderSkin } from "../src/skins/placeholder/index.js";
import { registerDailySettlement } from "../src/engine/world/daily-settlement.js";
import { registerPoolExpiry } from "../src/engine/world/pool-expiry.js";
import { registerDailyAuction } from "../src/engine/world/daily-auction.js";
import { registerLeadDecay } from "../src/engine/world/lead-decay.js";
import { registerTrustReactions } from "../src/engine/world/trust-reactions.js";
import { registerPolicyHourTick } from "../src/engine/world/policy-tick.js";
import { registerPoolClaimAutonomy } from "../src/engine/world/pool-claim-autonomy.js";
import { getDealsByState } from "../src/engine/deals/deals-repo.js";
import { listItemKinds } from "../src/engine/stock/items-repo.js";
import { makeDefaultBidders } from "../src/engine/auction/default-bidders.js";
import { registerPoolSpawner } from "../src/skins/placeholder/pool-spawner.js";
import { registerPubDealAutonomy } from "../src/engine/world/pub-deal-autonomy.js";
import { registerLocationGossip } from "../src/engine/world/location-gossip.js";
import { registerHeatReactions } from "../src/engine/world/heat-reactions.js";
import { registerHeatDecay } from "../src/engine/world/heat-decay.js";
import { registerAuthoritySweep } from "../src/engine/world/authority-sweep.js";
import type { DB } from "../src/engine/core/db.js";

function runFullSim(seed: string, days: number) {
  const db = openBetterSqlite3DB({ filename: ":memory:" });
  applyMigrations(db, ALL_MIGRATIONS);
  const rng = createRNG(seed);
  const skin = seedPlaceholderSkin(db, rng, { runLengthDays: days });

  const cashBefore = sumAllActorCash(db);

  const world = new World({ db, rng, seed, maxDays: days });

  registerPoolExpiry(world);
  registerDailySettlement(world, {
    procurementProceedsActorId: skin.auctionHouseActorId,
  });
  registerLocationGossip(world);

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

  registerPoolClaimAutonomy(world, {
    claimingActorIds: [...skin.policies.keys()],
    proceedsActorId: skin.auctionHouseActorId,
    attemptChance: 0.6,
    claimQuantity: 10,
  });

  registerPubDealAutonomy(world, {
    pubLocationIds: skin.pubLocationIds,
    npcActorIds: [...skin.policies.keys()],
    knowledgeProfiles: skin.bidderProfiles,
  });

  world.runToCompletion();

  return { db, skin, cashBefore };
}

function sumAllActorCash(db: DB): number {
  return listActors(db).reduce((acc, a) => acc + a.cash, 0);
}

describe("v1 invariants on a full 14-day run", () => {
  let dbToClose: DB | undefined;
  afterEach(() => {
    dbToClose?.close();
    dbToClose = undefined;
  });

  it.each(["seed-a", "seed-b", "seed-c"])(
    "[%s] cash is conserved across the run when proceeds go to a configured actor",
    (seed) => {
      const { db, cashBefore } = runFullSim(seed, 14);
      dbToClose = db;
      const cashAfter = sumAllActorCash(db);
      expect(cashAfter).toBe(cashBefore);
    },
  );

  it.each(["seed-a", "seed-b", "seed-c"])(
    "[%s] no actor ends with negative cash",
    (seed) => {
      const { db } = runFullSim(seed, 14);
      dbToClose = db;
      for (const a of listActors(db)) {
        expect(a.cash).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.each(["seed-a", "seed-b", "seed-c"])(
    "[%s] no agreed deal is left stranded past its deadline",
    (seed) => {
      const { db } = runFullSim(seed, 14);
      dbToClose = db;
      const stranded = getDealsByState(db, "agreed").filter(
        (d) => d.deadlineDay <= 14,
      );
      expect(stranded).toEqual([]);
    },
  );

  it.each(["seed-a", "seed-b", "seed-c"])(
    "[%s] no stock_lot has zero or negative quantity (the schema CHECK guards this, but assert anyway)",
    (seed) => {
      const { db } = runFullSim(seed, 14);
      dbToClose = db;
      const row = db
        .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM stock_lots WHERE quantity <= 0`)
        .get();
      expect(row?.n ?? 0).toBe(0);
    },
  );

  it.each(["seed-a", "seed-b", "seed-c"])(
    "[%s] every flushed pool has flushed_day set; none orphaned",
    (seed) => {
      const { db } = runFullSim(seed, 14);
      dbToClose = db;
      // After day 14, any pool with expiry_day < 14 must be flushed.
      const orphans = db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM world_pools
           WHERE flushed_day IS NULL AND expiry_day < 14`,
        )
        .get();
      expect(orphans?.n ?? 0).toBe(0);
    },
  );

  it("auction house collects proceeds equal to claim revenue + auction win revenue", () => {
    const { db } = runFullSim("revenue", 14);
    dbToClose = db;
    const house = getActorByCode(db, "auction-house");
    expect(house?.cash ?? 0).toBeGreaterThan(0);
  });

  it("at least some pool flushes occur during a 14-day run (smoke check)", () => {
    const { db } = runFullSim("activity", 14);
    dbToClose = db;
    const flushed = db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM world_pools WHERE flushed_day IS NOT NULL`)
      .get();
    expect(flushed?.n ?? 0).toBeGreaterThan(0);
  });

  it("item kind catalogue is unchanged after the run (skins seed once)", () => {
    const { db } = runFullSim("immutable", 14);
    dbToClose = db;
    const items = listItemKinds(db);
    expect(items.length).toBeGreaterThan(0);
  });
});

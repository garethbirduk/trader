import { describe, it, expect } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { PolicyRegistry } from "../src/engine/policy/runner.js";
import { seedPlaceholderSkin } from "../src/skins/placeholder/index.js";
import { registerDailySettlement } from "../src/engine/world/daily-settlement.js";
import { registerPoolExpiry } from "../src/engine/world/pool-expiry.js";
import { registerDailyAuction } from "../src/engine/world/daily-auction.js";
import { registerPolicyHourTick } from "../src/engine/world/policy-tick.js";
import { makeDefaultBidders } from "../src/engine/auction/default-bidders.js";
import { registerPoolSpawner } from "../src/skins/placeholder/pool-spawner.js";
import {
  listJudgementsByDay,
  type CompositePayload,
} from "../src/engine/perception/judgement-log-repo.js";
import { getActorById } from "../src/engine/actors/actors-repo.js";

describe("judgement audit — auction bidder", () => {
  it("writes a composite judgement_log row per qualifying bidder, joinable via context_ref to the lot", () => {
    const db = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db, ALL_MIGRATIONS);
    const rng = createRNG("audit-test-seed");
    const skin = seedPlaceholderSkin(db, rng, { runLengthDays: 5 });
    const world = new World({ db, rng, seed: "audit-test-seed", maxDays: 5 });
    registerPoolExpiry(world);
    registerDailySettlement(world, {
      procurementProceedsActorId: skin.auctionHouseActorId,
    });
    const registry = new PolicyRegistry();
    for (const [actorId, policy] of skin.policies) {
      registry.register(actorId, policy);
    }
    registerPolicyHourTick(world, registry);
    registerDailyAuction(world, {
      proceedsActorId: skin.auctionHouseActorId,
      auctionHour: skin.auctionHour,
      // Don't gate on location — without the actor planner running,
      // nobody walks to the auction floor. Bidders still need cash;
      // the placeholder skin seeds enough.
      findBiddersForLot: makeDefaultBidders({
        profiles: skin.bidderProfiles,
      }),
    });
    registerPoolSpawner(world, {
      reachableByCategory: skin.reachableByCategory,
      defaultReachableActorIds: skin.defaultReachableActorIds,
    });
    world.runToCompletion();

    // Collect all auction-bid judgements across the run.
    const allAuctionBids: Array<{ day: number; rec: ReturnType<typeof listJudgementsByDay>[number] }> = [];
    for (let day = 1; day <= 5; day += 1) {
      for (const rec of listJudgementsByDay(db, day)) {
        if (rec.contextKind === "auction-bid") {
          allAuctionBids.push({ day, rec });
        }
      }
    }

    expect(allAuctionBids.length).toBeGreaterThan(0);

    // Every row is a composite, references a valid actor and a lot id,
    // and carries a payload with the expected per-arm shape.
    for (const { rec } of allAuctionBids) {
      expect(rec.arm).toBe("composite");
      expect(rec.contextRefId).not.toBeNull();
      expect(getActorById(db, rec.actorId)).not.toBeNull();
      const payload = rec.payload as CompositePayload;
      expect(payload.itemKindId).toBeGreaterThan(0);
      expect(payload.category.length).toBeGreaterThan(0);
      expect(payload.quantity).toBeGreaterThan(0);
      expect(["broken", "shoddy", "fair", "good", "mint"]).toContain(payload.truthTier);
      expect(["broken", "shoddy", "fair", "good", "mint"]).toContain(payload.perceivedTier);
      expect(payload.price.expertise).toBeGreaterThanOrEqual(0);
      expect(payload.price.expertise).toBeLessThanOrEqual(1);
      expect(payload.price.j).toBeGreaterThanOrEqual(0);
      expect(payload.price.j).toBeLessThanOrEqual(1);
      expect(payload.price.centre).toBeGreaterThanOrEqual(0);
      expect(payload.price.low).toBeLessThanOrEqual(payload.price.centre);
      expect(payload.price.high).toBeGreaterThanOrEqual(payload.price.centre);
      expect(payload.perceivedLotValue).toBeGreaterThanOrEqual(0);
    }

    db.close();
  });
});

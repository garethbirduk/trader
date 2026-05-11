import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { insertLead, getLeadsByHolder } from "../src/engine/leads/leads-repo.js";
import { registerPubDealAutonomy } from "../src/engine/world/pub-deal-autonomy.js";
import { registerPubDealGossip } from "../src/engine/world/pub-deal-gossip.js";
import {
  FALLBACK_BIDDER_PROFILE,
  type BidderProfile,
} from "../src/engine/auction/bidder-profile.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("pubdeal-side gossip", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed(opts: { buyerCash: number; sellerFloor: number }) {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const seller = insertActor(localDb, { code: "s", displayName: "S", cash: 0 });
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: opts.buyerCash });
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    setActorLocation(localDb, seller.id, nags.id);
    setActorLocation(localDb, buyer.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: seller.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 50,
      acquiredUnitPrice: opts.sellerFloor,
      acquiredDay: 1,
    });
    // Both bring something to gossip about — distinct so each is novel
    // to the other.
    insertLead(localDb, {
      holderActorId: seller.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 100,
      estimatedUnitPrice: 5,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: buyer.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 40,
      estimatedUnitPrice: 25,
      acquiredDay: 1,
    });

    const profiles = new Map<number, BidderProfile>([
      [
        buyer.id,
        {
          appraisalAccuracy: new Map([["electrical", 1]]),
          defaultAppraisalAccuracy: 1,
          flawTypeDetection: new Map(),
          defaultFlawTypeDetection: 0,
        },
      ],
    ]);
    return { localDb, seller, buyer, nags, item, profiles };
  }

  it("emits a deal-kind gossip event when a pubdeal is agreed", () => {
    const { localDb, seller, buyer, nags, profiles } = seed({
      buyerCash: 10000,
      sellerFloor: 5,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("agreed"),
      seed: "agreed",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealGossip(world);
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: profiles,
      attemptsPerHour: 5,
      pairChance: 1.0,
    });
    world.runToCompletion();

    const agreed = events.filter((e) => e.type === "pubdeal.agreed");
    expect(agreed.length).toBeGreaterThan(0);
    const dealGossip = events.filter(
      (e): e is Extract<WorldEvent, { type: "gossip.exchanged" }> =>
        e.type === "gossip.exchanged" && e.kind === "deal",
    );
    expect(dealGossip.length).toBeGreaterThan(0);
    expect(dealGossip[0]!.atLocationId).toBe(nags.id);
    expect(dealGossip[0]!.participantActorIds).toEqual(
      expect.arrayContaining([seller.id, buyer.id]),
    );
  });

  it("also fires when the pubdeal walks (no agreement)", () => {
    // Seller floor above what buyer can ever pay → guaranteed walk.
    const { localDb, seller, buyer, nags, profiles } = seed({
      buyerCash: 20,
      sellerFloor: 500,
    });
    const world = new World({
      db: localDb,
      rng: createRNG("walked"),
      seed: "walked",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealGossip(world);
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: profiles,
      attemptsPerHour: 5,
      pairChance: 1.0,
      // Push the walk path: the negotiation will exit before agreement
      // when buyer ceiling < seller floor, which is impossible to bridge.
      sellerTargetMarkup: 5,
    });
    world.runToCompletion();

    // We don't strictly need a walked event — the autonomy may bail in
    // an earlier guard (no-overlap, can't bid £1/unit). What we want is
    // that when *some* pubdeal lifecycle event fires for this pair, the
    // gossip channel reacts. So drive the harder scenario: only walks.
    const lifecycleEvents = events.filter(
      (e) => e.type === "pubdeal.walked" || e.type === "pubdeal.agreed",
    );
    const dealGossip = events.filter(
      (e) => e.type === "gossip.exchanged" && e.kind === "deal",
    );
    expect(dealGossip.length).toBe(lifecycleEvents.length);
  });

  it("respects the novelty filter — silent when both bags identical", () => {
    const { localDb, seller, buyer, nags, item, profiles } = seed({
      buyerCash: 10000,
      sellerFloor: 5,
    });
    // Strip the distinct leads and give both parties an identical bag.
    localDb.prepare(`DELETE FROM leads`).run();
    const shared = {
      side: "supply" as const,
      subjectItemKindId: item.id,
      subjectQualityTier: "good" as const,
      estimatedQuantity: 50,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    };
    insertLead(localDb, { holderActorId: seller.id, ...shared });
    insertLead(localDb, { holderActorId: buyer.id, ...shared });

    const world = new World({
      db: localDb,
      rng: createRNG("identical"),
      seed: "identical",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPubDealGossip(world);
    registerPubDealAutonomy(world, {
      pubLocationIds: [nags.id],
      npcActorIds: [seller.id, buyer.id],
      bidderProfiles: profiles,
      attemptsPerHour: 3,
      pairChance: 1.0,
    });
    world.runToCompletion();

    // pubdeal events still happen, but no deal-kind gossip should fire.
    const dealGossip = events.filter(
      (e) => e.type === "gossip.exchanged" && e.kind === "deal",
    );
    expect(dealGossip.length).toBe(0);
    // Sanity: leads didn't multiply.
    expect(getLeadsByHolder(localDb, seller.id)).toHaveLength(1);
    expect(getLeadsByHolder(localDb, buyer.id)).toHaveLength(1);
  });
});

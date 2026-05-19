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
import {
  getLeadsByHolder,
  getRepLeadAbout,
  getRepLeadsBy,
  insertLead,
} from "../src/engine/leads/leads-repo.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import { registerReputationReactions } from "../src/engine/world/reputation-reactions.js";
import { registerPubDealAutonomy } from "../src/engine/world/pub-deal-autonomy.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import { DEFAULT_ECONOMICS_CONFIG } from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("reputation leads (Stage 5)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const buyer = insertActor(localDb, { code: "buy", firstName: "Buyer", shortName: "Buyer", cash: 1000 });
    const seller = insertActor(localDb, { code: "sel", firstName: "Seller", shortName: "Seller", cash: 0 });
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    return { localDb, buyer, seller, item };
  }

  describe("spawn on default", () => {
    it("creates a rep lead in the buyer's bag pointing at the seller", () => {
      const { localDb, buyer, seller, item } = seed();
      const deal = createAgreedDeal(localDb, {
        buyerActorId: buyer.id,
        sellerActorId: seller.id,
        agreedDay: 1,
        deadlineDay: 2,
        lines: [
          { itemKindId: item.id, qualityTier: "good", quantity: 10, unitPrice: 8 },
        ],
      });
      const world = new World({
        db: localDb,
        rng: createRNG("rep-spawn"),
        seed: "rep-spawn",
        maxDays: 1,
        startDay: 2,
        startHour: 10,
      });
      const events: WorldEvent[] = [];
      world.events.subscribe((e) => events.push(e));
      registerReputationReactions(world, { economics: DEFAULT_ECONOMICS_CONFIG });

      world.events.emit({
        type: "deal.defaulted",
        at: world.clock,
        dealId: deal.id,
        buyerActorId: buyer.id,
        sellerActorId: seller.id,
        reason: "stock disappeared",
      });

      // Rep lead landed in the buyer's bag, targeting the seller.
      const rep = getRepLeadAbout(localDb, buyer.id, seller.id);
      expect(rep).not.toBeNull();
      expect(rep!.kind).toBe("rep");
      expect(rep!.subjectTargetActorId).toBe(seller.id);
      expect(rep!.counterpartyActorId).toBe(buyer.id);
      // Damage on lead = the burned actor's perceived value of what they
      // were owed, summed across lines (docs/judgement.md). With the
      // default economics + fallback knowledge profile + no seeded
      // anchors (DEFAULT_ANCHOR_FALLBACK = 30):
      //   truth/unit  = item.baseValue × tierMult[good] = 30 × 1.1 = 33
      //   expertise   = defaultPriceAccuracy (fallback) = 0.6
      //   anchor      = DEFAULT_ANCHOR_FALLBACK = 30
      //   centre      = anchor + (truth - anchor) × expertise = 31.8
      //   damage      = qty × centre = 10 × 31.8 = 318
      expect(rep!.estimatedUnitPrice).toBe(318);
      expect(rep!.confidence).toBe("warm");
      expect(rep!.hopCount).toBe(0);

      // Companion event fires for the viewer.
      const spawn = events.find((e) => e.type === "rep.spawned");
      expect(spawn).toBeDefined();
    });

    it("doesn't spawn a duplicate when one already exists", () => {
      const { localDb, buyer, seller, item } = seed();
      const deal = createAgreedDeal(localDb, {
        buyerActorId: buyer.id,
        sellerActorId: seller.id,
        agreedDay: 1,
        deadlineDay: 2,
        lines: [
          { itemKindId: item.id, qualityTier: "good", quantity: 5, unitPrice: 10 },
        ],
      });
      const world = new World({
        db: localDb,
        rng: createRNG("rep-dedupe"),
        seed: "rep-dedupe",
        maxDays: 1,
        startDay: 2,
        startHour: 10,
      });
      registerReputationReactions(world, { economics: DEFAULT_ECONOMICS_CONFIG });

      // Two defaults in a row from the same pair.
      for (let i = 0; i < 2; i += 1) {
        world.events.emit({
          type: "deal.defaulted",
          at: world.clock,
          dealId: deal.id,
          buyerActorId: buyer.id,
          sellerActorId: seller.id,
          reason: "stranded",
        });
      }

      const reps = getRepLeadsBy(localDb, buyer.id);
      expect(reps).toHaveLength(1);
    });
  });

  describe("abort-on-rep in pub-deal autonomy", () => {
    it("buyer walks when they hold a warm rep lead about the seller above threshold", () => {
      const { localDb, buyer, seller, item } = seed();
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, buyer.id, nags.id);
      setActorLocation(localDb, seller.id, nags.id);
      insertStockLot(localDb, {
        ownerActorId: seller.id,
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 50,
        acquiredUnitPrice: 5,
        acquiredDay: 1,
      });

      // Pre-seed a warm rep lead: "Seller burned Buyer for £500."
      insertLead(localDb, {
        holderActorId: buyer.id,
        kind: "rep",
        side: "supply",
        subjectItemKindId: null,
        subjectTargetActorId: seller.id,
        counterpartyActorId: buyer.id,
        estimatedQuantity: 1,
        estimatedUnitPrice: 500,
        acquiredDay: 1,
        confidence: "warm",
      });

      const profiles = new Map<number, KnowledgeProfile>([
        [
          buyer.id,
          {
            priceAccuracy: new Map([["electrical", 1]]),
            defaultPriceAccuracy: 1,
            flawDetection: new Map(),
            defaultFlawDetection: 0,
          },
        ],
      ]);

      const world = new World({
        db: localDb,
        rng: createRNG("rep-abort"),
        seed: "rep-abort",
        maxDays: 1,
        startDay: 2,
        startHour: 18,
      });
      const events: WorldEvent[] = [];
      world.events.subscribe((e) => events.push(e));
      registerPubDealAutonomy(world, {
        pubLocationIds: [nags.id],
        npcActorIds: [seller.id, buyer.id],
        knowledgeProfiles: profiles,
        attemptsPerHour: 5,
        pairChance: 1.0,
        requireSellerFrom: new Set([seller.id]),
        requireBuyerFrom: new Set([buyer.id]),
        repAbortDamageThreshold: 100,
      });
      world.runToCompletion();

      const aborts = events.filter((e) => e.type === "pubdeal.skipped-rep");
      const agreements = events.filter((e) => e.type === "pubdeal.agreed");
      expect(aborts.length).toBeGreaterThan(0);
      expect(agreements).toHaveLength(0);
      expect(aborts[0]!.repLeadId).toBeDefined();
    });

    it("doesn't abort when the rep lead is cold or deep-hopped", () => {
      const { localDb, buyer, seller, item } = seed();
      const otherVictim = insertActor(localDb, {
        code: "victim",
        firstName: "Some Victim", shortName: "Some Victim",
        cash: 0,
      });
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, buyer.id, nags.id);
      setActorLocation(localDb, seller.id, nags.id);
      insertStockLot(localDb, {
        ownerActorId: seller.id,
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 50,
        acquiredUnitPrice: 5,
        acquiredDay: 1,
      });

      // Old hearsay: cold confidence + hop 5. The buyer ignores it.
      insertLead(localDb, {
        holderActorId: buyer.id,
        kind: "rep",
        side: "supply",
        subjectItemKindId: null,
        subjectTargetActorId: seller.id,
        counterpartyActorId: otherVictim.id,
        estimatedQuantity: 1,
        estimatedUnitPrice: 500,
        acquiredDay: 1,
        confidence: "cold",
        hopCount: 5,
      });

      const profiles = new Map<number, KnowledgeProfile>([
        [
          buyer.id,
          {
            priceAccuracy: new Map([["electrical", 1]]),
            defaultPriceAccuracy: 1,
            flawDetection: new Map(),
            defaultFlawDetection: 0,
          },
        ],
      ]);

      const world = new World({
        db: localDb,
        rng: createRNG("rep-stale"),
        seed: "rep-stale",
        maxDays: 1,
        startDay: 2,
        startHour: 18,
      });
      const events: WorldEvent[] = [];
      world.events.subscribe((e) => events.push(e));
      registerPubDealAutonomy(world, {
        pubLocationIds: [nags.id],
        npcActorIds: [seller.id, buyer.id],
        knowledgeProfiles: profiles,
        attemptsPerHour: 5,
        pairChance: 1.0,
        requireSellerFrom: new Set([seller.id]),
        requireBuyerFrom: new Set([buyer.id]),
        repAbortDamageThreshold: 100,
      });
      world.runToCompletion();

      const aborts = events.filter((e) => e.type === "pubdeal.skipped-rep");
      expect(aborts).toHaveLength(0);
    });
  });

  describe("commodity lookups exclude rep leads", () => {
    it("getRepLeadsBy doesn't return commodity leads, and vice versa", () => {
      const { localDb, buyer, seller, item } = seed();

      // One commodity, one rep — both in buyer's bag.
      insertLead(localDb, {
        holderActorId: buyer.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 10,
        estimatedUnitPrice: 8,
        acquiredDay: 1,
      });
      insertLead(localDb, {
        holderActorId: buyer.id,
        kind: "rep",
        side: "supply",
        subjectItemKindId: null,
        subjectTargetActorId: seller.id,
        counterpartyActorId: buyer.id,
        estimatedQuantity: 1,
        estimatedUnitPrice: 200,
        acquiredDay: 1,
      });

      const reps = getRepLeadsBy(localDb, buyer.id);
      expect(reps).toHaveLength(1);
      expect(reps[0]!.kind).toBe("rep");

      const all = getLeadsByHolder(localDb, buyer.id);
      expect(all).toHaveLength(2);
    });
  });
});

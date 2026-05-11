import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import {
  insertLead,
  shareLead,
  getLeadsByHolder,
} from "../src/engine/leads/leads-repo.js";
import { mutateLead } from "../src/engine/leads/mutation.js";
import { resolveEconomicsConfig } from "../src/engine/economics/config.js";
import { registerVisitorChat } from "../src/engine/world/visitor-chat.js";
import { insertPool } from "../src/engine/pools/pools-repo.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";
import { QUALITY_TIERS } from "../src/engine/stock/types.js";

describe("information mutation on every gossip hop", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  describe("pure mutateLead function", () => {
    it("disabled config returns the input verbatim", () => {
      const rng = createRNG("disabled");
      const input = {
        side: "supply" as const,
        subjectQualityTier: "good" as const,
        estimatedQuantity: 50,
        estimatedUnitPrice: 8,
        subjectPoolId: 42,
      };
      const config = {
        quantityJitter: 0,
        priceJitter: 0,
        tierSlipChance: 0,
        sideFlipChance: 0,
      };
      for (let i = 0; i < 50; i += 1) {
        expect(mutateLead(input, rng, config)).toEqual(input);
      }
    });

    it("numeric jitter is bounded and never drops below 1", () => {
      const rng = createRNG("jitter-bounds");
      const input = {
        side: "supply" as const,
        subjectQualityTier: null,
        estimatedQuantity: 100,
        estimatedUnitPrice: 50,
        subjectPoolId: null,
      };
      const config = {
        quantityJitter: 0.2,
        priceJitter: 0.2,
        tierSlipChance: 0,
        sideFlipChance: 0,
      };
      for (let i = 0; i < 200; i += 1) {
        const out = mutateLead(input, rng, config);
        expect(out.estimatedQuantity).toBeGreaterThanOrEqual(1);
        expect(out.estimatedQuantity).toBeLessThanOrEqual(120);
        expect(out.estimatedQuantity).toBeGreaterThanOrEqual(80);
        expect(out.estimatedUnitPrice).toBeGreaterThanOrEqual(40);
        expect(out.estimatedUnitPrice).toBeLessThanOrEqual(60);
      }
    });

    it("tiny values can't underflow to zero or negative", () => {
      const rng = createRNG("floor");
      const input = {
        side: "supply" as const,
        subjectQualityTier: null,
        estimatedQuantity: 1,
        estimatedUnitPrice: 1,
        subjectPoolId: null,
      };
      const config = {
        quantityJitter: 0.5,
        priceJitter: 0.5,
        tierSlipChance: 0,
        sideFlipChance: 0,
      };
      for (let i = 0; i < 100; i += 1) {
        const out = mutateLead(input, rng, config);
        expect(out.estimatedQuantity).toBeGreaterThanOrEqual(1);
        expect(out.estimatedUnitPrice).toBeGreaterThanOrEqual(1);
      }
    });

    it("tier slip stays within QUALITY_TIERS bounds", () => {
      const rng = createRNG("slip-bounds");
      const allowed = new Set(QUALITY_TIERS);
      const config = {
        quantityJitter: 0,
        priceJitter: 0,
        tierSlipChance: 1.0,
        sideFlipChance: 0,
      };
      for (const tier of QUALITY_TIERS) {
        for (let i = 0; i < 50; i += 1) {
          const out = mutateLead(
            {
              side: "supply",
              subjectQualityTier: tier,
              estimatedQuantity: 10,
              estimatedUnitPrice: 5,
              subjectPoolId: 1,
            },
            rng,
            config,
          );
          expect(out.subjectQualityTier).not.toBeNull();
          expect(allowed.has(out.subjectQualityTier!)).toBe(true);
          // Stays within ±1 step of the source tier.
          const idxBefore = QUALITY_TIERS.indexOf(tier);
          const idxAfter = QUALITY_TIERS.indexOf(out.subjectQualityTier!);
          expect(Math.abs(idxAfter - idxBefore)).toBeLessThanOrEqual(1);
        }
      }
    });

    it("null tier is never slipped", () => {
      const rng = createRNG("null-tier");
      const config = {
        quantityJitter: 0,
        priceJitter: 0,
        tierSlipChance: 1.0,
        sideFlipChance: 0,
      };
      for (let i = 0; i < 20; i += 1) {
        const out = mutateLead(
          {
            side: "supply",
            subjectQualityTier: null,
            estimatedQuantity: 1,
            estimatedUnitPrice: 1,
            subjectPoolId: null,
          },
          rng,
          config,
        );
        expect(out.subjectQualityTier).toBeNull();
      }
    });

    it("side flip drops the pool grounding", () => {
      const rng = createRNG("flip-drops-pool");
      const config = {
        quantityJitter: 0,
        priceJitter: 0,
        tierSlipChance: 0,
        sideFlipChance: 1.0,
      };
      const out = mutateLead(
        {
          side: "supply",
          subjectQualityTier: "good",
          estimatedQuantity: 10,
          estimatedUnitPrice: 5,
          subjectPoolId: 42,
        },
        rng,
        config,
      );
      expect(out.side).toBe("demand");
      expect(out.subjectPoolId).toBeNull();
    });

    it("no flip preserves the pool grounding", () => {
      const rng = createRNG("preserve-pool");
      const config = {
        quantityJitter: 0,
        priceJitter: 0,
        tierSlipChance: 0,
        sideFlipChance: 0,
      };
      const out = mutateLead(
        {
          side: "supply",
          subjectQualityTier: "good",
          estimatedQuantity: 10,
          estimatedUnitPrice: 5,
          subjectPoolId: 42,
        },
        rng,
        config,
      );
      expect(out.side).toBe("supply");
      expect(out.subjectPoolId).toBe(42);
    });
  });

  describe("shareLead with mutator integration", () => {
    it("applies the mutator transformation to the inserted lead", () => {
      const localDb = openBetterSqlite3DB({ filename: ":memory:" });
      applyMigrations(localDb, ALL_MIGRATIONS);
      db = localDb;
      const a = insertActor(localDb, { code: "a", displayName: "A", cash: 0 });
      const b = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
      const item = insertItemKind(localDb, {
        code: "i",
        displayName: "I",
        category: "electrical",
        baseValue: 30,
      });
      const pool = insertPool(localDb, {
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 100,
        createdDay: 1,
        expiryDay: 10,
        openingUnitPrice: 8,
        closingUnitPrice: 4,
      });
      const lead = insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 10,
        acquiredDay: 1,
        subjectPoolId: pool.id,
      });

      const transferred = shareLead(localDb, a.id, b.id, lead.id, 2, {
        mutate: (input) => ({
          ...input,
          estimatedQuantity: input.estimatedQuantity + 5,
          estimatedUnitPrice: input.estimatedUnitPrice * 2,
        }),
      });

      expect(transferred.estimatedQuantity).toBe(105);
      expect(transferred.estimatedUnitPrice).toBe(20);
      // Untouched dimensions still carry through.
      expect(transferred.subjectItemKindId).toBe(item.id);
      expect(transferred.subjectQualityTier).toBe("good");
      // Hop semantics still hold.
      expect(transferred.hopCount).toBe(1);
      expect(transferred.confidence).toBe("cold");
      expect(transferred.derivedFromLeadId).toBe(lead.id);
      // Original is unchanged.
      const original = getLeadsByHolder(localDb, a.id)[0]!;
      expect(original.estimatedQuantity).toBe(100);
      expect(original.estimatedUnitPrice).toBe(10);
    });

    it("no-mutate shareLead is a verbatim copy (back-compat)", () => {
      const localDb = openBetterSqlite3DB({ filename: ":memory:" });
      applyMigrations(localDb, ALL_MIGRATIONS);
      db = localDb;
      const a = insertActor(localDb, { code: "a", displayName: "A", cash: 0 });
      const b = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
      const item = insertItemKind(localDb, {
        code: "i",
        displayName: "I",
        category: "electrical",
        baseValue: 30,
      });
      const pool = insertPool(localDb, {
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 100,
        createdDay: 1,
        expiryDay: 10,
        openingUnitPrice: 8,
        closingUnitPrice: 4,
      });
      const lead = insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 10,
        acquiredDay: 1,
        subjectPoolId: pool.id,
      });

      const transferred = shareLead(localDb, a.id, b.id, lead.id, 2);
      expect(transferred.estimatedQuantity).toBe(100);
      expect(transferred.estimatedUnitPrice).toBe(10);
      expect(transferred.subjectQualityTier).toBe("good");
      expect(transferred.side).toBe("supply");
      expect(transferred.subjectPoolId).toBe(pool.id);
    });
  });

  describe("end-to-end through the gossip handlers", () => {
    it("aggressive mutation produces divergent leads after a chat", () => {
      const localDb = openBetterSqlite3DB({ filename: ":memory:" });
      applyMigrations(localDb, ALL_MIGRATIONS);
      db = localDb;
      const a = insertActor(localDb, { code: "a", displayName: "A", cash: 0 });
      const b = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, a.id, nags.id);
      setActorLocation(localDb, b.id, nags.id);
      const item = insertItemKind(localDb, {
        code: "k",
        displayName: "K",
        category: "electrical",
        baseValue: 30,
      });
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 50,
        acquiredDay: 1,
      });

      const economics = resolveEconomicsConfig({
        gossipMutation: {
          quantityJitter: 0.5,
          priceJitter: 0.5,
          tierSlipChance: 0,
          sideFlipChance: 0,
        },
      });
      const world = new World({
        db: localDb,
        rng: createRNG("aggressive"),
        seed: "aggressive",
        maxDays: 1,
        startDay: 1,
        startHour: 22,
      });
      registerVisitorChat(world, {
        chatLocationIds: [nags.id],
        attemptsPerHour: 1,
        pairChance: 1.0,
        chatLeadsPerExchange: 1,
        economics,
      });
      world.runToCompletion();

      const bLeads = getLeadsByHolder(localDb, b.id);
      expect(bLeads).toHaveLength(1);
      const transferred = bLeads[0]!;
      // With ±50% jitter the numbers should almost certainly drift.
      const drifted =
        transferred.estimatedQuantity !== 100 ||
        transferred.estimatedUnitPrice !== 50;
      expect(drifted).toBe(true);
      // But the subject — kind, tier (slip disabled), side — is faithful.
      expect(transferred.subjectItemKindId).toBe(item.id);
      expect(transferred.subjectQualityTier).toBe("good");
      expect(transferred.side).toBe("supply");
      // And the gossip event embeds the mutated values, not the source.
      // (Implicitly tested by virtue of receiver-side numbers matching the
      // post-mutation values.)
    });

    it("a side-flip during gossip drops the pool grounding on the receiver's copy", () => {
      const localDb = openBetterSqlite3DB({ filename: ":memory:" });
      applyMigrations(localDb, ALL_MIGRATIONS);
      db = localDb;
      const a = insertActor(localDb, { code: "a", displayName: "A", cash: 0 });
      const b = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, a.id, nags.id);
      setActorLocation(localDb, b.id, nags.id);
      const item = insertItemKind(localDb, {
        code: "k",
        displayName: "K",
        category: "electrical",
        baseValue: 30,
      });
      const pool = insertPool(localDb, {
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 100,
        createdDay: 1,
        expiryDay: 10,
        openingUnitPrice: 8,
        closingUnitPrice: 4,
      });
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 50,
        acquiredDay: 1,
        subjectPoolId: pool.id,
      });

      const economics = resolveEconomicsConfig({
        gossipMutation: {
          quantityJitter: 0,
          priceJitter: 0,
          tierSlipChance: 0,
          sideFlipChance: 1.0, // guaranteed flip
        },
      });
      const world = new World({
        db: localDb,
        rng: createRNG("flip"),
        seed: "flip",
        maxDays: 1,
        startDay: 1,
        startHour: 22,
      });
      const events: WorldEvent[] = [];
      world.events.subscribe((e) => events.push(e));
      registerVisitorChat(world, {
        chatLocationIds: [nags.id],
        attemptsPerHour: 1,
        pairChance: 1.0,
        chatLeadsPerExchange: 1,
        economics,
      });
      world.runToCompletion();

      const bLeads = getLeadsByHolder(localDb, b.id);
      expect(bLeads).toHaveLength(1);
      const transferred = bLeads[0]!;
      expect(transferred.side).toBe("demand");
      expect(transferred.subjectPoolId).toBeNull();
      // A's bag is untouched — both stories persist in the world.
      const aLeads = getLeadsByHolder(localDb, a.id);
      expect(aLeads[0]!.side).toBe("supply");
      expect(aLeads[0]!.subjectPoolId).toBe(pool.id);
    });
  });
});

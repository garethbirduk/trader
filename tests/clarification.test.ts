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
  clarifyLead,
  getLeadsByHolder,
  insertLead,
} from "../src/engine/leads/leads-repo.js";
import { resolveEconomicsConfig } from "../src/engine/economics/config.js";
import { registerVisitorChat } from "../src/engine/world/visitor-chat.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("clarification action", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const a = insertActor(localDb, { code: "a", firstName: "A", shortName: "A", cash: 0 });
    const b = insertActor(localDb, { code: "b", firstName: "B", shortName: "B", cash: 0 });
    const item = insertItemKind(localDb, {
      code: "i",
      displayName: "I",
      category: "electrical",
      baseValue: 30,
    });
    return { localDb, a, b, item };
  }

  describe("clarifyLead repo function", () => {
    it("surfaces target's matching lead into asker's bag", () => {
      const { localDb, a, b, item } = seed();
      // A's version: 100 units @ £10.
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 10,
        acquiredDay: 1,
      });
      // B's version of the same subject: 60 units @ £8.
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 60,
        estimatedUnitPrice: 8,
        acquiredDay: 1,
      });

      const result = clarifyLead(
        localDb,
        a.id,
        b.id,
        {
          side: "supply",
          subjectItemKindId: item.id,
          subjectQualityTier: "good",
          counterpartyActorId: null,
        },
        2,
      );
      expect(result).not.toBeNull();
      expect(result!.holderActorId).toBe(a.id);
      // No mutator → exact copy of B's values.
      expect(result!.estimatedQuantity).toBe(60);
      expect(result!.estimatedUnitPrice).toBe(8);
      // sourceActorId points at the speaker (B), per the "immediate prior"
      // semantics that make the chain walkable.
      expect(result!.sourceActorId).toBe(b.id);

      // Both versions persist in A's bag.
      const aLeads = getLeadsByHolder(localDb, a.id);
      expect(aLeads).toHaveLength(2);
    });

    it("returns null when the target has nothing on the subject", () => {
      const { localDb, a, b, item } = seed();
      const result = clarifyLead(
        localDb,
        a.id,
        b.id,
        {
          side: "supply",
          subjectItemKindId: item.id,
          subjectQualityTier: "good",
          counterpartyActorId: null,
        },
        2,
      );
      expect(result).toBeNull();
    });

    it("matches on counterpartyActorId when set", () => {
      const { localDb, a, b, item } = seed();
      const c = insertActor(localDb, { code: "c", firstName: "C", shortName: "C", cash: 0 });
      // B has two supply leads about the same item — one counterpartied
      // to actor c, the other untargeted.
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        counterpartyActorId: c.id,
        estimatedQuantity: 30,
        estimatedUnitPrice: 5,
        acquiredDay: 1,
      });
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        counterpartyActorId: null,
        estimatedQuantity: 99,
        estimatedUnitPrice: 99,
        acquiredDay: 1,
      });
      const result = clarifyLead(
        localDb,
        a.id,
        b.id,
        {
          side: "supply",
          subjectItemKindId: item.id,
          subjectQualityTier: "good",
          counterpartyActorId: c.id,
        },
        2,
      );
      expect(result).not.toBeNull();
      expect(result!.counterpartyActorId).toBe(c.id);
      expect(result!.estimatedQuantity).toBe(30);
    });

    it("prefers the freshest matching lead (lowest hop, warm-first)", () => {
      const { localDb, a, b, item } = seed();
      // B holds two versions of the same subject — one cold/old-hop, one
      // warm/firsthand. The warm one should win.
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 999,
        estimatedUnitPrice: 999,
        confidence: "cold",
        hopCount: 5,
        acquiredDay: 1,
      });
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 50,
        estimatedUnitPrice: 12,
        confidence: "warm",
        hopCount: 0,
        acquiredDay: 1,
      });
      const result = clarifyLead(
        localDb,
        a.id,
        b.id,
        {
          side: "supply",
          subjectItemKindId: item.id,
          subjectQualityTier: "good",
          counterpartyActorId: null,
        },
        2,
      );
      expect(result).not.toBeNull();
      expect(result!.estimatedQuantity).toBe(50);
    });

    it("self-clarify is silent", () => {
      const { localDb, a, item } = seed();
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 50,
        estimatedUnitPrice: 8,
        acquiredDay: 1,
      });
      const result = clarifyLead(
        localDb,
        a.id,
        a.id,
        {
          side: "supply",
          subjectItemKindId: item.id,
          subjectQualityTier: "good",
          counterpartyActorId: null,
        },
        2,
      );
      expect(result).toBeNull();
    });
  });

  describe("chat-side clarification autonomy", () => {
    it("emits a clarification-kind event when both parties hold leads on overlapping subjects", () => {
      const { localDb, a, b, item } = seed();
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, a.id, nags.id);
      setActorLocation(localDb, b.id, nags.id);

      // Both parties hold a supply lead on the same item-tier — fertile
      // ground for "what do you reckon?"
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 10,
        acquiredDay: 1,
      });
      insertLead(localDb, {
        holderActorId: b.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 60,
        estimatedUnitPrice: 8,
        acquiredDay: 1,
      });

      // Disable mutation so the clarification values stay readable.
      const economics = resolveEconomicsConfig({
        gossipMutation: {
          quantityJitter: 0,
          priceJitter: 0,
          tierSlipChance: 0,
          sideFlipChance: 0,
        },
      });
      const world = new World({
        db: localDb,
        rng: createRNG("clarify"),
        seed: "clarify",
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
        chatLeadsPerExchange: 0, // suppress the casual swap to isolate clarifications
        clarificationChance: 1.0,
        economics,
      });
      world.runToCompletion();

      const clarifications = events.filter(
        (e): e is Extract<WorldEvent, { type: "gossip.exchanged" }> =>
          e.type === "gossip.exchanged" && e.kind === "clarification",
      );
      expect(clarifications.length).toBeGreaterThan(0);
      const ev = clarifications[0]!;
      expect(ev.atLocationId).toBe(nags.id);
      expect(ev.participantActorIds).toEqual(expect.arrayContaining([a.id, b.id]));
      // Some exchange happened — at minimum one of the two clarifications
      // surfaced a matching lead.
      expect(ev.exchanges.length).toBeGreaterThan(0);
    });

    it("fires nothing when the partner has no matching subject", () => {
      const { localDb, a, b, item } = seed();
      const otherItem = insertItemKind(localDb, {
        code: "j",
        displayName: "J",
        category: "decor",
        baseValue: 20,
      });
      const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
      setActorLocation(localDb, a.id, nags.id);
      setActorLocation(localDb, b.id, nags.id);

      // A and B hold leads on completely disjoint subjects.
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 100,
        estimatedUnitPrice: 10,
        acquiredDay: 1,
      });
      insertLead(localDb, {
        holderActorId: b.id,
        side: "demand",
        subjectItemKindId: otherItem.id,
        subjectQualityTier: "fair",
        estimatedQuantity: 5,
        estimatedUnitPrice: 25,
        acquiredDay: 1,
      });

      const world = new World({
        db: localDb,
        rng: createRNG("no-match"),
        seed: "no-match",
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
        chatLeadsPerExchange: 0,
        clarificationChance: 1.0,
      });
      world.runToCompletion();

      const clarifications = events.filter(
        (e) => e.type === "gossip.exchanged" && e.kind === "clarification",
      );
      expect(clarifications).toHaveLength(0);
    });
  });
});

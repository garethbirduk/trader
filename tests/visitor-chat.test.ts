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
  setLocationProprietor,
} from "../src/engine/locations/locations.js";
import { insertLead, getLeadsByHolder } from "../src/engine/leads/leads-repo.js";
import { registerVisitorChat } from "../src/engine/world/visitor-chat.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("visitor↔visitor chat", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const a = insertActor(localDb, { code: "a", displayName: "A", cash: 0 });
    const b = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
    setActorLocation(localDb, a.id, nags.id);
    setActorLocation(localDb, b.id, nags.id);
    const item = insertItemKind(localDb, {
      code: "k",
      displayName: "K",
      category: "electrical",
      baseValue: 30,
    });
    return { localDb, nags, a, b, item };
  }

  it("pairs co-located actors and emits a chat-kind gossip event", () => {
    const { localDb, nags, a, b, item } = seed();
    // A has a supply lead B doesn't. B has a demand lead A doesn't.
    insertLead(localDb, {
      holderActorId: a.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 50,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: b.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 20,
      estimatedUnitPrice: 15,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("chat-seed"),
      seed: "chat-seed",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerVisitorChat(world, {
      chatLocationIds: [nags.id],
      attemptsPerHour: 5,
      pairChance: 1.0,
      chatLeadsPerExchange: 2,
    });
    world.runToCompletion();

    const chats = events.filter(
      (e): e is Extract<WorldEvent, { type: "gossip.exchanged" }> =>
        e.type === "gossip.exchanged",
    );
    expect(chats.length).toBeGreaterThan(0);
    expect(chats[0]!.kind).toBe("chat");
    expect(chats[0]!.atLocationId).toBe(nags.id);
    expect(chats[0]!.participantActorIds).toEqual(
      expect.arrayContaining([a.id, b.id]),
    );

    // Leads moved across in both directions on the first chat. After the
    // first trial each side may keep firing harmlessly with no novelty
    // left, but the leads count should have grown for both.
    const aLeads = getLeadsByHolder(localDb, a.id);
    const bLeads = getLeadsByHolder(localDb, b.id);
    expect(aLeads.length).toBeGreaterThanOrEqual(2);
    expect(bLeads.length).toBeGreaterThanOrEqual(2);
  });

  it("skips the proprietor — they get the drive-by handler instead", () => {
    const { localDb, nags, a, b, item } = seed();
    const mike = insertActor(localDb, { code: "mike", displayName: "Mike", cash: 0 });
    setActorLocation(localDb, mike.id, nags.id);
    setLocationProprietor(localDb, nags.id, mike.id);
    insertLead(localDb, {
      holderActorId: mike.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 99,
      estimatedUnitPrice: 1,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: a.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      estimatedQuantity: 1,
      estimatedUnitPrice: 99,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("no-proprietor"),
      seed: "no-proprietor",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerVisitorChat(world, {
      chatLocationIds: [nags.id],
      attemptsPerHour: 10,
      pairChance: 1.0,
      chatLeadsPerExchange: 5,
    });
    world.runToCompletion();

    const chats = events.filter(
      (e): e is Extract<WorldEvent, { type: "gossip.exchanged" }> =>
        e.type === "gossip.exchanged",
    );
    expect(chats.length).toBeGreaterThan(0);
    for (const c of chats) {
      expect(c.participantActorIds).not.toContain(mike.id);
    }
    // Useful side-effect: nothing learned by Mike from chats — his
    // bandwidth comes from the proprietor handler, not this one.
    const mikeLeadsAfter = getLeadsByHolder(localDb, mike.id);
    expect(mikeLeadsAfter.length).toBe(1);
  });

  it("info-trader pairs exchange more leads per encounter", () => {
    const { localDb, nags, a, b, item } = seed();
    // Stock A's bag with 6 distinct supply leads on the same item-kind so
    // B's "novel" pool is larger than the baseline yield (2) but smaller
    // than the info-trader yield (5). Then A and B converse twice — the
    // info-trader run should drain B's novelty faster.
    for (let i = 0; i < 6; i += 1) {
      insertLead(localDb, {
        holderActorId: a.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 10 + i,
        estimatedUnitPrice: 5 + i,
        acquiredDay: 1,
      });
    }
    const baselineBLeadsBefore = getLeadsByHolder(localDb, b.id).length;

    // Run 1 — baseline yield. One hour only (startHour=22, the last hour
    // in the chat window) so the bag-draining over multiple hours doesn't
    // mask the per-encounter difference.
    const w1 = new World({
      db: localDb,
      rng: createRNG("baseline"),
      seed: "baseline",
      maxDays: 1,
      startDay: 1,
      startHour: 22,
    });
    registerVisitorChat(w1, {
      chatLocationIds: [nags.id],
      attemptsPerHour: 1,
      pairChance: 1.0,
      chatLeadsPerExchange: 2,
      infoTraderChatYield: 2, // disabled — same yield either way
    });
    w1.runToCompletion();
    const afterBaseline = getLeadsByHolder(localDb, b.id).length;
    const gainBaseline = afterBaseline - baselineBLeadsBefore;

    // Wipe B's bag and reset.
    localDb.prepare(`DELETE FROM leads WHERE holder_actor_id = @id`).run({ id: b.id });

    // Run 2 — info-trader yield 5. A has more than enough novel leads.
    const w2 = new World({
      db: localDb,
      rng: createRNG("boosted"),
      seed: "boosted",
      maxDays: 1,
      startDay: 1,
      startHour: 22,
    });
    registerVisitorChat(w2, {
      chatLocationIds: [nags.id],
      attemptsPerHour: 1,
      pairChance: 1.0,
      chatLeadsPerExchange: 2,
      infoTraderChatYield: 5,
      infoTraderActorIds: new Set([a.id]),
    });
    w2.runToCompletion();
    const afterBoosted = getLeadsByHolder(localDb, b.id).length;
    expect(gainBaseline).toBeGreaterThan(0);
    expect(afterBoosted).toBeGreaterThan(gainBaseline);
  });

  it("emits nothing when there's nothing novel to say", () => {
    const { localDb, nags, a, b, item } = seed();
    // Both hold the exact same lead — no novelty either way.
    const seed1 = {
      side: "supply" as const,
      subjectItemKindId: item.id,
      subjectQualityTier: "good" as const,
      estimatedQuantity: 50,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    };
    insertLead(localDb, { holderActorId: a.id, ...seed1 });
    insertLead(localDb, { holderActorId: b.id, ...seed1 });

    const world = new World({
      db: localDb,
      rng: createRNG("nothing-novel"),
      seed: "nothing-novel",
      maxDays: 1,
      startDay: 1,
      startHour: 18,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerVisitorChat(world, {
      chatLocationIds: [nags.id],
      attemptsPerHour: 5,
      pairChance: 1.0,
      // Isolate the novel-swap silence; clarifications would still
      // pull A's identical lead back across as a deliberate ask.
      clarificationChance: 0,
    });
    world.runToCompletion();

    expect(events.filter((e) => e.type === "gossip.exchanged")).toHaveLength(0);
  });
});

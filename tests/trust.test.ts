import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { createAgreedDeal } from "../src/engine/deals/deals-repo.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import {
  adjustTrust,
  getTrust,
  listTrustHeldBy,
} from "../src/engine/trust/trust-repo.js";
import { registerDailySettlement } from "../src/engine/world/daily-settlement.js";
import { registerTrustReactions } from "../src/engine/world/trust-reactions.js";
import type { DB } from "../src/engine/core/db.js";

describe("trust repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("returns 0 trust for a never-recorded pair", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const b = insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    const t = getTrust(db, a.id, b.id);
    expect(t.score).toBe(0);
    expect(t.lastEventDay).toBeNull();
  });

  it("adjusts trust upward and downward, persisting last event day", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const b = insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    expect(adjustTrust(db, a.id, b.id, 5, 1).score).toBe(5);
    expect(adjustTrust(db, a.id, b.id, 3, 2).score).toBe(8);
    expect(adjustTrust(db, a.id, b.id, -10, 3).score).toBe(-2);
    expect(getTrust(db, a.id, b.id).lastEventDay).toBe(3);
  });

  it("trust is asymmetric — A's trust in B is independent of B's trust in A", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const b = insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    adjustTrust(db, a.id, b.id, 10, 1);
    expect(getTrust(db, a.id, b.id).score).toBe(10);
    expect(getTrust(db, b.id, a.id).score).toBe(0);
  });

  it("rejects self-trust", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    expect(() => getTrust(db, a.id, a.id)).toThrow();
    expect(() => adjustTrust(db, a.id, a.id, 1, 1)).toThrow();
  });

  it("listTrustHeldBy returns all pairs from one actor's perspective", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const b = insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    const c = insertActor(db, { code: "c", firstName: "C", shortName: "C" });
    adjustTrust(db, a.id, b.id, 5, 1);
    adjustTrust(db, a.id, c.id, -3, 1);
    expect(listTrustHeldBy(db, a.id).map((p) => p.targetActorId).sort()).toEqual(
      [b.id, c.id].sort(),
    );
  });
});

describe("trust reactions wired through deal lifecycle", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("settled deal bumps trust both ways; defaulted deal drops buyer's trust in seller", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const del = insertActor(localDb, { code: "del", firstName: "Del", shortName: "Del", cash: 0 });
    const boyce = insertActor(localDb, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 1000 });
    const denzil = insertActor(localDb, { code: "denzil", firstName: "Denzil", shortName: "Denzil", cash: 500 });
    const tables = insertItemKind(localDb, {
      code: "tables",
      displayName: "Tables",
      category: "furniture",
      baseValue: 20,
    });

    // Clean settlement: Del to Boyce.
    insertStockLot(localDb, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 5,
      acquiredUnitPrice: 10,
      acquiredDay: 1,
    });
    createAgreedDeal(localDb, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 5, unitPrice: 30 }],
    });

    // Default: Del forward-sold to Denzil but never sourced stock.
    createAgreedDeal(localDb, {
      buyerActorId: denzil.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [{ itemKindId: tables.id, qualityTier: "mint", quantity: 10, unitPrice: 50 }],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("trust-test"),
      seed: "trust-test",
      maxDays: 3,
    });
    registerDailySettlement(world);
    registerTrustReactions(world);
    world.runToCompletion();

    // Clean settle Del<->Boyce → +2 in each direction
    expect(getTrust(localDb, boyce.id, del.id).score).toBe(2);
    expect(getTrust(localDb, del.id, boyce.id).score).toBe(2);

    // Default Del→Denzil → Denzil's trust in Del drops; Del's trust in Denzil unchanged
    expect(getTrust(localDb, denzil.id, del.id).score).toBe(-10);
    expect(getTrust(localDb, del.id, denzil.id).score).toBe(0);
  });
});

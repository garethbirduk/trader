import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import {
  getActorCurrentLocationId,
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot, totalQuantityForOwnerAndKind } from "../src/engine/stock/lots-repo.js";
import { createAgreedDeal, getDealById } from "../src/engine/deals/deals-repo.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import { bufferHandler } from "../src/engine/core/events.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import {
  PolicyRegistry,
  applyAction,
  runPoliciesForHour,
} from "../src/engine/policy/runner.js";
import { RuleBasedAIPolicy } from "../src/engine/policy/rule-based.js";
import { buildActorView } from "../src/engine/policy/views.js";
import { registerDailySettlement } from "../src/engine/world/daily-settlement.js";
import type { DB } from "../src/engine/core/db.js";

describe("buildActorView", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("snapshots actor cash, inventory, deals, location, and clock", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 500 });
    const boyce = insertActor(db, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 1000 });
    const flat = insertLocation(db, { code: "flat", displayName: "Flat" });
    setActorLocation(db, del.id, flat.id);
    const tables = insertItemKind(db, {
      code: "tables",
      displayName: "Tables",
      category: "furniture",
      baseValue: 20,
    });
    insertStockLot(db, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 15,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(db, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 3,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 5, unitPrice: 30 }],
    });

    const view = buildActorView(db, del.id, { day: 1, hour: 10 });
    expect(view.actor.cash).toBe(500);
    expect(view.currentLocation?.code).toBe("flat");
    expect(view.inventory).toHaveLength(1);
    expect(view.inventory[0]?.quantity).toBe(10);
    expect(view.dealsAsSeller.map((d) => d.id)).toEqual([deal.id]);
    expect(view.dealsAsBuyer).toEqual([]);
    expect(view.clock).toEqual({ day: 1, hour: 10 });
  });
});

describe("RuleBasedAIPolicy", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("travels to scheduled location when not there", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const flat = insertLocation(db, { code: "flat", displayName: "Flat" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    setActorLocation(db, del.id, flat.id);

    const policy = new RuleBasedAIPolicy("p-del", {
      schedule: new Map([[18, nags.id]]),
      defaultLocationId: flat.id,
    });
    const view = buildActorView(db, del.id, { day: 1, hour: 18 });
    const action = policy.decide(view, createRNG("a"));
    expect(action).toEqual({ type: "travel", toLocationId: nags.id });
  });

  it("idles when already at scheduled location", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    setActorLocation(db, del.id, nags.id);

    const policy = new RuleBasedAIPolicy("p-del", {
      schedule: new Map([[18, nags.id]]),
    });
    const view = buildActorView(db, del.id, { day: 1, hour: 18 });
    expect(policy.decide(view, createRNG("a")).type).toBe("idle");
  });

  it("falls back to default when no schedule entry for the hour", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const flat = insertLocation(db, { code: "flat", displayName: "Flat" });
    setActorLocation(db, del.id, null);

    const policy = new RuleBasedAIPolicy("p-del", {
      defaultLocationId: flat.id,
    });
    const view = buildActorView(db, del.id, { day: 1, hour: 12 });
    const action = policy.decide(view, createRNG("a"));
    expect(action).toEqual({ type: "travel", toLocationId: flat.id });
  });

  it("idles when no schedule and no default", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const policy = new RuleBasedAIPolicy("p-del", {});
    const view = buildActorView(db, del.id, { day: 1, hour: 12 });
    expect(policy.decide(view, createRNG("a")).type).toBe("idle");
  });
});

describe("applyAction", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("travel updates current location and emits event", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });
    const buf = bufferHandler();
    applyAction(
      db,
      del.id,
      { type: "travel", toLocationId: nags.id },
      { day: 1, hour: 18 },
      { emit: buf.handler, subscribe: () => () => {} },
    );
    expect(getActorCurrentLocationId(db, del.id)).toBe(nags.id);
    expect(buf.events[0]?.type).toBe("actor.travelled");
  });

  it("idle is a no-op", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const buf = bufferHandler();
    applyAction(
      db,
      del.id,
      { type: "idle" },
      { day: 1, hour: 18 },
      { emit: buf.handler, subscribe: () => () => {} },
    );
    expect(buf.events).toEqual([]);
  });
});

describe("runPoliciesForHour", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("runs every registered policy in deterministic actor-id order", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    const b = insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    const flat = insertLocation(db, { code: "flat", displayName: "Flat" });
    const nags = insertLocation(db, { code: "nags", displayName: "Nag's" });

    const reg = new PolicyRegistry();
    reg.register(a.id, new RuleBasedAIPolicy("a", { defaultLocationId: flat.id }));
    reg.register(b.id, new RuleBasedAIPolicy("b", { defaultLocationId: nags.id }));

    const buf = bufferHandler();
    runPoliciesForHour(
      db,
      { day: 1, hour: 9 },
      reg,
      createRNG("x"),
      { emit: buf.handler, subscribe: () => () => {} },
    );

    expect(getActorCurrentLocationId(db, a.id)).toBe(flat.id);
    expect(getActorCurrentLocationId(db, b.id)).toBe(nags.id);
    expect(buf.events.filter((e) => e.type === "actor.travelled")).toHaveLength(2);
  });
});

describe("daily settlement", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("settles a deal whose deadline passes overnight", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const del = insertActor(localDb, {
      code: "del", firstName: "Del", shortName: "Del", cash: 0, transportCapacity: "truck",
    });
    const boyce = insertActor(localDb, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 500 });
    const tables = insertItemKind(localDb, {
      code: "tables",
      displayName: "Tables",
      category: "furniture",
      baseValue: 20,
    });
    insertStockLot(localDb, {
      ownerActorId: del.id,
      itemKindId: tables.id,
      qualityTier: "good",
      quantity: 10,
      acquiredUnitPrice: 15,
      acquiredDay: 1,
    });
    const deal = createAgreedDeal(localDb, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("daily"),
      seed: "daily",
      maxDays: 3,
      startDay: 1,
      startHour: 9,
    });
    const buf = bufferHandler();
    world.events.subscribe(buf.handler);
    registerDailySettlement(world);
    world.runToCompletion();

    const settled = getDealById(localDb, deal.id);
    expect(settled?.state).toBe("settled");
    expect(getActorById(localDb, boyce.id)?.cash).toBe(200);
    expect(getActorById(localDb, del.id)?.cash).toBe(300);
    expect(totalQuantityForOwnerAndKind(localDb, boyce.id, tables.id)).toBe(10);
    expect(buf.events.some((e) => e.type === "deal.settled")).toBe(true);
  });

  it("auto-defaults a deal when seller has no stock at settlement", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const del = insertActor(localDb, { code: "del", firstName: "Del", shortName: "Del", cash: 0 });
    const boyce = insertActor(localDb, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 500 });
    const tables = insertItemKind(localDb, {
      code: "tables",
      displayName: "Tables",
      category: "furniture",
      baseValue: 20,
    });
    // Del forward-sold but never acquired stock.
    const deal = createAgreedDeal(localDb, {
      buyerActorId: boyce.id,
      sellerActorId: del.id,
      agreedDay: 1,
      deadlineDay: 2,
      lines: [{ itemKindId: tables.id, qualityTier: "good", quantity: 10, unitPrice: 30 }],
    });

    const world = new World({
      db: localDb,
      rng: createRNG("daily-default"),
      seed: "daily-default",
      maxDays: 3,
    });
    const buf = bufferHandler();
    world.events.subscribe(buf.handler);
    registerDailySettlement(world);
    world.runToCompletion();

    const defaulted = getDealById(localDb, deal.id);
    expect(defaulted?.state).toBe("defaulted");
    // Buyer kept their cash; seller has none.
    expect(getActorById(localDb, boyce.id)?.cash).toBe(500);
    expect(getActorById(localDb, del.id)?.cash).toBe(0);
    expect(buf.events.some((e) => e.type === "deal.defaulted")).toBe(true);
  });
});

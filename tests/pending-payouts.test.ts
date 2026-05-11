import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import {
  insertActor,
  getActorById,
} from "../src/engine/actors/actors-repo.js";
import {
  insertPendingPayout,
  listDuePayouts,
  listPendingPayoutsForActor,
} from "../src/engine/payouts/pending-payouts-repo.js";
import { registerPendingPayouts } from "../src/engine/world/pending-payouts.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("pending payouts (Stage 7)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts a row and surfaces it on the actor's pending list", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const whale = insertActor(localDb, {
      code: "whale",
      displayName: "Whale",
      cash: 0,
    });
    insertPendingPayout(localDb, {
      actorId: whale.id,
      amount: 250,
      availableDay: 5,
      source: "off-map-resale",
      createdDay: 3,
    });
    const list = listPendingPayoutsForActor(localDb, whale.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.amount).toBe(250);
    expect(list[0]!.availableDay).toBe(5);
  });

  it("listDuePayouts only returns rows whose day has arrived", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const whale = insertActor(localDb, {
      code: "whale",
      displayName: "Whale",
      cash: 0,
    });
    insertPendingPayout(localDb, {
      actorId: whale.id,
      amount: 100,
      availableDay: 3,
      source: "x",
      createdDay: 1,
    });
    insertPendingPayout(localDb, {
      actorId: whale.id,
      amount: 200,
      availableDay: 5,
      source: "x",
      createdDay: 1,
    });
    expect(listDuePayouts(localDb, 2)).toHaveLength(0);
    expect(listDuePayouts(localDb, 3)).toHaveLength(1);
    expect(listDuePayouts(localDb, 5)).toHaveLength(2);
  });

  it("handler drains due payouts at day start and credits cash", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const whale = insertActor(localDb, {
      code: "whale",
      displayName: "Whale",
      cash: 0,
    });
    insertPendingPayout(localDb, {
      actorId: whale.id,
      amount: 150,
      availableDay: 2,
      source: "off-map-resale",
      createdDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("payouts"),
      seed: "payouts",
      maxDays: 3,
      startDay: 1,
      startHour: 23,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerPendingPayouts(world);
    world.start();
    // First tickOnce: hour 23 → next is day 2 hour 0 → fires day.started for day 2.
    world.tickOnce();

    // Payout for day 2 should now have landed.
    expect(getActorById(localDb, whale.id)!.cash).toBe(150);
    expect(listPendingPayoutsForActor(localDb, whale.id)).toHaveLength(0);
    const released = events.find((e) => e.type === "payout.released");
    expect(released).toBeDefined();
    if (released && released.type === "payout.released") {
      expect(released.amount).toBe(150);
      expect(released.originatedDay).toBe(1);
    }
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";
import {
  insertJudgement,
  listJudgementsByDay,
  type PriceArmPayload,
} from "../src/engine/perception/judgement-log-repo.js";
import { registerJudgementRetention } from "../src/engine/world/judgement-retention.js";

const PRICE_PAYLOAD: PriceArmPayload = {
  itemKindId: 1,
  category: "electrical",
  truthTier: "fair",
  truthUnit: 100,
  anchor: 30,
  tierMultiplier: 0.8,
  expertise: 0.8,
  j: 0.7,
  centre: 86,
  low: 40,
  high: 130,
  sample: null,
  quantity: 1,
};

function freshWorld(maxDays: number, startDay = 1) {
  const db = openBetterSqlite3DB({ filename: ":memory:" });
  applyMigrations(db, ALL_MIGRATIONS);
  const world = new World({
    db,
    rng: createRNG("retention"),
    seed: "retention",
    maxDays,
    startDay,
  });
  return { db, world };
}

function seedRow(db: DB, day: number): void {
  insertJudgement(db, {
    day,
    hour: 0,
    actorId: 1,
    arm: "price",
    contextKind: "lead-seed",
    contextRefId: day,
    payload: PRICE_PAYLOAD,
  });
}

describe("registerJudgementRetention", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("prunes rows older than keepDays at the next day-start", () => {
    const ctx = freshWorld(20, 20);
    db = ctx.db;
    seedRow(ctx.db, 1);
    seedRow(ctx.db, 10);
    seedRow(ctx.db, 19);

    registerJudgementRetention(ctx.world, { keepDays: 5 });
    ctx.world.start();

    expect(listJudgementsByDay(ctx.db, 1)).toHaveLength(0);
    expect(listJudgementsByDay(ctx.db, 10)).toHaveLength(0);
    expect(listJudgementsByDay(ctx.db, 19)).toHaveLength(1);
  });

  it("no-ops when cutoff would be negative (early-sim safety)", () => {
    const ctx = freshWorld(20);
    db = ctx.db;
    seedRow(ctx.db, 0);

    registerJudgementRetention(ctx.world, { keepDays: 14 });
    ctx.world.start();

    expect(listJudgementsByDay(ctx.db, 0)).toHaveLength(1);
  });

  it("defaults to keepDays=14", () => {
    const ctx = freshWorld(40, 30);
    db = ctx.db;
    seedRow(ctx.db, 10);
    seedRow(ctx.db, 16);
    seedRow(ctx.db, 25);

    registerJudgementRetention(ctx.world);
    ctx.world.start();

    expect(listJudgementsByDay(ctx.db, 10)).toHaveLength(0);
    expect(listJudgementsByDay(ctx.db, 16))
      .toHaveLength(1); // 30-14=16 cutoff; rows on day 16 survive (< not ≤)
    expect(listJudgementsByDay(ctx.db, 25)).toHaveLength(1);
  });
});

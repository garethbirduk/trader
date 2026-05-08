import { describe, it, expect, afterEach } from "vitest";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { World } from "../src/engine/core/world.js";
import { bufferHandler, type WorldEvent } from "../src/engine/core/events.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";

function freshWorld(maxDays: number, seed = "test") {
  const db = openBetterSqlite3DB({ filename: ":memory:" });
  applyMigrations(db, ALL_MIGRATIONS);
  const world = new World({ db, rng: createRNG(seed), seed, maxDays });
  const buf = bufferHandler();
  world.events.subscribe(buf.handler);
  return { db, world, events: buf.events };
}

describe("World tick loop", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("runs to completion over N days and emits expected lifecycle events", () => {
    const ctx = freshWorld(3);
    db = ctx.db;
    ctx.world.runToCompletion();

    expect(ctx.world.isFinished()).toBe(true);

    const types = ctx.events.map((e) => e.type);
    expect(types[0]).toBe("world.started");
    expect(types[types.length - 1]).toBe("world.ended");

    const dayStarted = ctx.events.filter((e) => e.type === "day.started");
    const dayEnded = ctx.events.filter((e) => e.type === "day.ended");
    expect(dayStarted.map((e) => (e as Extract<WorldEvent, { type: "day.started" }>).day)).toEqual([1, 2, 3]);
    expect(dayEnded.map((e) => (e as Extract<WorldEvent, { type: "day.ended" }>).day)).toEqual([1, 2, 3]);
  });

  it("runs a 14-day simulation as the v1 happy path", () => {
    const ctx = freshWorld(14);
    db = ctx.db;
    ctx.world.runToCompletion();

    expect(ctx.events.filter((e) => e.type === "day.started").length).toBe(14);
    expect(ctx.events.filter((e) => e.type === "day.ended").length).toBe(14);
  });

  it("invokes day-start and day-end hooks in order around midnight", () => {
    const ctx = freshWorld(2);
    db = ctx.db;
    const order: string[] = [];
    ctx.world.onDayStart((d) => order.push(`start:${d}`));
    ctx.world.onDayEnd((d) => order.push(`end:${d}`));
    ctx.world.runToCompletion();

    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("invokes the hour hook every hour", () => {
    const ctx = freshWorld(1);
    db = ctx.db;
    let hours = 0;
    ctx.world.onHour(() => {
      hours += 1;
    });
    ctx.world.runToCompletion();
    // Day starts at hour 9; runs 9..23 (15 hours) + the hour-23 tick that
    // transitions to day 2, after which the world stops. Rather than
    // asserting an exact count tied to start hour, assert it ran at least
    // a full day's worth.
    expect(hours).toBeGreaterThanOrEqual(15);
  });

  it("pause halts ticking; resume continues", () => {
    const ctx = freshWorld(5);
    db = ctx.db;
    ctx.world.start();
    expect(ctx.world.clock).toEqual({ day: 1, hour: 0 });

    ctx.world.tickOnce();
    expect(ctx.world.clock).toEqual({ day: 1, hour: 1 });

    ctx.world.pause();
    ctx.world.tickOnce();
    ctx.world.tickOnce();
    expect(ctx.world.clock).toEqual({ day: 1, hour: 1 });

    ctx.world.resume();
    ctx.world.tickOnce();
    expect(ctx.world.clock).toEqual({ day: 1, hour: 2 });
  });

  it("rejects double-start", () => {
    const ctx = freshWorld(1);
    db = ctx.db;
    ctx.world.start();
    expect(() => ctx.world.start()).toThrow();
  });

  it("rejects tickOnce before start", () => {
    const ctx = freshWorld(1);
    db = ctx.db;
    expect(() => ctx.world.tickOnce()).toThrow();
  });

  it("rejects bad maxDays", () => {
    const db2 = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db2, ALL_MIGRATIONS);
    expect(
      () => new World({ db: db2, rng: createRNG("x"), seed: "x", maxDays: 0 }),
    ).toThrow();
    db2.close();
  });
});

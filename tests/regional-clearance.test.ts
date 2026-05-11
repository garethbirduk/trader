import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { listOpenAuctionLots } from "../src/engine/auction/auction-repo.js";
import { registerRegionalClearance } from "../src/engine/world/regional-clearance.js";
import { resolveEconomicsConfig } from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("regional clearance (Stage 7)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("lists N regional-clearance lots on an auction day", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertItemKind(localDb, {
      code: "h",
      displayName: "Hi-Fi",
      category: "electrical",
      baseValue: 80,
    });

    const economics = resolveEconomicsConfig({
      regionalClearance: {
        lotsPerDay: 4,
        floorFractionOfRetail: 0.55,
        floorJitter: 0,
        provenancePhrases: ["Bromley estate"],
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("clearance"),
      seed: "clearance",
      maxDays: 2,
      startDay: 1,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerRegionalClearance(world, { economics });
    world.start();

    // Day 1 fires onDayStart at start().
    const listed = events.filter(
      (e) => e.type === "regional-clearance.listed",
    );
    expect(listed).toHaveLength(4);

    const lots = listOpenAuctionLots(localDb);
    expect(lots).toHaveLength(4);
    for (const lot of lots) {
      expect(lot.sourcePoolId).toBeNull();
      expect(lot.provenance).toBe("Bromley estate");
      expect(lot.floorPrice).toBeGreaterThan(0);
    }
  });

  it("doesn't fire on a closed day (Sat/Sun)", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });

    // Day 6 is Saturday by the (day - 1) % 7 + 1 convention (day 1 = Mon).
    const world = new World({
      db: localDb,
      rng: createRNG("weekend"),
      seed: "weekend",
      maxDays: 7,
      startDay: 6,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerRegionalClearance(world, {
      daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri only
    });
    world.start();

    expect(
      events.filter((e) => e.type === "regional-clearance.listed"),
    ).toHaveLength(0);
  });

  it("disables when lotsPerDay is 0", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });

    const economics = resolveEconomicsConfig({
      regionalClearance: {
        lotsPerDay: 0,
        floorFractionOfRetail: 0.55,
        floorJitter: 0,
        provenancePhrases: [],
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("off"),
      seed: "off",
      maxDays: 2,
      startDay: 1,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerRegionalClearance(world, { economics });
    world.start();

    expect(
      events.filter((e) => e.type === "regional-clearance.listed"),
    ).toHaveLength(0);
  });
});

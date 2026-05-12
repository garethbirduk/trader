import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import {
  getActorById,
  insertActor,
} from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  getStockLotsByOwner,
  insertStockLot,
} from "../src/engine/stock/lots-repo.js";
import {
  insertLocation,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import { registerShopSale } from "../src/engine/world/shop-sale.js";
import { resolveEconomicsConfig } from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("shop turnover (Stage 8)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("moves stock from keeper to invisible customers when foot traffic engages", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const shop = insertLocation(localDb, {
      code: "sparks",
      displayName: "Sparks",
    });
    const keeper = insertActor(localDb, {
      code: "eric",
      displayName: "Eric",
      cash: 0,
    });
    setActorLocation(localDb, keeper.id, shop.id);
    const item = insertItemKind(localDb, {
      code: "vacuum",
      displayName: "Vacuum",
      category: "electrical",
      baseValue: 30,
    });
    const lot = insertStockLot(localDb, {
      ownerActorId: keeper.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 8,
      acquiredDay: 1,
    });

    // Heavy footfall + 100% engagement to keep the test deterministic-ish.
    const economics = resolveEconomicsConfig({
      shopSale: {
        enabled: true,
        hourlyFootfall: { 12: 30 },
        pricePerUnitFraction: 1.0, // ask retail mid
      },
      marketSale: {
        pricePerUnitFraction: 1.0,
        customerTypes: {
          all: {
            categoryInterest: { electrical: 1.5 },
            defaultCategoryInterest: 1.0,
            willingnessToPayMid: 1.5,
            willingnessToPayJitter: 0,
            savviness: 0,
            populationWeight: 1.0,
          },
        },
        hourlyFootfall: { 12: 30 },
      },
    });

    const world = new World({
      db: localDb,
      rng: createRNG("shop-yes"),
      seed: "shop-yes",
      maxDays: 1,
      startDay: 1,
      startHour: 12,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerShopSale(world, {
      shops: [
        {
          locationId: shop.id,
          keeperActorId: keeper.id,
          specialties: ["electrical"],
        },
      ],
      bidderProfiles: new Map(),
      economics,
    });
    world.start();
    world.tickOnce();

    const summary = events.find((e) => e.type === "market.hour-summary");
    expect(summary).toBeDefined();
    if (summary && summary.type === "market.hour-summary") {
      expect(summary.sellerActorId).toBe(keeper.id);
      expect(summary.atLocationId).toBe(shop.id);
      expect(summary.unitsSold).toBeGreaterThan(0);
      expect(summary.revenue).toBeGreaterThan(0);
    }

    // Keeper's stock fell, cash rose. The lot may be fully cleared
    // (row deleted) when footfall exceeds units on display — assert
    // on the *delta* rather than the surviving row.
    const remaining = getStockLotsByOwner(localDb, keeper.id);
    const remainingQty = remaining[0]?.quantity ?? 0;
    expect(remainingQty).toBeLessThan(lot.quantity);
    expect(getActorById(localDb, keeper.id)!.cash).toBeGreaterThan(0);
  });

  it("skips when the keeper isn't at the shop", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const shop = insertLocation(localDb, {
      code: "sparks",
      displayName: "Sparks",
    });
    const keeper = insertActor(localDb, {
      code: "eric",
      displayName: "Eric",
      cash: 0,
    });
    // Keeper not at the shop — currentLocationId is null.
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "V",
      category: "electrical",
      baseValue: 30,
    });
    insertStockLot(localDb, {
      ownerActorId: keeper.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 20,
      acquiredUnitPrice: 8,
      acquiredDay: 1,
    });

    const economics = resolveEconomicsConfig({
      shopSale: {
        enabled: true,
        hourlyFootfall: { 12: 30 },
        pricePerUnitFraction: 1.0,
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("absent"),
      seed: "absent",
      maxDays: 1,
      startDay: 1,
      startHour: 12,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerShopSale(world, {
      shops: [
        {
          locationId: shop.id,
          keeperActorId: keeper.id,
          specialties: ["electrical"],
        },
      ],
      bidderProfiles: new Map(),
      economics,
    });
    world.start();
    world.tickOnce();

    expect(events.filter((e) => e.type === "market.hour-summary")).toHaveLength(0);
  });
});

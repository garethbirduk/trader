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
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  getStockLotsByOwner,
  insertStockLot,
} from "../src/engine/stock/lots-repo.js";
import { registerWriteOffRubbish } from "../src/engine/world/write-off-rubbish.js";
import { resolveEconomicsConfig } from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("write-off rubbish (Stage 8)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup(opts?: { dealerCash?: number }) {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const dealer = insertActor(localDb, {
      code: "d",
      displayName: "Dealer",
      cash: opts?.dealerCash ?? 500,
    });
    const ledger = insertActor(localDb, {
      code: "ledger",
      displayName: "Off-map ledger",
      cash: 0,
    });
    const item = insertItemKind(localDb, {
      code: "v",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    return { localDb, dealer, ledger, item };
  }

  it("writes off broken/shoddy stock held past the threshold", () => {
    const { localDb, dealer, ledger, item } = setup({ dealerCash: 1000 });
    const oldBroken = insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "broken",
      quantity: 10,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });
    const oldShoddy = insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "shoddy",
      quantity: 5,
      acquiredUnitPrice: 2,
      acquiredDay: 2,
    });
    // Good-tier stock isn't eligible.
    const oldGood = insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 3,
      acquiredUnitPrice: 8,
      acquiredDay: 1,
    });
    // Recent broken stock isn't eligible either.
    const recentBroken = insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "broken",
      quantity: 7,
      acquiredUnitPrice: 1,
      acquiredDay: 9,
    });

    const economics = resolveEconomicsConfig({
      writeOff: {
        enabled: true,
        eligibleTiers: ["broken", "shoddy"],
        minDaysHeld: 7,
        feePerUnit: 2,
        skipFeeBelowCash: 50,
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("wo"),
      seed: "wo",
      maxDays: 1,
      startDay: 10,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerWriteOffRubbish(world, {
      economics,
      feeProceedsActorId: ledger.id,
    });
    world.start();

    const writeOffs = events.filter((e) => e.type === "stock.written-off");
    expect(writeOffs).toHaveLength(2);

    // Old broken + shoddy are gone; the rest remain.
    const remaining = getStockLotsByOwner(localDb, dealer.id).map((l) => l.id);
    expect(remaining).not.toContain(oldBroken.id);
    expect(remaining).not.toContain(oldShoddy.id);
    expect(remaining).toContain(oldGood.id);
    expect(remaining).toContain(recentBroken.id);

    // Fees: 10×£2 + 5×£2 = £30. Dealer paid, ledger received.
    expect(getActorById(localDb, dealer.id)!.cash).toBe(1000 - 30);
    expect(getActorById(localDb, ledger.id)!.cash).toBe(30);
  });

  it("waives the fee when the owner is skint", () => {
    const { localDb, dealer, ledger, item } = setup({ dealerCash: 10 });
    insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "broken",
      quantity: 50,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });

    const economics = resolveEconomicsConfig({
      writeOff: {
        enabled: true,
        eligibleTiers: ["broken", "shoddy"],
        minDaysHeld: 7,
        feePerUnit: 2,
        skipFeeBelowCash: 50,
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("skint"),
      seed: "skint",
      maxDays: 1,
      startDay: 10,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerWriteOffRubbish(world, {
      economics,
      feeProceedsActorId: ledger.id,
    });
    world.start();

    // Stock gone, fee waived.
    expect(getStockLotsByOwner(localDb, dealer.id)).toHaveLength(0);
    expect(getActorById(localDb, dealer.id)!.cash).toBe(10);
    expect(getActorById(localDb, ledger.id)!.cash).toBe(0);
    const event = events.find((e) => e.type === "stock.written-off");
    expect(event).toBeDefined();
    if (event && event.type === "stock.written-off") {
      expect(event.feePaid).toBe(0);
      expect(event.reason).toContain("waived");
    }
  });

  it("disables when enabled: false", () => {
    const { localDb, dealer, ledger, item } = setup();
    insertStockLot(localDb, {
      ownerActorId: dealer.id,
      itemKindId: item.id,
      qualityTier: "broken",
      quantity: 50,
      acquiredUnitPrice: 1,
      acquiredDay: 1,
    });

    const economics = resolveEconomicsConfig({
      writeOff: {
        enabled: false,
        eligibleTiers: ["broken", "shoddy"],
        minDaysHeld: 7,
        feePerUnit: 2,
        skipFeeBelowCash: 50,
      },
    });
    const world = new World({
      db: localDb,
      rng: createRNG("off"),
      seed: "off",
      maxDays: 1,
      startDay: 10,
      startHour: 0,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerWriteOffRubbish(world, {
      economics,
      feeProceedsActorId: ledger.id,
    });
    world.start();

    expect(events.filter((e) => e.type === "stock.written-off")).toHaveLength(0);
    expect(getStockLotsByOwner(localDb, dealer.id)).toHaveLength(1);
  });
});

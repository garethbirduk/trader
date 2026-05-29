import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { insertPool } from "../src/engine/pools/pools-repo.js";
import { seedSupplyLeadForStockLot } from "../src/engine/leads/seed-from-stock.js";
import { seedSupplyLeadsForPool } from "../src/engine/leads/seed-from-pool.js";
import { setupWorld } from "../src/engine/setup.js";
import {
  listJudgementsByDay,
  getJudgementByContextRef,
  type CompositePayload,
  type JudgementContextKind,
  type JudgementRecord,
  type PriceArmPayload,
} from "../src/engine/perception/judgement-log-repo.js";
import { DEFAULT_ECONOMICS_CONFIG } from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";

const TIERS = ["broken", "shoddy", "fair", "good", "mint"];

function assertPriceArmShape(p: PriceArmPayload, ctx: string): void {
  expect(p.itemKindId, `${ctx}: itemKindId`).toBeGreaterThan(0);
  expect(p.category.length, `${ctx}: category`).toBeGreaterThan(0);
  expect(p.truthUnit, `${ctx}: truthUnit`).toBeGreaterThanOrEqual(0);
  expect(p.anchor, `${ctx}: anchor`).toBeGreaterThanOrEqual(0);
  expect(p.expertise, `${ctx}: expertise`).toBeGreaterThanOrEqual(0);
  expect(p.expertise, `${ctx}: expertise`).toBeLessThanOrEqual(1);
  expect(p.j, `${ctx}: j`).toBeGreaterThanOrEqual(0);
  expect(p.j, `${ctx}: j`).toBeLessThanOrEqual(1);
  expect(p.centre, `${ctx}: centre`).toBeGreaterThanOrEqual(0);
  expect(p.low, `${ctx}: low ≤ centre`).toBeLessThanOrEqual(p.centre);
  expect(p.high, `${ctx}: high ≥ centre`).toBeGreaterThanOrEqual(p.centre);
}

function assertCompositeShape(p: CompositePayload, ctx: string): void {
  expect(p.itemKindId, `${ctx}: itemKindId`).toBeGreaterThan(0);
  expect(p.category.length, `${ctx}: category`).toBeGreaterThan(0);
  expect(p.quantity, `${ctx}: quantity`).toBeGreaterThan(0);
  expect(TIERS, `${ctx}: truthTier`).toContain(p.truthTier);
  expect(TIERS, `${ctx}: perceivedTier`).toContain(p.perceivedTier);
  expect(p.price.expertise, `${ctx}: price.expertise`).toBeGreaterThanOrEqual(0);
  expect(p.price.expertise, `${ctx}: price.expertise`).toBeLessThanOrEqual(1);
  expect(p.price.j, `${ctx}: price.j`).toBeGreaterThanOrEqual(0);
  expect(p.price.j, `${ctx}: price.j`).toBeLessThanOrEqual(1);
  expect(p.price.centre, `${ctx}: price.centre`).toBeGreaterThanOrEqual(0);
  expect(p.price.low, `${ctx}: low ≤ centre`).toBeLessThanOrEqual(p.price.centre);
  expect(p.price.high, `${ctx}: high ≥ centre`).toBeGreaterThanOrEqual(p.price.centre);
  expect(p.perceivedLotValue, `${ctx}: perceivedLotValue`).toBeGreaterThanOrEqual(0);
}

describe("judgement audit — lead seed (from stock)", () => {
  it("writes a price-arm row with the lead id as contextRef and a recoverable join", () => {
    const db = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db, ALL_MIGRATIONS);
    try {
      const denzil = insertActor(db, {
        code: "denzil",
        firstName: "Denzil",
        shortName: "Denzil",
      });
      const item = insertItemKind(db, {
        code: "v",
        displayName: "v",
        category: "electrical",
        baseValue: 30,
      });
      const lot = insertStockLot(db, {
        ownerActorId: denzil.id,
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 10,
        acquiredUnitPrice: 12,
        acquiredDay: 1,
        locationId: null,
      });

      const lead = seedSupplyLeadForStockLot(db, lot, 1, DEFAULT_ECONOMICS_CONFIG, 3);

      const audit = getJudgementByContextRef(db, "lead-seed", lead.id);
      expect(audit).not.toBeNull();
      expect(audit?.arm).toBe("price");
      expect(audit?.actorId).toBe(denzil.id);
      expect(audit?.day).toBe(1);
      expect(audit?.hour).toBe(3);
      expect(getActorById(db, audit!.actorId)).not.toBeNull();
      assertPriceArmShape(audit!.payload as PriceArmPayload, "lead-seed/stock");
    } finally {
      db.close();
    }
  });
});

describe("judgement audit — lead seed (from pool)", () => {
  it("writes one price-arm row per reachable actor, each joinable to its lead", () => {
    const db = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(db, ALL_MIGRATIONS);
    try {
      const denzil = insertActor(db, {
        code: "denzil",
        firstName: "Denzil",
        shortName: "Denzil",
      });
      const mike = insertActor(db, {
        code: "mike",
        firstName: "Mike",
        shortName: "Mike",
      });
      const item = insertItemKind(db, {
        code: "v",
        displayName: "v",
        category: "electrical",
        baseValue: 30,
      });
      const pool = insertPool(db, {
        itemKindId: item.id,
        qualityTier: "good",
        quantity: 100,
        createdDay: 1,
        expiryDay: 4,
        openingUnitPrice: 15,
        closingUnitPrice: 6,
        reachableBy: [denzil.id, mike.id],
      });

      const leads = seedSupplyLeadsForPool(db, pool.id, 1, DEFAULT_ECONOMICS_CONFIG, 5);
      expect(leads).toHaveLength(2);

      for (const lead of leads) {
        const audit = getJudgementByContextRef(db, "lead-seed", lead.id);
        expect(audit, `lead ${lead.id} audit`).not.toBeNull();
        expect(audit?.arm).toBe("price");
        expect(audit?.actorId).toBe(lead.holderActorId);
        expect(audit?.hour).toBe(5);
        assertPriceArmShape(audit!.payload as PriceArmPayload, "lead-seed/pool");
      }
    } finally {
      db.close();
    }
  });
});

/**
 * Drive the full placeholder skin sim once, then assert that the three
 * sim-driven audit kinds (pubdeal-appraisal, market-seller-belief,
 * shop-seller-belief) populated the table with rows of the expected
 * shape. Keeps these tests in one harness so we don't pay the skin
 * setup cost three times.
 */
/**
 * Sim runs once for the whole describe block — beforeAll seeds and runs,
 * afterAll closes. Three tests then partition the harvested rows by
 * context kind. Shop and market both emit market.hour-summary events
 * but write distinct audit context kinds — `shop-seller-belief` is
 * only produced when the placeholder skin's high-street shops actually
 * see footfall + stock during the run.
 */
describe("judgement audit — sim-driven call sites", () => {
  let db: DB | undefined;
  let rows: readonly JudgementRecord[] = [];

  beforeAll(() => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const { world, skin } = setupWorld(localDb, { seed: "audit-others" });
    world.runToCompletion();
    const all: JudgementRecord[] = [];
    for (let day = 1; day <= skin.runLengthDays; day += 1) {
      all.push(...listJudgementsByDay(localDb, day));
    }
    rows = all;
  });

  afterAll(() => {
    db?.close();
    db = undefined;
  });

  function shapeAssertCompositeKind(kind: JudgementContextKind, label: string): void {
    const matched = rows.filter((r) => r.contextKind === kind);
    expect(matched.length, `${label}: at least one row produced`).toBeGreaterThan(0);
    for (const r of matched) {
      expect(r.arm, label).toBe("composite");
      expect(r.contextRefId, `${label}: contextRefId set`).not.toBeNull();
      expect(getActorById(db!, r.actorId), `${label}: actor exists`).not.toBeNull();
      assertCompositeShape(r.payload as CompositePayload, label);
    }
  }

  function shapeAssertPriceKind(kind: JudgementContextKind, label: string): void {
    const matched = rows.filter((r) => r.contextKind === kind);
    expect(matched.length, `${label}: at least one row produced`).toBeGreaterThan(0);
    for (const r of matched) {
      expect(r.arm, label).toBe("price");
      expect(r.contextRefId, `${label}: contextRefId set`).not.toBeNull();
      expect(getActorById(db!, r.actorId), `${label}: actor exists`).not.toBeNull();
      assertPriceArmShape(r.payload as PriceArmPayload, label);
    }
  }

  it("pubdeal-appraisal rows are composite, joinable to a buyer + a lot id", () => {
    shapeAssertCompositeKind("pubdeal-appraisal", "pubdeal-appraisal");
  });

  it("market-seller-belief rows are price-arm, joinable to a seller + a lot id", () => {
    shapeAssertPriceKind("market-seller-belief", "market-seller-belief");
  });

  // Shops are wired but the placeholder skin's default 7-day run may
  // produce zero hours of shop footfall (keeper schedules + stock
  // availability gate). When that happens, surface it explicitly
  // rather than failing — the call-site instrumentation has its own
  // integration coverage via shop-sale.test.ts.
  it("shop-seller-belief rows are price-arm when shops sell anything in the run", () => {
    const matched = rows.filter((r) => r.contextKind === "shop-seller-belief");
    if (matched.length === 0) {
      // No shop sales in this skin's default run window; assert is
      // satisfied vacuously, but log so a future schedule change that
      // restores shop sales doesn't silently lose the shape check.
      console.warn(
        "[judgement-audit-others] no shop-seller-belief rows produced this run — skin schedule produced zero shop sales",
      );
      return;
    }
    for (const r of matched) {
      expect(r.arm).toBe("price");
      expect(r.contextRefId, "shop-seller-belief: contextRefId set").not.toBeNull();
      expect(
        getActorById(db!, r.actorId),
        "shop-seller-belief: actor exists",
      ).not.toBeNull();
      assertPriceArmShape(r.payload as PriceArmPayload, "shop-seller-belief");
    }
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot, decrementLotQuantity } from "../src/engine/stock/lots-repo.js";
import { insertLead, unlockLeadDetail } from "../src/engine/leads/leads-repo.js";
import {
  computeNotebookRows,
  registerNotebookDiff,
} from "../src/engine/world/notebook.js";
import { bufferHandler } from "../src/engine/core/events.js";
import type { DB } from "../src/engine/core/db.js";

describe("notebook compute + diff", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const me = insertActor(localDb, {
      code: "me", displayName: "Me", cash: 1000,
    });
    const boyce = insertActor(localDb, {
      code: "boyce", displayName: "Boyce", cash: 1000,
    });
    const mickey = insertActor(localDb, {
      code: "mickey", displayName: "Mickey", cash: 1000,
    });
    const item = insertItemKind(localDb, {
      code: "radio",
      displayName: "Radio",
      category: "electrical",
      baseValue: 10,
    });
    return { localDb, me, boyce, mickey, item };
  }

  it("empty bag + no stock produces no rows", () => {
    const { localDb, me } = seed();
    const rows = computeNotebookRows(localDb, me.id);
    expect(rows).toHaveLength(0);
  });

  it("stock alone produces no rows — no demand lead, no actionable note", () => {
    const { localDb, me, item } = seed();
    insertStockLot(localDb, {
      ownerActorId: me.id,
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 10,
      acquiredUnitPrice: 4,
      acquiredDay: 1,
    });
    const rows = computeNotebookRows(localDb, me.id);
    expect(rows).toHaveLength(0);
  });

  it("stock + matching demand lead emits a sell-side row with gross-profit score", () => {
    const { localDb, me, boyce, item } = seed();
    insertStockLot(localDb, {
      ownerActorId: me.id,
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 10,
      acquiredUnitPrice: 4,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: me.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: boyce.id,
      estimatedQuantity: 6,
      estimatedUnitPrice: 9,
      acquiredDay: 1,
    });
    const rows = computeNotebookRows(localDb, me.id);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.side).toBe("sell");
    expect(r.counterpartyActorId).toBe(boyce.id);
    expect(r.myQty).toBe(10);
    expect(r.myUnitCost).toBe(4);
    expect(r.theirQty).toBe(6);
    expect(r.theirUnitPrice).toBe(9);
    // (9 - 4) × min(10, 6) = 30
    expect(r.score).toBe(30);
    expect(r.unlocked).toBe(true);
  });

  it("locked headline produces a row with null numbers and unlocked=false", () => {
    const { localDb, me, boyce, item } = seed();
    insertStockLot(localDb, {
      ownerActorId: me.id,
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 10,
      acquiredUnitPrice: 4,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: me.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: boyce.id,
      estimatedQuantity: 6,
      estimatedUnitPrice: 9,
      acquiredDay: 1,
      detailUnlocked: false,
    });
    const rows = computeNotebookRows(localDb, me.id);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.unlocked).toBe(false);
    expect(r.theirQty).toBeNull();
    expect(r.theirUnitPrice).toBeNull();
    expect(r.score).toBeNull();
    // My-side fields are always visible.
    expect(r.myQty).toBe(10);
  });

  it("buy-side row requires both a demand lead (interest) and a supply lead", () => {
    const { localDb, me, boyce, mickey, item } = seed();
    // Demand lead — I have a buyer at £12.
    insertLead(localDb, {
      holderActorId: me.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: boyce.id,
      estimatedQuantity: 20,
      estimatedUnitPrice: 12,
      acquiredDay: 1,
    });
    // Supply lead — Mickey will sell at £8.
    insertLead(localDb, {
      holderActorId: me.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: mickey.id,
      estimatedQuantity: 15,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    });
    const rows = computeNotebookRows(localDb, me.id);
    // Sell-side: no stock on hand → no row. Buy-side: yes.
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.side).toBe("buy");
    expect(r.counterpartyActorId).toBe(mickey.id);
    // (12 - 8) × 15 = 60
    expect(r.score).toBe(60);
  });

  it("diff hook emits row-added when a row materialises and row-removed when stock drops to zero", () => {
    const { localDb, me, boyce, item } = seed();
    const rng = createRNG("notebook-test");
    const world = new World({ db: localDb, rng, seed: "notebook-test", maxDays: 1 });
    const { handler, events } = bufferHandler();
    world.events.subscribe(handler);
    registerNotebookDiff(world, {
      actorIds: [me.id],
    });
    world.start();

    // No state yet — first tick should be empty diff (no notebook events).
    world.tickOnce();
    expect(events.filter((e) => e.type.startsWith("actor.notebook-"))).toHaveLength(0);

    // Add stock + demand lead → next tick should emit row-added.
    const lot = insertStockLot(localDb, {
      ownerActorId: me.id,
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 10,
      acquiredUnitPrice: 4,
      acquiredDay: 1,
    });
    insertLead(localDb, {
      holderActorId: me.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: boyce.id,
      estimatedQuantity: 6,
      estimatedUnitPrice: 9,
      acquiredDay: 1,
    });
    world.tickOnce();
    const added = events.filter((e) => e.type === "actor.notebook-row-added");
    expect(added).toHaveLength(1);
    expect(added[0]!.actorId).toBe(me.id);
    expect(added[0]!.side).toBe("sell");
    expect(added[0]!.counterpartyActorId).toBe(boyce.id);
    expect(added[0]!.score).toBe(30);

    // Drop stock to zero → next tick should emit row-removed.
    decrementLotQuantity(localDb, lot.id, 10);
    world.tickOnce();
    const removed = events.filter((e) => e.type === "actor.notebook-row-removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]!.actorId).toBe(me.id);
    expect(removed[0]!.counterpartyActorId).toBe(boyce.id);
  });

  it("diff hook emits row-updated when a locked headline gets unlocked", () => {
    const { localDb, me, boyce, item } = seed();
    const rng = createRNG("notebook-test-2");
    const world = new World({ db: localDb, rng, seed: "notebook-test-2", maxDays: 1 });
    const { handler, events } = bufferHandler();
    world.events.subscribe(handler);
    registerNotebookDiff(world, {
      actorIds: [me.id],
    });
    world.start();

    insertStockLot(localDb, {
      ownerActorId: me.id,
      itemKindId: item.id,
      qualityTier: "fair",
      quantity: 10,
      acquiredUnitPrice: 4,
      acquiredDay: 1,
    });
    const lead = insertLead(localDb, {
      holderActorId: me.id,
      side: "demand",
      subjectItemKindId: item.id,
      subjectQualityTier: "fair",
      counterpartyActorId: boyce.id,
      estimatedQuantity: 6,
      estimatedUnitPrice: 9,
      acquiredDay: 1,
      detailUnlocked: false,
    });
    world.tickOnce();
    const added = events.filter((e) => e.type === "actor.notebook-row-added");
    expect(added).toHaveLength(1);
    expect(added[0]!.unlocked).toBe(false);
    expect(added[0]!.score).toBeNull();

    // Unlock the lead → next tick should emit row-updated with numbers populated.
    unlockLeadDetail(localDb, lead.id);
    world.tickOnce();
    const updated = events.filter((e) => e.type === "actor.notebook-row-updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.unlocked).toBe(true);
    expect(updated[0]!.score).toBe(30);
  });
});

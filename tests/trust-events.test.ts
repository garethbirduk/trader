import { describe, it, expect, afterEach } from "vitest";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { createRNG } from "../src/engine/core/rng.js";
import { World } from "../src/engine/core/world.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { registerTrustReactions } from "../src/engine/world/trust-reactions.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("trust.adjusted events", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const buyer = insertActor(localDb, { code: "b", displayName: "B", cash: 0 });
    const seller = insertActor(localDb, { code: "s", displayName: "S", cash: 0 });
    return { localDb, buyer, seller };
  }

  it("settled deal emits two symmetric trust.adjusted events", () => {
    const { localDb, buyer, seller } = setup();
    const world = new World({
      db: localDb,
      rng: createRNG("t1"),
      seed: "t1",
      maxDays: 1,
      startDay: 1,
      startHour: 10,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerTrustReactions(world);
    world.start();

    world.events.emit({
      type: "deal.settled",
      at: world.clock,
      dealId: 42,
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      totalPrice: 100,
    });

    const adjusted = events.filter(
      (e): e is Extract<WorldEvent, { type: "trust.adjusted" }> =>
        e.type === "trust.adjusted",
    );
    expect(adjusted).toHaveLength(2);
    // Both deltas positive on settle.
    expect(adjusted.every((e) => e.delta > 0)).toBe(true);
    // One holder=buyer/target=seller, the other reversed.
    const directions = adjusted.map(
      (e) => `${e.holderActorId}->${e.targetActorId}`,
    );
    expect(directions).toContain(`${buyer.id}->${seller.id}`);
    expect(directions).toContain(`${seller.id}->${buyer.id}`);
    expect(adjusted[0]!.reason).toBe("settled");
    expect(adjusted[0]!.dealId).toBe(42);
  });

  it("defaulted deal emits one trust.adjusted event (wronged party only)", () => {
    const { localDb, buyer, seller } = setup();
    const world = new World({
      db: localDb,
      rng: createRNG("t2"),
      seed: "t2",
      maxDays: 1,
      startDay: 1,
      startHour: 10,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));
    registerTrustReactions(world);
    world.start();

    world.events.emit({
      type: "deal.defaulted",
      at: world.clock,
      dealId: 7,
      buyerActorId: buyer.id,
      sellerActorId: seller.id,
      reason: "no stock",
    });

    const adjusted = events.filter(
      (e): e is Extract<WorldEvent, { type: "trust.adjusted" }> =>
        e.type === "trust.adjusted",
    );
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]!.holderActorId).toBe(buyer.id);
    expect(adjusted[0]!.targetActorId).toBe(seller.id);
    expect(adjusted[0]!.delta).toBeLessThan(0);
    expect(adjusted[0]!.reason).toBe("defaulted");
    expect(adjusted[0]!.dealId).toBe(7);
  });
});

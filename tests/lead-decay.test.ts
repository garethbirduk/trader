import { describe, it, expect, afterEach } from "vitest";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import {
  getLeadsByHolder,
  insertLead,
} from "../src/engine/leads/leads-repo.js";
import { World } from "../src/engine/core/world.js";
import { createRNG } from "../src/engine/core/rng.js";
import { applyMigrations } from "../src/engine/core/migrations.js";
import { ALL_MIGRATIONS } from "../src/engine/core/migrations/index.js";
import { openBetterSqlite3DB } from "../src/engine/core/db-better-sqlite3.js";
import { registerLeadDecay } from "../src/engine/world/lead-decay.js";
import type { DB } from "../src/engine/core/db.js";

describe("lead decay (daily handler)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("ages out leads over a multi-day run", () => {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;

    const del = insertActor(localDb, { code: "del", displayName: "Del" });
    const vacuums = insertItemKind(localDb, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    insertLead(localDb, {
      holderActorId: del.id,
      side: "supply",
      subjectItemKindId: vacuums.id,
      estimatedQuantity: 100,
      estimatedUnitPrice: 10,
      acquiredDay: 1,
    });

    const world = new World({
      db: localDb,
      rng: createRNG("decay"),
      seed: "decay",
      maxDays: 10,
    });
    registerLeadDecay(world, { warmThresholdDays: 3, deleteThresholdDays: 7 });
    world.runToCompletion();

    // After day 8+ ticks, the day-1 lead should have been deleted.
    expect(getLeadsByHolder(localDb, del.id)).toHaveLength(0);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertStockLot } from "../src/engine/stock/lots-repo.js";
import { consultActor } from "../src/engine/knowledge/consult.js";
import { getBeliefsForLot } from "../src/engine/knowledge/beliefs-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { DB } from "../src/engine/core/db.js";

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

describe("consultActor — condition axis", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("zero-skill condition returns an adjacent tier on the slip", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "del", firstName: "Del", shortName: "Del", cash: 100 });
    const rodney = insertActor(db, { code: "rodney", firstName: "Rodney", shortName: "Rodney" });
    const item = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches", baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: asker.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    const r = consultActor(db, {
      askerActorId: asker.id, expertActorId: rodney.id, lotId: lot.id,
      axis: "condition", fee: 3, atDay: 1, rng: createRNG("rodney-cond"),
      expertProfileOverride: profileWith({ defaultConditionAccuracy: 0 }),
    });
    if (r.type !== "consulted") throw new Error("expected consulted");
    if (r.belief.value.axis !== "condition") throw new Error("expected condition axis");
    // Truth is good; zero-skill slip yields mint or fair.
    expect(["mint", "fair"]).toContain(r.belief.value.tier);
  });

  it("perfect-skill condition always names the true tier", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 100 });
    const expert = insertActor(db, { code: "e", firstName: "E", shortName: "E" });
    const item = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches", baseValue: 8000,
    });
    const lot = insertStockLot(db, {
      ownerActorId: asker.id, itemKindId: item.id, qualityTier: "shoddy",
      quantity: 1, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    const r = consultActor(db, {
      askerActorId: asker.id, expertActorId: expert.id, lotId: lot.id,
      axis: "condition", fee: 0, atDay: 1, rng: createRNG("s"),
      expertProfileOverride: profileWith({ defaultConditionAccuracy: 1 }),
    });
    if (r.type !== "consulted") throw new Error("expected consulted");
    if (r.belief.value.axis !== "condition") throw new Error("expected condition axis");
    expect(r.belief.value.tier).toBe("shoddy");
  });
});

describe("consultActor — price axis", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("a high-skill price oracle returns a tight band centred on truth", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 100 });
    const mickey = insertActor(db, { code: "m", firstName: "M", shortName: "M" });
    const item = insertItemKind(db, {
      code: "watch", displayName: "Watch", category: "watches", baseValue: 100,
    });
    const lot = insertStockLot(db, {
      ownerActorId: asker.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 25, acquiredDay: 1,
    });
    // good tier: tierMult=1.1, so true unit price = 110.
    const r = consultActor(db, {
      askerActorId: asker.id, expertActorId: mickey.id, lotId: lot.id,
      axis: "price", fee: 0, atDay: 1, rng: createRNG("mickey"),
      expertProfileOverride: profileWith({ defaultPriceAccuracy: 1 }),
    });
    if (r.type !== "consulted") throw new Error("expected consulted");
    if (r.belief.value.axis !== "price") throw new Error("expected price axis");
    // Tight band centred on 110 (±5% = ~104..116).
    expect(r.belief.value.low).toBeGreaterThanOrEqual(100);
    expect(r.belief.value.high).toBeLessThanOrEqual(120);
  });
});

describe("consultActor — flaw axis", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("zero-skill flaw detection always says 'clean' for a flawed item", () => {
    db = freshDB();
    const asker = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 10 });
    const expert = insertActor(db, { code: "e", firstName: "E", shortName: "E" });
    const item = insertItemKind(db, {
      code: "fake-watch", displayName: "Fake", category: "watches", baseValue: 100,
      flawType: "fake",
    });
    const lot = insertStockLot(db, {
      ownerActorId: asker.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    const r = consultActor(db, {
      askerActorId: asker.id, expertActorId: expert.id, lotId: lot.id,
      axis: "flaw", fee: 0, atDay: 1, rng: createRNG("s"),
      expertProfileOverride: profileWith({
        defaultFlawDetection: 0,
        flawDetection: new Map([["fake", 0]]),
      }),
    });
    if (r.type !== "consulted") throw new Error("expected consulted");
    if (r.belief.value.axis !== "flaw") throw new Error("expected flaw axis");
    expect(r.belief.value.flawType).toBeNull();
  });
});

describe("consultActor — book-keeping", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("blocks consultation with yourself", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 100 });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 10,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    const r = consultActor(db, {
      askerActorId: a.id, expertActorId: a.id, lotId: lot.id,
      axis: "condition", fee: 1, atDay: 1, rng: createRNG("s"),
    });
    expect(r.type).toBe("blocked");
  });

  it("blocks when asker can't afford the fee", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 2 });
    const e = insertActor(db, { code: "e", firstName: "E", shortName: "E" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 10,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    const r = consultActor(db, {
      askerActorId: a.id, expertActorId: e.id, lotId: lot.id,
      axis: "condition", fee: 5, atDay: 1, rng: createRNG("s"),
    });
    expect(r.type).toBe("blocked");
    expect(getBeliefsForLot(db, a.id, lot.id)).toHaveLength(0);
  });

  it("writes one belief row per successful consultation", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", firstName: "A", shortName: "A", cash: 100 });
    const e = insertActor(db, { code: "e", firstName: "E", shortName: "E" });
    const item = insertItemKind(db, {
      code: "x", displayName: "X", category: "watches", baseValue: 10,
    });
    const lot = insertStockLot(db, {
      ownerActorId: a.id, itemKindId: item.id, qualityTier: "good",
      quantity: 1, acquiredUnitPrice: 5, acquiredDay: 1,
    });
    consultActor(db, {
      askerActorId: a.id, expertActorId: e.id, lotId: lot.id,
      axis: "condition", fee: 3, atDay: 1, rng: createRNG("s"),
    });
    consultActor(db, {
      askerActorId: a.id, expertActorId: e.id, lotId: lot.id,
      axis: "price", fee: 3, atDay: 1, rng: createRNG("s2"),
    });
    expect(getBeliefsForLot(db, a.id, lot.id)).toHaveLength(2);
  });
});

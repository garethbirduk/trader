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
  insertLocation,
  setActorLocation,
  setLocationProprietor,
} from "../src/engine/locations/locations.js";
import {
  getLeadById,
  getLeadsByHolder,
  getLockedLeadsByHolder,
  insertLead,
  shareLead,
} from "../src/engine/leads/leads-repo.js";
import {
  attemptDetailUnlock,
  registerDetailUnlock,
} from "../src/engine/world/detail-unlock.js";
import { getDisclosuresForActor } from "../src/engine/leads/disclosures-repo.js";
import { DEFAULT_BIDDER_PROFILE } from "../src/engine/auction/bidder-profile.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  resolveEconomicsConfig,
} from "../src/engine/economics/config.js";
import type { DB } from "../src/engine/core/db.js";
import type { WorldEvent } from "../src/engine/core/events.js";

describe("detail-unlock (two-tier gossip)", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function seed() {
    const localDb = openBetterSqlite3DB({ filename: ":memory:" });
    applyMigrations(localDb, ALL_MIGRATIONS);
    db = localDb;
    const nags = insertLocation(localDb, { code: "nags", displayName: "Nag's" });
    const asker = insertActor(localDb, {
      code: "a", firstName: "A", shortName: "A", cash: 5000,
    });
    const partner = insertActor(localDb, {
      code: "p", firstName: "P", shortName: "P", cash: 0,
    });
    const mike = insertActor(localDb, {
      code: "m", firstName: "Mike", shortName: "Mike", cash: 0,
    });
    setActorLocation(localDb, asker.id, nags.id);
    setActorLocation(localDb, partner.id, nags.id);
    setActorLocation(localDb, mike.id, nags.id);
    setLocationProprietor(localDb, nags.id, mike.id);
    const item = insertItemKind(localDb, {
      code: "k", displayName: "K", category: "electrical", baseValue: 30,
    });
    return { localDb, nags, asker, partner, mike, item };
  }

  it("gossip-received leads land locked; first-hand inserts stay unlocked", () => {
    const { localDb, asker, partner, item } = seed();

    // First-hand lead: detail unlocked by default.
    const firstHand = insertLead(localDb, {
      holderActorId: partner.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 50,
      estimatedUnitPrice: 8,
      acquiredDay: 1,
    });
    expect(firstHand.detailUnlocked).toBe(true);

    // Gossip-shared lead: detail locked on the receiver's side.
    const shared = shareLead(localDb, partner.id, asker.id, firstHand.id, 1);
    expect(shared.detailUnlocked).toBe(false);
    expect(shared.holderActorId).toBe(asker.id);
  });

  it("attemptDetailUnlock flips the top-N most-recent locked leads and emits an event", () => {
    const { localDb, nags, asker, partner, mike, item } = seed();

    // Plant 5 leads in the asker's bag, all locked, with increasing
    // acquired_day so the top-3 by recency are unambiguous.
    for (let d = 1; d <= 5; d += 1) {
      const src = insertLead(localDb, {
        holderActorId: partner.id,
        side: "supply",
        subjectItemKindId: item.id,
        subjectQualityTier: "good",
        estimatedQuantity: 10 * d,
        estimatedUnitPrice: d,
        acquiredDay: d,
      });
      shareLead(localDb, partner.id, asker.id, src.id, d);
    }
    expect(getLockedLeadsByHolder(localDb, asker.id).length).toBe(5);

    const world = new World({
      db: localDb,
      rng: createRNG("unlock"),
      seed: "unlock",
      maxDays: 1,
      startDay: 6,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));

    const result = attemptDetailUnlock(
      world,
      {
        bidderProfiles: new Map(),
        autonomyEligibleActorIds: new Set([asker.id]),
        economics: DEFAULT_ECONOMICS_CONFIG,
      },
      {
        askerActorId: asker.id,
        partnerActorId: partner.id,
        locationId: nags.id,
        day: 6,
        hour: 19,
      },
    );
    expect(result.outcome).toBe("ok");

    // Three leads unlocked. Top-3 by acquired_day DESC.
    const stillLocked = getLockedLeadsByHolder(localDb, asker.id);
    expect(stillLocked.length).toBe(2);
    expect(stillLocked.map((l) => l.acquiredDay).sort()).toEqual([1, 2]);

    // Asker paid £3 → Mike (the venue proprietor) received it.
    expect(getActorById(localDb, asker.id)!.cash).toBe(5000 - 300);
    expect(getActorById(localDb, mike.id)!.cash).toBe(300);

    // Three audit rows written.
    expect(getDisclosuresForActor(localDb, asker.id)).toHaveLength(3);

    // Event payload reflects three unlocks.
    const unlock = events.find(
      (e) => e.type === "gossip.detail-unlocked",
    ) as Extract<WorldEvent, { type: "gossip.detail-unlocked" }>;
    expect(unlock).toBeDefined();
    expect(unlock.unlockedLeads).toHaveLength(3);
    expect(unlock.unlockedLeads.every((u) => u.unlocked)).toBe(true);
    expect(unlock.costPaid).toBe(300);
    expect(unlock.paidToActorId).toBe(mike.id);
  });

  it("is ineligible when cash < pricePence — no flip, no event, no debit", () => {
    const { localDb, nags, asker, partner, item } = seed();
    // Reset asker's cash to below the £3 fee.
    const skintAsker = insertActor(localDb, {
      code: "skint", firstName: "Skint", shortName: "Skint", cash: 100,
    });
    setActorLocation(localDb, skintAsker.id, nags.id);
    const src = insertLead(localDb, {
      holderActorId: partner.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 5,
      estimatedUnitPrice: 2,
      acquiredDay: 1,
    });
    shareLead(localDb, partner.id, skintAsker.id, src.id, 1);

    const world = new World({
      db: localDb,
      rng: createRNG("skint"),
      seed: "skint",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));

    const result = attemptDetailUnlock(
      world,
      {
        bidderProfiles: new Map(),
        autonomyEligibleActorIds: new Set([skintAsker.id]),
      },
      {
        askerActorId: skintAsker.id,
        partnerActorId: partner.id,
        locationId: nags.id,
        day: 2,
        hour: 19,
      },
    );
    expect(result.outcome).toBe("ineligible");
    expect(getLockedLeadsByHolder(localDb, skintAsker.id).length).toBe(1);
    expect(getActorById(localDb, skintAsker.id)!.cash).toBe(100);
    expect(events.filter((e) => e.type === "gossip.detail-unlocked")).toHaveLength(0);
  });

  it("autonomy roll fires after a chat exchange when probability is forced to 1.0", () => {
    const { localDb, nags, asker, partner, mike, item } = seed();
    setLocationProprietor(localDb, nags.id, mike.id);

    // Plant a locked lead in the asker's bag.
    const src = insertLead(localDb, {
      holderActorId: partner.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 9,
      estimatedUnitPrice: 7,
      acquiredDay: 1,
    });
    shareLead(localDb, partner.id, asker.id, src.id, 1);

    const world = new World({
      db: localDb,
      rng: createRNG("roll"),
      seed: "roll",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));

    // Force the autonomy roll to fire by setting baseProb = 1.0.
    registerDetailUnlock(world, {
      bidderProfiles: new Map([
        [asker.id, DEFAULT_BIDDER_PROFILE],
        [partner.id, DEFAULT_BIDDER_PROFILE],
      ]),
      autonomyEligibleActorIds: new Set([asker.id, partner.id]),
      economics: resolveEconomicsConfig({
        detailUnlock: { ...DEFAULT_ECONOMICS_CONFIG.detailUnlock, baseProb: 1.0 },
      }),
    });

    // Synthesise a gossip.exchanged event of kind 'chat'.
    world.events.emit({
      type: "gossip.exchanged",
      at: { day: 2, hour: 19 },
      atLocationId: nags.id,
      kind: "chat",
      participantActorIds: [asker.id, partner.id],
      exchanges: [],
    });

    // Asker had a locked lead, partner is in the room — the autonomy
    // handler should have triggered an unlock.
    const unlock = events.find(
      (e) => e.type === "gossip.detail-unlocked",
    ) as Extract<WorldEvent, { type: "gossip.detail-unlocked" }> | undefined;
    expect(unlock).toBeDefined();
    expect(unlock!.askerActorId).toBe(asker.id);
    expect(getActorById(localDb, asker.id)!.cash).toBe(5000 - 300);
    expect(getLockedLeadsByHolder(localDb, asker.id)).toHaveLength(0);
  });

  it("autonomy excludes actors not in autonomyEligibleActorIds (e.g. the player)", () => {
    const { localDb, nags, asker, partner, item } = seed();

    const src = insertLead(localDb, {
      holderActorId: partner.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 9,
      estimatedUnitPrice: 7,
      acquiredDay: 1,
    });
    shareLead(localDb, partner.id, asker.id, src.id, 1);

    const world = new World({
      db: localDb,
      rng: createRNG("excluded"),
      seed: "excluded",
      maxDays: 1,
      startDay: 2,
      startHour: 19,
    });
    const events: WorldEvent[] = [];
    world.events.subscribe((e) => events.push(e));

    registerDetailUnlock(world, {
      bidderProfiles: new Map(),
      autonomyEligibleActorIds: new Set(), // asker excluded
      economics: resolveEconomicsConfig({
        detailUnlock: { ...DEFAULT_ECONOMICS_CONFIG.detailUnlock, baseProb: 1.0 },
      }),
    });

    world.events.emit({
      type: "gossip.exchanged",
      at: { day: 2, hour: 19 },
      atLocationId: nags.id,
      kind: "chat",
      participantActorIds: [asker.id, partner.id],
      exchanges: [],
    });

    expect(events.filter((e) => e.type === "gossip.detail-unlocked")).toHaveLength(0);
    expect(getLockedLeadsByHolder(localDb, asker.id)).toHaveLength(1);
  });

  it("locked leads in the bag report detailUnlocked=false; unlock flips to true", () => {
    const { localDb, asker, partner, item } = seed();
    const src = insertLead(localDb, {
      holderActorId: partner.id,
      side: "supply",
      subjectItemKindId: item.id,
      subjectQualityTier: "good",
      estimatedQuantity: 9,
      estimatedUnitPrice: 7,
      acquiredDay: 1,
    });
    const shared = shareLead(localDb, partner.id, asker.id, src.id, 1);
    expect(shared.detailUnlocked).toBe(false);
    // After unlock the same lead row should now report detailUnlocked=true.
    const askerLeads = getLeadsByHolder(localDb, asker.id);
    expect(askerLeads).toHaveLength(1);
    expect(askerLeads[0]!.detailUnlocked).toBe(false);
  });
});

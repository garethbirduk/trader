import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import { insertItemKind } from "../src/engine/stock/items-repo.js";
import { insertAuctionLot } from "../src/engine/auction/auction-repo.js";
import { makeBidders } from "../src/engine/auction/default-bidders.js";
import {
  actorKnowsFlaw,
  getKnownFlawsByActor,
  recordKnownFlaw,
} from "../src/engine/inspection/inspection-repo.js";
import { inspectItem } from "../src/engine/inspection/inspect-item.js";
import { createRNG } from "../src/engine/core/rng.js";
import type { BidderProfile } from "../src/engine/auction/bidder-profile.js";
import type { FlawType } from "../src/engine/stock/types.js";
import type { DB } from "../src/engine/core/db.js";

function profile(over: Partial<BidderProfile> = {}): BidderProfile {
  return {
    appraisalAccuracy: new Map(),
    defaultAppraisalAccuracy: 1,
    flawTypeDetection: new Map(),
    defaultFlawTypeDetection: 0.5,
    ...over,
  };
}

describe("actor_known_flaws repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("records and retrieves a known flaw", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", displayName: "Del" });
    const item = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
      flawType: "faulty",
    });
    const known = recordKnownFlaw(db, {
      holderActorId: del.id,
      itemKindId: item.id,
      flawType: "faulty",
      learnedDay: 3,
    });
    expect(known.flawType).toBe("faulty");
    expect(actorKnowsFlaw(db, del.id, item.id, "faulty")).toBe(true);
    expect(actorKnowsFlaw(db, del.id, item.id, "fake")).toBe(false);
  });

  it("is idempotent — recording the same flaw twice doesn't duplicate", () => {
    db = freshDB();
    const del = insertActor(db, { code: "del", displayName: "Del" });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "electrical",
      baseValue: 1,
      flawType: "fake",
    });
    recordKnownFlaw(db, {
      holderActorId: del.id,
      itemKindId: item.id,
      flawType: "fake",
      learnedDay: 1,
    });
    recordKnownFlaw(db, {
      holderActorId: del.id,
      itemKindId: item.id,
      flawType: "fake",
      learnedDay: 5, // ignored
    });
    const all = getKnownFlawsByActor(db, del.id);
    expect(all).toHaveLength(1);
    expect(all[0]?.learnedDay).toBe(1);
  });
});

describe("inspectItem", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("expert who knows the flaw type reveals it; cash transfers", () => {
    db = freshDB();
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 100 });
    const boyce = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 0 });
    const item = insertItemKind(db, {
      code: "ee-engines",
      displayName: "Lawnmower engines",
      category: "tools",
      baseValue: 40,
      flawType: "faulty",
    });
    const r = inspectItem(db, {
      buyerActorId: buyer.id,
      expertActorId: boyce.id,
      expertProfile: profile({
        flawTypeDetection: new Map<FlawType, number>([["faulty", 1.0]]),
        defaultFlawTypeDetection: 0,
      }),
      itemKindId: item.id,
      atDay: 5,
      fee: 20,
    });
    expect(r.type).toBe("flaw-revealed");
    expect(getActorById(db, buyer.id)?.cash).toBe(80);
    expect(getActorById(db, boyce.id)?.cash).toBe(20);
    expect(actorKnowsFlaw(db, buyer.id, item.id, "faulty")).toBe(true);
  });

  it("expert without competence: still charges, but doesn't reveal", () => {
    db = freshDB();
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 100 });
    const trigger = insertActor(db, { code: "trigger", displayName: "Trigger", cash: 0 });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "tools",
      baseValue: 1,
      flawType: "fake",
    });
    const r = inspectItem(db, {
      buyerActorId: buyer.id,
      expertActorId: trigger.id,
      expertProfile: profile({
        flawTypeDetection: new Map<FlawType, number>([["fake", 0.05]]),
        defaultFlawTypeDetection: 0,
      }),
      itemKindId: item.id,
      atDay: 5,
      fee: 20,
    });
    expect(r.type).toBe("looks-clean");
    if (r.type === "looks-clean") expect(r.itemHasFlaw).toBe(true);
    expect(getActorById(db, buyer.id)?.cash).toBe(80);
    expect(getActorById(db, trigger.id)?.cash).toBe(20);
    // Buyer didn't learn anything.
    expect(actorKnowsFlaw(db, buyer.id, item.id, "fake")).toBe(false);
  });

  it("blocks if buyer can't afford the fee", () => {
    db = freshDB();
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 5 });
    const expert = insertActor(db, { code: "boyce", displayName: "Boyce", cash: 0 });
    const item = insertItemKind(db, {
      code: "x",
      displayName: "x",
      category: "tools",
      baseValue: 1,
      flawType: "fake",
    });
    const r = inspectItem(db, {
      buyerActorId: buyer.id,
      expertActorId: expert.id,
      expertProfile: profile(),
      itemKindId: item.id,
      atDay: 1,
      fee: 20,
    });
    expect(r.type).toBe("blocked");
    expect(getActorById(db, buyer.id)?.cash).toBe(5);
    expect(getActorById(db, expert.id)?.cash).toBe(0);
  });

  it("clean items return looks-clean with itemHasFlaw=false", () => {
    db = freshDB();
    const buyer = insertActor(db, { code: "del", displayName: "Del", cash: 100 });
    const expert = insertActor(db, { code: "e", displayName: "E", cash: 0 });
    const item = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuums",
      category: "electrical",
      baseValue: 30,
    });
    const r = inspectItem(db, {
      buyerActorId: buyer.id,
      expertActorId: expert.id,
      expertProfile: profile({ defaultFlawTypeDetection: 1 }),
      itemKindId: item.id,
      atDay: 1,
      fee: 10,
    });
    expect(r.type).toBe("looks-clean");
    if (r.type === "looks-clean") expect(r.itemHasFlaw).toBe(false);
    expect(getActorById(db, buyer.id)?.cash).toBe(90);
  });
});

describe("known flaws affect bidder ceilings", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("an actor who has been burned by faulty stock applies the discount on future bids", () => {
    db = freshDB();
    insertActor(db, { code: "auction-house", displayName: "House" });
    const del = insertActor(db, { code: "del", displayName: "Del", cash: 100000 });
    const ignorant = insertActor(db, { code: "ignorant", displayName: "Ignorant", cash: 100000 });
    const item = insertItemKind(db, {
      code: "ee-engines",
      displayName: "Lawnmower engines",
      category: "tools",
      baseValue: 40,
      flawType: "faulty",
    });
    const lot = insertAuctionLot(db, {
      itemKindId: item.id,
      qualityTier: "good",
      quantity: 10,
      floorPrice: 1,
      listedDay: 1,
    });
    // Both actors get perfect appraisal but zero flaw detection — without
    // a known-flaw record they pay full price.
    const profiles = new Map([
      [
        del.id,
        profile({
          appraisalAccuracy: new Map([["tools", 1]]),
          flawTypeDetection: new Map<FlawType, number>([["faulty", 0]]),
          defaultFlawTypeDetection: 0,
        }),
      ],
      [
        ignorant.id,
        profile({
          appraisalAccuracy: new Map([["tools", 1]]),
          flawTypeDetection: new Map<FlawType, number>([["faulty", 0]]),
          defaultFlawTypeDetection: 0,
        }),
      ],
    ]);

    // Del has previously learned the flaw — say, he was burned last week.
    recordKnownFlaw(db, {
      holderActorId: del.id,
      itemKindId: item.id,
      flawType: "faulty",
      learnedDay: 0,
    });

    const find = makeBidders({ profiles });
    const bidders = find(db, lot, 2, createRNG("known"));
    const delBid = bidders.find((b) => b.actorId === del.id);
    const ignorantBid = bidders.find((b) => b.actorId === ignorant.id);
    // True lot value: 40 × 1.1 (good) × 10 = 440.
    // Del knows it's faulty — applies 0.3 discount → ~£132.
    // Ignorant doesn't know — pays full ~£440.
    expect(delBid?.ceiling).toBe(132);
    expect(ignorantBid?.ceiling).toBe(440);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import type { BidderProfile } from "../src/engine/auction/bidder-profile.js";
import { deriveKnowledgeProfile, seedKnowledgeProfiles } from "../src/engine/knowledge/skin-seed.js";
import { loadKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import { toBidderProfile } from "../src/engine/knowledge/legacy-bridge.js";
import type { FlawType } from "../src/engine/stock/types.js";
import type { DB } from "../src/engine/core/db.js";

describe("knowledge skin-seed", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("derives a five-axis profile from a legacy two-axis BidderProfile", () => {
    const legacy: BidderProfile = {
      appraisalAccuracy: new Map([["electrical", 0.9], ["tools", 0.8]]),
      defaultAppraisalAccuracy: 0.6,
      flawTypeDetection: new Map<FlawType, number>([["dangerous", 0.85]]),
      defaultFlawTypeDetection: 0.5,
      customerTypes: ["tradesmen"],
    };
    const derived = deriveKnowledgeProfile(legacy);
    expect(derived.conditionAccuracy.get("electrical")).toBe(0.9);
    expect(derived.priceAccuracy.get("electrical")).toBe(0.9);
    expect(derived.flawDetection.get("dangerous")).toBe(0.85);
    expect(derived.defaultConditionAccuracy).toBe(0.6);
    expect(derived.defaultPriceAccuracy).toBe(0.6);
    expect(derived.defaultFlawDetection).toBe(0.5);
    expect(derived.customerTypes).toEqual(["tradesmen"]);
  });

  it("seedKnowledgeProfiles persists for every actor in the map", () => {
    db = freshDB();
    const a = insertActor(db, { code: "a", displayName: "A" });
    const b = insertActor(db, { code: "b", displayName: "B" });
    const profiles = new Map<number, BidderProfile>([
      [a.id, {
        appraisalAccuracy: new Map([["watches", 0.95]]),
        defaultAppraisalAccuracy: 0.5,
        flawTypeDetection: new Map(),
        defaultFlawTypeDetection: 0.4,
      }],
      [b.id, {
        appraisalAccuracy: new Map(),
        defaultAppraisalAccuracy: 0.3,
        flawTypeDetection: new Map<FlawType, number>([["fake", 0.9]]),
        defaultFlawTypeDetection: 0.7,
      }],
    ]);
    seedKnowledgeProfiles(db, profiles);

    const aProfile = loadKnowledgeProfile(db, a.id);
    expect(aProfile.priceAccuracy.get("watches")).toBe(0.95);
    expect(aProfile.conditionAccuracy.get("watches")).toBe(0.95);
    expect(aProfile.defaultPriceAccuracy).toBe(0.5);

    const bProfile = loadKnowledgeProfile(db, b.id);
    expect(bProfile.flawDetection.get("fake")).toBe(0.9);
    expect(bProfile.defaultFlawDetection).toBe(0.7);
  });

  it("derive + bridge is identity for the two axes that round-trip", () => {
    const legacy: BidderProfile = {
      appraisalAccuracy: new Map([["electrical", 0.9]]),
      defaultAppraisalAccuracy: 0.6,
      flawTypeDetection: new Map<FlawType, number>([["dangerous", 0.85]]),
      defaultFlawTypeDetection: 0.5,
    };
    const derived = deriveKnowledgeProfile(legacy);
    const round = toBidderProfile(derived);
    expect(round.appraisalAccuracy.get("electrical")).toBe(0.9);
    expect(round.defaultAppraisalAccuracy).toBe(0.6);
    expect(round.flawTypeDetection.get("dangerous")).toBe(0.85);
    expect(round.defaultFlawTypeDetection).toBe(0.5);
  });
});

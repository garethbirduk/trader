import { describe, it, expect } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import { setActorArmJ } from "../src/engine/perception/arm-j-repo.js";
import {
  CHARACTER_DEFAULT_EXPERTISE,
  resolvePerArmDials,
  resolvePerArmDialsPure,
} from "../src/engine/perception/expertise.js";
import { persistKnowledgeProfile } from "../src/engine/knowledge/skills-repo.js";
import {
  FALLBACK_KNOWLEDGE_PROFILE,
  type KnowledgeProfile,
} from "../src/engine/knowledge/types.js";

function makeActor(db: ReturnType<typeof freshDB>, code: string): number {
  return insertActor(db, {
    code,
    displayName: code,
    cash: 100,
    role: "civilian",
    transportCapacity: "none",
    isVirtual: false,
  }).id;
}

function profileWith(over: Partial<KnowledgeProfile>): KnowledgeProfile {
  return { ...FALLBACK_KNOWLEDGE_PROFILE, ...over };
}

describe("resolvePerArmDialsPure", () => {
  it("price arm reads priceAccuracy[category]", () => {
    const profile = profileWith({
      priceAccuracy: new Map([["electrical", 0.9]]),
      defaultPriceAccuracy: 0.4,
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "price",
      key: "electrical",
      storedJ: null,
    });
    expect(out.expertise).toBeCloseTo(0.9);
  });

  it("price arm falls back to defaultPriceAccuracy on unknown category", () => {
    const profile = profileWith({
      priceAccuracy: new Map([["electrical", 0.9]]),
      defaultPriceAccuracy: 0.4,
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "price",
      key: "furniture",
      storedJ: null,
    });
    expect(out.expertise).toBeCloseTo(0.4);
  });

  it("condition arm reads conditionAccuracy[category]", () => {
    const profile = profileWith({
      conditionAccuracy: new Map([["furniture", 0.7]]),
      defaultConditionAccuracy: 0.3,
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "condition",
      key: "furniture",
      storedJ: null,
    });
    expect(out.expertise).toBeCloseTo(0.7);
  });

  it("identity arm reads idAccuracy[pairCode]", () => {
    const profile = profileWith({
      idAccuracy: new Map([["rolex|rulex", 0.85]]),
      defaultIdAccuracy: 0.5,
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "identity",
      key: "rolex|rulex",
      storedJ: null,
    });
    expect(out.expertise).toBeCloseTo(0.85);
  });

  it("character arm returns CHARACTER_DEFAULT_EXPERTISE until the arm ships", () => {
    const profile = profileWith({});
    const out = resolvePerArmDialsPure({
      profile,
      arm: "character",
      storedJ: null,
    });
    expect(out.expertise).toBeCloseTo(CHARACTER_DEFAULT_EXPERTISE);
  });

  it("j falls back to expertise when no stored j", () => {
    const profile = profileWith({
      priceAccuracy: new Map([["electrical", 0.8]]),
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "price",
      key: "electrical",
      storedJ: null,
    });
    expect(out.j).toBeCloseTo(0.8);
  });

  it("stored j wins over expertise fallback", () => {
    const profile = profileWith({
      priceAccuracy: new Map([["electrical", 0.8]]),
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "price",
      key: "electrical",
      storedJ: 0.2,
    });
    expect(out.expertise).toBeCloseTo(0.8);
    expect(out.j).toBeCloseTo(0.2);
  });

  it("clamps out-of-range scalars in the profile to [0, 1]", () => {
    const profile = profileWith({
      // The KnowledgeProfile contract is [0,1], but defend against
      // garbage skin data — resolution must not blow up.
      priceAccuracy: new Map([["electrical", 1.5]]),
    });
    const out = resolvePerArmDialsPure({
      profile,
      arm: "price",
      key: "electrical",
      storedJ: -1,
    });
    expect(out.expertise).toBeCloseTo(1);
    expect(out.j).toBeCloseTo(0);
  });
});

describe("resolvePerArmDials (DB-backed)", () => {
  it("missing j row → j = expertise (the doc's default)", () => {
    const db = freshDB();
    const aid = makeActor(db, "a");
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        priceAccuracy: new Map([["electrical", 0.7]]),
        defaultPriceAccuracy: 0.4,
      }),
    );
    const out = resolvePerArmDials({
      db,
      actorId: aid,
      arm: "price",
      key: "electrical",
    });
    expect(out.expertise).toBeCloseTo(0.7);
    expect(out.j).toBeCloseTo(0.7);
  });

  it("stored j row overrides the expertise fallback", () => {
    const db = freshDB();
    const aid = makeActor(db, "a");
    persistKnowledgeProfile(
      db,
      aid,
      profileWith({
        priceAccuracy: new Map([["electrical", 0.7]]),
      }),
    );
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.2 });
    const out = resolvePerArmDials({
      db,
      actorId: aid,
      arm: "price",
      key: "electrical",
    });
    expect(out.expertise).toBeCloseTo(0.7);
    expect(out.j).toBeCloseTo(0.2);
  });

  it("actor with no profile rows uses the engine fallback profile", () => {
    const db = freshDB();
    const aid = makeActor(db, "a");
    // No persistKnowledgeProfile call — loadKnowledgeProfile will
    // synthesise a profile from the engine's FALLBACK defaults.
    const out = resolvePerArmDials({
      db,
      actorId: aid,
      arm: "price",
      key: "electrical",
    });
    expect(out.expertise).toBeCloseTo(
      FALLBACK_KNOWLEDGE_PROFILE.defaultPriceAccuracy,
    );
    expect(out.j).toBeCloseTo(
      FALLBACK_KNOWLEDGE_PROFILE.defaultPriceAccuracy,
    );
  });
});

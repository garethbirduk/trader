import { describe, it, expect } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor } from "../src/engine/actors/actors-repo.js";
import {
  DEFAULT_ANCHOR_FALLBACK,
  getAllCategoryAnchors,
  getCategoryAnchor,
  seedCategoryAnchors,
  setCategoryAnchor,
} from "../src/engine/perception/anchors-repo.js";
import {
  getActorAllArmJ,
  getActorArmJ,
  seedActorArmJ,
  setActorArmJ,
} from "../src/engine/perception/arm-j-repo.js";
import type { Arm } from "../src/engine/perception/types.js";

describe("category-anchors-repo", () => {
  it("missing category falls back to DEFAULT_ANCHOR_FALLBACK", () => {
    const db = freshDB();
    expect(getCategoryAnchor(db, "electrical")).toBe(DEFAULT_ANCHOR_FALLBACK);
  });

  it("setCategoryAnchor + getCategoryAnchor round-trips", () => {
    const db = freshDB();
    setCategoryAnchor(db, "electrical", 80);
    expect(getCategoryAnchor(db, "electrical")).toBe(80);
  });

  it("setCategoryAnchor upserts (no duplicate-key error)", () => {
    const db = freshDB();
    setCategoryAnchor(db, "electrical", 80);
    setCategoryAnchor(db, "electrical", 50);
    expect(getCategoryAnchor(db, "electrical")).toBe(50);
  });

  it("rejects negative anchor values", () => {
    const db = freshDB();
    expect(() => setCategoryAnchor(db, "electrical", -1)).toThrow();
  });

  it("rounds non-integer anchors to satisfy the integer CHECK", () => {
    const db = freshDB();
    setCategoryAnchor(db, "electrical", 49.7);
    expect(getCategoryAnchor(db, "electrical")).toBe(50);
  });

  it("seedCategoryAnchors writes all rows", () => {
    const db = freshDB();
    seedCategoryAnchors(
      db,
      new Map([
        ["electrical", 50],
        ["furniture", 70],
      ]),
    );
    const all = getAllCategoryAnchors(db);
    expect(all.size).toBe(2);
    expect(all.get("electrical")).toBe(50);
    expect(all.get("furniture")).toBe(70);
  });
});

describe("actor-arm-j-repo", () => {
  it("missing arm returns null (not the default fallback — that lives in the resolution layer)", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Tester", shortName: "Tester",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    expect(getActorArmJ(db, aid, "price")).toBeNull();
  });

  it("setActorArmJ + getActorArmJ round-trips", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Tester", shortName: "Tester",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.7 });
    expect(getActorArmJ(db, aid, "price")).toBeCloseTo(0.7);
  });

  it("upserts on conflict", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Tester", shortName: "Tester",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.7 });
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.3 });
    expect(getActorArmJ(db, aid, "price")).toBeCloseTo(0.3);
  });

  it("rejects out-of-range j", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Tester", shortName: "Tester",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    expect(() => setActorArmJ(db, { actorId: aid, arm: "price", j: 1.5 })).toThrow();
    expect(() => setActorArmJ(db, { actorId: aid, arm: "price", j: -0.1 })).toThrow();
  });

  it("getActorAllArmJ returns just the rows that exist", () => {
    const db = freshDB();
    const aid = insertActor(db, {
      code: "test",
      firstName: "Tester", shortName: "Tester",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    setActorArmJ(db, { actorId: aid, arm: "price", j: 0.7 });
    setActorArmJ(db, { actorId: aid, arm: "character", j: 0.4 });
    const all = getActorAllArmJ(db, aid);
    expect(all.size).toBe(2);
    expect(all.get("price")).toBeCloseTo(0.7);
    expect(all.get("character")).toBeCloseTo(0.4);
    expect(all.has("condition")).toBe(false);
  });

  it("seedActorArmJ writes the nested map for many actors", () => {
    const db = freshDB();
    const a = insertActor(db, {
      code: "a",
      firstName: "Alice", shortName: "Alice",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const b = insertActor(db, {
      code: "b",
      firstName: "Bob", shortName: "Bob",
      cash: 100,
      role: "civilian",
      transportCapacity: "none",
      isVirtual: false,
    }).id;
    const seed = new Map<number, Map<Arm, number>>([
      [a, new Map([["price", 0.8], ["character", 0.6]])],
      [b, new Map([["price", 0.3]])],
    ]);
    seedActorArmJ(db, seed);
    expect(getActorArmJ(db, a, "price")).toBeCloseTo(0.8);
    expect(getActorArmJ(db, a, "character")).toBeCloseTo(0.6);
    expect(getActorArmJ(db, b, "price")).toBeCloseTo(0.3);
    expect(getActorArmJ(db, b, "character")).toBeNull();
  });
});

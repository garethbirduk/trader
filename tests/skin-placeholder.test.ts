import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { createRNG } from "../src/engine/core/rng.js";
import { seedPlaceholderSkin } from "../src/skins/placeholder/index.js";
import { listActors, getActorByCode } from "../src/engine/actors/actors-repo.js";
import { listLocations } from "../src/engine/locations/locations.js";
import {
  listItemKinds,
  listSpawnableItemKinds,
} from "../src/engine/stock/items-repo.js";
import { listActivePools } from "../src/engine/pools/pools-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("placeholder skin", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("seeds locations, items, actors, and supplies a spawnable catalogue", () => {
    db = freshDB();
    const result = seedPlaceholderSkin(db, createRNG("seed"));
    expect(listLocations(db).length).toBeGreaterThanOrEqual(3);
    expect(listActors(db).length).toBeGreaterThanOrEqual(6);
    // Catalogue has the everyday items plus the easter eggs.
    expect(listItemKinds(db).length).toBeGreaterThanOrEqual(50);
    expect(listSpawnableItemKinds(db).length).toBeGreaterThan(0);
    // Pools are spawned daily by the spawner, not pre-seeded — none yet.
    expect(listActivePools(db, 1)).toEqual([]);

    const player = getActorByCode(db, "player");
    expect(player?.id).toBe(result.playerActorId);
    expect(player?.cash).toBeGreaterThan(0);
    expect(player?.currentLocationId).not.toBeNull();
  });

  it("includes easter-egg items in the catalogue", () => {
    db = freshDB();
    seedPlaceholderSkin(db, createRNG("seed"));
    const eggs = listItemKinds(db).filter((it) => it.isEasterEgg);
    expect(eggs.length).toBeGreaterThanOrEqual(30);
    // Spot-check one specific show item ships with its flavour text.
    const dolls = eggs.find((it) => it.code === "ee-inflatable-dolls");
    expect(dolls?.flavourText).toMatch(/propane/);
    expect(dolls?.flawType).toBe("dangerous");
  });

  it("supplies a reachableByCategory map keyed by item category", () => {
    db = freshDB();
    const result = seedPlaceholderSkin(db, createRNG("seed"));
    const denzilId = getActorByCode(db, "denzil")!.id;
    expect(result.reachableByCategory.get("electrical")).toContain(denzilId);
    expect(result.defaultReachableActorIds.length).toBeGreaterThan(0);
  });

  it("registers policies for every NPC except the player", () => {
    db = freshDB();
    const result = seedPlaceholderSkin(db, createRNG("seed"));
    const player = getActorByCode(db, "player");
    expect(result.policies.has(player!.id)).toBe(false);

    const denzil = getActorByCode(db, "denzil");
    const monkey = getActorByCode(db, "monkey-harris");
    expect(result.policies.has(denzil!.id)).toBe(true);
    expect(result.policies.has(monkey!.id)).toBe(true);
  });

  it("supplies bidder profiles per actor with the expected specialisations", () => {
    db = freshDB();
    const result = seedPlaceholderSkin(db, createRNG("seed"));
    const denzil = getActorByCode(db, "denzil");
    const trigger = getActorByCode(db, "trigger");
    const denzilProfile = result.bidderProfiles.get(denzil!.id);
    const triggerProfile = result.bidderProfiles.get(trigger!.id);

    // Denzil's "good at electricals" shows up in his per-category map.
    expect(denzilProfile?.appraisalAccuracy.get("electrical")).toBeGreaterThan(0.8);
    expect(denzilProfile?.defaultAppraisalAccuracy).toBeLessThan(0.8);

    // Trigger has a low default and no per-category specialisations.
    expect(triggerProfile?.defaultAppraisalAccuracy).toBeLessThan(0.5);
    expect(triggerProfile?.appraisalAccuracy.size).toBe(0);
  });
});

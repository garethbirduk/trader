import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import { insertActor, getActorById } from "../src/engine/actors/actors-repo.js";
import {
  getActorCurrentLocationId,
  getActorsAtLocation,
  getLocationByCode,
  getLocationById,
  insertLocation,
  listLocations,
  setActorLocation,
} from "../src/engine/locations/locations.js";
import type { DB } from "../src/engine/core/db.js";

describe("locations repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves a location", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "nags-head", displayName: "The Nag's Head" });
    expect(loc.id).toBeGreaterThan(0);
    expect(getLocationById(db, loc.id)).toEqual(loc);
    expect(getLocationByCode(db, "nags-head")).toEqual(loc);
  });

  it("rejects duplicate location codes", () => {
    db = freshDB();
    insertLocation(db, { code: "lock-up", displayName: "Lock-up" });
    expect(() =>
      insertLocation(db, { code: "lock-up", displayName: "Other" }),
    ).toThrow();
  });

  it("starts actors with no current location and assigns one", () => {
    db = freshDB();
    const a = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    expect(a.currentLocationId).toBeNull();
    expect(getActorCurrentLocationId(db, a.id)).toBeNull();

    const loc = insertLocation(db, { code: "flat", displayName: "Peckham flat" });
    setActorLocation(db, a.id, loc.id);
    expect(getActorCurrentLocationId(db, a.id)).toBe(loc.id);
    expect(getActorById(db, a.id)?.currentLocationId).toBe(loc.id);

    setActorLocation(db, a.id, null);
    expect(getActorCurrentLocationId(db, a.id)).toBeNull();
  });

  it("queries actors at a location", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "nags-head", displayName: "The Nag's Head" });
    const del = insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    const rodney = insertActor(db, { code: "rodney", firstName: "Rodney", shortName: "Rodney" });
    insertActor(db, { code: "boyce", firstName: "Boyce", shortName: "Boyce" });
    setActorLocation(db, del.id, loc.id);
    setActorLocation(db, rodney.id, loc.id);
    expect(getActorsAtLocation(db, loc.id)).toEqual([del.id, rodney.id]);
  });

  it("throws when assigning location to unknown actor", () => {
    db = freshDB();
    const loc = insertLocation(db, { code: "x", displayName: "X" });
    expect(() => setActorLocation(db, 9999, loc.id)).toThrow();
  });

  it("lists locations", () => {
    db = freshDB();
    insertLocation(db, { code: "a", displayName: "A" });
    insertLocation(db, { code: "b", displayName: "B" });
    expect(listLocations(db).map((l) => l.code)).toEqual(["a", "b"]);
  });
});

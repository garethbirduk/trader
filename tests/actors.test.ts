import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  adjustActorCash,
  getActorByCode,
  getActorById,
  insertActor,
  listActors,
} from "../src/engine/actors/actors-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("actors repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves an actor", () => {
    db = freshDB();
    const a = insertActor(db, { code: "del", firstName: "Del Boy", shortName: "Del Boy", cash: 2000 });
    expect(a.cash).toBe(2000);
    expect(getActorById(db, a.id)).toEqual(a);
    expect(getActorByCode(db, "del")).toEqual(a);
  });

  it("defaults cash to 0", () => {
    db = freshDB();
    const a = insertActor(db, { code: "rodney", firstName: "Rodney", shortName: "Rodney" });
    expect(a.cash).toBe(0);
  });

  it("rejects duplicate codes", () => {
    db = freshDB();
    insertActor(db, { code: "del", firstName: "Del", shortName: "Del" });
    expect(() => insertActor(db, { code: "del", firstName: "Del2", shortName: "Del2" })).toThrow();
  });

  it("adjusts cash by delta, supporting positive and negative", () => {
    db = freshDB();
    const a = insertActor(db, { code: "boyce", firstName: "Boyce", shortName: "Boyce", cash: 1000 });
    expect(adjustActorCash(db, a.id, 250).cash).toBe(1250);
    expect(adjustActorCash(db, a.id, -300).cash).toBe(950);
  });

  it("throws on adjustCash for unknown actor", () => {
    db = freshDB();
    expect(() => adjustActorCash(db, 9999, 100)).toThrow();
  });

  it("lists actors in insertion order", () => {
    db = freshDB();
    insertActor(db, { code: "a", firstName: "A", shortName: "A" });
    insertActor(db, { code: "b", firstName: "B", shortName: "B" });
    expect(listActors(db).map((x) => x.code)).toEqual(["a", "b"]);
  });
});

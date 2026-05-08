import { describe, it, expect, afterEach } from "vitest";
import { freshDB } from "./helpers/db-fixture.js";
import {
  getItemKindByCode,
  getItemKindById,
  insertItemKind,
  listItemKinds,
} from "../src/engine/stock/items-repo.js";
import type { DB } from "../src/engine/core/db.js";

describe("item_kinds repo", () => {
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("inserts and retrieves an item kind", () => {
    db = freshDB();
    const kind = insertItemKind(db, {
      code: "vacuums",
      displayName: "Vacuum cleaners",
      category: "electrical",
      baseValue: 30,
    });
    expect(kind.id).toBeGreaterThan(0);
    expect(getItemKindById(db, kind.id)).toEqual(kind);
    expect(getItemKindByCode(db, "vacuums")).toEqual(kind);
  });

  it("rejects duplicate codes", () => {
    db = freshDB();
    insertItemKind(db, { code: "tables", displayName: "Tables", category: "furniture", baseValue: 20 });
    expect(() =>
      insertItemKind(db, { code: "tables", displayName: "Tables", category: "furniture", baseValue: 25 }),
    ).toThrow();
  });

  it("rejects non-positive base_value at the schema level", () => {
    db = freshDB();
    expect(() =>
      insertItemKind(db, { code: "freebies", displayName: "Freebies", category: "junk", baseValue: 0 }),
    ).toThrow();
  });

  it("lists items in insertion order", () => {
    db = freshDB();
    insertItemKind(db, { code: "a", displayName: "A", category: "x", baseValue: 1 });
    insertItemKind(db, { code: "b", displayName: "B", category: "x", baseValue: 2 });
    const all = listItemKinds(db);
    expect(all.map((k) => k.code)).toEqual(["a", "b"]);
  });
});
